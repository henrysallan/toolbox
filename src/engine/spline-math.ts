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
