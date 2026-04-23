import type {
  FontParamValue,
  ImageValue,
  MaskValue,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";
import { computeSDF } from "@/engine/sdf";
import { CURATED_FONTS, ensureFontLoaded, isFontReady } from "@/lib/fonts";

// The built-in transform shader. Mostly identical to transform.ts but with an
// extra Y-flip when sampling the rasterized 2D canvas, whose row 0 sits at
// the top rather than the pipeline's bottom-origin convention.
const TEXT_TRANSFORM_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_translate;
uniform vec2 u_scale;
uniform float u_angle;
uniform vec2 u_pivot;
out vec4 outColor;

void main() {
  vec2 pivot = vec2(u_pivot.x, 1.0 - u_pivot.y);
  vec2 translate = vec2(u_translate.x, -u_translate.y);
  vec2 uv = v_uv - translate;
  vec2 p = uv - pivot;
  float c = cos(-u_angle);
  float s = sin(-u_angle);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  p /= max(u_scale, vec2(0.0001));
  uv = p + pivot;

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  outColor = texture(u_src, vec2(uv.x, 1.0 - uv.y));
}`;

interface TextState {
  // Reused offscreen raster target + its uploaded texture. Kept per-node so
  // resizing the canvas once on init avoids a re-alloc on every frame.
  rasterCanvas: HTMLCanvasElement;
  rasterTex: WebGLTexture;
  primary: ImageValue;
  sdf: MaskValue;
  // Hashable summary of every param that changes what gets rasterized. When
  // this matches the last eval's sig and the font is ready, we return the
  // existing textures and skip all the GL work.
  lastSig: string | null;
  lastPostSig: string | null;
  lastW: number;
  lastH: number;
}

function computeRasterSig(
  params: Record<string, unknown>,
  family: string,
  W: number,
  H: number
): string {
  return JSON.stringify({
    t: params.text,
    f: family,
    s: params.font_size,
    c: params.color,
    a: params.alignment,
    l: params.leading,
    k: params.letter_spacing,
    W,
    H,
  });
}

function computePostSig(params: Record<string, unknown>): string {
  return JSON.stringify({
    tx: params.translateX,
    ty: params.translateY,
    sx: params.scaleX,
    sy: params.scaleY,
    r: params.rotate,
    px: params.pivotX,
    py: params.pivotY,
  });
}

function effectiveFamily(params: Record<string, unknown>): string {
  const custom = params.custom_font as FontParamValue | null | undefined;
  if (custom?.family) return custom.family;
  return (params.font_family as string) ?? "Inter";
}

function ensureState(ctx: RenderContext, nodeId: string): TextState {
  const key = `text:${nodeId}`;
  const existing = ctx.state[key] as TextState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("text: failed to create raster texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const state: TextState = {
    rasterCanvas: document.createElement("canvas"),
    rasterTex: tex,
    primary: ctx.allocImage(),
    sdf: ctx.allocMask(),
    lastSig: null,
    lastPostSig: null,
    lastW: ctx.width,
    lastH: ctx.height,
  };
  ctx.state[key] = state;
  return state;
}

function resizeStateIfNeeded(ctx: RenderContext, state: TextState): void {
  if (state.lastW === ctx.width && state.lastH === ctx.height) return;
  ctx.releaseTexture(state.primary.texture);
  ctx.releaseTexture(state.sdf.texture);
  state.primary = ctx.allocImage();
  state.sdf = ctx.allocMask();
  state.lastW = ctx.width;
  state.lastH = ctx.height;
  // Force re-rasterize + retransform since the target grew/shrunk.
  state.lastSig = null;
  state.lastPostSig = null;
}

function rasterize(
  ctx: RenderContext,
  state: TextState,
  params: Record<string, unknown>,
  family: string
): void {
  const W = ctx.width;
  const H = ctx.height;
  const canvas = state.rasterCanvas;
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const c2d = canvas.getContext("2d");
  if (!c2d) return;
  c2d.clearRect(0, 0, W, H);

  const text = (params.text as string) ?? "";
  const size = (params.font_size as number) ?? 64;
  const color = (params.color as string) ?? "#ffffff";
  const alignment = ((params.alignment as string) ?? "center") as
    | "left"
    | "center"
    | "right";
  const leading = (params.leading as number) ?? 1.2;
  const letterSpacing = (params.letter_spacing as number) ?? 0;

  c2d.save();
  c2d.fillStyle = color;
  // The quote wrapping lets families with spaces ("Playfair Display") parse.
  c2d.font = `${size}px "${family}", sans-serif`;
  c2d.textAlign = alignment;
  c2d.textBaseline = "middle";
  // `letterSpacing` is a 2023+ canvas property. Older browsers just ignore
  // the assignment rather than throwing.
  (c2d as unknown as { letterSpacing?: string }).letterSpacing = `${letterSpacing}px`;

  const lines = text.split("\n");
  const lineHeight = size * leading;
  const totalHeight = Math.max(1, lines.length) * lineHeight;
  const startY = H / 2 - totalHeight / 2 + lineHeight / 2;
  const x = alignment === "left" ? 0 : alignment === "right" ? W : W / 2;
  for (let i = 0; i < lines.length; i++) {
    c2d.fillText(lines[i], x, startY + i * lineHeight);
  }
  c2d.restore();

  // Upload to the reusable RGBA8 texture bound to u_src in the transform pass.
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

function applyTransform(
  ctx: RenderContext,
  state: TextState,
  params: Record<string, unknown>
): void {
  const translateX = (params.translateX as number) ?? 0;
  const translateY = (params.translateY as number) ?? 0;
  const scaleX = Math.max(0.0001, (params.scaleX as number) ?? 1);
  const scaleY = Math.max(0.0001, (params.scaleY as number) ?? 1);
  const rotate = (params.rotate as number) ?? 0;
  const pivotX = (params.pivotX as number) ?? 0.5;
  const pivotY = (params.pivotY as number) ?? 0.5;
  const angle = (rotate * Math.PI) / 180;

  const prog = ctx.getShader("text/transform", TEXT_TRANSFORM_FS);
  ctx.drawFullscreen(prog, state.primary, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.rasterTex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
    gl.uniform2f(
      gl.getUniformLocation(prog, "u_translate"),
      translateX,
      translateY
    );
    gl.uniform2f(
      gl.getUniformLocation(prog, "u_scale"),
      scaleX,
      scaleY
    );
    gl.uniform1f(gl.getUniformLocation(prog, "u_angle"), angle);
    gl.uniform2f(
      gl.getUniformLocation(prog, "u_pivot"),
      pivotX,
      pivotY
    );
  });
}

export const textNode: NodeDefinition = {
  type: "text",
  name: "Text",
  category: "source",
  description:
    "Renders text with a built-in transform. Primary is the rasterized image; aux exposes an SDF (jump-flood) and a vector path socket (coming soon).",
  backend: "webgl2",
  // Unstable so font-load pipeline bumps re-enter compute; a local signature
  // cache inside the compute skips re-rasterization when nothing changed.
  stable: false,
  supportsTransformGizmo: true,
  inputs: [],
  params: [
    {
      name: "text",
      label: "Text",
      type: "string",
      multiline: true,
      default: "Hello",
      placeholder: "type here…",
    },
    {
      name: "font_family",
      label: "Font",
      type: "enum",
      options: CURATED_FONTS,
      default: "Inter",
    },
    {
      name: "custom_font",
      label: "Custom font",
      type: "font",
      default: null,
    },
    {
      name: "font_size",
      label: "Size (px)",
      type: "scalar",
      min: 4,
      max: 1000,
      softMax: 200,
      step: 1,
      default: 96,
    },
    {
      name: "color",
      label: "Color",
      type: "color",
      default: "#ffffff",
    },
    {
      name: "alignment",
      label: "Align",
      type: "enum",
      options: ["left", "center", "right"],
      default: "center",
    },
    {
      name: "leading",
      label: "Leading",
      type: "scalar",
      min: 0.5,
      max: 3,
      step: 0.01,
      default: 1.2,
    },
    {
      name: "letter_spacing",
      label: "Letter spacing",
      type: "scalar",
      min: -10,
      max: 40,
      step: 0.5,
      default: 0,
    },
    // Built-in transform — same param names as the Transform node so the
    // shared gizmo works without any special-casing.
    {
      name: "translateX",
      label: "Translate X",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "translateY",
      label: "Translate Y",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "scaleX",
      label: "Scale X",
      type: "scalar",
      min: 0.01,
      max: 10,
      softMax: 4,
      step: 0.01,
      default: 1,
    },
    {
      name: "scaleY",
      label: "Scale Y",
      type: "scalar",
      min: 0.01,
      max: 10,
      softMax: 4,
      step: 0.01,
      default: 1,
    },
    {
      name: "rotate",
      label: "Rotate (°)",
      type: "scalar",
      min: -360,
      max: 360,
      step: 0.5,
      default: 0,
    },
    {
      name: "pivotX",
      label: "Pivot X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "pivotY",
      label: "Pivot Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [
    {
      name: "sdf",
      type: "mask",
      description: "Signed distance field via jump flooding.",
    },
    {
      name: "paths",
      type: "vector",
      description: "Vector paths (not yet implemented).",
      disabled: true,
    },
  ],

  compute({ params, ctx, nodeId }) {
    const state = ensureState(ctx, nodeId);
    resizeStateIfNeeded(ctx, state);

    const family = effectiveFamily(params);

    // Font not yet loaded — paint a transparent placeholder and trigger the
    // async load. The load helper fires `pipeline-bump` on completion so
    // EffectsApp re-enters the evaluation loop.
    if (!isFontReady(family)) {
      ensureFontLoaded(family);
      ctx.clearTarget(state.primary, [0, 0, 0, 0]);
      ctx.clearTarget(state.sdf, [0, 0, 0, 0]);
      state.lastSig = null;
      state.lastPostSig = null;
      return { primary: state.primary, aux: { sdf: state.sdf } };
    }

    const sig = computeRasterSig(params, family, ctx.width, ctx.height);
    const postSig = computePostSig(params);

    const rasterChanged = sig !== state.lastSig;
    const postChanged = postSig !== state.lastPostSig;

    if (rasterChanged) {
      rasterize(ctx, state, params, family);
      state.lastSig = sig;
    }
    if (rasterChanged || postChanged) {
      applyTransform(ctx, state, params);
      // Re-run SDF on the transformed image. Released/reallocated each time
      // so downstream gets a fresh MaskValue — the old one is freed below.
      ctx.releaseTexture(state.sdf.texture);
      state.sdf = computeSDF(ctx, state.primary, 128);
      state.lastPostSig = postSig;
    }

    return { primary: state.primary, aux: { sdf: state.sdf } };
  },

  dispose(ctx, nodeId) {
    const state = ctx.state[`text:${nodeId}`] as TextState | undefined;
    if (!state) return;
    ctx.releaseTexture(state.primary.texture);
    ctx.releaseTexture(state.sdf.texture);
    ctx.gl.deleteTexture(state.rasterTex);
    delete ctx.state[`text:${nodeId}`];
  },
};
