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

// Convert a subpath into a flat list of cubics. Each consecutive anchor pair
// becomes one cubic; if `closed` is true, we also append a cubic from last
// back to first.
//
// Prefer this over subpathToBeziers when you don't need arc lengths —
// safeLength() runs a 24-sample Gauss-Legendre integration per segment, which
// is pure waste for callers that only walk the geometry.
export function subpathToCurves(sub: SplineSubpath): Bezier[] {
  const out: Bezier[] = [];
  const anchors = sub.anchors;
  if (anchors.length < 2) return out;
  const makeSeg = (a: SplineAnchor, b: SplineAnchor): Bezier => {
    const p0x = a.pos[0];
    const p0y = a.pos[1];
    const cp1x = a.outHandle ? a.pos[0] + a.outHandle[0] : a.pos[0];
    const cp1y = a.outHandle ? a.pos[1] + a.outHandle[1] : a.pos[1];
    const cp2x = b.inHandle ? b.pos[0] + b.inHandle[0] : b.pos[0];
    const cp2y = b.inHandle ? b.pos[1] + b.inHandle[1] : b.pos[1];
    const p3x = b.pos[0];
    const p3y = b.pos[1];
    return new Bezier(p0x, p0y, cp1x, cp1y, cp2x, cp2y, p3x, p3y);
  };
  for (let i = 0; i < anchors.length - 1; i++) {
    out.push(makeSeg(anchors[i], anchors[i + 1]));
  }
  if (sub.closed && anchors.length >= 2) {
    out.push(makeSeg(anchors[anchors.length - 1], anchors[0]));
  }
  return out;
}

// Same, with each cubic's arc length pre-computed.
export function subpathToBeziers(sub: SplineSubpath): BezierSegment[] {
  return subpathToCurves(sub).map((curve) => ({
    curve,
    length: safeLength(curve),
  }));
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

// Unit tangent of a cubic at parameter t, robust to the degenerate case where
// bezier-js's analytic derivative vanishes. A straight, handle-less segment is
// stored as a cubic with cp1 === p0 and cp2 === p3, whose derivative is exactly
// zero at t=0 and t=1 — so a naive `derivative(t)` returns (0,0) at every
// segment/subpath endpoint and callers lose the orientation there (points snap
// to angle 0). Fall back through: derivative nudged into the interior (recovers
// a straight segment, whose derivative is nonzero for 0<t<1), then a small
// finite-difference chord (curved-but-degenerate), then the whole-segment
// endpoint chord. Returns [0,0] only for a genuinely zero-length curve.
// (Exported for spline-width.ts — the width-envelope sampler needs the same
// degenerate-robust tangent.)
export function curveTangent(curve: Bezier, t: number): [number, number] {
  const norm = (dx: number, dy: number): [number, number] | null => {
    const m = Math.hypot(dx, dy);
    return m > 1e-9 ? [dx / m, dy / m] : null;
  };
  const d = curve.derivative(t);
  let r = norm(d.x, d.y);
  if (!r) {
    const ti = Math.min(0.999, Math.max(0.001, t));
    const di = curve.derivative(ti);
    r = norm(di.x, di.y);
  }
  if (!r) {
    const h = 1e-3;
    const a = curve.get(Math.max(0, t - h));
    const b = curve.get(Math.min(1, t + h));
    r = norm(b.x - a.x, b.y - a.y);
  }
  if (!r) {
    const p0 = curve.points[0];
    const p3 = curve.points[curve.points.length - 1];
    r = norm(p3.x - p0.x, p3.y - p0.y);
  }
  return r ?? [0, 0];
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
  const lenInSub = targetLen - lengths.offsets[subIdx];
  return sampleSubpathAtLength(sub, lenInSub);
}

// Sample one subpath at t ∈ [0,1] of *that* subpath's own arc length
// (not the concatenated spline). Closed/open and wrap are the caller's
// problem — this just locates the cubic.
export function sampleSubpathAt(
  lengths: SubpathLengths,
  t: number
): SampleResult {
  if (lengths.total <= 0) return { pos: [0, 0], tangent: [0, 0] };
  const clamped = Math.max(0, Math.min(1, t));
  return sampleSubpathAtLength(lengths, clamped * lengths.total);
}

function sampleSubpathAtLength(
  sub: SubpathLengths | undefined,
  lenInSub: number
): SampleResult {
  if (!sub || sub.total <= 0) return { pos: [0, 0], tangent: [0, 0] };
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
  return { pos: [p.x, p.y], tangent: curveTangent(seg.curve, tSeg) };
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
    samples.push({ pos: [p.x, p.y], tangent: curveTangent(seg.curve, tSeg) });
  }
  // Handle length is LOCAL: 1/3 of the straight-line distance to the neighbour
  // on each side (out ← next chord, in ← prev chord). NOT the global mean
  // spacing. Even arc-length sampling bunches anchors where the curve bends
  // tightly, so a mean-length handle overshoots its close neighbour, folds the
  // rebuilt cubic into a loop/cusp, and flips the sampled tangent ~180° there
  // (and shows a visible kink). Scaling each handle to its own side's chord
  // keeps both handles on a segment ≤ chord/3, so the segment can't self-fold —
  // the tangent field stays continuous and copies orient smoothly along it.
  const last = samples.length - 1;
  const chord = (i: number, j: number): number =>
    Math.hypot(
      samples[i].pos[0] - samples[j].pos[0],
      samples[i].pos[1] - samples[j].pos[1]
    );
  const anchors: SplineAnchor[] = samples.map((s, i) => {
    const a: SplineAnchor = { pos: s.pos };
    if (s.tangent[0] !== 0 || s.tangent[1] !== 0) {
      // Neighbours wrap on a closed subpath; an open end reuses its one
      // neighbour for the missing side so both handles stay defined.
      let prevD = i > 0 ? chord(i, i - 1) : sub.closed ? chord(i, last) : NaN;
      let nextD = i < last ? chord(i, i + 1) : sub.closed ? chord(i, 0) : NaN;
      if (Number.isNaN(prevD)) prevD = nextD;
      if (Number.isNaN(nextD)) nextD = prevD;
      const outLen = nextD / 3;
      const inLen = prevD / 3;
      a.outHandle = [s.tangent[0] * outLen, s.tangent[1] * outLen];
      a.inHandle = [-s.tangent[0] * inLen, -s.tangent[1] * inLen];
    }
    return a;
  });
  return { anchors, closed: sub.closed };
}

