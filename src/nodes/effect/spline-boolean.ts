import { OPACITY_PARAM } from "@/engine/conventions";
import type {
  NodeDefinition,
  OutputSocketDef,
  RenderContext,
  SplineValue,
} from "@/engine/types";
import { buildPath2D, hexToRgba } from "@/engine/spline-raster";
import {
  splineBoolean,
  type SplineBooleanOp,
} from "@/engine/spline-boolean";

// Boolean combination of two splines' filled regions. Defaults to
// Subtract (A − B): the area inside A but outside B — i.e. B cuts a hole
// in A. Also unions, intersects, and excludes (XOR). The result is a
// (polygonal) spline; an optional rasterized image is exposed exactly
// like the spline primitives (Spline Draw / SVG Source) when stroke or
// fill is enabled.

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

interface BoolState {
  rasterCanvas: HTMLCanvasElement;
  rasterTex: WebGLTexture | null;
  // Cached boolean result, keyed by its inputs — the clip is the
  // expensive part, so we skip it when nothing geometry-side changed.
  lastBoolSig: string | null;
  result: SplineValue;
  lastRasterSig: string | null;
}

function ensureState(ctx: RenderContext, nodeId: string): BoolState {
  const key = `spline-boolean:${nodeId}`;
  const existing = ctx.state[key] as BoolState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("spline-boolean: failed to create raster texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: BoolState = {
    rasterCanvas: document.createElement("canvas"),
    rasterTex: tex,
    lastBoolSig: null,
    result: EMPTY_SPLINE,
    lastRasterSig: null,
  };
  ctx.state[key] = s;
  return s;
}

export const splineBooleanNode: NodeDefinition = {
  type: "spline-boolean",
  name: "Spline Boolean",
  category: "spline",
  subcategory: "modifier",
  description:
    "Boolean of two splines' filled regions. Subtract (A − B) cuts B out of A; also union, intersect, and exclude (XOR). Outputs a spline, plus an image when stroke or fill is on.",
  backend: "webgl2",
  inputs: [
    { name: "a", type: "spline", required: true, label: "A (base)" },
    // Optional — with B unwired, A passes through unchanged.
    { name: "b", type: "spline", required: false, label: "B (cut)" },
  ],
  params: [
    OPACITY_PARAM,
    {
      name: "operation",
      label: "Operation",
      type: "enum",
      options: ["subtract", "union", "intersect", "exclude"],
      default: "subtract",
    },
    {
      // Line segments per curve when flattening for the boolean.
      // Higher is smoother but heavier.
      name: "resolution",
      label: "Curve resolution",
      type: "scalar",
      min: 3,
      max: 96,
      softMax: 48,
      step: 1,
      default: 24,
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
  // Image aux only when something would actually be drawn.
  resolveAuxOutputs(params): OutputSocketDef[] {
    const hasRaster = !!params.stroke_enabled || !!params.fill_enabled;
    return hasRaster ? [{ name: "image", type: "image" }] : [];
  },

  compute({ inputs, params, ctx, nodeId }) {
    const a = inputs.a;
    const b = inputs.b;
    const aSpline: SplineValue =
      a && a.kind === "spline" ? a : EMPTY_SPLINE;
    const bSpline: SplineValue =
      b && b.kind === "spline" ? b : EMPTY_SPLINE;

    const op = ((params.operation as string) ?? "subtract") as SplineBooleanOp;
    const steps = Math.max(
      3,
      Math.round((params.resolution as number) ?? 24)
    );

    const state = ensureState(ctx, nodeId);

    // Recompute the boolean only when geometry / op / resolution change.
    const boolSig = JSON.stringify({
      a: aSpline.subpaths,
      b: bSpline.subpaths,
      op,
      steps,
    });
    if (boolSig !== state.lastBoolSig) {
      state.result = splineBoolean(aSpline, bSpline, op, steps);
      state.lastBoolSig = boolSig;
    }
    const resultSpline = state.result;

    const strokeOn = !!params.stroke_enabled;
    const fillOn = !!params.fill_enabled;
    if (!strokeOn && !fillOn) {
      return { primary: resultSpline };
    }

    const W = ctx.width;
    const H = ctx.height;
    const rasterSig = JSON.stringify({
      subRef: resultSpline.subpaths,
      se: strokeOn,
      st: params.stroke_thickness,
      sc: params.stroke_color,
      fe: fillOn,
      fc: params.fill_color,
      W,
      H,
    });

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
            // Even-odd: boolean results carry holes as separate rings,
            // and the engine fills splines even-odd everywhere else.
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
    const prog = ctx.getShader("spline-boolean/blit", BLIT_FS);
    ctx.drawFullscreen(prog, image, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state.rasterTex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
    });

    return { primary: resultSpline, aux: { image } };
  },

  dispose(ctx, nodeId) {
    const key = `spline-boolean:${nodeId}`;
    const state = ctx.state[key] as BoolState | undefined;
    if (state?.rasterTex) ctx.gl.deleteTexture(state.rasterTex);
    delete ctx.state[key];
  },
};
