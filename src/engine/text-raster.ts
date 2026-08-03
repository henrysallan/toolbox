// Text raster core — measure, line layout (with optional word-wrap), and
// canvas2d drawing — extracted from nodes/source/text.ts so the Text
// node's primary raster and its Auto Layout element share one engine.
//
// Two paths, mirroring the original rasterizer:
//   FAST     — every variable-font axis is constant: one fillText per
//              line, native canvas2d layout (kerning, letter-spacing).
//   MODULATED — at least one axis varies per character: per-char measure
//              + draw with axis styling resolved at each glyph.
//
// `maxWidth` (px) turns on greedy word-wrap on top of the always-honored
// explicit "\n" breaks. Unconstrained behavior is unchanged: no wrap.
// The modulated path makes wrap decisions on median-axis measures (t=0.5)
// — good enough, per spec; final line widths are measured per-char.
//
// The canvas passed in must be DOM-attached for variable-font axes to
// resolve (see the ensureState comment in text.ts).

import {
  isAxisDictAllConstant,
  resolveAxisAt,
  type AxisInput,
} from "@/lib/font-axis";
import {
  FIELD_PROPS,
  resolveGlyphAnim,
  resolveTrackingExtra,
  type AnimProp,
  type GlyphFields,
  type TextAnimators,
} from "@/engine/text-animators";
import { aspectCorrectY } from "@/engine/aspect";
import { measureSpline, sampleSplineAt } from "@/engine/spline-math";
import { uploadCanvasToImage } from "@/engine/element";
import type {
  ImageValue,
  RenderContext,
  SplineValue,
  TextInstanceValue,
} from "@/engine/types";

// Per-character animators + their field pixel buffers, threaded into the
// modulated draw path. Present (non-null) forces per-character layout even when
// every font axis is constant. Fields are sampled at each glyph's centre.
export interface TextDrawAnim {
  animators: TextAnimators;
  fields: Partial<Record<AnimProp, ImageData | null>>;
}

// Text-on-path layout. Present (non-null) lays every glyph along `path` — a
// spline in normalized [0,1]² Y-DOWN, mapped to canvas px — instead of the box
// baseline, and forces the modulated per-glyph draw regardless of font axes.
// `align`/`offset` position the run along the arc length; `side` shifts it
// perpendicular; `flip` reverses direction. See §4 of
// specdocs/062526_node-expansion.md.
export interface TextPathLayout {
  path: SplineValue;
  align: "start" | "center" | "end";
  offset: number; // 0..1 slide along the path
  side: "on" | "above" | "below";
  flip: boolean;
}

// One color stop of a text gradient fill. Structurally a subset of the
// Color Ramp node's ColorRampStop, so the Text node passes its `color_ramp`
// param value straight through with no conversion (and the engine keeps no
// dependency on the node layer).
export interface TextGradientStop {
  position: number; // 0..1
  color: string; // hex
  alpha?: number; // 0..1, undefined = opaque
}

// How the glyph interiors are filled. `solid` uses TextStyle.color; the
// gradient modes span the whole text BOX (areaW × areaH at the origin), per
// the owner's "whole-box gradient" decision.
export type TextFill =
  | { mode: "solid" }
  | { mode: "linear"; stops: TextGradientStop[]; angle: number }
  | { mode: "radial"; stops: TextGradientStop[] };

// In-raster outline drawn under the fill (the spline Stroke node still
// exists for vector strokes — this is the inline convenience).
export interface TextStroke {
  width: number; // px
  color: string;
  join: CanvasLineJoin;
}

export type VAlign = "top" | "middle" | "bottom";

export interface TextStyle {
  text: string;
  family: string;
  size: number;
  color: string;
  alignment: "left" | "center" | "right";
  // Vertical placement of the line block inside the box. Default "middle"
  // reproduces the pre-vAlign centered layout.
  vAlign?: VAlign;
  leading: number;
  letterSpacing: number;
  // Base font weight (CSS 1..1000) and italic slant applied to every glyph.
  // A `wght` / `ital` variation axis, when modulated, overrides these
  // per-character (see applyAxisStyling). Undefined → 400 / upright.
  weight?: number;
  italic?: boolean;
  // Optional gradient fill + outline. Undefined fill ⇒ solid `color`.
  fill?: TextFill;
  stroke?: TextStroke | null;
  // Variation axes declared by the font (tags), and the user's per-axis
  // modulation config. Empty/undefined for non-variable fonts.
  fontAxes?: { tag: string }[];
  axesDict: Record<string, AxisInput>;
}

