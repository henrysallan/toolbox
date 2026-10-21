// Text (spec §4.7; M4 text lane, specdocs/ae-m4/text.md): a Text node → an
// AE text layer.
//
//   font        PostScript name from family + weight + italic: a table of
//               families whose names are known, else "<Family>-<Weight>"
//               with a warning (AE substitutes when it is not installed —
//               build.jsx says so too); every font lands in report.requires
//   size        font_size (px, or % of W)
//   tracking    letter_spacing px → 1/1000 em, rounded (AE takes only an
//               integer in ±1000); past ±1000 em/1000 the rest rides a px
//               Tracking animator over every character
//   leading     font_size × leading
//   box         the toolbox text box (boxWidth/boxHeight are uv01 fractions
//               of the canvas, centered); the block's vertical alignment is
//               placed by line count (AE's box text starts at its top).
//               Plain text (toolbox's fast path) aligns a line WITH its
//               trailing letter spacing (canvas letterSpacing), AE without:
//               the box moves by that much (½ of it centred); per-glyph
//               text (animators) drops it like AE
//   fill/stroke color (8-digit alpha → layer opacity), stroke width; toolbox
//               draws the stroke under the fill (Fill Over Stroke)
//   transform   translate / pivot are per-axis uv01, rotation rigid in px →
//               the layer transform (anchor = pivot px)
//   keyed doc   size, spacing, leading, box, weight, stroke width, font,
//               case, alignment… → Source Text hold keys: at toolbox's own
//               keys when only held params (enums, booleans) change, one per
//               frame while a number interpolates (AE cannot tween a
//               TextDocument). `text` itself is a string: toolbox does not
//               keyframe it (a wire into it bakes)
//   keyed color a Fill / Stroke Color animator over every character, the
//               color track on it (the shapes' route: OKLab expression)
//   animators   one AE animator per toolbox animator (+ a constant "base"
//               animator when toolbox's min is not the property's rest);
//               the per-unit drive t' becomes a Range Selector (exact for a
//               linear cascade, Ease High / Low within tolerance for an
//               eased one) or an Expression Selector (random order, other
//               easings — exact); see convert/text.ts. Scale / rotation
//               pivot on the glyph's middle like toolbox (a "Pivot"
//               animator: Anchor Point + an equal Position), about the word
//               for word-based ones (Anchor Point Grouping: Word)
//   on a path   the spline → a mask (mode None) + Path Options: start / end
//               / center → left / right / center justification, offset ×
//               arc length → First (or Last) Margin, flip → Reverse Path,
//               side → baseline shift (toolbox centres the glyph's middle on
//               the path, AE its baseline)
//
// Glyph metrics differ between toolbox's canvas rasterizer and AE, so text
// is approx. Field-driven animators, gradient / image fills, variable axes
// driven by a mask and a multi-subpath text path bake, with a note.

import { evaluateKeyframesAt, isKeyframable } from "@/engine/keyframes";
import { getNodeDef } from "@/engine/registry";
import { aspectCorrectY } from "@/engine/aspect";
import { measureSpline, sampleSplineAt } from "@/engine/spline-math";
import { parseAnimators, wordIndices, type AnimProp, type TextAnimators } from "@/engine/text-animators";
import type { ParamType, SplineValue } from "@/engine/types";
import { asAxisDict, isAxisDictAllConstant } from "@/lib/font-axis";
import { colorToRgba, sampledTrackToAe } from "../convert";
import { easeHeadroom, isLinearEase, planTextSelector, TEXT_EASE_FIT_TOLERANCE, textSelectorExpression, toolboxEase, type AeSelectorPlan, type TextDriveConfig } from "../convert/text";
import type { AeKey, AeLayer, AeProp, AePlanNode, AeRGB, AeTextAnimator, AeTextDocument, AeTextSelector } from "../types";
import { colorProp, driverOf, evalBlock, isAnimatedParam, keyCtx, markDriven, pairProp, scalarProp, staticNumber, valueOfSource, windowFrames, type WalkCtx } from "./context";
import { numbersOf, parseOut, sourceEndpoint } from "./graph";
import { BakeSignal, newLayer, rendered, type Rendered, type Scope } from "./layers";
import { applyImageMask, maskPaths } from "./masks";
import { animatedUpstream, localTick, splineAt } from "./shape";

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
  Menlo: (w, i) => (w >= 600 ? (i ? "Menlo-BoldItalic" : "Menlo-Bold") : i ? "Menlo-Italic" : "Menlo-Regular"),
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