// bezier-js's offset() needs non-degenerate control points: a handle-less
// (or zero-handle) straight segment maps to a cubic with cp1 === p0, whose
// derivative — hence normal — vanishes at the endpoints, and the offset
// translates by a NaN normal. Synthesize 1/3-chord handles (identical
// geometry) on such segments before offsetting.
function solidifyForOffset(sub: SplineSubpath): SplineSubpath {
  const n = sub.anchors.length;
  const anchors = sub.anchors.map((a) => ({ ...a }));
  const zero = (h?: [number, number]) => !h || (h[0] === 0 && h[1] === 0);
  const seg = (i: number, j: number) => {
    const a = anchors[i];
    const b = anchors[j];
    const dx = b.pos[0] - a.pos[0];
    const dy = b.pos[1] - a.pos[1];
    if (dx === 0 && dy === 0) return; // zero-length: nothing to orient by
    if (zero(a.outHandle)) a.outHandle = [dx / 3, dy / 3];
    if (zero(b.inHandle)) b.inHandle = [-dx / 3, -dy / 3];
  };
  for (let i = 0; i < n - 1; i++) seg(i, i + 1);
  if (sub.closed && n >= 2) seg(n - 1, 0);
  return { ...sub, anchors };
}

// Circular-arc join for a corner of the parallel curve: the arc from E to S
// around center C (the source corner anchor), radius ≈ |offset distance|,
// approximated by ≤90° cubic spans (handle length k = 4/3·tan(Δ/4)·r).
// Returns the tangent handle for the E anchor, intermediate arc anchors,
// and the tangent handle for the S anchor — or null when E/S don't sit near
// the radius-r circle (degenerate input; caller falls back to a straight
// connector).
function cornerArcJoin(
  E: [number, number],
  S: [number, number],
  C: [number, number],
  radius: number
): {
  outH: [number, number];
  mids: SplineAnchor[];
  inH: [number, number];
} | null {
  const vex = E[0] - C[0];
  const vey = E[1] - C[1];
  const vsx = S[0] - C[0];
  const vsy = S[1] - C[1];
  const rE = Math.hypot(vex, vey);
  const rS = Math.hypot(vsx, vsy);
  if (rE < radius * 0.75 || rE > radius * 1.25) return null;
  if (rS < radius * 0.75 || rS > radius * 1.25) return null;
  // Signed sweep from (E−C) to (S−C), shortest way — this equals the
  // tangent turn at the corner, so the arc continues the travel direction
  // on the convex side and closes the classic offset loop on the concave
  // side (which the overlap resolve then culls).
  const sweep = Math.atan2(vex * vsy - vey * vsx, vex * vsx + vey * vsy);
  if (sweep === 0) return null;
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const step = sweep / n;
  const r = (rE + rS) / 2;
  const h = (4 / 3) * Math.tan(Math.abs(step) / 4) * r;
  const sgn = Math.sign(step);
  const a0 = Math.atan2(vey, vex);
  const tangentAt = (ang: number): [number, number] => [
    -Math.sin(ang) * sgn,
    Math.cos(ang) * sgn,
  ];
  const mids: SplineAnchor[] = [];
  for (let k = 1; k < n; k++) {
    const ang = a0 + step * k;
    const t = tangentAt(ang);
    mids.push({
      pos: [C[0] + r * Math.cos(ang), C[1] + r * Math.sin(ang)],
      inHandle: [-h * t[0], -h * t[1]],
      outHandle: [h * t[0], h * t[1]],
    });
  }
  const t0 = tangentAt(a0);
  const tn = tangentAt(a0 + sweep);
  return {
    outH: [h * t0[0], h * t0[1]],
    mids,
    inH: [-h * tn[0], -h * tn[1]],
  };
}

