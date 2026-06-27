import type {
  NodeDefinition,
  NodeOutput,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
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

// Crosshair / registration mark: four straight arms radiating from a center,
// each running from `center + dir·offset` to `center + dir·(offset + length)`.
// `start offset` is the central gap (0 = arms meet at the center, forming a
// plus). Rotation spins the whole mark (45° → an X). Emitted as four open
// 2-anchor subpaths — meant to be stroked. Normalized [0,1]² Y-DOWN.

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

export const crossNode: NodeDefinition = {
  type: "cross",
  name: "Cross",
  category: "spline",
  subcategory: "generator",
  description:
    "Generate a crosshair / registration mark — four arms with an adjustable central gap (start offset), arm length, and rotation.",
  backend: "webgl2",
  inputs: [SPLINE_FILL_INPUT],
  params: [
    { name: "centerX", label: "Center X", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "centerY", label: "Center Y", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "length", label: "Arm length", type: "scalar", min: 0, max: 1, softMax: 0.4, step: 0.001, default: 0.15 },
    { name: "startOffset", label: "Start offset (gap)", type: "scalar", min: 0, max: 1, softMax: 0.25, step: 0.001, default: 0 },
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
    const len = Math.max(0, num(params.length, 0.15));
    const off = Math.max(0, num(params.startOffset, 0));
    const rot = (num(params.rotation, 0) * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);

    // Base arm directions (Y-DOWN): up, right, down, left.
    const dirs: Array<[number, number]> = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
    const subpaths: SplineSubpath[] = dirs.map(([dx, dy]) => {
      // Rotate the direction.
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;
      const p0: [number, number] = [cx + rx * off, cy + ry * off];
      const p1: [number, number] = [cx + rx * (off + len), cy + ry * (off + len)];
      return { anchors: [{ pos: p0 }, { pos: p1 }], closed: false };
    });
    const out: SplineValue = {
      kind: "spline",
      subpaths: applyTrimParams(subpaths, params),
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
