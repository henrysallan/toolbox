import type {
  NodeDefinition,
  NodeOutput,
  SplineValue,
} from "@/engine/types";
import { catmullRomSubpath } from "@/engine/spline-math";
import {
  SPLINE_FILL_INPUT,
  SPLINE_RASTER_PARAMS,
  SPLINE_TRIM_PARAMS,
  applyTrimParams,
  buildSplineElement,
  disposeSplineRasterAux,
  rasterizeSplineAux,
  resolveSplineRasterAux,
} from "./spline-raster-aux";

// Archimedean spiral: r(t) = inner + (outer − inner)·t, θ = ±t·2π·turns over
// t ∈ [0,1]. Sampled into a smooth open subpath (Catmull-Rom handles). Center +
// radii are in normalized [0,1]² Y-DOWN space, like every other spline source;
// the rasterizer's aspect correction keeps it round on a non-square canvas.

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

export const spiralNode: NodeDefinition = {
  type: "spiral",
  name: "Spiral",
  category: "spline",
  subcategory: "generator",
  description:
    "Generate an Archimedean spiral as an open spline — set turns, inner/outer radius, and direction.",
  backend: "webgl2",
  inputs: [SPLINE_FILL_INPUT],
  params: [
    { name: "centerX", label: "Center X", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "centerY", label: "Center Y", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "turns", label: "Turns", type: "scalar", min: 0.25, max: 20, softMax: 8, step: 0.25, default: 3 },
    { name: "innerRadius", label: "Inner radius", type: "scalar", min: 0, max: 1, softMax: 0.5, step: 0.001, default: 0 },
    { name: "outerRadius", label: "Outer radius", type: "scalar", min: 0, max: 1, softMax: 0.5, step: 0.001, default: 0.35 },
    { name: "pointsPerTurn", label: "Points / turn", type: "scalar", min: 4, max: 64, step: 1, default: 16 },
    {
      name: "direction",
      label: "Direction",
      type: "enum",
      options: ["clockwise", "counterclockwise"],
      default: "clockwise",
    },
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
    const turns = Math.max(0.0625, num(params.turns, 3));
    const r0 = Math.max(0, num(params.innerRadius, 0));
    const r1 = Math.max(0, num(params.outerRadius, 0.35));
    const ppt = Math.max(4, Math.floor(num(params.pointsPerTurn, 16)));
    const dir = params.direction === "counterclockwise" ? -1 : 1;

    const segments = Math.max(2, Math.round(turns * ppt));
    const thetaMax = turns * 2 * Math.PI;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const theta = dir * t * thetaMax;
      const r = r0 + (r1 - r0) * t;
      pts.push([cx + r * Math.cos(theta), cy + r * Math.sin(theta)]);
    }
    const out: SplineValue = {
      kind: "spline",
      subpaths: applyTrimParams([catmullRomSubpath(pts, false)], params),
    };

    const fillImage = inputs.fill?.kind === "image" ? inputs.fill : null;
    const image = rasterizeSplineAux(ctx, nodeId, out.subpaths, params, fillImage);
    const element = buildSplineElement(ctx, out.subpaths, params);
    const aux: NodeOutput["aux"] = { element };
    if (image) aux.image = image;
    return { primary: out, aux };
  },

  dispose: disposeSplineRasterAux,
};
