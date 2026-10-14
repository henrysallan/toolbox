import type { NodeDefinition, SkiaDrawValue } from "@/engine/types";
import { OPACITY_PARAM } from "@/engine/conventions";
import { bindDerived, bindParam, bindStatic, type Bind, type BindRef, type PaintIR, type SkiaNode } from "@/engine/skia/scene-ir";
import { hexToRgba01 } from "@/engine/spline-fill";
import { strokeUnitsParam } from "@/engine/stroke-units";
import { bindScaled, num, unitScale } from "./paint-shared";
import { SKIA_FONT_FAMILIES, SKIA_FONTS, canvasMiddleToAlphabetic, paragraphLineBox } from "./fonts";

// Text (Skia) — the Skia-layer mirror of the Text node's core: string,
// font, size (px or % of the canvas width), color, opacity, alignment, the
// centered text box (boxWidth / boxHeight, translateX / Y in uv01) and
// word-wrap in the box. It lays the text out where the Text node does —
// as Chromium's Canvas2D draws it (textBaseline "middle": each line's
// middle is placed, the alphabetic baseline sits canvasMiddleToAlphabetic
// below it) — and emits `text` IR:
//
//   shaping = paragraph (default)  every line is a React Native Skia
//     <Paragraph> (SkParagraph: HarfBuzz shaping, kerning — the advances
//     Chromium's canvas gives the Text node, to 0.01 px). Unwrapped lines
//     are one-line paragraphs on a wide layout box anchored at the line's
//     alignment point, each placed at its own baseline, so `leading`
//     works. With wrap on, the whole text is ONE paragraph laid out to the
//     box width: lines then sit the font's own line height apart (Geist
//     1.3 em, Inter 1.21 em, rounded to whole px) and the block hangs from
//     the box top — the wrapped height is only known after shaping, which
//     the IR can't anchor on.
//   shaping = line   every line is a React Native Skia <Text>: one simple
//     run (no kerning, no ligatures, whole-pixel advances), cheaper, a few
//     px narrower or wider than the Text node over a long line.
//
// Fonts are the bundled files in fonts.ts, shipped as scene assets — never
// a system font. Text on a path, gradient / image fills, the in-raster
// stroke, letter spacing, case, variable axes, animators and the
// post-transform (scale / rotate / pivot) are not part of this node: put a
// Skia Group around it to scale or rotate.

// The layout box unwrapped lines are anchored in: wide enough that no line
// wraps, an integer (SkParagraph floors the layout width), small enough
// that float32 keeps the anchor to ~0.002 px.
const NOWRAP_WIDTH = 32768;

const ALIGN = ["left", "center", "right"] as const;
const VALIGN = ["top", "middle", "bottom"] as const;
type Align = (typeof ALIGN)[number];

const pick = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);

