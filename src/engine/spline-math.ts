import { Bezier } from "bezier-js";
import type {
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "./types";

// Shared spline math. All positions are in the same [0,1]² Y-DOWN space
// SplineValue uses. We wrap bezier-js for per-cubic operations
// (length, sample, derivative, split, offset) rather than reimplementing
// Gauss-Legendre integration and De Casteljau in-house.
//
// NOTE: bezier-js operates on raw {x,y} points. Our anchors carry handles
// as OFFSETS from the anchor position — helpers here convert on the way in
// and out.

export interface BezierSegment {
  curve: Bezier;
  length: number;
}

// Convert a subpath into a flat list of cubics with their arc lengths
// pre-computed. Each consecutive anchor pair becomes one cubic; if `closed`
// is true, we also append a cubic from last back to first.
export function subpathToBeziers(sub: SplineSubpath): BezierSegment[] {
  const out: BezierSegment[] = [];
  const anchors = sub.anchors;
  if (anchors.length < 2) return out;
  const makeSeg = (a: SplineAnchor, b: SplineAnchor): BezierSegment => {
    const p0x = a.pos[0];
    const p0y = a.pos[1];
    const cp1x = a.outHandle ? a.pos[0] + a.outHandle[0] : a.pos[0];
    const cp1y = a.outHandle ? a.pos[1] + a.outHandle[1] : a.pos[1];
    const cp2x = b.inHandle ? b.pos[0] + b.inHandle[0] : b.pos[0];
    const cp2y = b.inHandle ? b.pos[1] + b.inHandle[1] : b.pos[1];
    const p3x = b.pos[0];
    const p3y = b.pos[1];
    const curve = new Bezier(p0x, p0y, cp1x, cp1y, cp2x, cp2y, p3x, p3y);
    return { curve, length: safeLength(curve) };
  };
  for (let i = 0; i < anchors.length - 1; i++) {
    out.push(makeSeg(anchors[i], anchors[i + 1]));
  }
  if (sub.closed && anchors.length >= 2) {
    out.push(makeSeg(anchors[anchors.length - 1], anchors[0]));
  }
  return out;
}

// bezier-js's length() throws on degenerate (all-collinear) curves on some
// versions. Fall back to the chord length so callers still get something
// useful to normalize against.
function safeLength(curve: Bezier): number {
  try {
    const L = curve.length();
    if (Number.isFinite(L) && L >= 0) return L;
  } catch {
    // fall through
  }
  const p0 = curve.points[0];
  const p3 = curve.points[curve.points.length - 1];
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  return Math.hypot(dx, dy);
}

// Cumulative segment lengths for a subpath, with a total. Used to locate a
// global `t` (in [0,1] of full length) inside a particular cubic.
export interface SubpathLengths {
  segments: BezierSegment[];
  cumulative: number[]; // cumulative[i] = total length up to END of segment i
  total: number;
}

export function measureSubpath(sub: SplineSubpath): SubpathLengths {
  const segments = subpathToBeziers(sub);
  const cumulative: number[] = [];
  let acc = 0;
  for (const s of segments) {
    acc += s.length;
    cumulative.push(acc);
  }
  return { segments, cumulative, total: acc };
}

// Walk a concatenation of all subpaths as a single linear arc-length
// domain. `t` in [0,1] means "t% of the total length across every subpath."
export interface SplineLengths {
  perSubpath: SubpathLengths[];
  offsets: number[]; // start-length of each subpath in the concatenation
  total: number;
}

export function measureSpline(spline: SplineValue): SplineLengths {
  const perSubpath: SubpathLengths[] = [];
  const offsets: number[] = [];
  let acc = 0;
  for (const sub of spline.subpaths) {
    const m = measureSubpath(sub);
    offsets.push(acc);
    perSubpath.push(m);
    acc += m.total;
  }
  return { perSubpath, offsets, total: acc };
}

export interface SampleResult {
  pos: [number, number];
  tangent: [number, number]; // unit vector (or [0,0] if undefined)
}

// Sample the spline at global arc-length parameter t ∈ [0,1]. Clamps out-of-
// range values so callers don't have to special-case endpoints. Picks the
// right segment by cumulative length, then delegates to bezier-js for the
// in-segment t.
export function sampleSplineAt(
  spline: SplineValue,
  lengths: SplineLengths,
  t: number
): SampleResult {
  if (lengths.total <= 0) return { pos: [0, 0], tangent: [0, 0] };
  const clamped = Math.max(0, Math.min(1, t));
  const targetLen = clamped * lengths.total;
  // Locate subpath.
  let subIdx = 0;
  for (let i = 0; i < lengths.perSubpath.length; i++) {
    const endOfSub = lengths.offsets[i] + lengths.perSubpath[i].total;
    if (targetLen <= endOfSub + 1e-9) {
      subIdx = i;
      break;
    }
    subIdx = i;
  }
  const sub = lengths.perSubpath[subIdx];
  if (!sub || sub.total <= 0) return { pos: [0, 0], tangent: [0, 0] };
  const lenInSub = targetLen - lengths.offsets[subIdx];
  // Locate segment within subpath.
  let segIdx = 0;
  let prevCum = 0;
  for (let i = 0; i < sub.segments.length; i++) {
    if (lenInSub <= sub.cumulative[i] + 1e-9) {
      segIdx = i;
      prevCum = i === 0 ? 0 : sub.cumulative[i - 1];
      break;
    }
    segIdx = i;
    prevCum = sub.cumulative[i];
  }
  const seg = sub.segments[segIdx];
  if (!seg) return { pos: [0, 0], tangent: [0, 0] };
  const local = seg.length > 0 ? (lenInSub - prevCum) / seg.length : 0;
  const tSeg = Math.max(0, Math.min(1, local));
  const p = seg.curve.get(tSeg);
  const d = seg.curve.derivative(tSeg);
  const mag = Math.hypot(d.x, d.y);
  const tx = mag > 1e-9 ? d.x / mag : 0;
  const ty = mag > 1e-9 ? d.y / mag : 0;
  return { pos: [p.x, p.y], tangent: [tx, ty] };
}

// Resample a subpath to `count` anchors evenly spaced along arc length.
// Handles are derived from the tangent at each sample point so the result
// stays smooth through the original curve rather than collapsing to a
// polyline of corners.
export function resampleSubpath(
  sub: SplineSubpath,
  count: number
): SplineSubpath {
  const n = Math.max(2, Math.floor(count));
  const m = measureSubpath(sub);
  if (m.total <= 0 || m.segments.length === 0) {
    return { anchors: [...sub.anchors], closed: sub.closed };
  }
  // When closed, the last sample meets the first — don't emit a duplicate.
  const divisor = sub.closed ? n : n - 1;
  const samples: Array<{ pos: [number, number]; tangent: [number, number] }> = [];
  for (let i = 0; i < n; i++) {
    const targetLen = (i / divisor) * m.total;
    // Locate segment.
    let segIdx = 0;
    let prevCum = 0;
    for (let j = 0; j < m.segments.length; j++) {
      if (targetLen <= m.cumulative[j] + 1e-9) {
        segIdx = j;
        prevCum = j === 0 ? 0 : m.cumulative[j - 1];
        break;
      }
      segIdx = j;
      prevCum = m.cumulative[j];
    }
    const seg = m.segments[segIdx];
    const local = seg.length > 0 ? (targetLen - prevCum) / seg.length : 0;
    const tSeg = Math.max(0, Math.min(1, local));
    const p = seg.curve.get(tSeg);
    const d = seg.curve.derivative(tSeg);
    const mag = Math.hypot(d.x, d.y);
    samples.push({
      pos: [p.x, p.y],
      tangent:
        mag > 1e-9 ? [d.x / mag, d.y / mag] : [0, 0],
    });
  }
  // Handle length = 1/3 of the local spacing, matching the "auto smooth"
  // Illustrator default. For uneven segment lengths the handles stretch a
  // bit but keep the original curvature reasonably intact.
  const spacing = m.total / divisor;
  const handleLen = spacing / 3;
  const anchors: SplineAnchor[] = samples.map((s) => {
    const a: SplineAnchor = { pos: s.pos };
    if (s.tangent[0] !== 0 || s.tangent[1] !== 0) {
      a.outHandle = [s.tangent[0] * handleLen, s.tangent[1] * handleLen];
      a.inHandle = [-s.tangent[0] * handleLen, -s.tangent[1] * handleLen];
    }
    return a;
  });
  return { anchors, closed: sub.closed };
}

// Parallel-curve offset via bezier-js. The library's .offset(d) on a single
// cubic returns an array of cubics (may subdivide around high-curvature
// regions). We reassemble them into a single subpath, stitching handles at
// the joins from each returned cubic's control points.
export function offsetSubpath(
  sub: SplineSubpath,
  distance: number
): SplineSubpath | null {
  if (distance === 0) return sub;
  const segments = subpathToBeziers(sub);
  if (segments.length === 0) return null;
  const outCurves: Bezier[] = [];
  for (const seg of segments) {
    const result = seg.curve.offset(distance);
    if (Array.isArray(result)) {
      // Each entry is already a Bezier.
      for (const b of result) outCurves.push(b);
    } else {
      // The single-arg form of offset(d) is documented to return Bezier[],
      // but fall through safely in case the types drift.
      continue;
    }
  }
  if (outCurves.length === 0) return null;
  // Rebuild anchors from the offset cubic chain. Each cubic contributes its
  // endpoint as an anchor, with in/out handles derived from its CP2/CP1.
  const anchors: SplineAnchor[] = [];
  const first = outCurves[0].points[0];
  const firstCp1 = outCurves[0].points[1];
  anchors.push({
    pos: [first.x, first.y],
    outHandle: [firstCp1.x - first.x, firstCp1.y - first.y],
  });
  for (let i = 0; i < outCurves.length; i++) {
    const c = outCurves[i];
    const p = c.points;
    const endAnchor: SplineAnchor = {
      pos: [p[3].x, p[3].y],
      inHandle: [p[2].x - p[3].x, p[2].y - p[3].y],
    };
    // Carry the next curve's CP1 as this anchor's outHandle so the join
    // tracks whatever slight discontinuity the offset introduced — bezier-js
    // subdivides at corners, so contiguous CPs may not be collinear.
    const next = outCurves[i + 1];
    if (next) {
      const nextCp1 = next.points[1];
      endAnchor.outHandle = [nextCp1.x - p[3].x, nextCp1.y - p[3].y];
    }
    anchors.push(endAnchor);
  }
  return { anchors, closed: sub.closed };
}

// ---------------------------------------------------------------------------
// Freehand curve fitting — the Pencil tool. Fit a chain of cubic béziers to a
// sampled polyline (Schneider, "An Algorithm for Automatically Fitting
// Digitized Curves", Graphics Gems 1990): least-squares fit a cubic to a
// chord-length-parameterized point run; refine with a few Newton-Raphson
// reparameterizations when the fit is close; otherwise subdivide at the point
// of maximum error and recurse. Implemented with plain vector math (no
// bezier-js — the algorithm is self-contained).
//
// Points and `error` live in ONE consistent metric space; the Pencil overlay
// passes canvas pixels so the tolerance is isotropic on a non-square canvas
// (rather than skewed by the [0,1]² aspect). Returned anchors are in that SAME
// space — the caller converts pos/handles to normalized coords.
// Spec: specdocs/062526_spline-pencil-tool.md.
// ---------------------------------------------------------------------------

type V2 = [number, number];

const vSub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const vAdd = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
const vScale = (a: V2, s: number): V2 => [a[0] * s, a[1] * s];
const vDot = (a: V2, b: V2): number => a[0] * b[0] + a[1] * b[1];
const vLen = (a: V2): number => Math.hypot(a[0], a[1]);
const vNorm = (a: V2): V2 => {
  const l = vLen(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0];
};

// Cubic Bernstein basis.
const B0 = (u: number) => (1 - u) ** 3;
const B1 = (u: number) => 3 * u * (1 - u) ** 2;
const B2 = (u: number) => 3 * u * u * (1 - u);
const B3 = (u: number) => u ** 3;

function cubicAt(c: V2[], t: number): V2 {
  const b0 = B0(t);
  const b1 = B1(t);
  const b2 = B2(t);
  const b3 = B3(t);
  return [
    b0 * c[0][0] + b1 * c[1][0] + b2 * c[2][0] + b3 * c[3][0],
    b0 * c[0][1] + b1 * c[1][1] + b2 * c[2][1] + b3 * c[3][1],
  ];
}

// Drop a near-zero handle offset (storing [0,0] would render a degenerate
// handle dot on top of the anchor and confuse corner↔smooth detection).
const nzHandle = (v: V2): V2 | undefined => (vLen(v) < 1e-9 ? undefined : v);

// Strip consecutive near-duplicate samples: chord-length parameterization
// divides by per-segment length, so coincident points would divide by zero.
function dedupePolyline(points: V2[], minDist: number): V2[] {
  if (points.length === 0) return [];
  const out: V2[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (vLen(vSub(points[i], out[out.length - 1])) >= minDist) out.push(points[i]);
  }
  return out;
}

// Normalized chord-length parameter (0..1) for pts[first..last].
function chordParams(pts: V2[], first: number, last: number): number[] {
  const u: number[] = [0];
  for (let i = first + 1; i <= last; i++) {
    u.push(u[u.length - 1] + vLen(vSub(pts[i], pts[i - 1])));
  }
  const total = u[u.length - 1] || 1;
  return u.map((x) => x / total);
}

// Least-squares fit the two interior control points for the cubic spanning
// pts[first..last] with fixed endpoint tangents tHat1/tHat2 and the supplied
// parameterization. Falls back to a Wu/Barsky third-of-chord heuristic when
// the solve degenerates (collinear / near-zero alpha).
function generateBezier(
  pts: V2[],
  first: number,
  last: number,
  u: number[],
  tHat1: V2,
  tHat2: V2
): V2[] {
  const p0 = pts[first];
  const p3 = pts[last];
  const n = last - first + 1;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let k = 0; k < n; k++) {
    const uu = u[k];
    const a0 = vScale(tHat1, B1(uu));
    const a1 = vScale(tHat2, B2(uu));
    c00 += vDot(a0, a0);
    c01 += vDot(a0, a1);
    c11 += vDot(a1, a1);
    // Part of the point fixed by the (clamped) endpoints.
    const fixed: V2 = [
      p0[0] * (B0(uu) + B1(uu)) + p3[0] * (B2(uu) + B3(uu)),
      p0[1] * (B0(uu) + B1(uu)) + p3[1] * (B2(uu) + B3(uu)),
    ];
    const tmp = vSub(pts[first + k], fixed);
    x0 += vDot(a0, tmp);
    x1 += vDot(a1, tmp);
  }
  const detC = c00 * c11 - c01 * c01;
  const segLen = vLen(vSub(p3, p0));
  let alphaL = detC === 0 ? 0 : (x0 * c11 - c01 * x1) / detC;
  let alphaR = detC === 0 ? 0 : (c00 * x1 - x0 * c01) / detC;
  const eps = 1e-6 * segLen;
  if (alphaL < eps || alphaR < eps) {
    const d = segLen / 3;
    alphaL = d;
    alphaR = d;
  }
  return [p0, vAdd(p0, vScale(tHat1, alphaL)), vAdd(p3, vScale(tHat2, alphaR)), p3];
}

