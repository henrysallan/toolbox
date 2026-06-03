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
import {
  asAxisDict,
  hasMaskDriven,
  isAxisDictAllConstant,
  resolveAxisAt,
  type AxisInput,
} from "@/lib/font-axis";

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
    // Variable-font axes — included so a slider drag re-rasterizes.
    v: params.font_variations,
    W,
    H,
  });
}

// Build the CSS `font-variation-settings` string from a resolved
// `Record<tag, number>`. The rasterizer calls resolveAxisAt once
// per char to populate that record, then this helper emits the CSS
// string that goes onto the rasterCanvas's style attribute.
function buildVariationsCss(
  resolved: Record<string, number>,
  axes: { tag: string }[] | undefined
): string {
  if (!axes || axes.length === 0) return "";
  const parts: string[] = [];
  for (const a of axes) {
    const v = resolved[a.tag];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    parts.push(`'${a.tag}' ${v}`);
  }
  return parts.join(", ");
}

// Apply all variation-styling paths (canvas CSS, font shorthand,
// fontStretch) for the axis values resolved at position `t`
// (normalised across the line) and `charIndex` (absolute char
// index). `axesDict` is the user's per-axis modulation config;
// fontAxes is the font's declared axis list (tags + ranges).
function applyAxisStyling(
  canvas: HTMLCanvasElement,
  c2d: CanvasRenderingContext2D,
  fontAxes: { tag: string }[] | undefined,
  axesDict: Record<string, AxisInput>,
  t: number,
  charIndex: number,
  family: string,
  size: number,
  // `maskValue` is forwarded to resolveAxisAt so the maskDriven
  // mode can interpolate its endpoints. Other modes ignore it.
  maskValue: number | null = null
) {
  // Resolve every axis at this character.
  const resolved: Record<string, number> = {};
  if (fontAxes) {
    for (const a of fontAxes) {
      const v = resolveAxisAt(axesDict[a.tag], t, charIndex, maskValue);
      if (v != null && Number.isFinite(v)) resolved[a.tag] = v;
    }
  }

  // CSS path — feeds Chromium's canvas-style inheritance.
  canvas.style.fontVariationSettings = buildVariationsCss(
    resolved,
    fontAxes
  );

  // Pull out wght / wdth / ital for the first-class canvas2d API
  // fallback. These are the standard axes for which canvas2d has
  // dedicated paths regardless of style inheritance.
  const wght = resolved.wght;
  const wdth = resolved.wdth;
  const isItalic =
    typeof resolved.ital === "number" && resolved.ital >= 0.5;
  const styleSlot = isItalic ? "italic " : "";
  const weightSlot =
    typeof wght === "number" && Number.isFinite(wght)
      ? `${Math.round(wght)} `
      : "";
  c2d.font = `${styleSlot}${weightSlot}${size}px "${family}", sans-serif`;
  if (typeof wdth === "number" && Number.isFinite(wdth)) {
    try {
      (c2d as unknown as { fontStretch?: string }).fontStretch =
        `${wdth}%`;
    } catch {
      // Older canvas2d — ignore.
    }
  } else {
    try {
      (c2d as unknown as { fontStretch?: string }).fontStretch =
        "normal";
    } catch {
      // ignore
    }
  }
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
    maskReadCanvas: null,
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

// Sample the mask's R channel at (x, y) pixels. Clamps to the
// canvas bounds and returns a [0, 1] luminance. The mask image is
// blitToCanvas'd in engine-standard Y-up orientation, so its
// row 0 is the visual bottom — we flip Y to match canvas2d's
// Y-down convention (where the text is drawn).
function sampleMask(
  maskData: ImageData,
  x: number,
  y: number,
  W: number,
  H: number
): number {
  if (W === 0 || H === 0) return 0;
  const ix = Math.max(0, Math.min(maskData.width - 1, Math.round(x)));
  // Flip Y: text draws with row 0 at canvas top; the blitted mask
  // also lands row 0 at top from canvas2d's POV (drawImage flips
  // FBO orientation back to top-down). If your mask looks
  // upside-down in practice, swap this `iy` to use H - 1 - y.
  const iy = Math.max(0, Math.min(maskData.height - 1, Math.round(y)));
  const idx = (iy * maskData.width + ix) * 4;
  return maskData.data[idx] / 255;
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
  family: string,
  // Pre-blitted mask pixels — when present, the per-char layout
  // samples the mask at each character's centre and passes the
  // resulting [0, 1] luminance into applyAxisStyling so maskDriven
  // axes can interpolate between their endpoints. Null when no
  // mask is wired (or no axis is in maskDriven mode).
  maskData: ImageData | null = null
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

  // Variable-font axes — applied via TWO redundant paths:
  //   1. `canvas.style.fontVariationSettings` — canvas needs to be
  //      in the DOM (we attach it in ensureState) for the browser
  //      to actually compute this. Chromium then reads it from the
  //      canvas's computed style during canvas2d font resolution,
  //      which is what carries all axes (including custom GRAD /
  //      XHGT / etc.) through.
  //   2. `wght` is also baked into the font shorthand and `wdth`
  //      into `c2d.fontStretch`. These are first-class canvas2d
  //      APIs and don't depend on CSS resolution at all, so even
  //      browsers that ignore the style attribute still get the
  //      most-common axes right.
  const customFont = params.custom_font as FontParamValue | null | undefined;
  const axesDict = asAxisDict(params.font_variations);
  const allConstant = isAxisDictAllConstant(axesDict);

  c2d.save();
  c2d.fillStyle = color;
  c2d.textBaseline = "middle";

  const lines = text.split("\n");
  const lineHeight = size * leading;
  const totalHeight = Math.max(1, lines.length) * lineHeight;
  const startY = H / 2 - totalHeight / 2 + lineHeight / 2;

  if (allConstant) {
    // FAST PATH — single fillText per line. All axes have the same
    // value across every character, so we set styling once and let
    // canvas2d's native text layout (kerning, letter-spacing) do
    // the work.
    // Fast path: every axis is constant. maskDriven counts as
    // modulated (isAxisDictAllConstant excludes it), so we never
    // reach here with a maskData payload — pass null and let the
    // resolver use its constant value.
    applyAxisStyling(
      canvas,
      c2d,
      customFont?.axes,
      axesDict,
      0,
      0,
      family,
      size,
      null
    );
    c2d.textAlign = alignment;
    (c2d as unknown as { letterSpacing?: string }).letterSpacing =
      `${letterSpacing}px`;
    const x =
      alignment === "left" ? 0 : alignment === "right" ? W : W / 2;
    for (let i = 0; i < lines.length; i++) {
      c2d.fillText(lines[i], x, startY + i * lineHeight);
    }
  } else {
    // MODULATED PATH — per-character layout. For each character we
    // resolve every axis at its position, restyle, measure, and
    // draw. textAlign stays "left" because we manage horizontal
    // alignment ourselves (we need exact advance accumulation,
    // which textAlign can't do mid-string).
    c2d.textAlign = "left";
    (c2d as unknown as { letterSpacing?: string }).letterSpacing = "0px";
    // For each line, two passes: measure total width (to handle
    // center/right alignment), then draw at the right starting x.
    // The line-total measure pre-applies the median axis values so
    // alignment is roughly right even when axes swing wildly; the
    // per-char draw pass then restyles for each glyph.
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const chars = Array.from(line); // codepoint-safe split
      const total = chars.length;
      const y = startY + li * lineHeight;
      // Pre-measure each char with its axis values applied so
      // alignment uses real advances rather than a single-shape
      // approximation. Mask sampling for the measure pass uses
      // a rough placeholder (W/2, y) — close enough; the draw
      // pass below re-samples at the actual glyph centre.
      const advances: number[] = [];
      let lineWidth = 0;
      for (let i = 0; i < total; i++) {
        const t = total <= 1 ? 0 : i / (total - 1);
        const mPre = maskData
          ? sampleMask(maskData, W / 2, y, W, H)
          : null;
        applyAxisStyling(
          canvas,
          c2d,
          customFont?.axes,
          axesDict,
          t,
          i,
          family,
          size,
          mPre
        );
        const adv = c2d.measureText(chars[i]).width;
        advances.push(adv);
        lineWidth += adv + letterSpacing;
      }
      lineWidth -= letterSpacing; // no trailing gap
      let cx =
        alignment === "left"
          ? 0
          : alignment === "right"
          ? W - lineWidth
          : (W - lineWidth) / 2;
      // Final draw pass — re-apply per-char styling and draw at cx.
      // measureText + fillText share the same active style so as
      // long as we restyle before each, the rendered glyph matches
      // the advance we measured. Mask sampling reads at the
      // glyph's CENTRE so a wide character is driven by its own
      // mid-region rather than its leading edge.
      for (let i = 0; i < total; i++) {
        const t = total <= 1 ? 0 : i / (total - 1);
        const cxCentre = cx + advances[i] / 2;
        const mVal = maskData
          ? sampleMask(maskData, cxCentre, y, W, H)
          : null;
        applyAxisStyling(
          canvas,
          c2d,
          customFont?.axes,
          axesDict,
          t,
          i,
          family,
          size,
          mVal
        );
        c2d.fillText(chars[i], cx, y);
        cx += advances[i] + letterSpacing;
      }
    }
  }
  c2d.restore();

  // Upload to the main rasterTex — single-pass canvas2d render
  // for all modes now (the mask-driven mode samples per char,
  // not per pixel, so we no longer need a parallel raster chain).
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
  inputs: [
    // Optional mask image — consumed only when at least one axis
    // is in maskMorph mode. The rasterizer renders the text twice
    // (axis endpoints A and B) and the GPU blend pass mixes
    // per-pixel using mask.r. Wire any image-producing node (SDF
    // Rasterize, Image Source, Gradient, etc.) in here.
    { name: "mask", label: "Mask", type: "image", required: false },
  ],
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

  compute({ inputs, params, ctx, nodeId }) {
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
    const sig =
      computeRasterSig(params, family, ctx.width, ctx.height) +
      "|" +
      maskSigKey;
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
      rasterize(ctx, state, params, family, maskData);
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
