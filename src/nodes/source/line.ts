import type {
  NodeDefinition,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import {
  SPLINE_FILL_INPUT,
  TRANSFORM_INPUT,
  SPLINE_RASTER_PARAMS,
  SPLINE_TRIM_PARAMS,
  applyTrimParams,
  emitSplinePrimitive,
  disposeSplineRasterAux,
  resolveSplineRasterAux,
} from "./spline-raster-aux";

// Straight open segment between two endpoints. Two sharp anchors, no
// handles. Normalized [0,1]² Y-DOWN, matching every other spline source.
// Meant to be stroked (fill is degenerate on an open 2-point path).

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function makeLineSubpath(
  ax: number,
  ay: number,
  bx: number,
  by: number
): SplineSubpath {
  return {
    anchors: [{ pos: [ax, ay] }, { pos: [bx, by] }],
    closed: false,
  };
}

export const lineNode: NodeDefinition = {
  type: "line",
  name: "Line",
  category: "spline",
  subcategory: "generator",
  description:
    "Generate a straight line as an open spline — set the two endpoints. Authored in [0,1]² Y-down; the rasterizer scales y about 0.5 by W/H so lengths stay width-relative.",
  searchAliases: ["segment", "line segment"],
  facts: {
    space: {
      "param:startX": "canvas01",
      "param:startY": "canvas01",
      "param:endX": "canvas01",
      "param:endY": "canvas01",
      "param:stroke_thickness": "pixels",
    },
    gotchas: [
      "stroke_thickness is absolute pixels by default; set stroke_units=% to make it a percentage of canvas width instead, so it scales with output size.",
      "Fill is degenerate on this open 2-anchor path (no enclosed area), so fill_enabled/fill_color have no visible effect; the line only reads as its stroke.",
      "The image aux exists only while stroke_enabled or fill_enabled is on; with both off there is nothing to rasterize and only the spline output carries data.",
      "Wire a transform input (a Gizmo, say) to move/rotate/scale the whole line without touching startX/startY/endX/endY.",
    ],
  },
  backend: "webgl2",
  inputs: [SPLINE_FILL_INPUT, TRANSFORM_INPUT],
  params: [
    { name: "startX", label: "Start X", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.25 },
    { name: "startY", label: "Start Y", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "endX", label: "End X", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.75 },
    { name: "endY", label: "End Y", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    ...SPLINE_TRIM_PARAMS,
    ...SPLINE_RASTER_PARAMS,
  ],
  primaryOutput: "spline",
  auxOutputs: [
    { name: "image", type: "image" },
    { name: "element", type: "element" },
  ],
  resolveAuxOutputs: resolveSplineRasterAux,

  compute({ inputs, params, ctx, nodeId }) {
    const ax = num(params.startX, 0.25);
    const ay = num(params.startY, 0.5);
    const bx = num(params.endX, 0.75);
    const by = num(params.endY, 0.5);
    const out: SplineValue = {
      kind: "spline",
      subpaths: applyTrimParams([makeLineSubpath(ax, ay, bx, by)], params),
    };

    return emitSplinePrimitive(ctx, nodeId, out, params, inputs);
  },

  dispose: disposeSplineRasterAux,
};
