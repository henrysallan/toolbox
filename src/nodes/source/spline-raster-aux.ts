import type {
  ImageValue,
  OutputSocketDef,
  ParamDef,
  RenderContext,
  SplineSubpath,
} from "@/engine/types";
import { buildPath2D, hexToRgba } from "@/engine/spline-raster";

// Shared "view this spline" rasterizer bundled into the spline primitive
// nodes (Circle, Rectangle, …). Each primitive keeps its `spline` output and
// gains an `image` aux output, so you can drop a primitive in and see the
// shape immediately without wiring up a separate Rasterize Spline node.
//
// A deliberately minimal stroke / fill control set — reach for the full
// Rasterize Spline node when you need dashes, caps, joins, fill rules, etc.

// Spread into a primitive's `params`.
export const SPLINE_RASTER_PARAMS: ParamDef[] = [
  { name: "stroke_enabled", label: "Stroke", type: "boolean", default: true },
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
  { name: "fill_enabled", label: "Fill", type: "boolean", default: false },
  {
    name: "fill_color",
    label: "Fill color",
    type: "color",
    default: "#ffffff",
    visibleIf: (p) => !!p.fill_enabled,
  },
];

// Use as a node's `resolveAuxOutputs`: only expose the image socket when
// something is actually drawn (otherwise it would always emit transparent
// pixels and just clutter the node).
export function resolveSplineRasterAux(
  params: Record<string, unknown>
): OutputSocketDef[] {
  const on = !!params.stroke_enabled || !!params.fill_enabled;
  return on ? [{ name: "image", type: "image" }] : [];
}

const RASTER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  // Canvas memory is row-0-top; flip Y to the pipeline's Y-up convention.
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

interface RasterState {
  rasterCanvas: HTMLCanvasElement;
  rasterTex: WebGLTexture | null;
  lastSig: string | null;
}

function stateKey(nodeId: string): string {
  return `spline-raster-aux:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): RasterState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as RasterState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("spline-raster-aux: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: RasterState = {
    rasterCanvas: document.createElement("canvas"),
    rasterTex: tex,
    lastSig: null,
  };
  ctx.state[key] = s;
  return s;
}

// Rasterize the given subpaths into a fresh ImageValue using the bundled
// stroke/fill params. Returns null when neither stroke nor fill is enabled
// (the caller should then emit spline data only).
export function rasterizeSplineAux(
  ctx: RenderContext,
  nodeId: string,
  subpaths: SplineSubpath[],
  params: Record<string, unknown>
): ImageValue | null {
  const strokeOn = !!params.stroke_enabled;
  const fillOn = !!params.fill_enabled;
  if (!strokeOn && !fillOn) return null;

  const state = ensureState(ctx, nodeId);
  const W = ctx.width;
  const H = ctx.height;

  const sig = JSON.stringify({
    p: subpaths,
    se: strokeOn,
    st: params.stroke_thickness,
    sc: params.stroke_color,
    fe: fillOn,
    fc: params.fill_color,
    W,
    H,
  });

  if (sig !== state.lastSig) {
    const canvas = state.rasterCanvas;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const c2d = canvas.getContext("2d");
    if (c2d) {
      c2d.clearRect(0, 0, W, H);
      const path = buildPath2D(subpaths, W, H, fillOn);
      if (path) {
        if (fillOn) {
          c2d.fillStyle = hexToRgba((params.fill_color as string) ?? "#ffffff");
          // Even-odd so nested subpaths punch holes — matches Spline Draw.
          c2d.fill(path, "evenodd");
        }
        if (strokeOn) {
          c2d.lineWidth = Math.max(0, (params.stroke_thickness as number) ?? 4);
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
    state.lastSig = sig;
  }

  const image = ctx.allocImage();
  const prog = ctx.getShader("spline-raster-aux/blit", RASTER_FS);
  ctx.drawFullscreen(prog, image, (gl2) => {
    gl2.activeTexture(gl2.TEXTURE0);
    gl2.bindTexture(gl2.TEXTURE_2D, state.rasterTex);
    gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
  });
  return image;
}

export function disposeSplineRasterAux(ctx: RenderContext, nodeId: string) {
  const key = stateKey(nodeId);
  const state = ctx.state[key] as RasterState | undefined;
  if (state?.rasterTex) ctx.gl.deleteTexture(state.rasterTex);
  delete ctx.state[key];
}