export interface TextBlockMetrics {
  lines: string[];
  widths: number[]; // per-line px
  lineHeight: number;
  width: number; // max line width
  height: number; // lines.length * lineHeight
}

// Build the CSS `font-variation-settings` string from a resolved
// `Record<tag, number>`.
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
// fontStretch) for the axis values resolved at position `t` (normalised
// across the line) and `charIndex` (absolute char index). `maskValue` is
// forwarded to resolveAxisAt so the maskDriven mode can interpolate its
// endpoints; other modes ignore it.
export function applyAxisStyling(
  canvas: HTMLCanvasElement,
  c2d: CanvasRenderingContext2D,
  fontAxes: { tag: string }[] | undefined,
  axesDict: Record<string, AxisInput>,
  t: number,
  charIndex: number,
  family: string,
  size: number,
  maskValue: number | null = null,
  // Base weight/italic from the node params. A modulated wght/ital axis
  // overrides these per glyph; otherwise they set the whole-string style
  // (this is what gives built-in, non-variable fonts a weight control).
  baseWeight = 400,
  baseItalic = false
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
  canvas.style.fontVariationSettings = buildVariationsCss(resolved, fontAxes);

  // Pull out wght / wdth / ital for the first-class canvas2d API
  // fallback. These are the standard axes for which canvas2d has
  // dedicated paths regardless of style inheritance. The axis value (if
  // modulated) wins; otherwise fall back to the node's base weight/italic.
  const wght =
    typeof resolved.wght === "number" && Number.isFinite(resolved.wght)
      ? resolved.wght
      : baseWeight;
  const wdth = resolved.wdth;
  const isItalic =
    (typeof resolved.ital === "number" && resolved.ital >= 0.5) || baseItalic;
  const styleSlot = isItalic ? "italic " : "";
  const weightSlot =
    typeof wght === "number" && Number.isFinite(wght)
      ? `${Math.round(wght)} `
      : "";
  c2d.font = `${styleSlot}${weightSlot}${size}px "${family}", sans-serif`;
  if (typeof wdth === "number" && Number.isFinite(wdth)) {
    try {
      (c2d as unknown as { fontStretch?: string }).fontStretch = `${wdth}%`;
    } catch {
      // Older canvas2d — ignore.
    }
  } else {
    try {
      (c2d as unknown as { fontStretch?: string }).fontStretch = "normal";
    } catch {
      // ignore
    }
  }
}

function isStyleAllConstant(style: TextStyle): boolean {
  return isAxisDictAllConstant(style.axesDict);
}

// Set up the context for whole-string measurement: median axis values
// (t = 0.5) and the style's letter-spacing, so measureText reflects what
// fillText will produce (exactly on the fast path, approximately on the
// modulated one).
function applyMedianStyling(
  canvas: HTMLCanvasElement,
  c2d: CanvasRenderingContext2D,
  style: TextStyle
) {
  applyAxisStyling(
    canvas,
    c2d,
    style.fontAxes,
    style.axesDict,
    0.5,
    0,
    style.family,
    style.size,
    null,
    style.weight ?? 400,
    style.italic ?? false
  );
  (c2d as unknown as { letterSpacing?: string }).letterSpacing =
    `${style.letterSpacing}px`;
}

// Explicit "\n" breaks always apply; `maxWidth` adds greedy word-wrap
// (split on whitespace) on top. A single word longer than maxWidth stays
// on its own overflowing line — min-content semantics, no mid-word break.
export function wrapStyledLines(
  canvas: HTMLCanvasElement,
  c2d: CanvasRenderingContext2D,
  style: TextStyle,
  maxWidth?: number
): string[] {
  const rawLines = (style.text ?? "").split("\n");
  if (maxWidth == null || maxWidth <= 0) return rawLines;

  applyMedianStyling(canvas, c2d, style);
  const out: string[] = [];
  for (const raw of rawLines) {
    const words = raw.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (!current || c2d.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else {
        out.push(current);
        current = word;
      }
    }
    out.push(current);
  }
  return out;
}