// --- fast parallel-curve offset -------------------------------------------
//
// bezier-js's .offset(d) delegates to reduce(), whose second pass hunts for
// "simple" spans by LINEAR SCAN at t-step 0.01: it constructs a throwaway
// Bezier via split(t1,t2) at every step and tests it. A span that is already
// simple end to end still pays the full ~100 splits to discover that, and
// each split allocates control points plus a derivative set. At the volumes
// Offset Path sees in practice — 900+ source segments per frame, each first
// split at its extrema — that one call dominated the entire frame: measured
// 264µs per source segment, 244ms per frame, 79% of a 309ms budget.
//
// Bisection finds the same spans in O(log n) splits instead of O(1/step):
// test the whole span, and only when the test fails split at the midpoint and
// recurse. A span that is already simple now costs ONE split and one test.
//
// The resulting pieces differ from the library's — its greedy scan yields
// maximal spans, bisection yields spans on binary fractions of t — but every
// piece satisfies the same simple() predicate, which is the only property
// scale() actually requires of its input.
const REDUCE_MAX_DEPTH = 8; // 1/256 of a span — finer than the 0.01 scan

// Below this the control points are treated as coincident: 1e-6 of normalized
// canvas space is ~1/1000 of a pixel at 1024².
const DEGENERATE_EPS_SQ = 1e-12;

// A span with no extent has no well-defined tangent, so its normals come back
// NaN and simple() — which compares them through acos — is false forever.
// Bisecting such a span would recurse straight to the depth cap and emit 2^MAX
// garbage pieces (measured: 256 pieces, 257 non-finite anchors, from a single
// zero-length input segment). bezier-js escaped this through reduce()'s "we
// can never form a reduction" bail-out; this is the equivalent.
function spanHasExtent(s: Bezier): boolean {
  const p = s.points;
  let maxSq = 0;
  for (const q of p) {
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return false;
    const dx = q.x - p[0].x;
    const dy = q.y - p[0].y;
    const d2 = dx * dx + dy * dy;
    if (d2 > maxSq) maxSq = d2;
  }
  return maxSq > DEGENERATE_EPS_SQ;
}

// bezier-js's reduce() also gives up and returns [] when a span narrower than
// one step is still not simple, silently dropping that stretch of curve. Where
// the span still has extent we stop subdividing at REDUCE_MAX_DEPTH and keep
// the piece instead: a slightly non-simple sliver offsets imperfectly, but a
// dropped one leaves a hole in the chain, which offsetSubpath would then
// bridge with a bogus corner arc.
function reduceSpan(
  src: Bezier,
  t1: number,
  t2: number,
  out: Bezier[],
  depth: number
): void {
  const seg = t1 === 0 && t2 === 1 ? src : src.split(t1, t2);
  if (!spanHasExtent(seg)) return;
  if (depth >= REDUCE_MAX_DEPTH || seg.simple()) {
    out.push(seg);
    return;
  }
  const tm = (t1 + t2) * 0.5;
  reduceSpan(src, t1, tm, out, depth + 1);
  reduceSpan(src, tm, t2, out, depth + 1);
}

// Split at the curve's extrema (same first pass as bezier-js — these are the
// points where the offset genuinely needs a break), then bisect each piece
// until simple.
function reduceToSimple(curve: Bezier): Bezier[] {
  const out: Bezier[] = [];
  const ts: number[] = [0];
  // extrema().values is sorted and deduped, and may include 0 and/or 1.
  for (const t of curve.extrema().values) {
    if (t > 1e-6 && t < 1 - 1e-6 && t > ts[ts.length - 1] + 1e-6) ts.push(t);
  }
  ts.push(1);
  for (let i = 0; i + 1 < ts.length; i++) {
    reduceSpan(curve, ts[i], ts[i + 1], out, 0);
  }
  return out;
}

// Translate a straight span along its (constant) normal. bezier-js does this
// for curves it flagged `_linear`, where scale()'s construction degenerates:
// the endpoint normals are parallel, so they have no intersection to scale
// about and lli4 returns null.
function translateAlongNormal(s: Bezier, d: number): Bezier | null {
  const n = s.normal(0);
  if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return null;
  const pts = s.points.map((p) => ({ x: p.x + n.x * d, y: p.y + n.y * d }));
  return new Bezier(pts);
}