// Toolbox draws each line with textBaseline "middle"; AE puts the first
// baseline of box text a font-dependent distance below the box top. Both
// measured per family (calibrate/text.mts metric_*, one line of "HHH" at
// 120 px, ±0.004 em): Chrome's middle is NOT (hhea ascent − descent)/2
// (Arial 0.275 vs 0.347), and AE's first baseline follows the font's typo
// ascender (Courier New 0.612, Menlo 0.757). Inter — the default face, not
// installed for AE on the measuring machine — keeps the scene lane's 0.364 /
// 0.72 (Inter Bold 120 px); other families take those too (text is approx).
const TOOLBOX_BASELINE_EM = 0.364;
const AE_FIRST_BASELINE_EM = 0.72;
const MIDDLE_EM: Record<string, number> = {
  Arial: 0.275,
  Helvetica: 0.3167,
  "Times New Roman": 0.2667,
  "Courier New": 0.2667,
  Georgia: 0.275,
  Menlo: 0.2583,
};
const FIRST_BASELINE_EM: Record<string, number> = {
  Arial: 0.715,
  Helvetica: 0.7167,
  "Times New Roman": 0.6993,
  "Courier New": 0.6122,
  Georgia: 0.7544,
  Menlo: 0.7571,
};
export const middleEm = (family: string) => MIDDLE_EM[family] ?? TOOLBOX_BASELINE_EM;
const firstBaselineEm = (family: string) => FIRST_BASELINE_EM[family] ?? AE_FIRST_BASELINE_EM;

const px = (ctx: WalkCtx, v: number, units: unknown) => (units === "%" ? (v / 100) * ctx.canvas.width : v);

// Params that only reach AE through the TextDocument (Source Text).
const DOC_PARAMS = ["text", "font_family", "font_size", "font_weight", "italic", "letter_spacing", "leading", "boxWidth", "boxHeight", "textCase", "alignment", "vAlign", "units", "wrap", "strokeWidth", "path_align", "path_side"];
// Animator params a selector is built from once (keyed → bake).
const SHAPE_PARAMS = ["driver", "by", "softness", "direction", "seed", "easing", "ease_intensity", "easing_curve"];
const ANIM_ORDER: AnimProp[] = ["typeon", "opacity", "position", "scale", "rotation", "tracking", "color"];
const ANIM_LABEL: Record<AnimProp, string> = { typeon: "Type On", opacity: "Opacity", position: "Position", scale: "Scale", rotation: "Rotation", tracking: "Tracking", color: "Color" };

type Getter = (name: string) => unknown;

interface DocOut {
  doc: AeTextDocument;
  family: string;
  ps: { name: string; sure: boolean };
  size: number;
  // The characters toolbox lays out (lines joined by nothing; path mode joins with spaces).
  lines: string[];
  // Letter spacing past the document's ±1000 (px per character).
  extra: number;
}

interface PathRun {
  endpoint: string;
  align: "start" | "center" | "end";
  side: "on" | "above" | "below";
  flip: boolean;
}

// AE's TextDocument tracking: an integer in ±1000 (setValue refuses the rest).
export const AE_DOC_TRACKING_MAX = 1000;

function buildDoc(ctx: WalkCtx, get: Getter, path: PathRun | null, fillColor: AeRGB, fastPath: boolean): DocOut {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const num = (name: string, fb: number) => {
    const v = get(name);
    return typeof v === "number" && Number.isFinite(v) ? v : fb;
  };
  const custom = get("custom_font") as { family?: unknown } | null | undefined;
  const family = custom && typeof custom === "object" && typeof custom.family === "string" ? custom.family : String(get("font_family") ?? "Inter");
  const weight = num("font_weight", 400);
  const italic = get("italic") === true;
  const ps = postScriptName(family, weight, italic);
  const units = get("units");
  const size = px(ctx, num("font_size", 96), units);
  const leading = num("leading", 1.2);
  const spacing = px(ctx, num("letter_spacing", 0), units);
  const tc = caseOf(String(get("text") ?? ""), get("textCase"));
  const lines = tc.text.split(/\r\n|\r|\n/);
  const em1000 = size > 0 ? (spacing / size) * 1000 : 0;
  const tracking = Math.max(-AE_DOC_TRACKING_MAX, Math.min(AE_DOC_TRACKING_MAX, Math.round(em1000)));
  const base: AeTextDocument = {
    text: "",
    font: ps.name,
    fontSize: size,
    fillColor,
    tracking,
    justification: "center",
    allCaps: tc.allCaps,
  };
  // Letter spacing the document cannot hold (past ±1000), px.
  const extra = Math.abs(em1000) > AE_DOC_TRACKING_MAX ? spacing - (tracking / 1000) * size : 0;
  if (path) {
    // One run along the path, lines joined by spaces (toolbox's
    // drawGlyphsAlongPath). Toolbox centres each glyph's middle on the path
    // (± ½ em for above / below); AE sits its baseline there.
    const side = path.side === "above" ? -0.5 : path.side === "below" ? 0.5 : 0;
    const doc: AeTextDocument = {
      ...base,
      text: lines.join(" "),
      justification: path.align === "start" ? "left" : path.align === "end" ? "right" : "center",
      baselineShift: -(middleEm(family) + side) * size,
    };
    return { doc, family, ps, size, lines: [lines.join(" ")], extra };
  }
  const lineHeight = size * leading;
  const boxW = Math.max(1, Math.min(2, num("boxWidth", 1)) * W);
  const boxH = Math.max(1, Math.min(2, num("boxHeight", 1)) * H);
  const originX = W / 2 - boxW / 2;
  const originY = H / 2 - boxH / 2;
  const total = Math.max(1, lines.length) * lineHeight;
  const va = String(get("vAlign") ?? "middle");
  const blockTop = va === "top" ? originY : va === "bottom" ? originY + boxH - total : originY + boxH / 2 - total / 2;
  const al = get("alignment");
  const shift = fastPath ? (al === "left" ? 0 : al === "right" ? -spacing : -spacing / 2) : 0;
  const doc: AeTextDocument = {
    text: tc.text.replace(/\r\n|\n/g, "\r"),
    font: base.font,
    fontSize: base.fontSize,
    fillColor: base.fillColor,
    tracking: base.tracking,
    leading: lineHeight,
    justification: al === "left" ? "left" : al === "right" ? "right" : "center",
    allCaps: base.allCaps,
    // Vertical placement. Toolbox draws each line with textBaseline
    // "middle" at blockTop + (i + ½)·lineHeight, its baseline middleEm
    // below that; AE's paragraph text puts the first baseline
    // firstBaselineEm below the box top (both measured, above). The box top
    // that lines the two up. The box is one em taller than the block: AE
    // drops a line that does not fit.
    box: { size: [boxW, total + size], position: [originX + shift, blockTop + lineHeight / 2 + (middleEm(family) - firstBaselineEm(family)) * size] },
  };
  return { doc, family, ps, size, lines, extra };
}

