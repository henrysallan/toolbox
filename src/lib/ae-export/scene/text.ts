// Text (spec §4.7): a plain Text node → an AE paragraph-text layer.
//
//   font        PostScript name from family + weight + italic: a table of
//               families whose names are known, else "<Family>-<Weight>"
//               with a warning (AE substitutes when it is not installed —
//               build.jsx says so too); every font lands in report.requires
//   size        font_size (px, or % of W)
//   tracking    letter_spacing px → 1/1000 em
//   leading     font_size × leading
//   box         the toolbox text box (boxWidth/boxHeight are uv01 fractions
//               of the canvas, centered); the block's vertical alignment is
//               placed by line count (AE's box text starts at its top)
//   fill/stroke color (8-digit alpha → layer opacity), stroke width; toolbox
//               draws the stroke under the fill (Fill Over Stroke)
//   transform   translate / pivot are per-axis uv01, rotation rigid in px →
//               the layer transform (anchor = pivot px)
//
// Glyph metrics differ between toolbox's canvas rasterizer and AE, so text
// is approx. Animators, text-on-path, gradient / image fills and variable
// axes driven by a mask are the next wave: such text bakes, with a note.

import { sampledTrackToAe } from "../convert";
import type { AeLayer, AePlanNode, AeTextDocument } from "../types";
import { colorProp, isAnimatedParam, keyCtx, pairProp, scalarProp, staticNumber, valueOfSource, windowFrames, type WalkCtx } from "./context";
import { parseOut, sourceEndpoint } from "./graph";
import { BakeSignal, newLayer, rendered, type Rendered, type Scope } from "./layers";
import { applyImageMask } from "./masks";

const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

// Families whose PostScript names don't follow "<Family>-<Weight>".
const KNOWN: Record<string, (w: number, italic: boolean) => string> = {
  Arial: (w, i) => (w >= 600 ? (i ? "Arial-BoldItalicMT" : "Arial-BoldMT") : i ? "Arial-ItalicMT" : "ArialMT"),
  Helvetica: (w, i) => (w >= 600 ? (i ? "Helvetica-BoldOblique" : "Helvetica-Bold") : i ? "Helvetica-Oblique" : "Helvetica"),
  "Times New Roman": (w, i) => (w >= 600 ? (i ? "TimesNewRomanPS-BoldItalicMT" : "TimesNewRomanPS-BoldMT") : i ? "TimesNewRomanPS-ItalicMT" : "TimesNewRomanPSMT"),
  "Courier New": (w, i) => (w >= 600 ? (i ? "CourierNewPS-BoldItalicMT" : "CourierNewPS-BoldMT") : i ? "CourierNewPS-ItalicMT" : "CourierNewPSMT"),
  Georgia: (w, i) => (w >= 600 ? (i ? "Georgia-BoldItalic" : "Georgia-Bold") : i ? "Georgia-Italic" : "Georgia"),
};
// Families that do follow "<Family>-<Weight>[Italic]" (Google static cuts).
const REGULAR = new Set(["Inter", "Roboto", "Open Sans", "Montserrat", "Lato", "Poppins", "Source Sans 3", "Work Sans", "DM Sans", "IBM Plex Sans", "Noto Sans"]);

export function postScriptName(family: string, weight: number, italic: boolean): { name: string; sure: boolean } {
  const w = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
  if (KNOWN[family]) return { name: KNOWN[family](w, italic), sure: true };
  const base = family.replace(/\s+/g, "");
  const wn = WEIGHT_NAMES[w] ?? "Regular";
  const style = italic ? (wn === "Regular" ? "Italic" : `${wn}Italic`) : wn;
  return { name: `${base}-${style}`, sure: REGULAR.has(family) };
}

function caseOf(text: string, mode: unknown): { text: string; allCaps: boolean } {
  if (mode === "upper") return { text, allCaps: true };
  if (mode === "lower") return { text: text.toLowerCase(), allCaps: false };
  if (mode === "title") return { text: text.replace(/\b(\p{L})(\p{L}*)/gu, (_m, a: string, b: string) => a.toUpperCase() + b.toLowerCase()), allCaps: false };
  return { text, allCaps: false };
}

const TOOLBOX_BASELINE_EM = 0.364;
const AE_FIRST_BASELINE_EM = 0.72;

const px = (ctx: WalkCtx, v: number, units: unknown) => (units === "%" ? (v / 100) * ctx.canvas.width : v);