function allFinite(s: Bezier): boolean {
  for (const p of s.points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  }
  return true;
}

function offsetPiece(s: Bezier, d: number): Bezier | null {
  // `_linear` is set by the Bezier constructor (all control points on the
  // baseline within its epsilon). Not in the published typings, but it is the
  // same flag the library's own offset() branches on.
  let out: Bezier | null;
  if ((s as unknown as { _linear?: boolean })._linear) {
    out = translateAlongNormal(s, d);
  } else {
    try {
      out = s.scale(d);
    } catch {
      // scale() throws "cannot scale this curve" when the endpoint normals are
      // parallel despite the curve not being flagged linear (a near-straight
      // span). Translating is the correct limit of the offset in that case.
      out = translateAlongNormal(s, d);
    }
  }
  // scale() can return non-finite control points without throwing when its
  // scaling origin lands at infinity. Emitting those would poison every
  // downstream consumer, so drop the piece.
  return out && allFinite(out) ? out : null;
}

// Drop-in replacement for `curve.offset(d)`.
function offsetCurve(curve: Bezier, d: number): Bezier[] {
  if (!spanHasExtent(curve)) return [];
  if ((curve as unknown as { _linear?: boolean })._linear) {
    const only = translateAlongNormal(curve, d);
    return only && allFinite(only) ? [only] : [];
  }
  const out: Bezier[] = [];
  for (const piece of reduceToSimple(curve)) {
    const o = offsetPiece(piece, d);
    if (o) out.push(o);
  }
  return out;
}