const sameDoc = (a: AeTextDocument, b: AeTextDocument) => JSON.stringify(a) === JSON.stringify(b);

export function emitText(scope: Scope, endpoint: string, pn: AePlanNode): Rendered | null {
  const { ctx, clock } = scope;
  const { id, out } = parseOut(endpoint);
  if (out !== "out:primary") return null;
  const n = ctx.graph.node(id);
  if (!n || n.type !== "text") return null;
  void pn;
  const p = ctx.graph.params(id);
  const def = getNodeDef("text");
  const types = new Map<string, ParamType>((def?.params ?? []).map((d) => [d.name, d.type]));

  // What a text layer cannot carry.
  if ((p.fillMode ?? "solid") !== "solid") throw new BakeSignal(`text fill ${String(p.fillMode)} (gradient / image) has no plain text-layer form`);
  if (ctx.graph.wireInto(id, "in:morph_mask")) throw new BakeSignal("variable-font morph by mask");
  if (p.legacySkew === true) throw new BakeSignal("text with legacySkew (per-axis TRS)");
  const anim = parseAnimators(p);
  const enabled = ANIM_ORDER.filter((k) => anim[k]?.enabled);
  for (const k of enabled) {
    const c = anim[k] as { driver?: string };
    if (k !== "typeon" && k !== "tracking" && c.driver === "field") throw new BakeSignal(`text animator ${k} is driven by an image field — no AE selector samples an image per character`);
    for (const s of SHAPE_PARAMS) if (isAnimatedParam(ctx, id, `anim_${k}_${s}`)) throw new BakeSignal(`animated ${k} animator ${s} — an AE selector's shape is built once`);
  }

  // Params at a tick: wire > keys > constant (the evaluator's priority).
  const at = (name: string, tick: number): unknown => {
    const src = driverOf(ctx, id, name);
    if (src) {
      const v = numbersOf(ctx.graph.valueAt(src, tick));
      if (!v) throw new BakeSignal(`${name} is driven by ${src}, which is not a number`);
      return v[0];
    }
    // A block on a param the evaluator does not keyframe (text: a string)
    // is ignored, as toolbox ignores it.
    const type = types.get(name) ?? "scalar";
    const b = isKeyframable(type) ? ctx.graph.block(id, name) : undefined;
    if (b && b.keyframes.length > 1) return evaluateKeyframesAt(b, type, tick) ?? p[name];
    if (b && b.keyframes.length === 1) return b.keyframes[0].value;
    return p[name];
  };
  const [f0, f1] = windowFrames(clock);
  const tick0 = localTick(scope, f0);

  // Text on a path: a spline with one usable subpath (toolbox falls back to
  // the box when it has none).
  let path: PathRun | null = null;
  const pathWire = ctx.graph.wireInto(id, "in:path");
  if (pathWire && isAnimatedParam(ctx, id, "path_enabled")) throw new BakeSignal("animated path_enabled (text switching between box and path layout)");
  if (pathWire && p.path_enabled !== false) {
    const ep = sourceEndpoint(pathWire);
    const sp = splineAt(scope, ep, f0);
    const usable = sp.subpaths.filter((s) => s.anchors.length >= 2);
    if (usable.length > 1 || (usable.length === 1 && sp.subpaths.length > 1)) throw new BakeSignal("text on a spline of several subpaths — AE runs text along one mask path");
    if (usable.length === 1) {
      path = {
        endpoint: ep,
        align: p.path_align === "start" ? "start" : p.path_align === "end" ? "end" : "center",
        side: p.path_side === "above" ? "above" : p.path_side === "below" ? "below" : "on",
        flip: p.path_flip === true,
      };
      for (const k of ["path_align", "path_side", "path_flip"]) if (isAnimatedParam(ctx, id, k)) throw new BakeSignal(`animated ${k}`);
    }
  }

  // Fill: static → the document; keyed → a Fill Color animator.
  const fill = colorProp(ctx, clock, id, "color", { shapeOrSolid: true });
  const firstRgb = (prop: AeProp<AeRGB>, param: string, fb: string): AeRGB => {
    if ("v" in prop) return prop.v;
    const b = ctx.graph.block(id, param);
    const c = colorToRgba(b ? (evaluateKeyframesAt(b, "color", tick0) ?? fb) : (p[param] ?? fb));
    return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
  };
  const fillRgb = firstRgb(fill.color, "color", "#ffffff");

  // The document, and its keys when a document param animates.
  // Toolbox draws plain text in one fillText per line (its fast path) unless
  // an animator or a varying font axis asks for per-glyph layout.
  const fastPath = !path && !enabled.length && isAxisDictAllConstant(asAxisDict(p.font_variations));
  const docAt = (tick: number) => buildDoc(ctx, (name) => at(name, tick), path, fillRgb, fastPath);
  const first = docAt(tick0);
  const keyedDoc = DOC_PARAMS.filter((k) => (driverOf(ctx, id, k) || (isKeyframable(types.get(k) ?? "scalar") && isAnimatedParam(ctx, id, k))) && !(path && /^(box|wrap|vAlign|alignment|leading)/.test(k)));
  const stroke = p.strokeEnabled === true;
  let strokeRgb: AeRGB | undefined;
  let strokeKeys: AeProp<AeRGB> | undefined;
  if (stroke) {
    const sc = colorProp(ctx, clock, id, "strokeColor", { shapeOrSolid: true, fallback: "#000000" });
    strokeRgb = firstRgb(sc.color, "strokeColor", "#000000");
    if (!("v" in sc.color)) strokeKeys = sc.color;
  }
  const docs: { f: number; d: DocOut }[] = [];
  // Canvas strokes centered on the outline under the fill: AE's stroke
  // width is the full width too.
  const finish = (d: DocOut, tick: number): AeTextDocument => {
    if (!stroke) return d.doc;
    const w = at("strokeWidth", tick);
    return { ...d.doc, strokeColor: strokeRgb, strokeWidth: px(ctx, typeof w === "number" && Number.isFinite(w) ? w : 2, at("units", tick)), strokeOverFill: false };
  };
  let document: AeProp<AeTextDocument>;
  const families = new Set<string>([first.family]);
  if (keyedDoc.length) {
    let prev: AeTextDocument | null = null;
    const keys: AeKey<AeTextDocument>[] = [];
    for (let f = f0; f <= f1; f++) {
      const tick = localTick(scope, f);
      const d = docAt(tick);
      const doc = finish(d, tick);
      families.add(d.family);
      docs.push({ f, d });
      if (prev && sameDoc(prev, doc)) continue;
      keys.push({ t: f / ctx.fps, v: doc, inInterp: "hold", outInterp: "hold" });
      prev = doc;
    }
    document = keys.length > 1 ? { keys, dims: 1 } : { v: keys[0].v };
    const tweened = keyedDoc.filter((k) => types.get(k) === "scalar" && keys.length > 1);
    if (tweened.length) ctx.report.sampled(id, `animated ${tweened.join(", ")} → a Source Text hold key per frame (AE cannot tween a text document)`);
    else if (keys.length > 1) ctx.report.note(id, `keyed ${keyedDoc.join(", ")} → Source Text hold keys at toolbox's keys`);
  } else {
    document = { v: finish(first, tick0) };
    docs.push({ f: f0, d: first });
  }
  for (const fam of families) ctx.report.fonts.add(fam);
  if (!first.ps.sure || p.custom_font) {
    ctx.report.warn(`Text ${ctx.graph.name(id)}: PostScript name "${first.ps.name}" derived from ${first.family} ${staticNumber(ctx, id, "font_weight", 400)}${p.italic === true ? " italic" : ""} — check it is installed under that name in After Effects.`);
  }
  if (p.font_variations && typeof p.font_variations === "object" && Object.keys(p.font_variations as object).length)
    ctx.report.approx(id, "variable-font axes: AE sets them only inside text animators — the named instance is used");
  ctx.report.approx(id, `glyph metrics: toolbox's canvas rasterizer vs AE's text engine (font ${first.ps.name})`);
  if (!path && p.wrap !== true) ctx.report.note(id, "no wrap: the AE box is the toolbox box (long lines may wrap in AE where toolbox overflows)");

  const L: AeLayer = newLayer(scope, "text", ctx.graph.name(id), [id], { text: { document } });
  const T = L.text!;

  // Text on a path.
  if (path) {
    const paths = maskPaths(scope, path.endpoint);
    L.masks = [
      ...(L.masks ?? []),
      { name: `${ctx.graph.name(parseOut(path.endpoint).id)} (text path)`, path: paths[0], mode: "none", inverted: false, feather: { v: [0, 0] }, expansion: { v: 0 }, opacity: { v: 100 } },
    ];
    T.pathMask = L.masks.length;
    const margin = pathMargin(scope, id, path.endpoint);
    T.pathOptions = { reverse: path.flip, perpendicular: true, forceAlignment: false, ...(path.align === "end" ? { lastMargin: margin } : { firstMargin: margin }) };
    ctx.report.note(id, `text on a path → mask + Path Options (${path.align === "start" ? "left, First Margin" : path.align === "end" ? "right, Last Margin" : "centred, First Margin"} = offset × arc length${path.flip ? ", Reverse Path" : ""}${path.side !== "on" ? `, ${path.side}: baseline shift` : ""})`);
    ctx.report.approx(id, "text on a path: glyphs past a path end — toolbox stacks them on the end point, AE continues straight along it");
  }

  // Animators.
  const animators: AeTextAnimator[] = [];
  if (!("v" in fill.color) && !anim.color?.enabled) {
    animators.push({ name: "Fill Color", properties: { "ADBE Text Fill Color": fill.color }, selector: everyUnit("characters") });
    ctx.report.note(id, "keyed color → a Fill Color animator over every character");
  }
  if (strokeKeys) {
    animators.push({ name: "Stroke Color", properties: { "ADBE Text Stroke Color": strokeKeys }, selector: everyUnit("characters") });
    ctx.report.note(id, "keyed stroke color → a Stroke Color animator over every character");
  }
  if (docs.some((x) => x.d.extra !== 0)) {
    const extras = docs.map((x) => x.d.extra);
    const amount: AeProp<number> = extras.every((v) => v === extras[0]) ? { v: extras[0] } : { keys: docs.map((x) => ({ t: x.f / ctx.fps, v: x.d.extra, inInterp: "linear" as const, outInterp: "linear" as const })), dims: 1 };
    animators.push({ name: "Letter Spacing", properties: { "ADBE Text Track Type": { v: 3 }, "ADBE Text Tracking Amount": amount }, selector: everyUnit("characters") });
    ctx.report.note(id, "letter spacing past AE's ±1000 tracking → the rest as a px Tracking animator over every character");
  }
  if (enabled.length) {
    const unitsOf = (d: DocOut, by: "character" | "word") => {
      const chars = d.lines.map((l) => Array.from(l));
      return by === "word" ? wordIndices(chars).total : chars.reduce((s, c) => s + c.length, 0);
    };
    const pivoting = enabled.filter((k) => (k === "scale" || k === "rotation") && !identityXform(anim, k));
    const bys = new Set(pivoting.map((k) => anim[k]!.by));
    if (bys.size > 1) throw new BakeSignal("scale / rotation animators based on both characters and words — AE has one anchor grouping per layer");
    if (bys.has("word")) T.anchorGrouping = "word";
    if (pivoting.length) {
      // Toolbox scales / rotates about the glyph's middle (textBaseline
      // "middle"), AE about its baseline: move the anchor up and the glyph
      // back by the same amount (measured: Anchor Point alone moves a glyph
      // by −anchor).
      const h = (sz: number) => middleEm(first.family) * sz;
      const sizes = docs.map((x) => x.d.size);
      const pv: AeProp<number[]> =
        sizes.every((s) => s === sizes[0])
          ? { v: [0, -h(sizes[0]), 0] }
          : { keys: docs.map((x) => ({ t: x.f / ctx.fps, v: [0, -h(x.d.size), 0], inInterp: "linear" as const, outInterp: "linear" as const })), dims: 3 };
      animators.push({ name: "Pivot", properties: { "ADBE Text Anchor Point 3D": pv, "ADBE Text Position 3D": pv }, selector: everyUnit("characters") });
    }
    if (!path && p.wrap === true) ctx.report.approx(id, "animators on wrapped text: toolbox's wrap drops the spaces where lines break, AE counts them");
    for (const k of enabled) {
      const by = anim[k]!.by;
      const totals = new Set(docs.map((x) => unitsOf(x.d, by)));
      animators.push(...emitAnimator(scope, id, k, anim, { total: [...totals][0], fixedTotal: totals.size === 1, stroke, baseFill: fillRgb }));
    }
  }
  if (animators.length) T.animators = animators;

  // Opacity: the node's opacity × the fill color's alpha.
  const op = scalarProp(ctx, clock, id, "opacity", { map: { scale: 100, offset: 0 }, fallback: 1 });
  if ("v" in fill.opacity) {
    const fillA = fill.opacity.v / 100;
    L.transform.opacity = "v" in op ? { v: op.v * fillA } : op;
  } else if ("v" in op) {
    const s = op.v / 100;
    L.transform.opacity = { ...fill.opacity, keys: fill.opacity.keys.map((k) => ({ ...k, v: k.v * s, ...(k.easeIn ? { easeIn: k.easeIn.map((e) => ({ ...e, speed: e.speed * s })) } : {}), ...(k.easeOut ? { easeOut: k.easeOut.map((e) => ({ ...e, speed: e.speed * s })) } : {}) })) };
  } else {
    ctx.report.sampled(id, "keyed opacity × keyed fill alpha → per-frame layer opacity");
    L.transform.opacity = scalarOf(sampledTrackToAe(windowFrames(clock), (tick) => [100 * valueOfSource(ctx, { node: id, param: "opacity", fallback: 1 }, tick) * clamp01(colorToRgba(at("color", tick))[3])], keyCtx(ctx, clock)).prop);
  }

  // The text's own TRS: per-axis uv01 translate / pivot, rigid rotation.
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
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

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

const scalarOf = (p: AeProp<number[]>): AeProp<number> => ("v" in p ? { v: p.v[0] } : { keys: p.keys.map((k) => ({ ...k, v: k.v[0] })), dims: 1 });

// A Range Selector over every unit at 100 % (AE's default selector).
function everyUnit(basedOn: "characters" | "words"): NonNullable<AeTextAnimator["selector"]> {
  return { basedOn, units: "percentage", start: { v: 0 }, end: { v: 100 }, offset: { v: 0 }, shape: "square", easeHigh: { v: 0 }, easeLow: { v: 0 } };
}

function identityXform(anim: TextAnimators, k: "scale" | "rotation"): boolean {
  const c = anim[k]!;
  return k === "scale" ? c.min === 1 && c.max === 1 : c.min === 0 && c.max === 0;
}

// --- path ------------------------------------------------------------------------

// Toolbox's arc length of the path in canvas px: its 512-segment polyline
// in aspect-corrected px (text-raster.ts buildPathSampler).
export function toolboxPathLength(path: SplineValue, W: number, H: number): number {
  const lengths = measureSpline(path);
  const aspect = W / H;
  let total = 0;
  let px0 = 0;
  let py0 = 0;
  for (let i = 0; i <= 512; i++) {
    const r = sampleSplineAt(path, lengths, i / 512);
    const x = r.pos[0] * W;
    const y = aspectCorrectY(r.pos[1], aspect) * H;
    if (i > 0) total += Math.hypot(x - px0, y - py0);
    px0 = x;
    py0 = y;
  }
  return total;
}

// path_offset (a fraction of the arc length) → the margin in px.
function pathMargin(scope: Scope, id: string, endpoint: string): AeProp<number> {
  const { ctx, clock } = scope;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const [f0, f1] = windowFrames(clock);
  const lenAt = (f: number) => toolboxPathLength(splineAt(scope, endpoint, f), W, H);
  if (!animatedUpstream(ctx, parseOut(endpoint).id)) {
    const len = lenAt(f0);
    return scalarProp(ctx, clock, id, "path_offset", { map: { scale: len, offset: 0 }, fallback: 0, label: "path offset" });
  }
  // The path animates: its length (so the margin) per frame.
  const keys: AeKey<number>[] = [];
  for (let f = f0; f <= f1; f++) {
    const tick = localTick(scope, f);
    keys.push({ t: f / ctx.fps, v: lenAt(f) * valueOfSource(ctx, { node: id, param: "path_offset", fallback: 0 }, tick), inInterp: "linear", outInterp: "linear" });
  }
  if (keys.every((k) => k.v === keys[0].v)) return { v: keys[0].v };
  ctx.report.sampled(id, "animated text path → First / Last Margin per frame (offset × the path's length)");
  return { keys, dims: 1 };
}

// --- animators -------------------------------------------------------------------

interface AnimCtx {
  total: number;
  // The unit count is the same at every frame (a keyed text that changes
  // length needs textTotal: an Expression Selector).
  fixedTotal: boolean;
  stroke: boolean;
  baseFill: AeRGB;
}

type PropValues = Record<string, unknown>;

// Toolbox's lerp(min, max, t') as AE animators: an optional constant `base`
// (every unit) and the varying part, selected by t'/K or (1 − t')/K. The
// stacking rules are measured (types.ts AeTextAnimator).
function splitProp(k: AnimProp, mm: { min: number | number[] | string; max: number | number[] | string }, K: number, stroke: boolean, baseFill: AeRGB): { base?: PropValues; vary: PropValues; complement: boolean } {
  const n = (v: unknown) => v as number;
  switch (k) {
    case "typeon":
      return { vary: { "ADBE Text Opacity": 0 }, complement: true };
    case "opacity": {
      // Fill (+ Stroke) Opacity, so it multiplies Type On's Opacity like
      // toolbox's alpha product.
      const set = (v: number): PropValues => (stroke ? { "ADBE Text Fill Opacity": v, "ADBE Text Stroke Opacity": v } : { "ADBE Text Fill Opacity": v });
      const lo = n(mm.min);
      const hi = n(mm.max);
      if (hi === 1) return { vary: set(100 * lo), complement: true };
      if (lo === 1) return { vary: set(100 * hi), complement: false };
      return { base: set(100 * lo), vary: set(100 * hi), complement: false };
    }
    case "position": {
      const lo = mm.min as number[];
      const hi = mm.max as number[];
      const pos = (x: number, y: number): PropValues => ({ "ADBE Text Position 3D": [x, y, 0] });
      // Rest at max: the offset is min·(1 − t').
      if (!hi[0] && !hi[1] && (lo[0] || lo[1])) return { vary: pos(K * lo[0], K * lo[1]), complement: true };
      return { ...(lo[0] || lo[1] ? { base: pos(lo[0], lo[1]) } : {}), vary: pos(K * (hi[0] - lo[0]), K * (hi[1] - lo[1])), complement: false };
    }
    case "rotation":
    case "tracking": {
      const lo = n(mm.min);
      const hi = n(mm.max);
      const val = (v: number): PropValues => (k === "rotation" ? { "ADBE Text Rotation": v } : { "ADBE Text Track Type": 3, "ADBE Text Tracking Amount": v });
      if (!hi && lo) return { vary: val(K * lo), complement: true };
      return { ...(lo ? { base: val(lo) } : {}), vary: val(K * (hi - lo)), complement: false };
    }
    case "scale": {
      const lo = n(mm.min);
      const hi = n(mm.max);
      const sc = (f: number): PropValues => ({ "ADBE Text Scale 3D": [100 * f, 100 * f, 100] });
      if (lo === 1) return { vary: sc(1 + K * (hi - 1)), complement: false };
      if (hi === 1) return { vary: sc(1 + K * (lo - 1)), complement: true };
      if (lo !== 0) return { base: sc(lo), vary: sc(1 + K * (hi / lo - 1)), complement: false };
      if (hi !== 0) return { base: sc(hi), vary: sc(1 - K), complement: true };
      return { base: sc(0), vary: sc(1), complement: false };
    }
    case "color":
    default: {
      const lo = rgbOf(mm.min as string);
      const hi = rgbOf(mm.max as string);
      const isFill = (c: AeRGB) => c.every((v, i) => Math.abs(v - baseFill[i]) < 1e-9);
      // The text's own fill at one end: one animator, toward the other end.
      if (isFill(lo)) return { vary: { "ADBE Text Fill Color": hi }, complement: false };
      if (isFill(hi)) return { vary: { "ADBE Text Fill Color": lo }, complement: true };
      return { base: { "ADBE Text Fill Color": lo }, vary: { "ADBE Text Fill Color": hi }, complement: false };
    }
  }
}

function rgbOf(hex: string): AeRGB {
  const c = colorToRgba(hex);
  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}

function emitAnimator(scope: Scope, id: string, k: AnimProp, anim: TextAnimators, ac: AnimCtx): AeTextAnimator[] {
  const { ctx, clock } = scope;
  const c = anim[k]! as TextAnimators["opacity"] & { driver?: string; min?: unknown; max?: unknown };
  const label = ANIM_LABEL[k];
  const by = c.by;
  const basedOn = by === "word" ? "words" : "characters";
  const drive: TextDriveConfig = {
    driver: k === "typeon" ? "cascade" : c.driver === "cascade" ? "cascade" : "uniform",
    direction: c.direction,
    softness: c.softness,
    seed: c.seed,
    easing: c.easing,
    easeIntensity: c.easeIntensity,
    curve: c.curve,
  };
  // Overshooting easings: the property carries the headroom, the selection
  // is divided by it (AE clamps a selection to ±100 %).
  const K = k === "position" || k === "rotation" || k === "tracking" || k === "scale" ? easeHeadroom(drive) : 1;
  if (K > 1) ctx.report.note(id, `${label} animator: ${drive.easing} overshoots to ${K.toFixed(3)} — the animator's value carries the overshoot, the selector reaches 100 / ${K.toFixed(3)} %`);

  // min / max (keyed → per-frame property values).
  const mmParams = k === "typeon" ? [] : k === "position" ? ["minX", "maxX", "minY", "maxY"] : ["min", "max"];
  const mmAt = (tick: number | null) => {
    const get = (s: string, fb: number) => (tick === null ? staticNumber(ctx, id, `anim_${k}_${s}`, fb) : valueOfSource(ctx, { node: id, param: `anim_${k}_${s}`, fallback: fb }, tick));
    if (k === "position") return { min: [get("minX", 0), get("minY", 0)], max: [get("maxX", 0), get("maxY", 0)] };
    if (k === "color") return { min: String(ctx.graph.params(id).anim_color_min ?? "#ffffff"), max: String(ctx.graph.params(id).anim_color_max ?? "#ffffff") };
    if (k === "typeon") return { min: 0, max: 1 };
    return { min: get("min", k === "opacity" || k === "scale" ? 1 : 0), max: get("max", k === "opacity" || k === "scale" ? 1 : 0) };
  };
  if (k === "color" && (isAnimatedParam(ctx, id, "anim_color_min") || isAnimatedParam(ctx, id, "anim_color_max"))) throw new BakeSignal("animated color animator min / max");
  const keyedMm = mmParams.some((s) => isAnimatedParam(ctx, id, `anim_${k}_${s}`));
  const split0 = splitProp(k, mmAt(null), K, ac.stroke, ac.baseFill);
  let base: Record<string, AeProp> | undefined;
  let vary: Record<string, AeProp>;
  if (!keyedMm) {
    base = split0.base ? asProps(split0.base) : undefined;
    vary = asProps(split0.vary);
  } else {
    // Sample both parts per frame on the same branch of the split.
    const [f0, f1] = windowFrames(clock);
    const frames: { f: number; s: ReturnType<typeof splitProp> }[] = [];
    for (let f = f0; f <= f1; f++) {
      const s = splitProp(k, mmAt(localTick(scope, f)), K, ac.stroke, ac.baseFill);
      if (s.complement !== split0.complement || !!s.base !== !!split0.base) throw new BakeSignal(`animated ${k} animator min / max crosses the property's rest value`);
      frames.push({ f, s });
    }
    const track = (pick: (s: ReturnType<typeof splitProp>) => PropValues | undefined): Record<string, AeProp> | undefined => {
      const first = pick(frames[0].s);
      if (!first) return undefined;
      const out: Record<string, AeProp> = {};
      for (const m of Object.keys(first)) {
        const vals = frames.map((x) => pick(x.s)![m]);
        const vec = Array.isArray(vals[0]);
        const same = vals.every((v) => JSON.stringify(v) === JSON.stringify(vals[0]));
        out[m] = same
          ? { v: vals[0] }
          : { keys: frames.map((x, i) => ({ t: x.f / ctx.fps, v: vals[i], inInterp: "linear" as const, outInterp: "linear" as const })), dims: (vec ? (vals[0] as number[]).length : 1) as 1 | 2 | 3 };
      }
      return out;
    };
    base = track((s) => s.base);
    vary = track((s) => s.vary)!;
    ctx.report.sampled(id, `${label} animator: animated min / max → per-frame animator values`);
  }
  const complement = split0.complement;

  // The varying part's selector.
  const amountParam = `anim_${k}_amount`;
  // Tracking by word: AE's Words leave the spaces out (measured), so the
  // selector runs on characters and reads toolbox's words from the text.
  const wordsFromText = k === "tracking" && by === "word";
  const req = { ...drive, total: ac.total, complement, headroom: K, fidelity: ctx.policy.fidelity, tolerance: TEXT_EASE_FIT_TOLERANCE, wordsFromText };
  const plan: AeSelectorPlan = planTextSelector(req);
  let selectors: AeTextSelector[];
  if (plan.route === "expression" || (plan.route === "range" && !ac.fixedTotal)) {
    // A Range Selector's ends depend on the unit count: a text that changes
    // length needs textTotal.
    const reason = plan.route === "expression" ? plan.reason : "the text's length changes";
    selectors = [{ kind: "expression", basedOn: wordsFromText ? "characters" : basedOn, amount: scalarProp(ctx, clock, id, amountParam, { map: { scale: 100, offset: 0 }, fallback: 1, label: `${label} amount` }), expression: plan.route === "expression" ? plan.expression : textSelectorExpression(req) }];
    ctx.report.note(id, `${label} animator: an Expression Selector replays toolbox's ${drive.direction} cascade (${reason}); its Amount carries the amount`);
  } else if (plan.route === "uniform") {
    const linear = isLinearEase(drive) && K === 1;
    let amount: AeProp<number>;
    if (linear) amount = scalarProp(ctx, clock, id, amountParam, { map: complement ? { scale: -100, offset: 100 } : { scale: 100, offset: 0 }, fallback: 1, label: `${label} amount` });
    else if (!isAnimatedParam(ctx, id, amountParam)) amount = { v: selPct(drive, staticNumber(ctx, id, amountParam, 1), complement, K) };
    else {
      const src = driverOf(ctx, id, amountParam);
      if (src) markDriven(ctx, id, amountParam, src, `${label} amount: driven by ${src} → per-frame keys`);
      ctx.report.sampled(id, `${label} animator: eased uniform amount → the selector's Amount per frame`);
      amount = scalarOf(sampledTrackToAe(windowFrames(clock), (tick) => [selPct(drive, amountAt(scope, id, amountParam, tick), complement, K)], keyCtx(ctx, clock)).prop);
    }
    selectors = [{ ...everyUnit(basedOn), amount }];
    ctx.report.note(id, `${label} animator: uniform → a Range Selector over every ${by === "word" ? "word" : "character"}, Amount = the drive`);
  } else {
    selectors = plan.selectors.map((s) => ({
      basedOn,
      units: "index" as const,
      start: { v: s.start },
      end: { v: s.end },
      offset: scalarProp(ctx, clock, id, amountParam, { map: { scale: s.offsetPerAmount, offset: 0 }, fallback: 1, label: `${label} amount` }),
      shape: s.shape,
      easeHigh: { v: plan.easeHigh },
      easeLow: { v: plan.easeLow },
      ...(s.mode !== "add" ? { mode: s.mode } : {}),
      ...(plan.amount !== 100 ? { amount: { v: plan.amount } } : {}),
    }));
    const how = `${drive.direction} cascade → ${plan.selectors.length > 1 ? `two Range Selectors (${plan.selectors[1].mode})` : "a Range Selector"} in index units, the amount on Offset`;
    if (plan.error > 1e-4) ctx.report.approx(id, `${label} animator: ${how}; ${drive.easing} as Ease High ${plan.easeHigh} / Low ${plan.easeLow} (within ${(plan.error * 100).toFixed(2)}% of the property's range)`);
    else ctx.report.note(id, `${label} animator: ${how} (exact)`);
  }
  const out: AeTextAnimator[] = [];
  if (base) out.push({ name: `${label} base`, properties: base, selector: everyUnit(basedOn) });
  out.push({ name: label, properties: vary, selectors });
  return out;
}

function asProps(v: PropValues): Record<string, AeProp> {
  const out: Record<string, AeProp> = {};
  for (const [m, x] of Object.entries(v)) out[m] = { v: x };
  return out;
}

// The selection percent for a uniform drive at amount a.
function selPct(c: TextDriveConfig, a: number, complement: boolean, K: number): number {
  const t = toolboxEase(c, clamp01(a));
  return (100 * (complement ? 1 - t : t)) / K;
}

function amountAt(scope: Scope, id: string, param: string, tick: number): number {
  const { ctx } = scope;
  const src = driverOf(ctx, id, param);
  if (src) return numbersOf(ctx.graph.valueAt(src, tick))?.[0] ?? 1;
  const b = ctx.graph.block(id, param);
  return b && b.keyframes.length > 1 ? evalBlock(b, tick, 1) : staticNumber(ctx, id, param, 1);
}
