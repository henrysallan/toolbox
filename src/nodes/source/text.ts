import { OPACITY_PARAM } from "@/engine/conventions";
import type {
  ElementValue,
  FontParamValue,
  ImageValue,
  MaskValue,
  NodeDefinition,
  RenderContext,
  SdfValue,
  SplineValue,
} from "@/engine/types";
import { computeSDF } from "@/engine/sdf";
import { emptyElement, uploadCanvasToImage } from "@/engine/element";
import { marchingSquares } from "@/engine/marching-squares";
import {
  drawTextBlock,
  measureStyledBlock,
  wrapStyledLines,
  type TextFill,
  type TextGradientStop,
  type TextStroke,
  type TextStyle,
  type VAlign,
} from "@/engine/text-raster";
import { CURATED_FONTS, ensureFontLoaded, isFontReady } from "@/lib/fonts";
import { asAxisDict, hasMaskDriven } from "@/lib/font-axis";

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

// Transform variant for an already-Y-up source (the image-fill composite
// renders into a standard pooled image, unlike the row-0-top rasterTex). Same
// math, no sample-time Y-flip.
const TEXT_TRANSFORM_NOFLIP_FS = `#version 300 es
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
  outColor = texture(u_src, uv);
}`;

// Image-fill composite. The glyph fill coverage (white-on-transparent,
// row-0-top) and the in-raster stroke (its own color, row-0-top) are rendered
// as separate layers; the wired image fills the glyph interiors (per
// `fill_fit`) and the stroke sits OVER it — matching the CPU raster's
// stroke-then-fill order (fill on top). Straight-alpha source-over.
const TEXT_COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_cov;       // glyph fill coverage (alpha), row-0-top
uniform sampler2D u_stroke;    // stroke color straight-alpha, row-0-top
uniform sampler2D u_fillImage; // straight-alpha fill image, Y-up
uniform int u_hasStroke;
uniform int u_fit;             // 0 window, 1 contain, 2 cover
uniform vec2 u_uvMin;          // text box in canvas UV (Y-up)
uniform vec2 u_uvSize;
uniform vec2 u_fitScale;
out vec4 outColor;

vec4 over(vec4 s, vec4 d) {
  float oa = s.a + d.a * (1.0 - s.a);
  vec3 oc = oa < 1e-4
    ? vec3(0.0)
    : (s.rgb * s.a + d.rgb * d.a * (1.0 - s.a)) / oa;
  return vec4(oc, oa);
}

