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

// N-point star: 2·points vertices alternating between the outer radius (the
// points) and the inner radius (the valleys), on a circle about the center.
// First point at 12 o'clock (−90°) plus `rotation`. Sharp corner anchors,
// closed. Normalized [0,1]² Y-DOWN; aspect correction keeps it regular.

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function makeStarSubpath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  points: number,
  rotRad: number
): SplineSubpath {
  const p = Math.max(3, Math.floor(points));
  const anchors: SplineAnchor[] = [];
  const start = -Math.PI / 2 + rotRad;
  const step = Math.PI / p; // half a point-to-point spacing
  for (let i = 0; i < p * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = start + i * step;
    anchors.push({ pos: [cx + r * Math.cos(a), cy + r * Math.sin(a)] });
  }
  return { anchors, closed: true };
}

export const starNode: NodeDefinition = {
  type: "star",
  name: "Star",
  category: "spline",
  subcategory: "generator",
  description:
    "Generate an N-point star as a closed spline — set the point count, outer/inner radius, and rotation. Authored in [0,1]² Y-down; the rasterizer scales y about 0.5 by W/H so radii stay width-relative.",
  facts: {
    space: {
      "param:centerX": "canvas01",
      "param:centerY": "canvas01",
      "param:outerRadius": "canvas01",
      "param:innerRadius": "canvas01",
      "param:stroke_thickness": "pixels",
    },
    gotchas: [
      "stroke_thickness is pixels by default; stroke_units=% resolves it as a percent of canvas width instead.",
      "outerRadius/innerRadius are each clamped to ≥0 independently with no ordering clamp — innerRadius > outerRadius makes the valleys poke out past the points.",
      "The fill input image is only sampled when fill_enabled is on; fill_fit (window/contain/cover) likewise does nothing while fill is off.",
      "The image aux only exists when stroke_enabled or fill_enabled is on; the element aux is always emitted regardless.",
    ],
  },
  backend: "webgl2",
  inputs: [SPLINE_FILL_INPUT, TRANSFORM_INPUT],
  params: [
    { name: "centerX", label: "Center X", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "centerY", label: "Center Y", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "points", label: "Points", type: "scalar", min: 3, max: 32, step: 1, default: 5 },
    { name: "outerRadius", label: "Outer radius", type: "scalar", min: 0, max: 1, softMax: 0.4, step: 0.001, default: 0.3 },
    { name: "innerRadius", label: "Inner radius", type: "scalar", min: 0, max: 1, softMax: 0.4, step: 0.001, default: 0.13 },
    { name: "rotation", label: "Rotation (°)", type: "scalar", min: -180, max: 180, step: 1, default: 0 },
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
    const cx = num(params.centerX, 0.5);
    const cy = num(params.centerY, 0.5);
    const points = num(params.points, 5);
    const rOuter = Math.max(0, num(params.outerRadius, 0.3));
    const rInner = Math.max(0, num(params.innerRadius, 0.13));
    const rot = (num(params.rotation, 0) * Math.PI) / 180;
    const out: SplineValue = {
      kind: "spline",
      subpaths: applyTrimParams([makeStarSubpath(cx, cy, rOuter, rInner, points, rot)], params),
    };

    return emitSplinePrimitive(ctx, nodeId, out, params, inputs);
  },

  dispose: disposeSplineRasterAux,
};
