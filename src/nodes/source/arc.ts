import type {
  NodeDefinition,
  SocketValue,
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
//
// Optional `center` / `start` / `end` vec2 sockets override the polar params
// so each authorable anchor can be driven from any vec2 source (Point,
// Combine Vec2, Cursor, Sample Along Path, …). Unwired sockets fall back to
// centerX/Y + radius + angles. When both endpoints are wired, the circle is
// refitted so both positions are exact (center projected onto the chord's
// perpendicular bisector); the angle params only pick major vs minor sweep.

const TWO_PI = Math.PI * 2;
const EPS = 1e-8;

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function readVec2(v: SocketValue | undefined): [number, number] | null {
  if (v?.kind !== "vec2") return null;
  const x = v.value[0];
  const y = v.value[1];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

// Two simple arcs join a0 to a1Raw on the circle: clockwise in (0, 2π] and
// counterclockwise in [-2π, 0). Pick the one closer to the polar sweep.
function pickSweep(a0: number, a1Raw: number, preferred: number): number {
  let d = (a1Raw - a0) % TWO_PI;
  if (!Number.isFinite(d) || d === 0) return a0 + preferred;
  if (d < 0) d += TWO_PI;
  const cw = d;
  const ccw = d - TWO_PI;
  return Math.abs(cw - preferred) <= Math.abs(ccw - preferred)
    ? a0 + cw
    : a0 + ccw;
}

function resolveArcPolar(args: {
  cx: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
  start: [number, number] | null;
  end: [number, number] | null;
}): { cx: number; cy: number; r: number; a0: number; a1: number } {
  const { start, end } = args;
  let { cx, cy, r, a0, a1 } = args;

  if (start && end) {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const chord = Math.hypot(dx, dy);
    if (chord < EPS) {
      return resolveArcPolar({ cx, cy, r, a0, a1, start, end: null });
    }
    const mx = (start[0] + end[0]) / 2;
    const my = (start[1] + end[1]) / 2;
    const nx = -dy / chord;
    const ny = dx / chord;
    const t = (cx - mx) * nx + (cy - my) * ny;
    cx = mx + t * nx;
    cy = my + t * ny;
    r = Math.hypot(start[0] - cx, start[1] - cy);
    a0 = Math.atan2(start[1] - cy, start[0] - cx);
    a1 = pickSweep(a0, Math.atan2(end[1] - cy, end[0] - cx), args.a1 - args.a0);
    return { cx, cy, r, a0, a1 };
  }

  if (start) {
    const dx = start[0] - cx;
    const dy = start[1] - cy;
    const sr = Math.hypot(dx, dy);
    return {
      cx,
      cy,
      r: sr,
      a0: sr < EPS ? a0 : Math.atan2(dy, dx),
      a1,
    };
  }

  if (end) {
    const dx = end[0] - cx;
    const dy = end[1] - cy;
    const er = Math.hypot(dx, dy);
    return {
      cx,
      cy,
      r: er,
      a0,
      a1: er < EPS ? a1 : Math.atan2(dy, dx),
    };
  }

  return { cx, cy, r, a0, a1 };
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
    "Generate a circular arc / pie wedge as a spline — set radius, start/end angle, and whether it's an open arc, a pie, or a chord. Wire Center / Start / End to drive those anchors from a vec2 (unwired sockets keep the polar params). Authored in [0,1]² Y-down; the rasterizer scales y about 0.5 by W/H so radii stay width-relative.",
  facts: {
    space: {
      "in:center": "canvas01",
      "in:start": "canvas01",
      "in:end": "canvas01",
      "param:centerX": "canvas01",
      "param:centerY": "canvas01",
      "param:radius": "canvas01",
      "param:stroke_thickness": "pixels",
    },
    gotchas: [
      "When both start and end are wired, the circle is refitted so both positions are exact; centerX/Y/radius are ignored and the angle params only pick the major or minor sweep.",
      "Wiring only start or only end keeps the center fixed and recomputes radius and that endpoint's angle from it; the other angle param still applies.",
      "Angles are degrees, 0° at +X and positive clockwise on screen (Y is down); a sweep past 360° (e.g. endAngle=630) is honored, not wrapped.",
      "stroke_thickness is pixels by default; switching stroke_units to % makes it a fraction of canvas width instead.",
      "trim_offset is unbounded mod 1, so keyframing it past ±1 keeps orbiting the arc rather than clamping.",
    ],
  },
  backend: "webgl2",
  inputs: [
    SPLINE_FILL_INPUT,
    TRANSFORM_INPUT,
    { name: "center", type: "vec2", required: false, label: "Center" },
    { name: "start", type: "vec2", required: false, label: "Start" },
    { name: "end", type: "vec2", required: false, label: "End" },
  ],
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
    const centerIn = readVec2(inputs.center);
    const { cx, cy, r, a0, a1 } = resolveArcPolar({
      cx: centerIn ? centerIn[0] : num(params.centerX, 0.5),
      cy: centerIn ? centerIn[1] : num(params.centerY, 0.5),
      r: Math.max(0, num(params.radius, 0.3)),
      a0: (num(params.startAngle, 0) * Math.PI) / 180,
      a1: (num(params.endAngle, 270) * Math.PI) / 180,
      start: readVec2(inputs.start),
      end: readVec2(inputs.end),
    });
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
