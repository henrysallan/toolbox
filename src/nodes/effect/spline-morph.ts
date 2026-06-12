import { OPACITY_PARAM } from "@/engine/conventions";
import type {
  NodeDefinition,
  OutputSocketDef,
  RenderContext,
  SplineValue,
} from "@/engine/types";
import { buildPath2D, hexToRgba } from "@/engine/spline-raster";
import {
  buildMorphCorrespondence,
  applyMorph,
  type MorphCorrespondence,
} from "@/engine/spline-morph";

// Morph (tween) between two splines. Both shapes are put into
// correspondence — resampled to a matched anchor count and aligned by
// orientation + start vertex — then interpolated per anchor by Amount
// (0 = A, 1 = B). Outputs the tweened spline, plus a rasterized image
// when stroke or fill is enabled, exactly like the spline primitives.
//
// Amount is a keyframable param and a wireable scalar input, so you can
// drive the transition from a curve, an LFO, audio, anything.

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

interface MorphState {
  rasterCanvas: HTMLCanvasElement;
  rasterTex: WebGLTexture | null;
  // Correspondence depends only on the two shapes + resolution, not on
  // Amount — cache it so animating Amount is just a per-anchor lerp.
  // Shapes are compared by OBJECT IDENTITY: upstream re-renders hand us
  // new SplineValue objects exactly when geometry changed (the evaluator
  // caches otherwise), so identity invalidates precisely — and avoids
  // JSON-stringifying potentially huge splines (e.g. SDF→Spline on
  // video) every eval.
  corrA: SplineValue | null;
  corrB: SplineValue | null;
  corrRes: number;
  corr: MorphCorrespondence;
  // Bumped on every correspondence rebuild — stands in for the result
  // geometry in the raster signature (corrGen + amount fully determine
  // the morphed shape), so the sig never serializes anchor data.
  corrGen: number;
  lastRasterSig: string | null;
}

function ensureState(ctx: RenderContext, nodeId: string): MorphState {
  const key = `spline-morph:${nodeId}`;
  const existing = ctx.state[key] as MorphState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("spline-morph: failed to create raster texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: MorphState = {
    rasterCanvas: document.createElement("canvas"),
    rasterTex: tex,
    corrA: null,
    corrB: null,
    corrRes: 0,
    corr: [],
    corrGen: 0,
    lastRasterSig: null,
  };
  ctx.state[key] = s;
  return s;
}

export const splineMorphNode: NodeDefinition = {
  type: "spline-morph",
  name: "Spline Morph",
  category: "spline",
  subcategory: "modifier",
  description:
    "Morph (tween) between two splines by Amount (0 = A, 1 = B). Shapes are auto-aligned by orientation and start vertex; surplus subpaths grow/shrink from a point. Outputs a spline, plus an image when stroke or fill is on.",
  backend: "webgl2",
  inputs: [
    { name: "a", type: "spline", required: true, label: "A" },
    { name: "b", type: "spline", required: true, label: "B" },
    { name: "amount", type: "scalar", required: false, label: "Amount" },
  ],
  params: [
    OPACITY_PARAM,
    {
      name: "amount",
      label: "Amount",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      // Anchors each shape is resampled to before interpolating. Higher
      // tracks the source curves more closely; heavier per rebuild.
      name: "resolution",
      label: "Resolution",
      type: "scalar",
      min: 3,
      max: 256,
      softMax: 128,
      step: 1,
      default: 64,
    },
    {
      name: "stroke_enabled",
      label: "Stroke",
      type: "boolean",
      default: false,
    },
    {
      name: "stroke_thickness",
      label: "Thickness (px)",
      type: "scalar",
      min: 0,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 4,
      visibleIf: (p) => !!p.stroke_enabled,
    },
    {
      name: "stroke_color",
      label: "Stroke color",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => !!p.stroke_enabled,
    },
    {
      name: "fill_enabled",
      label: "Fill",
      type: "boolean",
      default: true,
    },
    {
      name: "fill_color",
      label: "Fill color",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => !!p.fill_enabled,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "image", type: "image" }],
  resolveAuxOutputs(params): OutputSocketDef[] {
    const hasRaster = !!params.stroke_enabled || !!params.fill_enabled;
    return hasRaster ? [{ name: "image", type: "image" }] : [];
  },

  compute({ inputs, params, ctx, nodeId }) {
    const a = inputs.a;
    const b = inputs.b;
    const aSpline: SplineValue = a && a.kind === "spline" ? a : EMPTY_SPLINE;
    const bSpline: SplineValue = b && b.kind === "spline" ? b : EMPTY_SPLINE;

    // Wired scalar wins over the keyframable param.
    const rawAmount =
      inputs.amount?.kind === "scalar"
        ? inputs.amount.value
        : ((params.amount as number) ?? 0.5);
    const amount = Math.max(0, Math.min(1, rawAmount));
    const resolution = Math.max(
      3,
      Math.round((params.resolution as number) ?? 64)
    );

    const state = ensureState(ctx, nodeId);

    // Rebuild the correspondence only when shapes / resolution change —
    // NOT when Amount sweeps.
    if (
      state.corrA !== aSpline ||
      state.corrB !== bSpline ||
      state.corrRes !== resolution
    ) {
      state.corr = buildMorphCorrespondence(aSpline, bSpline, resolution);
      state.corrA = aSpline;
      state.corrB = bSpline;
      state.corrRes = resolution;
      state.corrGen++;
    }
    const resultSpline = applyMorph(state.corr, amount);

    const strokeOn = !!params.stroke_enabled;
    const fillOn = !!params.fill_enabled;
    if (!strokeOn && !fillOn) {
      return { primary: resultSpline };
    }

    const W = ctx.width;
    const H = ctx.height;
    // corrGen + amount stand in for the morphed geometry — no anchor
    // serialization (the result can be huge when fed SDF→Spline output).
    const rasterSig = `${state.corrGen}:${amount}:${strokeOn}:${params.stroke_thickness}:${params.stroke_color}:${fillOn}:${params.fill_color}:${W}x${H}`;

    if (rasterSig !== state.lastRasterSig) {
      const canvas = state.rasterCanvas;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      const c2d = canvas.getContext("2d");
      if (c2d) {
        c2d.clearRect(0, 0, W, H);
        const path = buildPath2D(resultSpline.subpaths, W, H, fillOn);
        if (path) {
          if (fillOn) {
            c2d.fillStyle = hexToRgba(
              (params.fill_color as string) ?? "#ffffff"
            );
            c2d.fill(path, "evenodd");
          }
          if (strokeOn) {
            c2d.lineWidth = Math.max(
              0,
              (params.stroke_thickness as number) ?? 4
            );
            c2d.strokeStyle = hexToRgba(
              (params.stroke_color as string) ?? "#ffffff"
            );
            c2d.lineCap = "round";
            c2d.lineJoin = "round";
            c2d.stroke(path);
          }
        }
        const gl = ctx.gl;
        gl.bindTexture(gl.TEXTURE_2D, state.rasterTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          canvas
        );
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      state.lastRasterSig = rasterSig;
    }

    const image = ctx.allocImage();
    const prog = ctx.getShader("spline-morph/blit", BLIT_FS);
    ctx.drawFullscreen(prog, image, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state.rasterTex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
    });

    return { primary: resultSpline, aux: { image } };
  },

  dispose(ctx, nodeId) {
    const key = `spline-morph:${nodeId}`;
    const state = ctx.state[key] as MorphState | undefined;
    if (state?.rasterTex) ctx.gl.deleteTexture(state.rasterTex);
    delete ctx.state[key];
  },
};
