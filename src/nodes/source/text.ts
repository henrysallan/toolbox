import type {
  FontParamValue,
  ImageValue,
  MaskValue,
  NodeDefinition,
  RenderContext,
  SdfValue,
  SplineValue,
} from "@/engine/types";
import { computeSDF } from "@/engine/sdf";
import { marchingSquares } from "@/engine/marching-squares";
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
  // Cached marching-squares contour of the current text raster.
  // Recomputed only when rasterChanged || postChanged fires (text /
  // font / size / position changes), reused across frames otherwise.
  spline: SplineValue;
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
    spline: { kind: "spline", subpaths: [] },
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
  category: "image",
  subcategory: "generator",
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
      type: "sdf",
      description:
        "Signed distance field via jump flooding, exposed as a first-class sdf socket — composes with SDF Smooth Union / Round / Rasterize / etc. Distance is sampled from a precomputed JFA texture (clamped to ~12% of the canvas dimension), so the result is fast but bounded — narrow text glyphs work great; very wide kerning may show clipping.",
    },
    {
      name: "spline",
      type: "spline",
      description:
        "Outline of the rasterized text as a spline (marching squares on the alpha channel). Recomputes only when the text content / font / position changes; downstream consumers (Stroke, Fill, Modulate Splines, etc.) work directly on it.",
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
      state.spline = { kind: "spline", subpaths: [] };
      return {
        primary: state.primary,
        aux: { sdf: emptySdf(), spline: state.spline },
      };
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
      // Refresh the cached spline outline by marching squares on the
      // raster's alpha channel (text is opaque inside, transparent
      // outside). Iso = 0.5 puts the contour on the visual edge of
      // the glyph. CPU readback is one sync stall per text change —
      // acceptable since text rarely animates per-frame.
      state.spline = extractTextSpline(ctx, state.primary);
      state.lastPostSig = postSig;
    }

    // Wrap the JFA distance image as a real sdf-socket value so it
    // composes with the rest of the SDF graph. The range matches
    // computeSDF's own normalization: 128 px / max(canvas dim) →
    // canvas-UV signed distance after the un-normalize in the helper.
    const sdfRange = 128 / Math.max(state.primary.width, state.primary.height, 1);
    const sdfOut: SdfValue = {
      kind: "sdf",
      root: {
        kind: "sdfFromImage",
        position: { kind: "canvasUv" },
        image: state.sdf.texture,
        range: sdfRange,
      },
    };

    return {
      primary: state.primary,
      aux: { sdf: sdfOut, spline: state.spline },
    };
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

// Sentinel for the placeholder pre-font-load case. Combiners
// (Union, Smooth Union, etc.) treat `empty` as far-away so they
// degrade gracefully when one input isn't producing yet.
function emptySdf(): SdfValue {
  return { kind: "sdf", root: { kind: "empty" } };
}

// Extract the text glyph outline by marching squares on the alpha
// channel of the rasterized text image. Reads the raster back via
// the engine's existing readImageToFloat32 bridge, packs the alpha
// values into a flat Float32 grid (with the convention "value < iso
// = inside"), and runs the same marching-squares helper SDF to
// Spline uses. The text raster's resolution is the canvas size,
// which can be 1024² or larger — one CPU readback per text edit
// is the cost.
function extractTextSpline(
  ctx: RenderContext,
  image: ImageValue
): SplineValue {
  const w = image.width;
  const h = image.height;
  if (w <= 0 || h <= 0) return { kind: "spline", subpaths: [] };
  const data = ctx.readImageToFloat32(image);
  const grid = new Float32Array(w * h);
  // Convention: marching squares treats `value < iso` as inside.
  // Text alpha is ~1 inside the glyph, ~0 outside — so use
  // `(0.5 - alpha)`: negative inside, positive outside, contour at
  // alpha = 0.5. readPixels returns rows bottom-up, but our spline
  // coords are y-down — flip Y when copying into the grid.
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const a = data[(srcY * w + x) * 4 + 3];
      grid[y * w + x] = 0.5 - a;
    }
  }
  const subpaths = marchingSquares(grid, w, h, {
    iso: 0,
    uvOrigin: [0, 0],
    uvSize: [1, 1],
  });
  return { kind: "spline", subpaths };
}