// One Newton-Raphson step toward the parameter on `cubic` nearest to P.
function newtonStep(cubic: V2[], P: V2, u: number): number {
  const q = cubicAt(cubic, u);
  // Q'(u): degree-2 bézier of 3·(Cᵢ₊₁−Cᵢ).
  const q1 = [
    vScale(vSub(cubic[1], cubic[0]), 3),
    vScale(vSub(cubic[2], cubic[1]), 3),
    vScale(vSub(cubic[3], cubic[2]), 3),
  ];
  const q1u: V2 = [
    (1 - u) ** 2 * q1[0][0] + 2 * (1 - u) * u * q1[1][0] + u * u * q1[2][0],
    (1 - u) ** 2 * q1[0][1] + 2 * (1 - u) * u * q1[1][1] + u * u * q1[2][1],
  ];
  // Q''(u): degree-1 bézier of 2·(Q'ᵢ₊₁−Q'ᵢ).
  const q2 = [vScale(vSub(q1[1], q1[0]), 2), vScale(vSub(q1[2], q1[1]), 2)];
  const q2u: V2 = [
    (1 - u) * q2[0][0] + u * q2[1][0],
    (1 - u) * q2[0][1] + u * q2[1][1],
  ];
  const diff = vSub(q, P);
  const num = vDot(diff, q1u);
  const den = vDot(q1u, q1u) + vDot(diff, q2u);
  if (Math.abs(den) < 1e-12) return u;
  return u - num / den;
}

