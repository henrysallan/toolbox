import type {
  NodeDefinition,
  SplineAnchor,
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

// Arrow outline (shaft rectangle + triangular head) as a closed 7-point spline
// aimed from `tail` to `tip`. Shaft thickness, head length, and head width are
// in normalized units. Fillable; stroked by default like the other primitives.
// Normalized [0,1]² Y-DOWN.

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function makeArrowSubpath(
  tail: [number, number],
  tip: [number, number],
  shaft: number,
  headLen: number,
  headWid: number
): SplineSubpath {
  let dx = tip[0] - tail[0];
  let dy = tip[1] - tail[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    // Degenerate (tail == tip): emit a tiny dot so downstream stays valid.
    return { anchors: [{ pos: tail }], closed: false };
  }
  dx /= len;
  dy /= len;
  const px = -dy; // perpendicular
  const py = dx;
  // Don't let the head be longer than the whole arrow.
  const hl = Math.min(headLen, len);
  const hs = shaft / 2;
  const hw = headWid / 2;
  // Base of the head, where it meets the shaft.
  const bx = tip[0] - dx * hl;
  const by = tip[1] - dy * hl;
  // 7-point outline: tail +side, around the head, back to tail −side.
  const anchors: SplineAnchor[] = [
    { pos: [tail[0] + px * hs, tail[1] + py * hs] }, // tail, +side
    { pos: [bx + px * hs, by + py * hs] }, // head base, +shaft
    { pos: [bx + px * hw, by + py * hw] }, // head base, +wing
    { pos: [tip[0], tip[1]] }, // tip
    { pos: [bx - px * hw, by - py * hw] }, // head base, −wing
    { pos: [bx - px * hs, by - py * hs] }, // head base, −shaft
    { pos: [tail[0] - px * hs, tail[1] - py * hs] }, // tail, −side
  ];
  return { anchors, closed: true };
}

export const arrowNode: NodeDefinition = {
  type: "arrow",
  name: "Arrow",
  category: "spline",
  subcategory: "generator",
  description:
    "Generate an arrow outline as a closed spline — aim it tail→tip and set the shaft thickness and head size.",
  backend: "webgl2",
  inputs: [SPLINE_FILL_INPUT, TRANSFORM_INPUT],
  params: [
    { name: "tailX", label: "Tail X", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.25 },
    { name: "tailY", label: "Tail Y", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "tipX", label: "Tip X", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.75 },
    { name: "tipY", label: "Tip Y", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "shaftThickness", label: "Shaft thickness", type: "scalar", min: 0, max: 0.5, softMax: 0.1, step: 0.001, default: 0.04 },
    { name: "headLength", label: "Head length", type: "scalar", min: 0, max: 1, softMax: 0.25, step: 0.001, default: 0.12 },
    { name: "headWidth", label: "Head width", type: "scalar", min: 0, max: 1, softMax: 0.25, step: 0.001, default: 0.12 },
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
    const tail: [number, number] = [num(params.tailX, 0.25), num(params.tailY, 0.5)];
    const tip: [number, number] = [num(params.tipX, 0.75), num(params.tipY, 0.5)];
    const shaft = Math.max(0, num(params.shaftThickness, 0.04));
    const headLen = Math.max(0, num(params.headLength, 0.12));
    const headWid = Math.max(0, num(params.headWidth, 0.12));
    const out: SplineValue = {
      kind: "spline",
      subpaths: applyTrimParams([makeArrowSubpath(tail, tip, shaft, headLen, headWid)], params),
    };

    return emitSplinePrimitive(ctx, nodeId, out, params, inputs);
  },

  dispose: disposeSplineRasterAux,
};
