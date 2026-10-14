import type { NodeDefinition, SkiaDrawValue } from "@/engine/types";
import { mirrorParams } from "@/engine/skia/library";
import { rectangleNode } from "../source/rectangle";
import { canvas01Of, DEG, groupOf, num, primitivePaints, scaledParam, shapesOf, withCanvasOffset } from "./primitive";

// Rectangle (Skia) — Rectangle's params, drawn as React Native Skia's own
// <RoundedRect>. Like Rectangle, (originX, originY) is the CENTER: the rect
// sits centered on the local origin of a <Group> translated there and
// rotated by `rotate` (degrees in the panel, radians in the IR via
// BindRef.scale = π/180), so every value is one param × a constant and
// exports as an exact track. Skia clamps the corner radius to half the
// shorter side exactly as Rectangle does (SkRRect's uniform radius scale).
//
// Round corners only: Rectangle's squircle (Figma's continuous corner) has
// no Skia primitive — Rectangle → Skia Shape draws it as a path.

export const skiaRectNode: NodeDefinition = {
  type: "skia-rect",
  name: "Rectangle (Skia)",
  category: "spline",
  subcategory: "generator",
  description:
    "Skia-layer Rectangle: Rectangle's params (center, size and corner radius in canvas01, rotate, stroke / fill) drawn as a React Native Skia <RoundedRect> whose values export as exact timeline tracks. Wire it into Skia Group or Skia Canvas.",
  searchAliases: ["rectangle", "rect", "square", "rounded", "skia", "react native"],
  facts: {
    space: {
      out: "pixels",
      "param:originX": "canvas01",
      "param:originY": "canvas01",
      "param:width": "canvas01",
      "param:height": "canvas01",
      "param:corner_radius": "canvas01",
      "param:stroke_thickness": "pixels",
    },
    gotchas: [
      "originX/originY is the rectangle's CENTER, as on Rectangle; width, height and corner_radius are fractions of the canvas width on both axes.",
      "rotate spins about the center in degrees, +CW on screen; it exports as a radians track on the group (scale π/180).",
      "corner_radius clamps to half the shorter side (Skia's rule, = Rectangle's); round corners only — squircle corners need Rectangle → Skia Shape.",
      "Fill draws first, then the stroke over it with round joins; stroke_units=% makes stroke_thickness a percent of canvas width.",
      "opacity fades each draw separately (React Native Skia paint opacity): below 1 the fill shows through the stroke, where Rectangle fades the composite.",
      "No trim, fill image or transform input: for those use Rectangle → Skia Shape, whose path is sampled per frame when it animates.",
    ],
  },
  backend: "webgl2",
  skia: { class: "native", mirrors: "rectangle" },
  noMaskInput: true,
  inputs: [],
  params: mirrorParams(rectangleNode, [
    "originX",
    "originY",
    "width",
    "height",
    "corner_radius",
    "rotate",
    "stroke_enabled",
    "stroke_thickness",
    "stroke_units",
    "stroke_color",
    "fill_enabled",
    "fill_color",
    "opacity",
  ]),
  linkedPairs: [{ a: "width", b: "height" }],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ params, ctx, nodeId }) {
    const c = canvas01Of(ctx);
    const W = c.W;
    const rect = () => ({
      k: "rect" as const,
      x: scaledParam(nodeId, params, "width", 0.5, -W / 2, true),
      y: scaledParam(nodeId, params, "height", 0.5, -W / 2, true),
      w: scaledParam(nodeId, params, "width", 0.5, W, true),
      h: scaledParam(nodeId, params, "height", 0.5, W, true),
      r: scaledParam(nodeId, params, "corner_radius", 0, W, true),
    });
    const deg = num(params.rotate, 0);
    const inner = groupOf(nodeId, shapesOf(nodeId, primitivePaints(nodeId, params, c, { fill: true }), rect), {
      translate: [scaledParam(nodeId, params, "originX", 0.5, W), scaledParam(nodeId, params, "originY", 0.5, W)],
      rotate: { v: deg * DEG, ref: { node: nodeId, param: "rotate", scale: DEG } },
    });
    const out: SkiaDrawValue = { kind: "skia_draw", node: withCanvasOffset(nodeId, inner, c) };
    return { primary: out };
  },
};
