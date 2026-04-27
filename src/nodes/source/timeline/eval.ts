import type {
  TimelineCurvePoint,
  TimelineCurveValue,
} from "@/engine/types";

// Default two-point linear ramp from (0,0) to (1,1).
export function defaultTimelineCurve(): TimelineCurveValue {
  return {
    controlPoints: [
      makeDefaultPoint(0, 0),
      makeDefaultPoint(1, 1),
    ],
  };
}

export function makeDefaultPoint(x: number, y: number): TimelineCurvePoint {
  return {
    x,
    y,
    handleMode: "aligned",
    leftHandle: { dx: -0.1, dy: 0 },
    rightHandle: { dx: 0.1, dy: 0 },
  };
}

// Coerce arbitrary stored data into a valid curve. Used during deserialize
// and as a guard in compute / editor render paths.
export function sanitizeTimelineCurve(value: unknown): TimelineCurveValue {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as TimelineCurveValue).controlPoints)
  ) {
    return defaultTimelineCurve();
  }
  const raw = (value as TimelineCurveValue).controlPoints;
  const cleaned: TimelineCurvePoint[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const x = typeof p.x === "number" ? p.x : 0;
    const y = typeof p.y === "number" ? p.y : 0;
    const mode = (p.handleMode === "aligned" ||
      p.handleMode === "mirrored" ||
      p.handleMode === "free" ||
      p.handleMode === "vector"
      ? p.handleMode
      : "aligned") as TimelineCurvePoint["handleMode"];
    const lh = p.leftHandle && typeof p.leftHandle === "object"
      ? { dx: Number(p.leftHandle.dx) || 0, dy: Number(p.leftHandle.dy) || 0 }
      : { dx: -0.1, dy: 0 };
    const rh = p.rightHandle && typeof p.rightHandle === "object"
      ? { dx: Number(p.rightHandle.dx) || 0, dy: Number(p.rightHandle.dy) || 0 }
      : { dx: 0.1, dy: 0 };
    cleaned.push({ x, y, handleMode: mode, leftHandle: lh, rightHandle: rh });
  }
  if (cleaned.length === 0) return defaultTimelineCurve();
  cleaned.sort((a, b) => a.x - b.x);
  // Force endpoints to x=0 and x=1.
  cleaned[0].x = 0;
  cleaned[cleaned.length - 1].x = 1;
  return { controlPoints: cleaned };
}

function fract(v: number): number {
  return v - Math.floor(v);
}

// Solve cubic bezier for y given an x in [p0.x, p1.x]. Uses Newton's method
// on the bezier x parameter; this is the standard CSS-easing technique.
export function evalTimelineCurveNormalized(
  curve: TimelineCurveValue,
  tIn: number
): number {
  const cps = curve.controlPoints;
  if (cps.length === 0) return 0;
  if (cps.length === 1) return cps[0].y;

  const t = fract(tIn);

  // Binary search the surrounding pair.
  let lo = 0;
  let hi = cps.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cps[mid].x <= t) lo = mid;
    else hi = mid;
  }
  const a = cps[lo];
  const b = cps[hi];

  // Bezier control points in absolute coords.
  const p0x = a.x;
  const p0y = a.y;
  const p1x = a.x + a.rightHandle.dx;
  const p1y = a.y + a.rightHandle.dy;
  const p2x = b.x + b.leftHandle.dx;
  const p2y = b.y + b.leftHandle.dy;
  const p3x = b.x;
  const p3y = b.y;

  // Solve x(u) = t for u in [0, 1]. Initial guess: linear t mapping.
  const span = Math.max(1e-9, p3x - p0x);
  let u = (t - p0x) / span;
  for (let i = 0; i < 8; i++) {
    const x = bezier1d(p0x, p1x, p2x, p3x, u);
    const dx = bezier1dDeriv(p0x, p1x, p2x, p3x, u);
    if (Math.abs(dx) < 1e-9) break;
    const next = u - (x - t) / dx;
    if (next <= 0) {
      u = 0;
      break;
    }
    if (next >= 1) {
      u = 1;
      break;
    }
    if (Math.abs(next - u) < 1e-7) {
      u = next;
      break;
    }
    u = next;
  }
  return bezier1d(p0y, p1y, p2y, p3y, u);
}

function bezier1d(p0: number, p1: number, p2: number, p3: number, u: number) {
  const iu = 1 - u;
  return (
    iu * iu * iu * p0 +
    3 * iu * iu * u * p1 +
    3 * iu * u * u * p2 +
    u * u * u * p3
  );
}

function bezier1dDeriv(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  u: number
) {
  const iu = 1 - u;
  return (
    3 * iu * iu * (p1 - p0) +
    6 * iu * u * (p2 - p1) +
    3 * u * u * (p3 - p2)
  );
}