export const skiaTextNode: NodeDefinition = {
  type: "skia-text",
  name: "Text (Skia)",
  category: "image",
  subcategory: "generator",
  description:
    "Draws text in a Skia layer with a bundled font, laid out like the Text node (centered text box, alignment, vertical alignment, leading, wrap in box), as React Native Skia <Paragraph>s (shaped and kerned) or simple <Text> runs. Wire it into Skia Group or Skia Canvas.",
  searchAliases: ["skia", "text", "type", "paragraph", "label", "react native"],
  facts: {
    space: {
      out: "pixels",
      "param:font_size": "pixels",
      "param:boxWidth": "uv01",
      "param:boxHeight": "uv01",
      "param:translateX": "uv01",
      "param:translateY": "uv01",
    },
    gotchas: [
      "Fonts are the bundled files only (Geist, Inter's default instance); the font ships with the export as an asset.",
      "boxWidth/boxHeight are uv01 fractions of the canvas, the box centered and moved by translateX/Y, exactly like the Text node; there is no rotate / scale here (wrap it in a Skia Group).",
      "wrap=true lays the text out as one paragraph: lines sit the font's own line height apart (leading is ignored) and the block hangs from the box top (vAlign is ignored).",
      "shaping=line draws React Native <Text> runs: no kerning, so long lines drift a few px from the Text node; paragraph shaping matches its advances.",
      "Text with \"\\n\" draws one paragraph (or run) per line unwrapped: an export needs the line count to stay constant over the scene.",
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
    {
      name: "font_size",
      label: "Size",
      type: "scalar",
      min: 4,
      max: 1000,
      softMax: 200,
      step: 1,
      default: 96,
    },
    strokeUnitsParam("units", undefined, { governs: ["font_size"] }),
    { name: "color", label: "Color", type: "color", default: "#ffffff", alpha: true },
    { name: "alignment", label: "Align", type: "enum", options: [...ALIGN], default: "center" },
    {
      name: "vAlign",
      label: "Vertical align",
      type: "enum",
      options: [...VALIGN],
      default: "middle",
      visibleIf: (p) => p.wrap !== true,
    },
    {
      name: "leading",
      label: "Leading",
      type: "scalar",
      min: 0.5,
      max: 3,
      step: 0.01,
      default: 1.2,
      visibleIf: (p) => p.wrap !== true,
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
    const face = SKIA_FONTS[pick(params.font_family, SKIA_FONT_FAMILIES, "Inter")];
    const u = unitScale(params.units, W);
    const size = Math.max(0.01, num(params.font_size, 96) * u);
    const text = typeof params.text === "string" ? params.text : "";
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
    const anchorX = originX + boxW * k;
    const middleToBaseline = canvasMiddleToAlphabetic(face, size);
    const box = paragraphLineBox(face, size);

    const ref = (param: string): BindRef => ({ node: nodeId, param });
    const layoutDeps = ["font_size", "units", "leading", "boxWidth", "boxHeight", "translateX", "translateY", "text"].map(ref);
    const placed = (v: number): Bind<number> => bindDerived(v, layoutDeps);
    const paint: PaintIR = {
      style: "fill",
      color: bindParam(hexToRgba01((params.color as string) ?? "#ffffff"), nodeId, "color"),
      opacity: bindParam(num(params.opacity, 1), nodeId, "opacity"),
      antiAlias: true,
    };
    const font = { asset: face.asset.id, size: bindScaled(size, nodeId, "font_size", u) };

    const children: SkiaNode[] = [];
    if (wrap) {
      // One paragraph in the box; its first line where a Text node with
      // leading = the font's line height puts it, vAlign top. SkParagraph
      // aligns inside floor(width): shift by what the floor took.
      const lineH = box.height;
      const baseline0 = originY + lineH / 2 + middleToBaseline;
      children.push({
        k: "text",
        id: nodeId,
        text: bindParam(text, nodeId, "text"),
        font,
        x: placed(originX + (boxW - Math.floor(boxW)) * k),
        y: placed(baseline0 - box.baseline),
        width: { v: boxW, ref: { node: nodeId, param: "boxWidth", scale: W } },
        align,
        paint,
      });
    } else {
      const lines = text.split("\n");
      const lineH = size * num(params.leading, 1.2);
      const total = Math.max(1, lines.length) * lineH;
      const blockTop = vAlign === "top" ? originY : vAlign === "bottom" ? originY + boxH - total : originY + boxH / 2 - total / 2;
      lines.forEach((line, i) => {
        const baseline = blockTop + lineH / 2 + i * lineH + middleToBaseline;
        const t = bindDerived(line, [ref("text")]);
        children.push(
          paragraph
            ? {
                k: "text",
                id: nodeId,
                text: t,
                font,
                x: placed(anchorX - NOWRAP_WIDTH * k),
                y: placed(baseline - box.baseline),
                width: bindStatic(NOWRAP_WIDTH),
                align,
                paint,
              }
            : { k: "text", id: nodeId, text: t, font, x: placed(anchorX), y: placed(baseline), align, paint }
        );
      });
    }
    const out: SkiaDrawValue = {
      kind: "skia_draw",
      node: children.length === 1 ? children[0] : { k: "group", id: nodeId, children },
      assets: { [face.asset.id]: face.asset },
    };
    return { primary: out };
  },
};
