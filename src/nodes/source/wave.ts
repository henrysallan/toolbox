import type {
  NodeDefinition,
  SplineValue,
} from "@/engine/types";
import { catmullRomSubpath } from "@/engine/spline-math";
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

// Sine wave as an open spline: y = centerY + amplitude·sin(2π·cycles·t +
// phase·π) for x spanning `width` centered on `centerX`, t ∈ [0,1]. Phase is in
// ×π units (matching Lissajous), so π/2, π read as 0.5, 1. Sampled into a
// smooth open subpath. Normalized [0,1]² Y-DOWN.

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

export const waveNode: NodeDefinition = {
  type: "wave",
  name: "Sine Wave",
  category: "spline",
  subcategory: "generator",
  description:
    "Generate a sine wave as an open spline — set amplitude, cycles, phase, and the horizontal span.",
  backend: "webgl2",
  inputs: [SPLINE_FILL_INPUT, TRANSFORM_INPUT],
  params: [
    { name: "centerX", label: "Center X", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "centerY", label: "Center Y", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "width", label: "Width", type: "scalar", min: 0, max: 1, softMax: 1, step: 0.001, default: 0.8 },
    { name: "amplitude", label: "Amplitude", type: "scalar", min: 0, max: 1, softMax: 0.3, step: 0.001, default: 0.15 },
    { name: "cycles", label: "Cycles", type: "scalar", min: 0.25, max: 20, softMax: 6, step: 0.25, default: 2 },
    { name: "phase", label: "Phase (×π)", type: "scalar", min: -2, max: 2, step: 0.01, default: 0 },
    { name: "resolution", label: "Points / cycle", type: "scalar", min: 4, max: 64, step: 1, default: 16 },
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
    const width = Math.max(0, num(params.width, 0.8));
    const amp = num(params.amplitude, 0.15);
    const cycles = Math.max(0.0625, num(params.cycles, 2));
    const phase = num(params.phase, 0) * Math.PI;
    const ppc = Math.max(4, Math.floor(num(params.resolution, 16)));

    const segments = Math.max(2, Math.round(cycles * ppc));
    const x0 = cx - width / 2;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const x = x0 + width * t;
      const y = cy + amp * Math.sin(2 * Math.PI * cycles * t + phase);
      pts.push([x, y]);
    }
    const out: SplineValue = {
      kind: "spline",
      subpaths: applyTrimParams([catmullRomSubpath(pts, false)], params),
    };

    return emitSplinePrimitive(ctx, nodeId, out, params, inputs);
  },

  dispose: disposeSplineRasterAux,
};
