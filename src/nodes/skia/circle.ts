import type { NodeDefinition, SkiaDrawValue } from "@/engine/types";
import { mirrorParams } from "@/engine/skia/library";
import { circleNode } from "../source/circle";
import { canvas01Of, groupOf, primitivePaints, scaledParam, shapesOf, withCanvasOffset } from "./primitive";

// Circle (Skia) — Circle's params, drawn as React Native Skia's own
// <Oval> (an ellipse when the radii differ) instead of a sampled path. The
// oval sits at the local origin of a <Group> translated to the center, so
// every value is one param × the canvas width: centerX/Y → the group's
// translate, radiusX/Y → the oval's rect (−r·W, −r·W, 2r·W, 2r·W). Keyframed
// or driven, each exports as an exact track (BindRef.scale).
//
// Skia draws the true conic ellipse; Circle's spline is a 4-cubic
// approximation (< 0.03% of the radius off), which only moves anti-aliased
// edge pixels.

export const skiaCircleNode: NodeDefinition = {
  type: "skia-circle",
  name: "Circle (Skia)",
  category: "spline",
  subcategory: "generator",
  description:
    "Skia-layer Circle: Circle's params (center and radii in canvas01, stroke / fill) drawn as a React Native Skia <Oval> whose center and radii export as exact timeline tracks. Wire it into Skia Group or Skia Canvas.",
  searchAliases: ["circle", "ellipse", "oval", "skia", "react native"],
  facts: {
    space: {
      out: "pixels",
      "param:centerX": "canvas01",
      "param:centerY": "canvas01",
      "param:radiusX": "canvas01",
      "param:radiusY": "canvas01",
      "param:stroke_thickness": "pixels",
    },
    gotchas: [
      "Same units as Circle: both axes scale by the canvas width (y shifted about the middle), so equal radii draw a true circle on any canvas.",
      "Fill draws first, then the stroke over it, centered on the outline with round caps; stroke_units=% makes stroke_thickness a percent of canvas width.",
      "opacity fades each draw separately (React Native Skia paint opacity): below 1 the fill shows through the stroke, where Circle fades the composite.",
      "No trim, fill image or transform input: for those use Circle → Skia Shape, whose path is sampled per frame when it animates.",
      "A radius keyed below 0 (an overshooting ease) clamps to 0 like Circle; the export then samples that bind per frame instead of shipping a track.",
    ],
  },
  backend: "webgl2",
  skia: { class: "native", mirrors: "circle" },
  noMaskInput: true,
  inputs: [],
  params: mirrorParams(circleNode, [
    "centerX",
    "centerY",
    "radiusX",
    "radiusY",
    "stroke_enabled",
    "stroke_thickness",
    "stroke_units",
    "stroke_color",
    "fill_enabled",
    "fill_color",
    "opacity",
  ]),
  linkedPairs: [{ a: "radiusX", b: "radiusY" }],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ params, ctx, nodeId }) {
    const c = canvas01Of(ctx);
    const W = c.W;
    const oval = () => ({
      k: "oval" as const,
      x: scaledParam(nodeId, params, "radiusX", 0.25, -W, true),
      y: scaledParam(nodeId, params, "radiusY", 0.25, -W, true),
      w: scaledParam(nodeId, params, "radiusX", 0.25, 2 * W, true),
      h: scaledParam(nodeId, params, "radiusY", 0.25, 2 * W, true),
    });
    const inner = groupOf(nodeId, shapesOf(nodeId, primitivePaints(nodeId, params, c, { fill: true }), oval), {
      translate: [scaledParam(nodeId, params, "centerX", 0.5, W), scaledParam(nodeId, params, "centerY", 0.5, W)],
    });
    const out: SkiaDrawValue = { kind: "skia_draw", node: withCanvasOffset(nodeId, inner, c) };
    return { primary: out };
  },
};