// Max distance from the fitted cubic to its samples, plus the index that
// should split the run if the fit is rejected.
function maxFitError(
  pts: V2[],
  first: number,
  last: number,
  cubic: V2[],
  u: number[]
): { error: number; split: number } {
  let error = 0;
  let split = first + Math.floor((last - first) / 2);
  for (let i = first + 1; i < last; i++) {
    const d = vLen(vSub(cubicAt(cubic, u[i - first]), pts[i]));
    if (d > error) {
      error = d;
      split = i;
    }
  }
  return { error, split };
}

function centerTangent(pts: V2[], center: number): V2 {
  const v1 = vSub(pts[center - 1], pts[center]);
  const v2 = vSub(pts[center], pts[center + 1]);
  return vNorm([(v1[0] + v2[0]) / 2, (v1[1] + v2[1]) / 2]);
}

const FIT_MAX_ITERATIONS = 4;
// Within this multiple of the tolerance, reparameterize-and-retry before
// giving up and splitting (a split is a sharper, more expensive change).
const FIT_ITERATION_BAND = 4;

function fitCubicRun(
  pts: V2[],
  first: number,
  last: number,
  tHat1: V2,
  tHat2: V2,
  error: number,
  out: V2[][]
): void {
  // Two points → exact line; handles a third of the chord along the tangents.
  if (last - first === 1) {
    const d = vLen(vSub(pts[last], pts[first])) / 3;
    out.push([
      pts[first],
      vAdd(pts[first], vScale(tHat1, d)),
      vAdd(pts[last], vScale(tHat2, d)),
      pts[last],
    ]);
    return;
  }
  let u = chordParams(pts, first, last);
  let cubic = generateBezier(pts, first, last, u, tHat1, tHat2);
  let { error: maxErr, split } = maxFitError(pts, first, last, cubic, u);
  if (maxErr < error) {
    out.push(cubic);
    return;
  }
  if (maxErr < error * FIT_ITERATION_BAND) {
    for (let i = 0; i < FIT_MAX_ITERATIONS; i++) {
      const uPrime = u.map((uu, k) => newtonStep(cubic, pts[first + k], uu));
      cubic = generateBezier(pts, first, last, uPrime, tHat1, tHat2);
      const next = maxFitError(pts, first, last, cubic, uPrime);
      u = uPrime;
      if (next.error < error) {
        out.push(cubic);
        return;
      }
      split = next.split;
      maxErr = next.error;
    }
  }
  // Split at the worst point; share a center tangent so the join stays smooth.
  const tc = centerTangent(pts, split);
  fitCubicRun(pts, first, split, tHat1, tc, error, out);
  fitCubicRun(pts, split, last, [-tc[0], -tc[1]], tHat2, error, out);
}