void main() {
  vec2 m = vec2(v_uv.x, 1.0 - v_uv.y);   // sample row-0-top canvases
  float cov = texture(u_cov, m).a;

  vec2 uv;
  if (u_fit == 0) {
    uv = v_uv;
  } else {
    vec2 local = (v_uv - u_uvMin) / max(u_uvSize, vec2(1e-6));
    uv = (local - 0.5) * u_fitScale + 0.5;
  }
  vec4 img = texture(u_fillImage, uv);
  if (u_fit == 1 &&
      (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))))) {
    img = vec4(0.0);
  }
  vec4 fill = vec4(img.rgb, img.a * cov);

  vec4 stroke = u_hasStroke == 1 ? texture(u_stroke, m) : vec4(0.0);
  outColor = over(fill, stroke);          // fill over stroke (fill on top)
}`;

function makeTex(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("text: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

interface TextState {
  // Reused offscreen raster target + its uploaded texture. Kept per-node so
  // resizing the canvas once on init avoids a re-alloc on every frame.
  rasterCanvas: HTMLCanvasElement;
  rasterTex: WebGLTexture;
  // Image-fill path: glyph fill coverage + stroke layers, composited with a
  // wired image into `composite` (pre-transform). Allocated lazily, only when
  // fillMode === "image".
  fillCovTex: WebGLTexture | null;
  strokeLayerTex: WebGLTexture | null;
  zeroTex: WebGLTexture | null;
  composite: ImageValue | null;
  // Off-screen canvas used to read back the `mask` input's pixels
  // when any axis is in `maskDriven` mode. The rasterizer blits
  // the mask into this canvas at our own resolution, then
  // `getImageData` to sample the mask at each glyph's centre.
  // Allocated lazily.
  maskReadCanvas: HTMLCanvasElement | null;
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
  // Whether the cached sdf / spline reflect the CURRENT raster+transform.
  // Reset whenever the raster or transform changes; the expensive
  // recompute is deferred until something actually consumes that output
  // (so dragging text that only feeds an image/element pays nothing for
  // the JFA SDF or the marching-squares contour).
  sdfValid: boolean;
  splineValid: boolean;
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
    // Weight / italic / case / vertical align — all re-rasterize.
    fw: params.font_weight,
    it: params.italic,
    tc: params.textCase,
    va: params.vAlign,
    // Fill (solid/gradient) + in-raster stroke.
    fm: params.fillMode,
    fs: params.fillStops,
    ga: params.gradientAngle,
    se: params.strokeEnabled,
    sw: params.strokeWidth,
    sc: params.strokeColor,
    sj: params.strokeJoin,
    // Text box + wrap — box edits and the wrap toggle re-rasterize.
    bw: params.boxWidth,
    bh: params.boxHeight,
    w: params.wrap,
    // Variable-font axes — included so a slider drag re-rasterizes.
    v: params.font_variations,
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
  const tex = makeTex(gl);
  // Attach the rasterCanvas to the DOM (off-screen + hidden) so the
  // browser actually computes its style. Detached canvases don't get
  // styles resolved, which means setting
  // `canvas.style.fontVariationSettings` would silently no-op when
  // canvas2d's font property tries to inherit from the element. With
  // the canvas in the document the computed style is real and
  // canvas2d's font resolver (Chromium + recent Firefox) reads
  // font-variation-settings out of it for variable-font axes.
  const rasterCanvas = document.createElement("canvas");
  rasterCanvas.setAttribute("data-toolbox-text-raster", "1");
  rasterCanvas.style.position = "fixed";
  rasterCanvas.style.left = "-99999px";
  rasterCanvas.style.top = "-99999px";
  rasterCanvas.style.pointerEvents = "none";
  rasterCanvas.style.visibility = "hidden";
  if (typeof document !== "undefined") {
    document.body.appendChild(rasterCanvas);
  }
  const state: TextState = {
    rasterCanvas,
    rasterTex: tex,
    fillCovTex: null,
    strokeLayerTex: null,
    zeroTex: null,
    composite: null,
    maskReadCanvas: null,
    primary: ctx.allocImage(),
    sdf: ctx.allocMask(),
    spline: { kind: "spline", subpaths: [] },
    lastSig: null,
    lastPostSig: null,
    lastW: ctx.width,
    lastH: ctx.height,
    sdfValid: false,
    splineValid: false,
  };
  ctx.state[key] = state;
  return state;
}

// Blit the mask image to a CPU-readable 2D canvas at the
// rasterizer's native resolution, then pull the pixel buffer.
// Returns an ImageData for direct (x, y) sampling, or null if
// the mask isn't usable. Allocates the readback canvas lazily on
// the state so we don't churn one per frame.
function readMaskImageData(
  ctx: RenderContext,
  state: TextState,
  mask: ImageValue,
  W: number,
  H: number
): ImageData | null {
  if (!state.maskReadCanvas) {
    state.maskReadCanvas = document.createElement("canvas");
  }
  const c = state.maskReadCanvas;
  if (c.width !== W) c.width = W;
  if (c.height !== H) c.height = H;
  try {
    ctx.blitToCanvas(mask, c);
    const c2d = c.getContext("2d");
    if (!c2d) return null;
    return c2d.getImageData(0, 0, W, H);
  } catch {
    return null;
  }
}

function resizeStateIfNeeded(ctx: RenderContext, state: TextState): void {
  if (state.lastW === ctx.width && state.lastH === ctx.height) return;
  ctx.releaseTexture(state.primary.texture);
  ctx.releaseTexture(state.sdf.texture);
  state.primary = ctx.allocImage();
  state.sdf = ctx.allocMask();
  // The image-fill composite target is canvas-sized; drop it so it re-allocs
  // at the new size. The coverage/stroke layer textures are re-uploaded at
  // the new size on the forced re-raster below.
  if (state.composite) {
    ctx.releaseTexture(state.composite.texture);
    state.composite = null;
  }
  state.lastW = ctx.width;
  state.lastH = ctx.height;
  // Force re-rasterize + retransform since the target grew/shrunk.
  state.lastSig = null;
  state.lastPostSig = null;
}

// Case transform applied to the raw text before layout/wrap so measure,
// wrap, and draw all agree. "title" uppercases the first letter of each
// whitespace-delimited word (Unicode-aware), preserving newlines.
function applyTextCase(text: string, mode: string | undefined): string {
  switch (mode) {
    case "upper":
      return text.toUpperCase();
    case "lower":
      return text.toLowerCase();
    case "title":
      return text
        .toLowerCase()
        .replace(/(^|\s)(\p{L})/gu, (_m, lead, ch) => lead + ch.toUpperCase());
    default:
      return text;
  }
}

// Build the gradient/solid fill descriptor. The `fillStops` param is a
// ColorRampStop[] (id + position + color + alpha?), a structural superset
// of TextGradientStop — passed straight through.
function fillFromParams(params: Record<string, unknown>): TextFill {
  const mode = (params.fillMode as string) ?? "solid";
  if (mode !== "linear" && mode !== "radial") return { mode: "solid" };
  const stops = (Array.isArray(params.fillStops)
    ? params.fillStops
    : []) as TextGradientStop[];
  if (mode === "radial") return { mode: "radial", stops };
  return { mode: "linear", stops, angle: (params.gradientAngle as number) ?? 0 };
}

function strokeFromParams(params: Record<string, unknown>): TextStroke | null {
  if (params.strokeEnabled !== true) return null;
  const width = (params.strokeWidth as number) ?? 0;
  if (width <= 0) return null;
  return {
    width,
    color: (params.strokeColor as string) ?? "#000000",
    join: ((params.strokeJoin as string) ?? "round") as CanvasLineJoin,
  };
}

// Resolve the node's params into the shared text-raster style. The
// variable-font styling paths (canvas CSS + font shorthand + fontStretch)
// live in engine/text-raster.ts now — see the comments there.
function styleFromParams(
  params: Record<string, unknown>,
  family: string
): TextStyle {
  const customFont = params.custom_font as FontParamValue | null | undefined;
  return {
    text: applyTextCase((params.text as string) ?? "", params.textCase as string),
    family,
    size: (params.font_size as number) ?? 64,
    color: (params.color as string) ?? "#ffffff",
    alignment: ((params.alignment as string) ?? "center") as
      | "left"
      | "center"
      | "right",
    vAlign: ((params.vAlign as string) ?? "middle") as VAlign,
    leading: (params.leading as number) ?? 1.2,
    letterSpacing: (params.letter_spacing as number) ?? 0,
    weight: (params.font_weight as number) ?? 400,
    italic: params.italic === true,
    fill: fillFromParams(params),
    stroke: strokeFromParams(params),
    fontAxes: customFont?.axes,
    axesDict: asAxisDict(params.font_variations),
  };
}

// Lay out + draw one styled text block onto the node's raster canvas and
// upload it to `targetTex`. Shared by the primary raster and the image-fill
// coverage/stroke layers (each passes a style override). The box model
// (centered boxWidth/boxHeight rect) is identical across layers so the
// coverage and stroke register exactly.
function renderTextLayer(
  ctx: RenderContext,
  state: TextState,
  params: Record<string, unknown>,
  style: TextStyle,
  maskData: ImageData | null,
  targetTex: WebGLTexture
): void {
  const W = ctx.width;
  const H = ctx.height;
  const canvas = state.rasterCanvas;
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const c2d = canvas.getContext("2d");
  if (!c2d) return;
  c2d.clearRect(0, 0, W, H);

  // Text box: a rect centered on the canvas (boxWidth/boxHeight are
  // fractions of the canvas dims; both default 1 = full canvas, which
  // reproduces the pre-box rendering exactly). Alignment is within the
  // box; the wrap toggle word-wraps lines at the box width. The node's
  // transform post-pass then places the box on the canvas, so the
  // gizmo's box position rides translateX/translateY.
  const boxW = Math.max(1, Math.min(2, (params.boxWidth as number) ?? 1) * W);
  const boxH = Math.max(1, Math.min(2, (params.boxHeight as number) ?? 1) * H);
  const originX = W / 2 - boxW / 2;
  const originY = H / 2 - boxH / 2;
  const wrap = params.wrap === true;
  const lines = wrapStyledLines(canvas, c2d, style, wrap ? boxW : undefined);
  drawTextBlock(canvas, c2d, style, lines, boxW, boxH, maskData, originX, originY);

  const gl = ctx.gl;
  gl.bindTexture(gl.TEXTURE_2D, targetTex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

function rasterize(
  ctx: RenderContext,
  state: TextState,
  params: Record<string, unknown>,
  family: string,
  // Pre-blitted mask pixels — when present, the per-char layout
  // samples the mask at each character's centre so maskDriven axes
  // can interpolate between their endpoints. Null when no mask is
  // wired (or no axis is in maskDriven mode).
  maskData: ImageData | null = null
): void {
  // Single-pass canvas2d render for all (non-image-fill) modes — the
  // mask-driven mode samples per char, not per pixel.
  const style = styleFromParams(params, family);
  renderTextLayer(ctx, state, params, style, maskData, state.rasterTex);
}

// Box rect (canvas UV, Y-up) + per-axis sample scale for the image-fill
// contain/cover modes. The box is centered, so the Y-up conversion is
// symmetric (no flip needed). `null` for window mode.
function textFitUniforms(
  params: Record<string, unknown>,
  W: number,
  H: number,
  fit: "window" | "contain" | "cover"
): { uvMin: [number, number]; uvSize: [number, number]; fitScale: [number, number] } | null {
  if (fit === "window") return null;
  const bwf = Math.max(0.01, Math.min(2, (params.boxWidth as number) ?? 1));
  const bhf = Math.max(0.01, Math.min(2, (params.boxHeight as number) ?? 1));
  const aImg = W / H;
  const aBox = (bwf * W) / (bhf * H);
  let sx = 1;
  let sy = 1;
  if (fit === "contain") {
    if (aBox > aImg) sx = aBox / aImg;
    else sy = aImg / aBox;
  } else {
    if (aBox > aImg) sy = aImg / aBox;
    else sx = aBox / aImg;
  }
  return {
    uvMin: [0.5 - bwf / 2, 0.5 - bhf / 2],
    uvSize: [bwf, bhf],
    fitScale: [sx, sy],
  };
}

// Composite the wired fill image through the glyph coverage (+ stroke layer)
// into `state.composite`, returning its texture for the transform pass. The
// coverage/stroke layers are assumed up to date (rendered on rasterChanged).
function compositeImageFill(
  ctx: RenderContext,
  state: TextState,
  params: Record<string, unknown>,
  fillImg: ImageValue
): WebGLTexture {
  const gl = ctx.gl;
  if (!state.composite) state.composite = ctx.allocImage();
  if (!state.zeroTex) {
    state.zeroTex = makeTex(gl);
    gl.bindTexture(gl.TEXTURE_2D, state.zeroTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0])
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  const fit = ((params.fill_fit as string) ?? "window") as
    | "window"
    | "contain"
    | "cover";
  const fitU = textFitUniforms(params, ctx.width, ctx.height, fit);
  const hasStroke = params.strokeEnabled === true && state.strokeLayerTex;

  const prog = ctx.getShader("text/composite", TEXT_COMPOSITE_FS);
  ctx.drawFullscreen(prog, state.composite, (g) => {
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, state.fillCovTex ?? state.zeroTex);
    g.uniform1i(g.getUniformLocation(prog, "u_cov"), 0);

    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_2D, hasStroke ? state.strokeLayerTex! : state.zeroTex!);
    g.uniform1i(g.getUniformLocation(prog, "u_stroke"), 1);

    g.activeTexture(g.TEXTURE2);
    g.bindTexture(g.TEXTURE_2D, fillImg.texture);
    g.uniform1i(g.getUniformLocation(prog, "u_fillImage"), 2);

    g.uniform1i(g.getUniformLocation(prog, "u_hasStroke"), hasStroke ? 1 : 0);
    g.uniform1i(
      g.getUniformLocation(prog, "u_fit"),
      fitU ? (fit === "contain" ? 1 : 2) : 0
    );
    g.uniform2f(
      g.getUniformLocation(prog, "u_uvMin"),
      fitU ? fitU.uvMin[0] : 0,
      fitU ? fitU.uvMin[1] : 0
    );
    g.uniform2f(
      g.getUniformLocation(prog, "u_uvSize"),
      fitU ? fitU.uvSize[0] : 1,
      fitU ? fitU.uvSize[1] : 1
    );
    g.uniform2f(
      g.getUniformLocation(prog, "u_fitScale"),
      fitU ? fitU.fitScale[0] : 1,
      fitU ? fitU.fitScale[1] : 1
    );
  });
  return state.composite.texture;
}

function applyTransform(
  ctx: RenderContext,
  state: TextState,
  params: Record<string, unknown>,
  // Source raster to transform into `state.primary`. The default rasterTex is
  // a row-0-top canvas upload (needs the Y-flip variant); the image-fill
  // composite is a standard pooled image (no flip).
  srcTex: WebGLTexture = state.rasterTex,
  flip = true
): void {
  const translateX = (params.translateX as number) ?? 0;
  const translateY = (params.translateY as number) ?? 0;
  const scaleX = Math.max(0.0001, (params.scaleX as number) ?? 1);
  const scaleY = Math.max(0.0001, (params.scaleY as number) ?? 1);
  const rotate = (params.rotate as number) ?? 0;
  const pivotX = (params.pivotX as number) ?? 0.5;
  const pivotY = (params.pivotY as number) ?? 0.5;
  const angle = (rotate * Math.PI) / 180;

  const prog = flip
    ? ctx.getShader("text/transform", TEXT_TRANSFORM_FS)
    : ctx.getShader("text/transform-noflip", TEXT_TRANSFORM_NOFLIP_FS);
  ctx.drawFullscreen(prog, state.primary, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
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
  // On-canvas manipulation is the bounds gizmo (PRIMITIVE_GIZMO_ADAPTERS
  // "text" entry): drag the box, resize edges/corners with the opposite
  // side anchored. The legacy symmetric transform gizmo is off.
  inputs: [
    // Optional mask image — consumed only when at least one axis
    // is in maskMorph mode. The rasterizer renders the text twice
    // (axis endpoints A and B) and the GPU blend pass mixes
    // per-pixel using mask.r. Wire any image-producing node (SDF
    // Rasterize, Image Source, Gradient, etc.) in here.
    { name: "mask", label: "Mask", type: "image", required: false },
    // Optional fill image — when wired and fillMode is "image", the glyph
    // interiors are filled with this image (per `fill_fit`) instead of a
    // flat color. Declared `image`, so mask/element coercions apply.
    { name: "fill", label: "fill", type: "image", required: false },
  ],
  params: [
    OPACITY_PARAM,
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
      // Variable-font axis values, keyed by 4-char OpenType tag
      // (e.g. { wght: 700, wdth: 80 }). The slider list is
      // rendered dynamically by ParamPanel based on the uploaded
      // custom_font's `.axes`. Empty / missing keys fall back to
      // each axis's declared default at render time.
      name: "font_variations",
      label: "Variable axes",
      type: "font_variations",
      default: {},
      visibleIf: (p) => {
        const f = p.custom_font as FontParamValue | null | undefined;
        return !!(f?.axes && f.axes.length > 0);
      },
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
    // Base weight applies to any font (the Google CDN ships the full
    // wght@100..900 range, so built-in families interpolate too). A
    // modulated `wght` variable axis overrides this per glyph.
    {
      name: "font_weight",
      label: "Weight",
      type: "scalar",
      min: 100,
      max: 900,
      step: 1,
      default: 400,
    },
    {
      name: "italic",
      label: "Italic",
      type: "boolean",
      default: false,
    },
    {
      name: "color",
      label: "Color",
      type: "color",
      default: "#ffffff",
    },
    // Fill mode — solid uses `color`; the gradient modes span the whole
    // text box through a color ramp.
    {
      name: "fillMode",
      label: "Fill",
      type: "enum",
      options: ["solid", "linear", "radial", "image"],
      default: "solid",
    },
    // How a wired `fill` image maps into the glyphs. `window` reveals the
    // full-canvas image through the letters; `contain`/`cover` fit the image
    // into the text box. Only meaningful in `image` fill mode with the `fill`
    // socket wired (otherwise the glyphs fall back to the flat `color`).
    {
      name: "fill_fit",
      label: "Image fit",
      type: "enum",
      options: ["window", "contain", "cover"],
      default: "window",
      visibleIf: (p) => p.fillMode === "image",
    },
    {
      name: "fillStops",
      label: "Gradient",
      type: "color_ramp",
      default: [
        { id: "stop-a", position: 0, color: "#ffffff" },
        { id: "stop-b", position: 1, color: "#3b82f6" },
      ],
      visibleIf: (p) => p.fillMode === "linear" || p.fillMode === "radial",
    },
    {
      name: "gradientAngle",
      label: "Gradient angle",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      visibleIf: (p) => p.fillMode === "linear",
    },
    // In-raster outline (the spline Stroke node still handles vector strokes).
    {
      name: "strokeEnabled",
      label: "Stroke",
      type: "boolean",
      default: false,
    },
    {
      name: "strokeWidth",
      label: "Stroke width",
      type: "scalar",
      min: 0,
      max: 50,
      softMax: 20,
      step: 0.5,
      default: 2,
      visibleIf: (p) => p.strokeEnabled === true,
    },
    {
      name: "strokeColor",
      label: "Stroke color",
      type: "color",
      default: "#000000",
      visibleIf: (p) => p.strokeEnabled === true,
    },
    {
      name: "strokeJoin",
      label: "Stroke join",
      type: "enum",
      options: ["round", "miter", "bevel"],
      default: "round",
      visibleIf: (p) => p.strokeEnabled === true,
    },
    {
      name: "alignment",
      label: "Align",
      type: "enum",
      options: ["left", "center", "right"],
      default: "center",
    },
    {
      name: "vAlign",
      label: "Vertical align",
      type: "enum",
      options: ["top", "middle", "bottom"],
      default: "middle",
    },
    {
      name: "textCase",
      label: "Case",
      type: "enum",
      options: ["none", "upper", "lower", "title"],
      default: "none",
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
    // Text box — a rect the text is laid out inside (alignment is
    // box-relative; vertical centering is within the box). Sizes are
    // fractions of the canvas dims; 1 × 1 = full canvas reproduces the
    // pre-box rendering, so old saves are unchanged. The on-canvas
    // gizmo drags edges/corners with the opposite side anchored.
    {
      name: "boxWidth",
      label: "Box width",
      type: "scalar",
      min: 0.01,
      max: 2,
      softMax: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "boxHeight",
      label: "Box height",
      type: "scalar",
      min: 0.01,
      max: 2,
      softMax: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "wrap",
      label: "Wrap in box",
      type: "boolean",
      default: false,
    },
    // Built-in transform — applied as a post-pass after the box layout.
    // The bounds gizmo drives translateX/Y (box position); scale /
    // rotate / pivot stay panel-and-keyframe-driven.
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
    {
      name: "element",
      type: "element",
      description:
        "The text as an intrinsically-sized element for Auto Layout. Measures to tight line bounds and word-wraps when the layout constrains its width (a fill-width slot in a vertical layout reflows live). The node's built-in transform params do NOT apply here — the layout owns placement.",
    },
  ],

  compute({ inputs, params, ctx, nodeId, consumedOutputs }) {
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
      state.sdfValid = false;
      state.splineValid = false;
      state.spline = { kind: "spline", subpaths: [] };
      return {
        primary: state.primary,
        aux: { sdf: emptySdf(), spline: state.spline, element: emptyElement() },
      };
    }

    // Mask-driven dispatch. When any axis is in `maskDriven` mode
    // we read the mask socket back to CPU once and sample it per
    // character during the per-char layout. The mask's texture
    // identity goes into the sig so wiring / unwiring the socket
    // reliably re-renders.
    const axesDict = asAxisDict(params.font_variations);
    const maskMode = hasMaskDriven(axesDict);
    const maskIn = inputs.mask;
    const maskImg =
      maskIn && maskIn.kind === "image" ? maskIn : null;
    const maskSigKey = maskMode
      ? `mask:${maskImg ? "wired" : "unwired"}`
      : "no-mask";

    // Image fill: fillMode "image" + a wired `fill` socket fills the glyphs
    // with that image. Unwired (or another mode) falls back to the normal
    // raster (the flat `color`). The active flag goes in the sig so toggling
    // it re-renders the (different) raster layers.
    const fillIn = inputs.fill;
    const fillImg = fillIn && fillIn.kind === "image" ? fillIn : null;
    const imageFillActive = (params.fillMode as string) === "image" && !!fillImg;

    const sig =
      computeRasterSig(params, family, ctx.width, ctx.height) +
      "|" +
      maskSigKey +
      "|imgfill:" +
      (imageFillActive ? "1" : "0");
    const postSig = computePostSig(params);

    // Force re-rasterize every frame when maskDriven is in play
    // AND the socket is actually wired. The mask's TEXTURE
    // identity is stable across frames (the engine reuses
    // pooled textures), so we can't detect content changes from
    // it — and we DO want content changes to drive a re-render
    // when the user wires, say, the Cursor node into the mask.
    // The text node already declares stable: false so compute
    // re-enters on every pipeline bump; bypassing the sig cache
    // here is what actually makes the mask sampling live.
    const liveMask = maskMode && !!maskImg;
    const rasterChanged = liveMask || sig !== state.lastSig;
    const postChanged = postSig !== state.lastPostSig;

    if (rasterChanged) {
      // Read mask back once per rasterize. Skip when no axis needs
      // it, or when the socket is unwired (resolver falls back to
      // each maskDriven axis's `a` endpoint in that case).
      const maskData =
        maskMode && maskImg
          ? readMaskImageData(ctx, state, maskImg, ctx.width, ctx.height)
          : null;
      if (imageFillActive) {
        // Two layers: glyph fill coverage (solid white, no stroke) and the
        // in-raster stroke in its own color. Composited with the image below.
        const gl = ctx.gl;
        if (!state.fillCovTex) state.fillCovTex = makeTex(gl);
        const baseStyle = styleFromParams(params, family);
        renderTextLayer(
          ctx,
          state,
          params,
          { ...baseStyle, fill: { mode: "solid" }, color: "#ffffff", stroke: null },
          maskData,
          state.fillCovTex
        );
        const strokeOnly = strokeFromParams(params);
        if (strokeOnly) {
          if (!state.strokeLayerTex) state.strokeLayerTex = makeTex(gl);
          renderTextLayer(
            ctx,
            state,
            params,
            {
              ...baseStyle,
              fill: { mode: "solid" },
              color: "rgba(0,0,0,0)",
              stroke: strokeOnly,
            },
            maskData,
            state.strokeLayerTex
          );
        }
      } else {
        rasterize(ctx, state, params, family, maskData);
      }
      state.lastSig = sig;
      // Raster moved → cached sdf/spline are stale.
      state.sdfValid = false;
      state.splineValid = false;
    }
    // Image fill re-composites every eval (the wired image may have changed
    // even when the glyph layers did not); the flat path only re-transforms
    // when the raster or transform params moved.
    if (imageFillActive) {
      const compTex = compositeImageFill(ctx, state, params, fillImg!);
      applyTransform(ctx, state, params, compTex, false);
      state.lastPostSig = postSig;
      state.sdfValid = false;
      state.splineValid = false;
    } else if (rasterChanged || postChanged) {
      applyTransform(ctx, state, params, state.rasterTex, true);
      state.lastPostSig = postSig;
      // Transform moved the glyphs → cached sdf/spline are stale.
      state.sdfValid = false;
      state.splineValid = false;
    }

    // The two costly aux outputs — the JFA SDF (GPU) and the marching-
    // squares spline outline (a full-canvas readback + contour trace) —
    // are the bulk of this node's per-frame cost. Build them lazily, only
    // when something actually consumes that output, and only when the
    // cache is stale. This is what keeps dragging text smooth: text →
    // Output / Auto Layout never touches either. `consumedOutputs`
    // undefined (non-evaluator caller) ⇒ behave as before and build both.
    const wantSdf = !consumedOutputs || consumedOutputs.has("aux:sdf");
    const wantSpline = !consumedOutputs || consumedOutputs.has("aux:spline");
    if (wantSdf && !state.sdfValid) {
      // Released/reallocated so downstream gets a fresh MaskValue.
      ctx.releaseTexture(state.sdf.texture);
      state.sdf = computeSDF(ctx, state.primary, 128);
      state.sdfValid = true;
    }
    if (wantSpline && !state.splineValid) {
      // Marching squares on the raster's alpha channel (opaque inside,
      // transparent outside; iso 0.5 = the glyph edge).
      state.spline = extractTextSpline(ctx, state.primary);
      state.splineValid = true;
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

    // Auto Layout element. Measure wraps + measures to tight line bounds
    // through the shared text-raster core; render rasterizes at exactly
    // the granted rect (wrap width = rect width) into a caller-owned
    // texture. Reuses the node's DOM-attached rasterCanvas — required
    // for variable-font axis styling to resolve; safe to clobber because
    // the primary raster was already uploaded to rasterTex, and the sig
    // path re-rasterizes whenever the primary actually changes.
    // maskDriven axis modulation is primary-only (mask coords are canvas
    // space, which doesn't exist inside a layout rect).
    const style = styleFromParams(params, family);
    const element: ElementValue = {
      kind: "element",
      measure(constraints) {
        const canvas = state.rasterCanvas;
        const c2d = canvas.getContext("2d");
        if (!c2d) return { width: 0, height: 0 };
        const lines = wrapStyledLines(canvas, c2d, style, constraints.maxWidth);
        const m = measureStyledBlock(canvas, c2d, style, lines);
        return { width: Math.ceil(m.width), height: Math.ceil(m.height) };
      },
      render(rctx, width, height) {
        const canvas = state.rasterCanvas;
        const w = Math.max(1, Math.round(width));
        const h = Math.max(1, Math.round(height));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        const c2d = canvas.getContext("2d");
        if (!c2d) {
          const out = rctx.allocImage({ width: w, height: h });
          rctx.clearTarget(out, [0, 0, 0, 0]);
          return out;
        }
        c2d.clearRect(0, 0, w, h);
        const lines = wrapStyledLines(canvas, c2d, style, w);
        drawTextBlock(canvas, c2d, style, lines, w, h, null);
        return uploadCanvasToImage(rctx, canvas);
      },
      preferredSizing: { width: "hug", height: "hug" },
    };

    return {
      primary: state.primary,
      aux: { sdf: sdfOut, spline: state.spline, element },
    };
  },

  dispose(ctx, nodeId) {
    const state = ctx.state[`text:${nodeId}`] as TextState | undefined;
    if (!state) return;
    ctx.releaseTexture(state.primary.texture);
    ctx.releaseTexture(state.sdf.texture);
    if (state.composite) ctx.releaseTexture(state.composite.texture);
    ctx.gl.deleteTexture(state.rasterTex);
    if (state.fillCovTex) ctx.gl.deleteTexture(state.fillCovTex);
    if (state.strokeLayerTex) ctx.gl.deleteTexture(state.strokeLayerTex);
    if (state.zeroTex) ctx.gl.deleteTexture(state.zeroTex);
    if (state.rasterCanvas.parentNode) {
      state.rasterCanvas.parentNode.removeChild(state.rasterCanvas);
    }
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
