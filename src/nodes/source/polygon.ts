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

// Regular N-sided polygon. Vertices sit on a circle of `radius` about the
// center, first vertex at 12 o'clock (−90°) plus `rotation`. Sharp corner
// anchors (no handles), closed. Normalized [0,1]² Y-DOWN; the rasterizer's
// aspect correction keeps it regular on a non-square canvas.

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function makePolygonSubpath(
  cx: number,
  cy: number,
  r: number,
  sides: number,
  rotRad: number
): SplineSubpath {
  const n = Math.max(3, Math.floor(sides));
  const anchors: SplineAnchor[] = [];
  const start = -Math.PI / 2 + rotRad;
  for (let i = 0; i < n; i++) {
    const a = start + (i / n) * 2 * Math.PI;
    anchors.push({ pos: [cx + r * Math.cos(a), cy + r * Math.sin(a)] });
  }
  return { anchors, closed: true };
}

export const polygonNode: NodeDefinition = {
  type: "polygon",
  name: "Polygon",
  category: "spline",
  subcategory: "generator",
  description:
    "Generate a regular polygon as a closed spline — set the number of sides, radius, and rotation.",
  backend: "webgl2",
  inputs: [SPLINE_FILL_INPUT, TRANSFORM_INPUT],
  params: [
    { name: "centerX", label: "Center X", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "centerY", label: "Center Y", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "radius", label: "Radius", type: "scalar", min: 0, max: 1, softMax: 0.4, step: 0.001, default: 0.3 },
    { name: "sides", label: "Sides", type: "scalar", min: 3, max: 64, step: 1, default: 5 },
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
    const r = Math.max(0, num(params.radius, 0.3));
    const sides = num(params.sides, 5);
    const rot = (num(params.rotation, 0) * Math.PI) / 180;
    const out: SplineValue = {
      kind: "spline",
      subpaths: applyTrimParams([makePolygonSubpath(cx, cy, r, sides, rot)], params),
    };

    return emitSplinePrimitive(ctx, nodeId, out, params, inputs);
  },

  dispose: disposeSplineRasterAux,
};
