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

// Circle slice from `startAngle` to `endAngle` (degrees; 0° = +X / 3 o'clock,
// positive = clockwise on screen in Y-DOWN). Exact circular-arc bézier: each
// ≤90° segment uses the standard handle length r·(4/3)·tan(Δθ/4) along the
// tangent. `mode`: open (just the arc), pie (closed through the center), chord
// (closed by a straight chord). Normalized [0,1]² Y-DOWN.

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

// Anchors tracing the arc itself (no closure). The shared endpoints of adjacent
// ≤90° segments get symmetric in/out handles (smooth circle); the first anchor
// has no inHandle and the last no outHandle, so closing through the center
// (pie) or across a chord stays straight.
function makeArcAnchors(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number
): SplineAnchor[] {
  const sweep = a1 - a0;
  const segCount = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const dTheta = sweep / segCount;
  const hl = r * (4 / 3) * Math.tan(dTheta / 4);
  const anchors: SplineAnchor[] = [];
  for (let j = 0; j <= segCount; j++) {
    const th = a0 + j * dTheta;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    const tx = -sin; // unit tangent, increasing θ
    const ty = cos;
    const a: SplineAnchor = { pos: [cx + r * cos, cy + r * sin] };
    if (j > 0) a.inHandle = [-tx * hl, -ty * hl];
    if (j < segCount) a.outHandle = [tx * hl, ty * hl];
    anchors.push(a);
  }
  return anchors;
}

export const arcNode: NodeDefinition = {
  type: "arc",
  name: "Arc",
  category: "spline",
  subcategory: "generator",
  description:
    "Generate a circular arc / pie wedge as a spline — set radius, start/end angle, and whether it's an open arc, a pie, or a chord.",
  backend: "webgl2",
  inputs: [SPLINE_FILL_INPUT, TRANSFORM_INPUT],
  params: [
    { name: "centerX", label: "Center X", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "centerY", label: "Center Y", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "radius", label: "Radius", type: "scalar", min: 0, max: 1, softMax: 0.4, step: 0.001, default: 0.3 },
    { name: "startAngle", label: "Start angle (°)", type: "scalar", min: -360, max: 360, step: 1, default: 0 },
    { name: "endAngle", label: "End angle (°)", type: "scalar", min: -360, max: 360, step: 1, default: 270 },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["open", "pie", "chord"],
      default: "open",
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
    const r = Math.max(0, num(params.radius, 0.3));
    const a0 = (num(params.startAngle, 0) * Math.PI) / 180;
    const a1 = (num(params.endAngle, 270) * Math.PI) / 180;
    const mode = (params.mode as string) ?? "open";

    const arc = makeArcAnchors(cx, cy, r, a0, a1);
    let subpath: SplineSubpath;
    if (mode === "pie") {
      subpath = { anchors: [{ pos: [cx, cy] }, ...arc], closed: true };
    } else if (mode === "chord") {
      subpath = { anchors: arc, closed: true };
    } else {
      subpath = { anchors: arc, closed: false };
    }
    const out: SplineValue = {
      kind: "spline",
      subpaths: applyTrimParams([subpath], params),
    };

    return emitSplinePrimitive(ctx, nodeId, out, params, inputs);
  },

  dispose: disposeSplineRasterAux,
};