// Measure already-wrapped lines to tight block bounds. The modulated
// path measures per character with its axis styling applied (matching
// the draw pass's advance accumulation); the fast path measures whole
// lines with native letter-spacing.
export function measureStyledBlock(
  canvas: HTMLCanvasElement,
  c2d: CanvasRenderingContext2D,
  style: TextStyle,
  lines: string[]
): TextBlockMetrics {
  const lineHeight = style.size * style.leading;
  const widths: number[] = [];
  if (isStyleAllConstant(style)) {
    applyMedianStyling(canvas, c2d, style);
    for (const line of lines) {
      widths.push(line ? c2d.measureText(line).width : 0);
    }
  } else {
    (c2d as unknown as { letterSpacing?: string }).letterSpacing = "0px";
    for (const line of lines) {
      const chars = Array.from(line);
      const total = chars.length;
      let w = 0;
      for (let i = 0; i < total; i++) {
        const t = total <= 1 ? 0 : i / (total - 1);
        applyAxisStyling(
          canvas,
          c2d,
          style.fontAxes,
          style.axesDict,
          t,
          i,
          style.family,
          style.size,
          null,
          style.weight ?? 400,
          style.italic ?? false
        );
        w += c2d.measureText(chars[i]).width + style.letterSpacing;
      }
      widths.push(Math.max(0, w - style.letterSpacing));
    }
  }
  const width = widths.reduce((a, b) => Math.max(a, b), 0);
  const height = Math.max(1, lines.length) * lineHeight;
  return { lines, widths, lineHeight, width, height };
}