// Assemble a smooth anchor chain from a contiguous run of fitted cubics.
// Adjacent cubics share an endpoint; the shared anchor takes its inHandle from
// the previous cubic's CP2 and its outHandle from the next cubic's CP1. Joins
// are left smooth (broken falsy) — the fit produces collinear-ish tangents at
// split points.
function cubicsToAnchors(cubics: V2[][]): SplineAnchor[] {
  if (cubics.length === 0) return [];
  const anchors: SplineAnchor[] = [];
  const head = cubics[0];
  anchors.push({ pos: [head[0][0], head[0][1]], outHandle: nzHandle(vSub(head[1], head[0])) });
  for (let k = 0; k < cubics.length; k++) {
    const c = cubics[k];
    const anchor: SplineAnchor = {
      pos: [c[3][0], c[3][1]],
      inHandle: nzHandle(vSub(c[2], c[3])),
    };
    const next = cubics[k + 1];
    if (next) anchor.outHandle = nzHandle(vSub(next[1], next[0]));
    anchors.push(anchor);
  }
  return anchors;
}

// Fit a chain of cubic béziers to a freehand polyline within `error` (same
// units as the points). Returns smooth SplineAnchors in the input space, or
// [] when there aren't enough distinct samples to make a curve.
export function fitSplineToPolyline(points: V2[], error: number): SplineAnchor[] {
  const pts = dedupePolyline(points, Math.max(1e-4, error * 0.25));
  if (pts.length < 2) return [];
  const tHat1 = vNorm(vSub(pts[1], pts[0]));
  const tHat2 = vNorm(vSub(pts[pts.length - 2], pts[pts.length - 1]));
  const cubics: V2[][] = [];
  fitCubicRun(pts, 0, pts.length - 1, tHat1, tHat2, error, cubics);
  return cubicsToAnchors(cubics);
}