export function emitText(scope: Scope, endpoint: string, pn: AePlanNode): Rendered | null {
  const { ctx, clock } = scope;
  const { id, out } = parseOut(endpoint);
  if (out !== "out:primary") return null;
  const n = ctx.graph.node(id);
  if (!n || n.type !== "text") return null;
  void pn;
  const p = ctx.graph.params(id);
  // What the plain text layer cannot carry yet.
  const animators = Object.keys(p).filter((k) => /^anim_.*_enabled$/.test(k) && p[k] === true);
  if (animators.length) throw new BakeSignal(`text animators (${animators.map((k) => k.slice(5, -8)).join(", ")}) are the next wave — the text bakes until AE animators land`);
  if (ctx.graph.wireInto(id, "in:path") && p.path_enabled !== false) throw new BakeSignal("text on a path (Path Options) is the next wave");
  if ((p.fillMode ?? "solid") !== "solid") throw new BakeSignal(`text fill ${String(p.fillMode)} (gradient / image) has no plain text-layer form`);
  if (ctx.graph.wireInto(id, "in:morph_mask")) throw new BakeSignal("variable-font morph by mask");
  for (const k of ["text", "font_size", "letter_spacing", "leading", "boxWidth", "boxHeight", "font_weight", "strokeWidth"])
    if (isAnimatedParam(ctx, id, k)) throw new BakeSignal(`animated ${k} (a keyed text document) is the next wave`);
  if (p.legacySkew === true) throw new BakeSignal("text with legacySkew (per-axis TRS)");

  const custom = p.custom_font as { family?: unknown } | null | undefined;
  const family = custom && typeof custom === "object" && typeof custom.family === "string" ? custom.family : String(p.font_family ?? "Inter");
  const weight = staticNumber(ctx, id, "font_weight", 400);
  const italic = p.italic === true;
  const ps = postScriptName(family, weight, italic);
  ctx.report.fonts.add(family);
  if (!ps.sure || custom) {
    const w = `Text ${ctx.graph.name(id)}: PostScript name "${ps.name}" derived from ${family} ${weight}${italic ? " italic" : ""} — check it is installed under that name in After Effects.`;
    ctx.report.warn(w);
  }
  if (p.font_variations && typeof p.font_variations === "object" && Object.keys(p.font_variations as object).length)
    ctx.report.approx(id, "variable-font axes: AE sets them only inside text animators — the named instance is used");
  ctx.report.approx(id, `glyph metrics: toolbox's canvas rasterizer vs AE's text engine (font ${ps.name})`);

  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const units = p.units;
  const size = px(ctx, staticNumber(ctx, id, "font_size", 96), units);
  const leading = staticNumber(ctx, id, "leading", 1.2);
  const spacing = px(ctx, staticNumber(ctx, id, "letter_spacing", 0), units);
  const tc = caseOf(String(p.text ?? ""), p.textCase);
  const lines = tc.text.split(/\r\n|\r|\n/);
  const lineHeight = size * leading;
  const boxW = Math.max(1, Math.min(2, Number(p.boxWidth ?? 1)) * W);
  const boxH = Math.max(1, Math.min(2, Number(p.boxHeight ?? 1)) * H);
  const originX = W / 2 - boxW / 2;
  const originY = H / 2 - boxH / 2;
  const total = Math.max(1, lines.length) * lineHeight;
  const va = String(p.vAlign ?? "middle");
  const blockTop = va === "top" ? originY : va === "bottom" ? originY + boxH - total : originY + boxH / 2 - total / 2;
  if (p.wrap !== true) ctx.report.note(id, "no wrap: the AE box is the toolbox box (long lines may wrap in AE where toolbox overflows)");

  const fill = colorProp(ctx, clock, id, "color", { shapeOrSolid: true });
  if (!("v" in fill.color)) throw new BakeSignal("keyed text color (a keyed text document) is the next wave");
  const doc: AeTextDocument = {
    text: tc.text.replace(/\r\n|\n/g, "\r"),
    font: ps.name,
    fontSize: size,
    fillColor: fill.color.v,
    tracking: size > 0 ? (spacing / size) * 1000 : 0,
    leading: lineHeight,
    justification: p.alignment === "left" ? "left" : p.alignment === "right" ? "right" : "center",
    allCaps: tc.allCaps,
    // Vertical placement. Toolbox draws each line with textBaseline
    // "middle" at blockTop + (i + ½)·lineHeight, i.e. its baseline sits
    // (ascent − descent)/2 below that (Chrome; ≈ 0.364 em for Inter). AE's
    // paragraph text puts the first baseline ≈ 0.72 em below the box top
    // (measured: Inter Bold 120 px, AE 26.5). The box top that lines the two
    // up; other fonts' metrics shift it slightly (text is approx anyway).
    // The box is one em taller than the block: AE drops a line that does
    // not fit.
    box: { size: [boxW, total + size], position: [originX, blockTop + lineHeight / 2 + (TOOLBOX_BASELINE_EM - AE_FIRST_BASELINE_EM) * size] },
  };
  if (p.strokeEnabled === true) {
    const sc = colorProp(ctx, clock, id, "strokeColor", { shapeOrSolid: true, fallback: "#000000" });
    if ("v" in sc.color) {
      doc.strokeColor = sc.color.v;
      // Canvas strokes centered on the outline under the fill: AE's
      // stroke width is the full width too.
      doc.strokeWidth = px(ctx, staticNumber(ctx, id, "strokeWidth", 2), units);
      doc.strokeOverFill = false;
    }
  }
  const L: AeLayer = newLayer(scope, "text", ctx.graph.name(id), [id], { text: { document: { v: doc } } });
  // Opacity: the node's opacity × the fill color's alpha.
  const op = scalarProp(ctx, clock, id, "opacity", { map: { scale: 100, offset: 0 }, fallback: 1 });
  const fillA = "v" in fill.opacity ? fill.opacity.v / 100 : 1;
  L.transform.opacity = "v" in op ? { v: op.v * fillA } : op;

  // The text's own TRS: per-axis uv01 translate / pivot, rigid rotation.
  const trs = ["translateX", "translateY", "scaleX", "scaleY", "rotate", "pivotX", "pivotY"];
  const moved = trs.some((k) => isAnimatedParam(ctx, id, k)) || staticNumber(ctx, id, "translateX", 0) !== 0 || staticNumber(ctx, id, "translateY", 0) !== 0 || staticNumber(ctx, id, "scaleX", 1) !== 1 || staticNumber(ctx, id, "scaleY", 1) !== 1 || staticNumber(ctx, id, "rotate", 0) !== 0;
  if (moved) {
    const pivotAnimated = isAnimatedParam(ctx, id, "pivotX") || isAnimatedParam(ctx, id, "pivotY");
    const anchor = pairProp(ctx, clock, [{ node: id, param: "pivotX", fallback: 0.5, map: { scale: W, offset: 0 } }, { node: id, param: "pivotY", fallback: 0.5, map: { scale: H, offset: 0 } }], { label: "pivot", owner: id });
    let position;
    if (!pivotAnimated) {
      const pxv = staticNumber(ctx, id, "pivotX", 0.5) * W;
      const pyv = staticNumber(ctx, id, "pivotY", 0.5) * H;
      position = pairProp(ctx, clock, [{ node: id, param: "translateX", fallback: 0, map: { scale: W, offset: pxv } }, { node: id, param: "translateY", fallback: 0, map: { scale: H, offset: pyv } }], { spatial: true, label: "translate", owner: id });
    } else {
      ctx.report.sampled(id, "pivot and translate both animate → per-frame position");
      position = sampledTrackToAe(
        windowFrames(clock),
        (tick) => [W * (valueOfSource(ctx, { node: id, param: "pivotX", fallback: 0.5 }, tick) + valueOfSource(ctx, { node: id, param: "translateX", fallback: 0 }, tick)), H * (valueOfSource(ctx, { node: id, param: "pivotY", fallback: 0.5 }, tick) + valueOfSource(ctx, { node: id, param: "translateY", fallback: 0 }, tick))],
        keyCtx(ctx, clock)
      ).prop;
    }
    L.transform = {
      anchor,
      position,
      scale: pairProp(ctx, clock, [{ node: id, param: "scaleX", fallback: 1, map: { scale: 100, offset: 0 } }, { node: id, param: "scaleY", fallback: 1, map: { scale: 100, offset: 0 } }], { label: "scale", owner: id }),
      rotation: scalarProp(ctx, clock, id, "rotate", { fallback: 0 }),
      opacity: L.transform.opacity,
    };
    ctx.free.delete(L);
  }
  const r = rendered(L);
  const mask = ctx.graph.wireInto(id, "in:mask");
  return mask ? applyImageMask(scope, r, id, sourceEndpoint(mask)) : r;
}
