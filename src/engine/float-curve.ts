// Shared single-channel float curve model + CPU sampler. Lives engine-side
// so engine code (spline-repeat offsets, node rasterizers) can sample a
// curve without an engine→nodes import (invariant #1) — same precedent as
// engine/color-ramp.ts. The Color Correction / RGB Curves nodes re-export
// the math from here for back-compat with existing importers.
//
// A curve is a plain CurvePoint[] mapping x∈[0,1] → y∈[0,1], interpolated
// with monotone cubic Hermite (Fritsch–Carlson) — no overshoot, which is
// what a clamped 0..1 curve editor needs. This is also the value shape of
// the `float_curve` ParamType (plain JSON, serializes as-is).

export interface CurvePoint {
  id: string;
  x: number; // 0..1 input
  y: number; // 0..1 output
}

export function newCurvePointId(): string {
  return `cp-${Math.random().toString(36).slice(2, 8)}`;
}

// Two-point curve from (0, y0) to (1, y1). defaultFloatCurve(0, 1) is the
// linear ramp (spacing curves); defaultFloatCurve(1, 1) is the flat
// identity multiplier (thickness/opacity falloff curves).
export function defaultFloatCurve(y0 = 0, y1 = 1): CurvePoint[] {
  return [
    { id: newCurvePointId(), x: 0, y: y0 },
    { id: newCurvePointId(), x: 1, y: y1 },
  ];
}

// Monotone cubic Hermite interpolation (Fritsch-Carlson). Chosen because it
// won't overshoot — critical for curve editors where points are clamped 0..1.
export function computeMonotoneTangents(pts: CurvePoint[]): number[] {
  const n = pts.length;
  if (n < 2) return new Array(n).fill(0);
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    d[i] = dx === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx;
  }
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else m[i] = (d[i - 1] + d[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const h = a * a + b * b;
      if (h > 9) {
        const t = 3 / Math.sqrt(h);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
  }
  return m;
}

export function evalMonotoneCubic(
  pts: CurvePoint[],
  tangents: number[],
  x: number
): number {
  if (pts.length === 0) return 0;
  if (pts.length === 1) return pts[0].y;
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  let i = 0;
  for (; i < pts.length - 1; i++) {
    if (x <= pts[i + 1].x) break;
  }
  const x0 = pts[i].x;
  const x1 = pts[i + 1].x;
  const h = x1 - x0;
  if (h === 0) return pts[i].y;
  const t = (x - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return (
    h00 * pts[i].y +
    h10 * h * tangents[i] +
    h01 * pts[i + 1].y +
    h11 * h * tangents[i + 1]
  );
}

// Clamp/sort/validate a raw param value into a usable curve. Invalid or
// empty input falls back to the provided default endpoints — callers pass
// the same (y0, y1) they used for the ParamDef default so a wiped param
// resets to its intended identity.
export function sanitizeFloatCurve(raw: unknown, y0 = 0, y1 = 1): CurvePoint[] {
  if (!Array.isArray(raw) || raw.length === 0) return defaultFloatCurve(y0, y1);
  const pts = (raw as CurvePoint[])
    .filter(
      (p) =>
        p &&
        typeof p.x === "number" &&
        typeof p.y === "number" &&
        typeof p.id === "string"
    )
    .map((p) => ({
      id: p.id,
      x: Math.max(0, Math.min(1, p.x)),
      y: Math.max(0, Math.min(1, p.y)),
    }))
    .sort((a, b) => a.x - b.x);
  if (pts.length < 2) return defaultFloatCurve(y0, y1);
  return pts;
}

// Tangents + eval in one call. Param values round-trip by reference through
// the evaluator, so array identity is a sound cache key — repeated sampling
// of the same curve (per repeat index, per frame) pays the tangent solve
// once.
const tangentCache = new WeakMap<CurvePoint[], number[]>();

export function sampleFloatCurve(pts: CurvePoint[], x: number): number {
  let tangents = tangentCache.get(pts);
  if (!tangents) {
    tangents = computeMonotoneTangents(pts);
    tangentCache.set(pts, tangents);
  }
  return evalMonotoneCubic(pts, tangents, x);
}