// Build a smooth interpolating subpath through `points` via a uniform
// Catmull-Rom → Bézier conversion: the tangent at Pᵢ is (Pᵢ₊₁ − Pᵢ₋₁)/2, so
// each anchor's symmetric handles are ±(Pᵢ₊₁ − Pᵢ₋₁)/6. The curve passes
// through every point (unlike a least-squares fit). For an open curve the
// endpoints get a one-sided tangent; closed curves wrap. Points are in the
// SplineValue's normalized space. Used by the parametric primitives (Spiral,
// Sine Wave). Fewer than 2 points → a plain corner-anchor subpath.
export function catmullRomSubpath(points: V2[], closed: boolean): SplineSubpath {
  const n = points.length;
  if (n < 2) {
    return {
      anchors: points.map((p) => ({ pos: [p[0], p[1]] as V2 })),
      closed,
    };
  }
  const at = (i: number): V2 =>
    closed ? points[((i % n) + n) % n] : points[Math.max(0, Math.min(n - 1, i))];
  const anchors: SplineAnchor[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const a: SplineAnchor = { pos: [p[0], p[1]] };
    if (!closed && i === 0) {
      const next = points[1];
      a.outHandle = [(next[0] - p[0]) / 3, (next[1] - p[1]) / 3];
    } else if (!closed && i === n - 1) {
      const prev = points[n - 2];
      a.inHandle = [(prev[0] - p[0]) / 3, (prev[1] - p[1]) / 3];
    } else {
      const prev = at(i - 1);
      const next = at(i + 1);
      const hx = (next[0] - prev[0]) / 6;
      const hy = (next[1] - prev[1]) / 6;
      a.outHandle = [hx, hy];
      a.inHandle = [-hx, -hy];
    }
    anchors.push(a);
  }
  return { anchors, closed };
}
