import type { NodeDefinition, SkiaDrawValue } from "@/engine/types";
import { bindStatic, type BindXY } from "@/engine/skia/scene-ir";
import { mirrorParams } from "@/engine/skia/library";
import { lineNode } from "../source/line";
import { canvas01Of, groupOf, primitivePaints, scaledParam, shapesOf } from "./primitive";

// Line (Skia) — Line's straight mode, drawn as React Native Skia's own
// <Line>: each endpoint coordinate is one param × the canvas width (the
// y shift of a non-square canvas is a static outer Group), so keyframed or
// driven endpoints export as exact tracks. Stroke only — a straight line
// encloses nothing to fill.

export const skiaLineNode: NodeDefinition = {
  type: "skia-line",
  name: "Line (Skia)",
  category: "spline",
  subcategory: "generator",
  description:
    "Skia-layer Line: a straight segment between Line's two endpoints (canvas01), stroked with round caps as a React Native Skia <Line> whose endpoints export as exact timeline tracks. Wire it into Skia Group or Skia Canvas.",
  searchAliases: ["line", "segment", "stroke", "skia", "react native"],
  facts: {
    space: {
      out: "pixels",
      "param:startX": "canvas01",
      "param:startY": "canvas01",
      "param:endX": "canvas01",
      "param:endY": "canvas01",
      "param:stroke_thickness": "pixels",
    },
    gotchas: [
      "Straight only (Line's mode=straight): for bezier handles use Line → Skia Shape, whose path is sampled per frame when it animates.",
      "Round caps extend the stroke half its width past each endpoint, as Line's raster does; stroke_units=% makes stroke_thickness a percent of canvas width.",
      "No start/end vec2 sockets: expose startX…endY and wire scalars (an Animated Value exports as a track).",
      "Same units as Line: both axes scale by the canvas width, y shifted about the middle on a non-square canvas.",
    ],
  },
  backend: "webgl2",
  skia: { class: "native", mirrors: "line" },
  noMaskInput: true,
  inputs: [],
  params: mirrorParams(lineNode, [
    "startX",
    "startY",
    "endX",
    "endY",
    "stroke_enabled",
    "stroke_thickness",
    "stroke_units",
    "stroke_color",
    "opacity",
  ]),
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ params, ctx, nodeId }) {
    const c = canvas01Of(ctx);
    const W = c.W;
    const line = () => ({
      k: "line" as const,
      p1: [scaledParam(nodeId, params, "startX", 0.25, W), scaledParam(nodeId, params, "startY", 0.5, W)] as BindXY,
      p2: [scaledParam(nodeId, params, "endX", 0.75, W), scaledParam(nodeId, params, "endY", 0.5, W)] as BindXY,
    });
    const shapes = shapesOf(nodeId, primitivePaints(nodeId, params, c, { fill: false }), line);
    // One group either way (stroke_enabled off is an empty drawing, not a
    // different node kind); it carries a non-square canvas's static y shift.
    const node = groupOf(nodeId, shapes, c.off === 0 ? undefined : { translate: [bindStatic(0), bindStatic(c.off)] });
    const out: SkiaDrawValue = { kind: "skia_draw", node };
    return { primary: out };
  },
};
