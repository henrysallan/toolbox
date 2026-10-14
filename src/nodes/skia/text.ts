import type { NodeDefinition, SkiaDrawValue } from "@/engine/types";
import { OPACITY_PARAM } from "@/engine/conventions";
import { bindDerived, bindParam, bindStatic, type Bind, type BindRef, type PaintIR, type SkiaNode } from "@/engine/skia/scene-ir";
import { hexToRgba01 } from "@/engine/spline-fill";
import { strokeUnitsParam, unitsRangeHints } from "@/engine/stroke-units";
import { applyTextCase } from "../source/text";
import { bindScaled, num, unitScale } from "./paint-shared";
import { SKIA_FONT_FAMILIES, canvasMiddleToAlphabetic, resolveSkiaTextFace } from "./fonts";

// Text (Skia) — the Skia-layer mirror of the Text node's core, with its
// param names: string, case, font (family / Custom font / weight / italic),
// size + letter spacing (px or % of the canvas width), color, opacity,
// alignment, vertical alignment, leading, the centered text box (boxWidth /
// boxHeight, translateX / Y in uv01) and word-wrap in the box. It lays the
// text out where the Text node does — as Chromium's Canvas2D draws it
// (textBaseline "middle": each line's middle sits leading × size below the
// last, the alphabetic baseline canvasMiddleToAlphabetic below that) — and
// emits `text` IR (scene-ir.ts):
//
//   shaping = paragraph (default)  the whole text is ONE paragraph
//     (SkParagraph: HarfBuzz shaping, kerning — Chromium's advances to
//     0.01 px). SkParagraph breaks it (at the box width with wrap on, else
//     only at "\n") and places each line horizontally; every line is then
//     drawn `lineHeight` = leading × size below the last, the block anchored
//     at the box's top / middle / bottom by vAlign, each baseline
//     `baselineOffset` = lineHeight / 2 + the middle → alphabetic offset into
//     its line box. So leading and vAlign hold for wrapped text too, whose
//     line count only shaping knows.
//   shaping = line   every line is a React Native Skia <Text>: one simple
//     run (no kerning, no ligatures, no letter spacing), cheaper, a few px
//     narrower or wider than the Text node over a long line.
//
// Fonts (fonts.ts): Inter and Geist ship with toolbox (OFL); a Custom font
// ships as its uploaded bytes. Any other family, a weight the face can't
// draw, italic, or a variable-font axis refuses the export with the reason
// (the preview draws Inter / the default instance meanwhile).
//
// Text on a path, gradient / image fills, the in-raster stroke, animators
// and the post-transform (scale / rotate / pivot) are not part of this node:
// put a Skia Group around it to scale or rotate.

// The layout box unwrapped text is laid out in: wide enough that no line
// wraps, an integer (SkParagraph floors the layout width), small enough
// that float32 keeps the anchor to ~0.002 px.
const NOWRAP_WIDTH = 32768;

const ALIGN = ["left", "center", "right"] as const;
const VALIGN = ["top", "middle", "bottom"] as const;
const CASES = ["none", "upper", "lower", "title"] as const;
type Align = (typeof ALIGN)[number];

// The governed metrics (the Text node's TEXT_UNITS_GOVERNS minus its stroke).
const UNITS_GOVERNS = ["font_size", "letter_spacing"];

const pick = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);