// Parallel-curve offset. offsetCurve() on a single cubic returns an array of
// cubics (subdividing around high-curvature regions). Each source segment's offset chain is contiguous internally,
// but at a source CORNER (tangent discontinuity) consecutive chains do NOT
// meet — they're separated by an arc-shaped gap of angle = the tangent turn.
// We insert that arc (radius |distance| around the corner anchor), which is
// the exact parallel curve of a corner: rings stay equidistant at corners
// instead of getting welded/chamfered. Smooth joins (gap ≈ 0) merge into a
// single anchor as before.
export function offsetSubpath(
  sub: SplineSubpath,
  distance: number
): SplineSubpath | null {
  if (distance === 0) return sub;
  const solid = solidifyForOffset(sub);
  // Curves, not BezierSegments — the offset never looks at arc length, and
  // measuring it here cost a Gauss-Legendre integration per segment.
  const segments = subpathToCurves(solid);
  if (segments.length === 0) return null;
  const nAnchors = solid.anchors.length;

  // Offset per source segment, keeping the chains separate — segIdx maps a
  // chain back to its source segment so joins know which corner anchor to
  // wrap around. (subpathToBeziers emits segment j = anchors[j]→[j+1] plus
  // a closing segment, so the corner after segment j is anchors[(j+1)%n].)
  const chains: { curves: Bezier[]; segIdx: number }[] = [];
  for (let j = 0; j < segments.length; j++) {
    const result = offsetCurve(segments[j], distance);
    if (result.length > 0) {
      chains.push({ curves: result, segIdx: j });
    }
  }
  if (chains.length === 0) return null;

  const absD = Math.abs(distance);
  // Below this gap a join is treated as smooth/continuous. Relative to the
  // offset distance so it's scale-free (callers pass normalized OR pixel
  // space). Corners turn a gap of 2·|d|·sin(θ/2), so this merges only
  // sub-degree corners.
  const mergeEps = absD * 0.01;

  const anchors: SplineAnchor[] = [];
  const firstPts = chains[0].curves[0].points;
  anchors.push({
    pos: [firstPts[0].x, firstPts[0].y],
    outHandle: [firstPts[1].x - firstPts[0].x, firstPts[1].y - firstPts[0].y],
  });

  for (let ci = 0; ci < chains.length; ci++) {
    const { curves, segIdx } = chains[ci];
    // Interior of the chain: contiguous cubics from one segment's offset.
    // Carry the next curve's CP1 as the outHandle so the join tracks any
    // slight discontinuity the subdivision introduced.
    for (let k = 0; k + 1 < curves.length; k++) {
      const p = curves[k].points;
      const nextCp1 = curves[k + 1].points[1];
      anchors.push({
        pos: [p[3].x, p[3].y],
        inHandle: [p[2].x - p[3].x, p[2].y - p[3].y],
        outHandle: [nextCp1.x - p[3].x, nextCp1.y - p[3].y],
      });
    }
    const lastP = curves[curves.length - 1].points;
    const endAnchor: SplineAnchor = {
      pos: [lastP[3].x, lastP[3].y],
      inHandle: [lastP[2].x - lastP[3].x, lastP[2].y - lastP[3].y],
    };

    const isSeam = ci === chains.length - 1;
    const nextChain = isSeam ? (sub.closed ? chains[0] : null) : chains[ci + 1];
    if (!nextChain) {
      // Open end — nothing to join.
      anchors.push(endAnchor);
      continue;
    }

    const sPts = nextChain.curves[0].points;
    const S: [number, number] = [sPts[0].x, sPts[0].y];
    const E = endAnchor.pos;
    const gap = Math.hypot(E[0] - S[0], E[1] - S[1]);

    if (gap <= mergeEps) {
      // Smooth join. Mid-path: merge into one anchor grafting the next
      // chain's CP1 (the next chain's start IS this anchor). At the seam:
      // keep both anchors — the closing segment spans the ≈0 gap.
      if (!isSeam) {
        endAnchor.outHandle = [sPts[1].x - E[0], sPts[1].y - E[1]];
      }
      anchors.push(endAnchor);
      continue;
    }

    // Corner join. Only when the chains are source-adjacent do we know the
    // corner anchor; a dropped segment between them leaves no center to arc
    // around, so fall back to a straight connector (no handles).
    const contiguous = nextChain.segIdx === (segIdx + 1) % segments.length;
    const arc = contiguous
      ? cornerArcJoin(E, S, solid.anchors[(segIdx + 1) % nAnchors].pos, absD)
      : null;
    if (arc) {
      endAnchor.outHandle = arc.outH;
      anchors.push(endAnchor, ...arc.mids);
    } else {
      anchors.push(endAnchor);
    }
    if (isSeam) {
      // The closing segment (last anchor → anchors[0]) becomes the arc's
      // final cubic.
      if (arc) anchors[0].inHandle = arc.inH;
    } else {
      const startAnchor: SplineAnchor = {
        pos: S,
        outHandle: [sPts[1].x - S[0], sPts[1].y - S[1]],
      };
      if (arc) startAnchor.inHandle = arc.inH;
      anchors.push(startAnchor);
    }
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
// Spec: specdocs/archive/062526_spline-pencil-tool.md.
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
  // Scalar accumulation — the vector spelling allocated four arrays per
  // sample here. Same operations in the same order; see newtonStep.
  const t1x = tHat1[0], t1y = tHat1[1];
  const t2x = tHat2[0], t2y = tHat2[1];
  const p0x = p0[0], p0y = p0[1];
  const p3x = p3[0], p3y = p3[1];
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let k = 0; k < n; k++) {
    const uu = u[k];
    const b0 = B0(uu), b1 = B1(uu), b2 = B2(uu), b3 = B3(uu);
    const a0x = t1x * b1, a0y = t1y * b1;
    const a1x = t2x * b2, a1y = t2y * b2;
    c00 += a0x * a0x + a0y * a0y;
    c01 += a0x * a1x + a0y * a1y;
    c11 += a1x * a1x + a1y * a1y;
    // Part of the point fixed by the (clamped) endpoints.
    const wStart = b0 + b1;
    const wEnd = b2 + b3;
    const pk = pts[first + k];
    const tmpx = pk[0] - (p0x * wStart + p3x * wEnd);
    const tmpy = pk[1] - (p0y * wStart + p3y * wEnd);
    x0 += a0x * tmpx + a0y * tmpy;
    x1 += a1x * tmpx + a1y * tmpy;
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
//
// Written out in scalars. V2 is [number, number], so the vSub/vScale/vAdd
// spelling allocated a fresh 2-element array for EVERY intermediate — this
// function alone built ~15 of them, and it runs per sample per iteration per
// recursion level. It was a third of Blend Intersections.
//
// Every expression below is the same arithmetic in the same order as the
// vector-helper version, so the float results are bit-identical (verified by
// snapshotting 18 configurations of blendIntersections, 52823 anchors, before
// and after). Keep it that way: in particular vLen used Math.hypot, which is
// NOT equal to sqrt(x*x+y*y) in the last bits, and a changed last bit can
// flip which sample is chosen as the split point and cascade into different
// output.
function newtonStep(cubic: V2[], P: V2, u: number): number {
  const c0x = cubic[0][0], c0y = cubic[0][1];
  const c1x = cubic[1][0], c1y = cubic[1][1];
  const c2x = cubic[2][0], c2y = cubic[2][1];
  const c3x = cubic[3][0], c3y = cubic[3][1];

  const b0 = B0(u), b1 = B1(u), b2 = B2(u), b3 = B3(u);
  const qx = b0 * c0x + b1 * c1x + b2 * c2x + b3 * c3x;
  const qy = b0 * c0y + b1 * c1y + b2 * c2y + b3 * c3y;

  // Q'(u): degree-2 bézier of 3·(Cᵢ₊₁−Cᵢ).
  const q10x = (c1x - c0x) * 3, q10y = (c1y - c0y) * 3;
  const q11x = (c2x - c1x) * 3, q11y = (c2y - c1y) * 3;
  const q12x = (c3x - c2x) * 3, q12y = (c3y - c2y) * 3;
  const om = 1 - u;
  const q1ux = om ** 2 * q10x + 2 * om * u * q11x + u * u * q12x;
  const q1uy = om ** 2 * q10y + 2 * om * u * q11y + u * u * q12y;

  // Q''(u): degree-1 bézier of 2·(Q'ᵢ₊₁−Q'ᵢ).
  const q20x = (q11x - q10x) * 2, q20y = (q11y - q10y) * 2;
  const q21x = (q12x - q11x) * 2, q21y = (q12y - q11y) * 2;
  const q2ux = om * q20x + u * q21x;
  const q2uy = om * q20y + u * q21y;

  const dx = qx - P[0];
  const dy = qy - P[1];
  const num = dx * q1ux + dy * q1uy;
  const den = (q1ux * q1ux + q1uy * q1uy) + (dx * q2ux + dy * q2uy);
  if (Math.abs(den) < 1e-12) return u;
  return u - num / den;
}

// Max distance from the fitted cubic to its samples, plus the index that
// should split the run if the fit is rejected. Scalar for the same reason as
// newtonStep — this allocated two arrays per sample.
function maxFitError(
  pts: V2[],
  first: number,
  last: number,
  cubic: V2[],
  u: number[]
): { error: number; split: number } {
  const c0x = cubic[0][0], c0y = cubic[0][1];
  const c1x = cubic[1][0], c1y = cubic[1][1];
  const c2x = cubic[2][0], c2y = cubic[2][1];
  const c3x = cubic[3][0], c3y = cubic[3][1];
  let error = 0;
  let split = first + Math.floor((last - first) / 2);
  for (let i = first + 1; i < last; i++) {
    const t = u[i - first];
    const b0 = B0(t), b1 = B1(t), b2 = B2(t), b3 = B3(t);
    const qx = b0 * c0x + b1 * c1x + b2 * c2x + b3 * c3x;
    const qy = b0 * c0y + b1 * c1y + b2 * c2y + b3 * c3y;
    const p = pts[i];
    // Math.hypot, matching vLen — see newtonStep's note on bit-exactness.
    const d = Math.hypot(qx - p[0], qy - p[1]);
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

// Rewrite the in/out handles of existing anchors with catmull-rom auto
// handles: the tangent at Pᵢ is (Pᵢ₊₁ − Pᵢ₋₁)/2, so each anchor gets
// symmetric handles ±tension·(Pᵢ₊₁ − Pᵢ₋₁)/6. Open endpoints get a one-sided
// handle toward their single neighbor; closed subpaths wrap. tension 1 is
// plain catmull-rom, 0 collapses to a polyline, > 1 overshoots. Positions
// are copied, never mutated — returns fresh anchors. Shared by
// catmullRomSubpath (the parametric primitives) and Set Spline Type.
export function autoSmoothHandles(
  anchors: SplineAnchor[],
  closed: boolean,
  tension = 1
): SplineAnchor[] {
  const n = anchors.length;
  if (n < 2) return anchors.map((a) => ({ pos: [a.pos[0], a.pos[1]] as V2 }));
  const at = (i: number): V2 =>
    closed
      ? anchors[((i % n) + n) % n].pos
      : anchors[Math.max(0, Math.min(n - 1, i))].pos;
  const out: SplineAnchor[] = [];
  for (let i = 0; i < n; i++) {
    const p = anchors[i].pos;
    const a: SplineAnchor = { pos: [p[0], p[1]] };
    if (!closed && i === 0) {
      const next = anchors[1].pos;
      a.outHandle = [
        ((next[0] - p[0]) / 3) * tension,
        ((next[1] - p[1]) / 3) * tension,
      ];
    } else if (!closed && i === n - 1) {
      const prev = anchors[n - 2].pos;
      a.inHandle = [
        ((prev[0] - p[0]) / 3) * tension,
        ((prev[1] - p[1]) / 3) * tension,
      ];
    } else {
      const prev = at(i - 1);
      const next = at(i + 1);
      const hx = ((next[0] - prev[0]) / 6) * tension;
      const hy = ((next[1] - prev[1]) / 6) * tension;
      a.outHandle = [hx, hy];
      a.inHandle = [-hx, -hy];
    }
    out.push(a);
  }
  return out;
}

// Build a smooth interpolating subpath through `points` via a uniform
// Catmull-Rom → Bézier conversion (see autoSmoothHandles). The curve passes
// through every point (unlike a least-squares fit). Points are in the
// SplineValue's normalized space. Used by the parametric primitives (Spiral,
// Sine Wave) and Points to Spline. Fewer than 2 points → a plain
// corner-anchor subpath.
export function catmullRomSubpath(points: V2[], closed: boolean): SplineSubpath {
  const corner = points.map((p) => ({ pos: [p[0], p[1]] as V2 }));
  return { anchors: autoSmoothHandles(corner, closed), closed };
}

// Ramer–Douglas–Peucker polyline simplification. Keeps the subset of
// points whose removal would deviate the chain by more than `tol`
// (same units as the points — callers pick the space; pixel space gives
// an isotropic tolerance on non-square canvases). Straight runs collapse
// to single segments while curves keep ≤ tol fidelity — the decimator
// for dense marching-squares contours (text outline), whose ~1-cell
// edges otherwise cap Round Corners' fillets into sub-pixel no-ops.
// `closed` loops are handled by appending the seam point and letting the
// degenerate first chord (zero length → radial distance) pick the far
// side of the loop as the first split. A closed loop that simplifies
// below 3 points (everything within tol of the seam) returns just the
// seam — callers drop those micro-loops.
export function simplifyPolyline(
  pts: V2[],
  tol: number,
  closed: boolean
): V2[] {
  const n = pts.length;
  if (n <= (closed ? 3 : 2) || !(tol > 0)) return pts.slice();
  const src = closed ? [...pts, pts[0]] : pts;
  const m = src.length;
  const keep = new Uint8Array(m);
  keep[0] = 1;
  keep[m - 1] = 1;
  // Iterative stack — glyph outlines run to thousands of points and
  // worst-case RDP recursion is O(n) deep.
  const stack: Array<[number, number]> = [[0, m - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = src[a][0];
    const ay = src[a][1];
    const dx = src[b][0] - ax;
    const dy = src[b][1] - ay;
    const len = Math.hypot(dx, dy);
    let maxD = -1;
    let maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const px = src[i][0] - ax;
      const py = src[i][1] - ay;
      const d =
        len < 1e-12
          ? Math.hypot(px, py)
          : Math.abs(px * dy - py * dx) / len;
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > tol) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  const out: V2[] = [];
  const last = closed ? m - 1 : m; // drop the appended seam duplicate
  for (let i = 0; i < last; i++) if (keep[i]) out.push(src[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Corner rounding — the Round Corners node (Illustrator "Round Corners").
// Replace each *corner* anchor (one with no handles — straight edges meet here)
// with a pair of anchors inset along the incoming/outgoing edges, joined by a
// circular-fillet cubic. The inset distance is
//   d = min(radius, |prevEdge|/2, |nextEdge|/2)
// — capping at half of each edge keeps two adjacent corners from overrunning
// the edge they share. The fillet is a true circular arc tangent to both
// edges: with the tangent lines meeting at the corner at distance d, the arc
// radius is R = d / tan(θ/2) where θ is the turn angle, and each bézier handle
// has length R·(4/3)·tan(θ/4) — the same arc→bézier formula the Arc primitive
// uses — pointing from each inset anchor back toward the original corner.
//
// Anchors that already carry a handle (a curve meets here) pass through
// untouched — rounding an already-curved join is ill-defined (v1). Closed
// subpaths round every anchor (neighbors wrap); open subpaths leave the two
// endpoints alone. radius ≤ 0 is identity. Positions are normalized [0,1]²
// (no aspect correction — matches the other spline modifiers).
// Spec: specdocs/archive/062526_node-expansion.md §3.
// ---------------------------------------------------------------------------

const ROUND_EPS = 1e-6;

function anchorHasHandle(a: SplineAnchor): boolean {
  return (
    (a.inHandle != null && (a.inHandle[0] !== 0 || a.inHandle[1] !== 0)) ||
    (a.outHandle != null && (a.outHandle[0] !== 0 || a.outHandle[1] !== 0))
  );
}

// Generalized over a per-anchor radius resolver so the uniform Round Corners
// node and Spline Draw's per-anchor Live Corners (anchor.cornerRadius, spec
// 071926_spline-draw-authoring-upgrade.md M1) share one fillet.
function roundSubpath(
  sub: SplineSubpath,
  radiusFor: (a: SplineAnchor, index: number) => number
): SplineSubpath {
  const anchors = sub.anchors;
  const n = anchors.length;
  // Fewer than 3 anchors → no real corner to round (a closed 2-anchor path is
  // a degenerate back-and-forth). Return a shallow clone unchanged.
  if (n < 3) return { anchors: anchors.map((a) => ({ ...a })), closed: sub.closed };
  const out: SplineAnchor[] = [];
  for (let i = 0; i < n; i++) {
    const cur = anchors[i];
    const isEndpoint = !sub.closed && (i === 0 || i === n - 1);
    if (isEndpoint || anchorHasHandle(cur)) {
      out.push({ ...cur });
      continue;
    }
    const radius = radiusFor(cur, i);
    if (!(radius > 0)) {
      out.push({ ...cur });
      continue;
    }
    const P = cur.pos;
    const prev = anchors[(i - 1 + n) % n].pos;
    const next = anchors[(i + 1) % n].pos;
    const toPrev = vSub(prev, P); // P → previous neighbor
    const toNext = vSub(next, P); // P → next neighbor
    const lenPrev = vLen(toPrev);
    const lenNext = vLen(toNext);
    if (lenPrev < ROUND_EPS || lenNext < ROUND_EPS) {
      out.push({ ...cur });
      continue;
    }
    const uPrev = vScale(toPrev, 1 / lenPrev); // unit P → prev
    const uNext = vScale(toNext, 1 / lenNext); // unit P → next
    // Turn angle θ between travel-in (prev→P, i.e. -uPrev) and travel-out
    // (P→next, i.e. uNext). dot(-uPrev, uNext) = -dot(uPrev, uNext).
    const cosT = Math.max(-1, Math.min(1, -vDot(uPrev, uNext)));
    const theta = Math.acos(cosT);
    // Nearly straight (no corner) or a degenerate 180° spike → leave as-is.
    if (theta < ROUND_EPS || Math.PI - theta < ROUND_EPS) {
      out.push({ ...cur });
      continue;
    }
    const d = Math.min(radius, lenPrev / 2, lenNext / 2);
    if (d < ROUND_EPS) {
      out.push({ ...cur });
      continue;
    }
    const R = d / Math.tan(theta / 2);
    const h = R * (4 / 3) * Math.tan(theta / 4);
    const p1 = vAdd(P, vScale(uPrev, d)); // inset toward prev
    const p2 = vAdd(P, vScale(uNext, d)); // inset toward next
    // Corner style (spec 080226 M1): all three variants share the inset
    // frame above. Chamfer = straight cut; scoop = the round arc's control
    // tips reflected across the p1→p2 chord (same tangent circle, bulging
    // INTO the corner); default = the circular arc.
    if (cur.cornerStyle === "chamfer") {
      out.push({ pos: p1 });
      out.push({ pos: p2 });
    } else if (cur.cornerStyle === "scoop") {
      const chord = vSub(p2, p1);
      const cl = vLen(chord);
      if (cl < ROUND_EPS) {
        out.push({ pos: p1 });
        out.push({ pos: p2 });
      } else {
        const c = vScale(chord, 1 / cl);
        // Reflect q across the chord line (through p1, direction c).
        const reflect = (q: [number, number]): [number, number] => {
          const rel = vSub(q, p1);
          const t = vDot(rel, c);
          return [
            p1[0] + 2 * t * c[0] - rel[0],
            p1[1] + 2 * t * c[1] - rel[1],
          ];
        };
        const tip1 = reflect(vAdd(p1, vScale(uPrev, -h)));
        const tip2 = reflect(vAdd(p2, vScale(uNext, -h)));
        out.push({ pos: p1, outHandle: vSub(tip1, p1) });
        out.push({ pos: p2, inHandle: vSub(tip2, p2) });
      }
    } else {
      // Both fillet handles point from the inset anchor back toward P.
      out.push({ pos: p1, outHandle: vScale(uPrev, -h) });
      out.push({ pos: p2, inHandle: vScale(uNext, -h) });
    }
  }
  return { anchors: out, closed: sub.closed };
}

export function roundCorners(
  subpaths: SplineSubpath[],
  radius: number
): SplineSubpath[] {
  if (!(radius > 0)) return subpaths;
  return subpaths.map((s) => roundSubpath(s, () => radius));
}

// --- Live Corners (per-anchor radius) --------------------------------------
// Spline Draw's live rounding: each anchor may carry its own `cornerRadius`
// (see SplineAnchor in types.ts); anchors without one pass through. Fillet
// math, caps, and eligibility (handle-less interior corners only) are
// identical to roundCorners. Identity — returns the INPUT ARRAY REFERENCE —
// when no anchor carries a live radius, so callers can apply it
// unconditionally at zero cost for radius-free splines.

function anchorHasLiveCorner(a: SplineAnchor): boolean {
  return (a.cornerRadius ?? 0) > ROUND_EPS && !anchorHasHandle(a);
}

export function hasLiveCorners(subpaths: SplineSubpath[]): boolean {
  return subpaths.some((s) => s.anchors.some(anchorHasLiveCorner));
}

export function roundCornersPerAnchor(
  subpaths: SplineSubpath[]
): SplineSubpath[] {
  if (!hasLiveCorners(subpaths)) return subpaths;
  return subpaths.map((s) =>
    s.anchors.some(anchorHasLiveCorner)
      ? roundSubpath(s, (a) => a.cornerRadius ?? 0)
      : s
  );
}