// Sample a mask ImageData's R channel at (x, y) px, clamped. See text.ts
// for the orientation discussion.
export function sampleMask(
  maskData: ImageData,
  x: number,
  y: number,
  W: number,
  H: number
): number {
  if (W === 0 || H === 0) return 0;
  const ix = Math.max(0, Math.min(maskData.width - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(maskData.height - 1, Math.round(y)));
  const idx = (iy * maskData.width + ix) * 4;
  return maskData.data[idx] / 255;
}

// Convert a gradient stop to a canvas-acceptable CSS color, folding in the
// optional per-stop alpha. `#rgb`/`#rrggbb` + alpha → `rgba(...)`.
function stopToCss(stop: TextGradientStop): string {
  if (stop.alpha == null || stop.alpha >= 1) return stop.color;
  const h = stop.color.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return stop.color;
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, stop.alpha))})`;
}

// Resolve the glyph fill into a canvas fillStyle. Solid ⇒ the style color;
// gradient modes build a CanvasGradient spanning the whole text BOX
// (areaW × areaH at the origin). The linear gradient line is fitted to the
// box along `angle` (degrees, 0 = left→right) so it always fully covers it.
function resolveFillStyle(
  c2d: CanvasRenderingContext2D,
  style: TextStyle,
  originX: number,
  originY: number,
  areaW: number,
  areaH: number
): string | CanvasGradient {
  const fill = style.fill;
  if (!fill || fill.mode === "solid") return style.color;
  const stops = fill.stops;
  if (!stops || stops.length === 0) return style.color;

  const cx = originX + areaW / 2;
  const cy = originY + areaH / 2;
  const hx = areaW / 2;
  const hy = areaH / 2;
  let grad: CanvasGradient;
  if (fill.mode === "radial") {
    grad = c2d.createRadialGradient(
      cx,
      cy,
      0,
      cx,
      cy,
      Math.max(1, Math.hypot(hx, hy))
    );
  } else {
    const rad = ((fill.angle ?? 0) * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    // Half-extent of the box projected onto the gradient direction — the
    // gradient line runs ±half from the box centre, so it spans corner to
    // corner along any angle.
    const half = Math.abs(dx) * hx + Math.abs(dy) * hy;
    grad = c2d.createLinearGradient(
      cx - dx * half,
      cy - dy * half,
      cx + dx * half,
      cy + dy * half
    );
  }
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  for (const stop of sorted) {
    const pos = Math.max(0, Math.min(1, stop.position));
    grad.addColorStop(pos, stopToCss(stop));
  }
  return grad;
}

// Sample a spline into a canvas-pixel arc-length table for text-on-path. The
// spline is the authored square space (Y-DOWN), so each sample maps to
// canvas px through the same aspect correction every spline rasterizer
// applies (sx*W, aspectCorrectY(sy)*H — see engine/aspect.ts); the glyphs
// land exactly on the path as it renders/displays on non-square canvases.
// We accumulate PIXEL arc length: glyph advances — which are in px — map
// correctly to path positions, and the glyph rotation falls out directly
// with no tangent conversion. The subpaths concatenate into one continuous
// domain (same as sampleSplineAt), matching the spec's single arc-length
// domain.
interface PathSampler {
  totalPx: number;
  at(s: number): { x: number; y: number; angle: number };
}

function buildPathSampler(
  path: SplineValue,
  W: number,
  H: number,
  samples = 512
): PathSampler {
  const lengths = measureSpline(path);
  const xs: number[] = [];
  const ys: number[] = [];
  const cum: number[] = [0];
  const N = Math.max(2, samples);
  const aspect = W / H;
  for (let i = 0; i <= N; i++) {
    const r = sampleSplineAt(path, lengths, i / N);
    const x = r.pos[0] * W;
    const y = aspectCorrectY(r.pos[1], aspect) * H;
    xs.push(x);
    ys.push(y);
    if (i > 0) cum.push(cum[i - 1] + Math.hypot(x - xs[i - 1], y - ys[i - 1]));
  }
  const totalPx = cum[cum.length - 1];
  return {
    totalPx,
    at(sRaw: number) {
      const s = Math.max(0, Math.min(totalPx, sRaw));
      // Binary search the cumulative table for the segment containing s.
      let lo = 1;
      let hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < s) lo = mid + 1;
        else hi = mid;
      }
      const i1 = lo;
      const i0 = i1 - 1;
      const segLen = cum[i1] - cum[i0] || 1e-6;
      const f = (s - cum[i0]) / segLen;
      const x = xs[i0] + (xs[i1] - xs[i0]) * f;
      const y = ys[i0] + (ys[i1] - ys[i0]) * f;
      const angle = Math.atan2(ys[i1] - ys[i0], xs[i1] - xs[i0]);
      return { x, y, angle };
    },
  };
}

// Lay a single glyph run along `layout.path` (canvas-px space). Path text
// ignores wrapping / line breaks — all lines flatten into one run joined by
// spaces. Per glyph: advance-accumulate the arc-length position, sample the
// path point + tangent, draw the glyph centred and rotated to the tangent,
// shifted perpendicular by `side`. Animator glyph transforms (when `anim`)
// stack ON TOP of the path transform (per spec). Glyphs past either end clamp
// to the endpoint (sampleSplineAt/the px table both clamp) — AE-style
// "clamp-and-stop".
function drawGlyphsAlongPath(
  canvas: HTMLCanvasElement,
  c2d: CanvasRenderingContext2D,
  style: TextStyle,
  lines: string[],
  layout: TextPathLayout,
  maskData: ImageData | null,
  anim: TextDrawAnim | null,
  stroke: TextStroke | null
): void {
  const W = canvas.width;
  const H = canvas.height;
  const { size, letterSpacing } = style;
  const sampler = buildPathSampler(layout.path, W, H);
  const totalPx = sampler.totalPx;
  if (totalPx <= 0) return;

  const chars = Array.from(lines.join(" "));
  const total = chars.length;
  if (total === 0) return;

  c2d.textAlign = "left";
  (c2d as unknown as { letterSpacing?: string }).letterSpacing = "0px";

  const sampleFields = (x: number, y: number): GlyphFields => {
    const f: GlyphFields = {};
    if (!anim) return f;
    for (const p of FIELD_PROPS) {
      const d = anim.fields[p];
      if (d) f[p] = sampleMask(d, x, y, d.width, d.height);
    }
    return f;
  };

  // Pre-measure advances + tracking with per-glyph axis styling so the
  // along-path spacing matches the visible glyph widths.
  const advances: number[] = [];
  const tracks: number[] = [];
  let textWidth = 0;
  for (let i = 0; i < total; i++) {
    const t = total <= 1 ? 0 : i / (total - 1);
    applyAxisStyling(
      canvas, c2d, style.fontAxes, style.axesDict, t, i,
      style.family, size, null, style.weight ?? 400, style.italic ?? false
    );
    const adv = c2d.measureText(chars[i]).width;
    advances.push(adv);
    const trk = anim ? resolveTrackingExtra(anim.animators, i, total) : 0;
    tracks.push(trk);
    textWidth += adv + letterSpacing + trk;
  }
  // Trailing inter-glyph gap doesn't count toward the visible run width.
  textWidth -= letterSpacing + tracks[total - 1];

  // Start arc-length by align, then slide by `offset` (fraction of full path).
  let start =
    layout.align === "start"
      ? 0
      : layout.align === "end"
        ? totalPx - textWidth
        : (totalPx - textWidth) / 2;
  start += layout.offset * totalPx;

  // Perpendicular shift. Baseline is "middle", so "on" centres the glyph on
  // the path; above/below push it a half-em to either side.
  const sideShift =
    layout.side === "above" ? -size * 0.5 : layout.side === "below" ? size * 0.5 : 0;

  let cursor = start;
  for (let i = 0; i < total; i++) {
    const t = total <= 1 ? 0 : i / (total - 1);
    const adv = advances[i];
    const centre = cursor + adv / 2;
    // Flip reads from the far end and turns each glyph to face the new way.
    const s = layout.flip ? totalPx - centre : centre;
    const sample = sampler.at(s);
    const angle = layout.flip ? sample.angle + Math.PI : sample.angle;
    const mVal = maskData ? sampleMask(maskData, sample.x, sample.y, W, H) : null;
    applyAxisStyling(
      canvas, c2d, style.fontAxes, style.axesDict, t, i,
      style.family, size, mVal, style.weight ?? 400, style.italic ?? false
    );
    c2d.save();
    c2d.translate(sample.x, sample.y);
    c2d.rotate(angle);
    if (sideShift) c2d.translate(0, sideShift);
    if (anim) {
      const g = resolveGlyphAnim(
        anim.animators, i, total, sampleFields(sample.x, sample.y)
      );
      c2d.globalAlpha = Math.max(0, Math.min(1, g.alpha));
      if (g.color) c2d.fillStyle = g.color;
      c2d.translate(g.offsetX, g.offsetY);
      if (g.rotation) c2d.rotate(g.rotation);
      if (g.scale !== 1) c2d.scale(g.scale, g.scale);
    }
    // Draw centred on the path point (textAlign left ⇒ shift left by half adv).
    if (stroke) c2d.strokeText(chars[i], -adv / 2, 0);
    c2d.fillText(chars[i], -adv / 2, 0);
    c2d.restore();
    cursor += adv + letterSpacing + tracks[i];
  }
}

// Draw a block of (already wrapped) lines into the canvas, horizontally
// aligned across areaW and vertically aligned across areaH (style.vAlign),
// with the area's top-left at (originX, originY) — the box model. The caller owns
// canvas sizing and clearing. `maskData`, when present, drives maskDriven
// axes per glyph (modulated path only); it's sampled in absolute canvas
// coordinates, so origin offsets keep mask-driven styling aligned. When
// `pathLayout` is present, glyphs lay along its spline instead of the box.
export function drawTextBlock(
  canvas: HTMLCanvasElement,
  c2d: CanvasRenderingContext2D,
  style: TextStyle,
  lines: string[],
  areaW: number,
  areaH: number,
  maskData: ImageData | null = null,
  originX = 0,
  originY = 0,
  anim: TextDrawAnim | null = null,
  pathLayout: TextPathLayout | null = null
): void {
  const { size, alignment, leading, letterSpacing } = style;
  c2d.save();
  c2d.fillStyle = resolveFillStyle(c2d, style, originX, originY, areaW, areaH);
  c2d.textBaseline = "middle";

  // In-raster outline: drawn before the fill each glyph so the fill sits on
  // top and the stroke reads as an outline. Width 0 / disabled ⇒ no stroke.
  const stroke = style.stroke && style.stroke.width > 0 ? style.stroke : null;
  if (stroke) {
    c2d.strokeStyle = stroke.color;
    c2d.lineWidth = stroke.width;
    c2d.lineJoin = stroke.join;
    c2d.miterLimit = 2;
  }

  // Text-on-path: a wired spline (≥1 usable subpath) takes over layout,
  // ignoring the box/wrap/vAlign model below.
  if (
    pathLayout &&
    pathLayout.path.subpaths.some((sp) => sp.anchors.length >= 2)
  ) {
    drawGlyphsAlongPath(canvas, c2d, style, lines, pathLayout, maskData, anim, stroke);
    c2d.restore();
    return;
  }

  const lineHeight = size * leading;
  const totalHeight = Math.max(1, lines.length) * lineHeight;
  const vAlign = style.vAlign ?? "middle";
  // Top edge of the first line's baseline-middle, by vertical alignment.
  const blockTop =
    vAlign === "top"
      ? originY
      : vAlign === "bottom"
        ? originY + areaH - totalHeight
        : originY + areaH / 2 - totalHeight / 2;
  const startY = blockTop + lineHeight / 2;

  if (isStyleAllConstant(style) && !anim) {
    // FAST PATH — single fillText per line; native canvas2d layout.
    // maskDriven counts as modulated (isAxisDictAllConstant excludes
    // it), so we never reach here with a maskData payload. Active text
    // animators also force the modulated path (per-char transform/alpha).
    applyAxisStyling(
      canvas,
      c2d,
      style.fontAxes,
      style.axesDict,
      0,
      0,
      style.family,
      size,
      null,
      style.weight ?? 400,
      style.italic ?? false
    );
    c2d.textAlign = alignment;
    (c2d as unknown as { letterSpacing?: string }).letterSpacing =
      `${letterSpacing}px`;
    const x =
      originX +
      (alignment === "left" ? 0 : alignment === "right" ? areaW : areaW / 2);
    for (let i = 0; i < lines.length; i++) {
      const ly = startY + i * lineHeight;
      if (stroke) c2d.strokeText(lines[i], x, ly);
      c2d.fillText(lines[i], x, ly);
    }
  } else {
    // MODULATED PATH — per-character layout. textAlign stays "left"
    // because we manage horizontal alignment ourselves (exact advance
    // accumulation, which textAlign can't do mid-string).
    c2d.textAlign = "left";
    (c2d as unknown as { letterSpacing?: string }).letterSpacing = "0px";
    // Global character index across all lines so a cascade / type-on reveals
    // continuously through wrapped text rather than restarting each line.
    let globalTotal = 0;
    for (const l of lines) globalTotal += Array.from(l).length;
    let globalOffset = 0;
    // Sample every wired animator field at a glyph centre (absolute canvas px).
    const sampleFields = (x: number, y: number): GlyphFields => {
      const f: GlyphFields = {};
      if (!anim) return f;
      for (const p of FIELD_PROPS) {
        const d = anim.fields[p];
        if (d) f[p] = sampleMask(d, x, y, d.width, d.height);
      }
      return f;
    };
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const chars = Array.from(line); // codepoint-safe split
      const total = chars.length;
      const y = startY + li * lineHeight;
      // Pre-measure each char with its axis values applied so alignment
      // uses real advances. Mask sampling for the measure pass uses a
      // rough placeholder (areaW/2, y); the draw pass re-samples at the
      // actual glyph centre. Per-char tracking (index-driven) is folded
      // into the advance so alignment stays correct.
      const advances: number[] = [];
      const tracks: number[] = [];
      let lineWidth = 0;
      for (let i = 0; i < total; i++) {
        const t = total <= 1 ? 0 : i / (total - 1);
        const mPre = maskData
          ? sampleMask(maskData, originX + areaW / 2, y, areaW, areaH)
          : null;
        applyAxisStyling(
          canvas,
          c2d,
          style.fontAxes,
          style.axesDict,
          t,
          i,
          style.family,
          size,
          mPre,
          style.weight ?? 400,
          style.italic ?? false
        );
        const adv = c2d.measureText(chars[i]).width;
        advances.push(adv);
        const trk = anim
          ? resolveTrackingExtra(anim.animators, globalOffset + i, globalTotal)
          : 0;
        tracks.push(trk);
        lineWidth += adv + letterSpacing + trk;
      }
      // Drop the trailing inter-glyph gap (letter-spacing + tracking) so the
      // alignment math sees the true visible width.
      lineWidth -= letterSpacing;
      if (total > 0) lineWidth -= tracks[total - 1];
      let cx =
        originX +
        (alignment === "left"
          ? 0
          : alignment === "right"
            ? areaW - lineWidth
            : (areaW - lineWidth) / 2);
      // Final draw pass — re-apply per-char styling and draw at cx.
      // Mask sampling reads at the glyph's CENTRE so a wide character is
      // driven by its own mid-region rather than its leading edge.
      for (let i = 0; i < total; i++) {
        const t = total <= 1 ? 0 : i / (total - 1);
        const cxCentre = cx + advances[i] / 2;
        const mVal = maskData
          ? sampleMask(maskData, cxCentre, y, areaW, areaH)
          : null;
        applyAxisStyling(
          canvas,
          c2d,
          style.fontAxes,
          style.axesDict,
          t,
          i,
          style.family,
          size,
          mVal,
          style.weight ?? 400,
          style.italic ?? false
        );
        if (anim) {
          // Per-glyph transform + alpha + color from the active animators,
          // applied about the glyph centre so scale/rotation pivot there.
          const g = resolveGlyphAnim(
            anim.animators,
            globalOffset + i,
            globalTotal,
            sampleFields(cxCentre, y)
          );
          c2d.save();
          c2d.globalAlpha = Math.max(0, Math.min(1, g.alpha));
          if (g.color) c2d.fillStyle = g.color;
          c2d.translate(cxCentre + g.offsetX, y + g.offsetY);
          if (g.rotation) c2d.rotate(g.rotation);
          if (g.scale !== 1) c2d.scale(g.scale, g.scale);
          c2d.translate(-cxCentre, -y);
          if (stroke) c2d.strokeText(chars[i], cx, y);
          c2d.fillText(chars[i], cx, y);
          c2d.restore();
        } else {
          if (stroke) c2d.strokeText(chars[i], cx, y);
          c2d.fillText(chars[i], cx, y);
        }
        cx += advances[i] + letterSpacing + tracks[i];
      }
      globalOffset += total;
    }
  }
  c2d.restore();
}

// =====================================================================
// Text-instance helpers (Text → Copy to Points)
// =====================================================================

// A minimal upright style for empty `text_instance` values (gated clips,
// missing font). `strings: []` means placement consumers render nothing.
export const DEFAULT_TEXT_STYLE: TextStyle = {
  text: "",
  family: "sans-serif",
  size: 64,
  color: "#ffffff",
  alignment: "center",
  leading: 1.2,
  letterSpacing: 0,
  axesDict: {},
};

export function emptyTextInstance(): TextInstanceValue {
  return { kind: "text_instance", base: DEFAULT_TEXT_STYLE, strings: [] };
}

// Render a styled text block to a tight (hug) intrinsic-size ImageValue —
// measured to its natural bounds, drawn once, uploaded (Y-flipped) to a pooled
// texture. `canvas` MUST be DOM-attached for variable-font axes to resolve.
// `maxWidth` (px) enables word-wrap; undefined = single run, no wrap. Box
// layout only (no animators / path) — the per-copy raster for Copy to Points'
// text mode. The returned ImageValue's texture is owned by the caller (release
// it once composited).
export function renderStyledTextToImage(
  rctx: RenderContext,
  canvas: HTMLCanvasElement,
  style: TextStyle,
  maxWidth?: number
): ImageValue {
  const c2d = canvas.getContext("2d");
  if (!c2d) {
    const out = rctx.allocImage({ width: 1, height: 1 });
    rctx.clearTarget(out, [0, 0, 0, 0]);
    return out;
  }
  // Metrics are independent of the canvas backing-store size, so measure
  // first, then size the canvas to the tight block bounds.
  const measureLines = wrapStyledLines(canvas, c2d, style, maxWidth);
  const m = measureStyledBlock(canvas, c2d, style, measureLines);
  const w = Math.max(1, Math.ceil(m.width));
  const h = Math.max(1, Math.ceil(m.height));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  // Resizing the backing store resets 2D state — re-fetch the context.
  const c2 = canvas.getContext("2d");
  if (!c2) {
    const out = rctx.allocImage({ width: w, height: h });
    rctx.clearTarget(out, [0, 0, 0, 0]);
    return out;
  }
  c2.clearRect(0, 0, w, h);
  const lines = wrapStyledLines(canvas, c2, style, maxWidth);
  drawTextBlock(canvas, c2, style, lines, w, h, null);
  return uploadCanvasToImage(rctx, canvas);
}