export const skiaTextNode: NodeDefinition = {
  type: "skia-text",
  name: "Text (Skia)",
  category: "image",
  subcategory: "generator",
  description:
    "Draws text in a Skia layer with a font that ships in the export (Inter, Geist or an uploaded Custom font), laid out like the Text node (centered text box, alignment, vertical alignment, leading, letter spacing, case, wrap in box), as React Native Skia paragraphs (shaped and kerned) or simple <Text> runs. Wire it into Skia Group or Skia Canvas.",
  searchAliases: ["skia", "text", "type", "paragraph", "label", "react native", "font"],
  facts: {
    space: {
      out: "pixels",
      "param:font_size": "pixels",
      "param:letter_spacing": "pixels",
      "param:boxWidth": "uv01",
      "param:boxHeight": "uv01",
      "param:translateX": "uv01",
      "param:translateY": "uv01",
    },
    gotchas: [
      "Only shipped fonts draw: Inter, Geist (bundled, OFL) or a Custom font upload (its bytes ship). Any other font_family refuses the export; the preview draws Inter.",
      "Variable fonts draw their default instance (Inter: opsz 14, wght 400): React Native's native text ignores font axes, so font_weight must be the default and font_variations unset.",
      "The Text node draws variable fonts at their default optical size too (no automatic opsz), so Inter matches it at every size, as Geist (static) does.",
      "boxWidth/boxHeight are uv01 fractions of the canvas, the box centered and moved by translateX/Y, exactly like the Text node; there is no rotate / scale here (wrap it in a Skia Group).",
      "Paragraph shaping puts each line leading × size below the last and anchors the block by vAlign, wrapped too; SkParagraph picks the breaks (greedy, but it keeps runs of spaces).",
      "shaping=line draws React Native <Text> runs: no kerning and no letter spacing, so long lines drift a few px from the Text node; paragraph shaping matches its advances.",
    ],
  },
  backend: "webgl2",
  skia: { class: "native", mirrors: "text" },
  noMaskInput: true,
  inputs: [],
  params: [
    OPACITY_PARAM,
    { name: "text", label: "Text", type: "string", multiline: true, default: "Hello", placeholder: "type here…" },
    { name: "font_family", label: "Font", type: "enum", options: SKIA_FONT_FAMILIES, default: "Inter" },
    // The Text node's upload slot: when set it wins over font_family and its
    // bytes ship with the export.
    { name: "custom_font", label: "Custom font", type: "font", default: null },
    {
      name: "font_size",
      label: "Size",
      type: "scalar",
      min: 4,
      max: 1000,
      softMax: 200,
      step: 1,
      default: 96,
      ...unitsRangeHints("units", { min: 0.1, max: 100, softMax: 20, step: 0.1 }),
    },
    strokeUnitsParam("units", undefined, { governs: UNITS_GOVERNS }),
    { name: "font_weight", label: "Weight", type: "scalar", min: 100, max: 900, step: 1, default: 400 },
    { name: "italic", label: "Italic", type: "boolean", default: false },
    { name: "color", label: "Color", type: "color", default: "#ffffff", alpha: true },
    { name: "alignment", label: "Align", type: "enum", options: [...ALIGN], default: "center" },
    { name: "vAlign", label: "Vertical align", type: "enum", options: [...VALIGN], default: "middle" },
    { name: "textCase", label: "Case", type: "enum", options: [...CASES], default: "none" },
    { name: "leading", label: "Leading", type: "scalar", min: 0.5, max: 3, step: 0.01, default: 1.2 },
    {
      name: "letter_spacing",
      label: "Letter spacing",
      type: "scalar",
      min: -10,
      max: 40,
      step: 0.5,
      default: 0,
      ...unitsRangeHints("units", { min: -1, max: 4, step: 0.05 }),
    },
    { name: "boxWidth", label: "Box width", type: "scalar", min: 0.01, max: 2, softMax: 1, step: 0.001, default: 1 },
    { name: "boxHeight", label: "Box height", type: "scalar", min: 0.01, max: 2, softMax: 1, step: 0.001, default: 1 },
    { name: "wrap", label: "Wrap in box", type: "boolean", default: false },
    {
      name: "shaping",
      label: "Shaping",
      type: "enum",
      options: ["paragraph", "line"],
      optionLabels: { paragraph: "Paragraph (kerned)", line: "Simple runs" },
      default: "paragraph",
      visibleIf: (p) => p.wrap !== true,
    },
    { name: "translateX", label: "Translate X", type: "scalar", min: -2, max: 2, step: 0.001, default: 0 },
    { name: "translateY", label: "Translate Y", type: "scalar", min: -2, max: 2, step: 0.001, default: 0 },
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ params, ctx, nodeId }) {
    const W = ctx.width;
    const H = ctx.height;
    const { face, problems } = resolveSkiaTextFace(params);
    const u = unitScale(params.units, W);
    const size = Math.max(0.01, num(params.font_size, 96) * u);
    const spacing = num(params.letter_spacing, 0) * u;
    const caseMode = pick(params.textCase, CASES, "none");
    const raw = typeof params.text === "string" ? params.text : "";
    const text = applyTextCase(raw, caseMode);
    const align: Align = pick(params.alignment, ALIGN, "center");
    const vAlign = pick(params.vAlign, VALIGN, "middle");
    const wrap = params.wrap === true;
    const paragraph = wrap || params.shaping !== "line";

    // The Text node's box: centered, then moved by the post-transform's
    // translate (uv01 of each axis; +y is down on screen).
    const boxW = Math.max(1, Math.min(2, num(params.boxWidth, 1)) * W);
    const boxH = Math.max(1, Math.min(2, num(params.boxHeight, 1)) * H);
    const originX = W / 2 - boxW / 2 + num(params.translateX, 0) * W;
    const originY = H / 2 - boxH / 2 + num(params.translateY, 0) * H;
    const k = align === "left" ? 0 : align === "right" ? 1 : 0.5;
    const kv = vAlign === "top" ? 0 : vAlign === "bottom" ? 1 : 0.5;
    const anchorX = originX + boxW * k;
    const lineH = size * num(params.leading, 1.2);
    const middleToBaseline = canvasMiddleToAlphabetic(face, size);

    const ref = (param: string): BindRef => ({ node: nodeId, param });
    const layoutDeps = ["font_size", "units", "leading", "boxWidth", "boxHeight", "translateX", "translateY", "text", "textCase"].map(ref);
    const placed = (v: number): Bind<number> => bindDerived(v, layoutDeps);
    const metric = (v: number): Bind<number> => bindDerived(v, ["font_size", "units", "leading"].map(ref));
    const paint: PaintIR = {
      style: "fill",
      color: bindParam(hexToRgba01((params.color as string) ?? "#ffffff"), nodeId, "color"),
      opacity: bindParam(num(params.opacity, 1), nodeId, "opacity"),
      antiAlias: true,
    };
    const font = { asset: face.asset.id, size: bindScaled(size, nodeId, "font_size", u) };
    const textBind = (v: string): Bind<string> => (caseMode === "none" ? bindParam(v, nodeId, "text") : bindDerived(v, [ref("text"), ref("textCase")]));

    const children: SkiaNode[] = [];
    if (paragraph) {
      // One paragraph: SkParagraph breaks and aligns the lines inside
      // `width` (it aligns inside floor(width): shift by what the floor
      // took); the renderer stacks them lineHeight apart from the vAlign
      // edge of the box.
      const width: Bind<number> = wrap ? { v: boxW, ref: { node: nodeId, param: "boxWidth", scale: W } } : bindStatic(NOWRAP_WIDTH);
      // SkParagraph spaces letters half before, half after each glyph;
      // Chromium all after (the line widths agree): move back by half.
      const x = (wrap ? originX + (boxW - Math.floor(boxW)) * k : anchorX - NOWRAP_WIDTH * k) - spacing / 2;
      children.push({
        k: "text",
        id: nodeId,
        text: textBind(text),
        font,
        x: bindDerived(x, [...layoutDeps, ref("letter_spacing")]),
        y: placed(originY + boxH * kv),
        width,
        align,
        paint,
        lineHeight: metric(lineH),
        anchor: vAlign,
        baselineOffset: metric(lineH / 2 + middleToBaseline),
        letterSpacing: bindScaled(spacing, nodeId, "letter_spacing", u),
      });
    } else {
      if (spacing !== 0) problems.push("Simple runs (shaping = line) can't space letters — use Paragraph shaping for letter spacing.");
      const lines = text.split("\n");
      const total = Math.max(1, lines.length) * lineH;
      const blockTop = originY + (boxH - total) * kv;
      lines.forEach((line, i) => {
        const baseline = blockTop + lineH / 2 + i * lineH + middleToBaseline;
        const t = bindDerived(line, [ref("text"), ref("textCase")]);
        children.push({ k: "text", id: nodeId, text: t, font, x: placed(anchorX), y: placed(baseline), align, paint });
      });
    }
    const out: SkiaDrawValue = {
      kind: "skia_draw",
      node: children.length === 1 ? children[0] : { k: "group", id: nodeId, children },
      assets: { [face.asset.id]: face.asset },
      ...(problems.length ? { problems: [...new Set(problems)] } : {}),
    };
    return { primary: out };
  },
};
