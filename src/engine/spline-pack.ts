import { Bezier } from "bezier-js";
import { aspectCorrectY, aspectUncorrectY } from "./aspect";
import { simplifyPolyline } from "./spline-math";
import type { SplineAnchor, SplineSubpath, SplineValue } from "./types";

// Greedy collision-packing of spline fragments (spec 090126_spline-pack.md).
// Flatten into canvas px, pack there (radii are circles only in px), map
// the surviving pieces back to authored [0,1]². A polyline is corner
// anchors; bezier-fit is a downstream job.

const SIMPLIFY_TOL_PX = 0.25;
const LUT_STEP_PX = 0.5;

export interface SplinePackOpts {
  minWidth: number;
  maxWidth: number;
  randomizeWidth: boolean;
  gap: number;
  minLength: number;
  spacing: number;
  seed: number;
  width: number;
  height: number;
}

interface Frag {
  xy: Float32Array;
  n: number;
  closed: boolean;
  rTarget: number;
  sourceIndex: number;
}

interface Placed {
  xy: Float32Array;
  n: number;
  closed: boolean;
  r: number;
  sourceIndex: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function safeLength(curve: Bezier): number {
  try {
    const L = curve.length();
    if (Number.isFinite(L) && L >= 0) return L;
  } catch {
    // fall through
  }
  const p0 = curve.points[0];
  const p3 = curve.points[curve.points.length - 1];
  return Math.hypot(p3.x - p0.x, p3.y - p0.y);
}

function pxOf(
  p: [number, number],
  W: number,
  H: number,
  aspect: number
): [number, number] {
  return [p[0] * W, aspectCorrectY(p[1], aspect) * H];
}

function authoredOf(
  x: number,
  y: number,
  W: number,
  H: number,
  aspect: number
): [number, number] {
  return [x / W, aspectUncorrectY(y / H, aspect)];
}

function subpathToPxCurves(
  sub: SplineSubpath,
  W: number,
  H: number
): Bezier[] {
  const anchors = sub.anchors;
  const n = anchors.length;
  if (n < 2) return [];
  const aspect = W / Math.max(1, H);
  const px = (p: [number, number]) => pxOf(p, W, H, aspect);
  const make = (a: SplineAnchor, b: SplineAnchor): Bezier => {
    const p0 = px(a.pos);
    const p1 = px(
      a.outHandle
        ? [a.pos[0] + a.outHandle[0], a.pos[1] + a.outHandle[1]]
        : a.pos
    );
    const p2 = px(
      b.inHandle
        ? [b.pos[0] + b.inHandle[0], b.pos[1] + b.inHandle[1]]
        : b.pos
    );
    const p3 = px(b.pos);
    return new Bezier(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  };
  const out: Bezier[] = [];
  for (let i = 0; i < n - 1; i++) out.push(make(anchors[i], anchors[i + 1]));
  if (sub.closed) out.push(make(anchors[n - 1], anchors[0]));
  return out;
}

interface LutPt {
  x: number;
  y: number;
  s: number;
}

function sampleLut(lut: LutPt[], s: number): { x: number; y: number } {
  const last = lut[lut.length - 1];
  if (s <= lut[0].s) return lut[0];
  if (s >= last.s) return last;
  let lo = 0;
  let hi = lut.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lut[mid].s <= s) lo = mid;
    else hi = mid;
  }
  const a = lut[lo];
  const b = lut[hi];
  const span = b.s - a.s;
  const t = span > 1e-12 ? (s - a.s) / span : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function flattenSubpath(
  sub: SplineSubpath,
  spacing: number,
  W: number,
  H: number
): { xy: Float32Array; n: number } | null {
  const curves = subpathToPxCurves(sub, W, H);
  if (curves.length === 0) return null;
  const lut: LutPt[] = [];
  let acc = 0;
  let prevX = 0;
  let prevY = 0;
  let hasPrev = false;
  for (const curve of curves) {
    const L = safeLength(curve);
    const steps = Math.max(4, Math.ceil(Math.max(L, 1e-3) / LUT_STEP_PX));
    const k0 = hasPrev ? 1 : 0;
    for (let k = k0; k <= steps; k++) {
      const p = curve.get(k / steps);
      if (hasPrev) acc += Math.hypot(p.x - prevX, p.y - prevY);
      lut.push({ x: p.x, y: p.y, s: acc });
      prevX = p.x;
      prevY = p.y;
      hasPrev = true;
    }
  }
  if (lut.length < 2 || acc < 1e-6) return null;

  const pts: number[] = [];
  const emit = (s: number) => {
    const p = sampleLut(lut, s);
    pts.push(p.x, p.y);
  };
  emit(0);
  const sp = Math.max(0.25, spacing);
  for (let s = sp; s < acc - 1e-4; s += sp) emit(s);
  const lastX = pts[pts.length - 2];
  const lastY = pts[pts.length - 1];
  const end = lut[lut.length - 1];
  if (Math.hypot(end.x - lastX, end.y - lastY) > 1e-4) emit(acc);

  if (sub.closed && pts.length >= 4) {
    const dx = pts[pts.length - 2] - pts[0];
    const dy = pts[pts.length - 1] - pts[1];
    if (Math.hypot(dx, dy) < sp * 0.25) pts.length -= 2;
  }
  const n = pts.length / 2;
  if (n < (sub.closed ? 3 : 2)) return null;
  return { xy: new Float32Array(pts), n };
}

function distPointSeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointToPolyline(
  px: number,
  py: number,
  xy: Float32Array,
  n: number,
  closed: boolean
): number {
  if (n <= 0) return Infinity;
  if (n === 1) return Math.hypot(px - xy[0], py - xy[1]);
  let min = Infinity;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const d = distPointSeg(
      px,
      py,
      xy[i * 2],
      xy[i * 2 + 1],
      xy[j * 2],
      xy[j * 2 + 1]
    );
    if (d < min) min = d;
  }
  return min;
}

function minPointToPoly(
  axy: Float32Array,
  an: number,
  bxy: Float32Array,
  bn: number,
  bClosed: boolean
): number {
  let min = Infinity;
  for (let i = 0; i < an; i++) {
    const d = pointToPolyline(axy[i * 2], axy[i * 2 + 1], bxy, bn, bClosed);
    if (d < min) min = d;
  }
  return min;
}

function symmetricDist(a: Frag | Placed, b: Frag | Placed): number {
  const ab = minPointToPoly(a.xy, a.n, b.xy, b.n, b.closed);
  const ba = minPointToPoly(b.xy, b.n, a.xy, a.n, a.closed);
  return ab < ba ? ab : ba;
}

function polyLength(xy: Float32Array, n: number, closed: boolean): number {
  if (n < 2) return 0;
  let L = 0;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    L += Math.hypot(xy[j * 2] - xy[i * 2], xy[j * 2 + 1] - xy[i * 2 + 1]);
  }
  return L;
}

function crossingT(d0: number, d1: number, threshold: number): number {
  const denom = d1 - d0;
  if (Math.abs(denom) < 1e-12) return 0.5;
  const t = (threshold - d0) / denom;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function lerpXY(
  xy: Float32Array,
  i: number,
  j: number,
  t: number
): [number, number] {
  return [
    xy[i * 2] + (xy[j * 2] - xy[i * 2]) * t,
    xy[i * 2 + 1] + (xy[j * 2 + 1] - xy[i * 2 + 1]) * t,
  ];
}

function pred(i: number, n: number, closed: boolean): number | null {
  if (i > 0) return i - 1;
  return closed ? n - 1 : null;
}

function succ(i: number, n: number, closed: boolean): number | null {
  if (i < n - 1) return i + 1;
  return closed ? 0 : null;
}

function keptRuns(n: number, closed: boolean, keep: Uint8Array): number[][] {
  const runs: number[][] = [];
  let i = 0;
  while (i < n) {
    if (!keep[i]) {
      i++;
      continue;
    }
    const run: number[] = [];
    while (i < n && keep[i]) {
      run.push(i);
      i++;
    }
    runs.push(run);
  }
  if (closed && runs.length >= 2 && keep[0] && keep[n - 1]) {
    const last = runs.pop()!;
    runs[0] = last.concat(runs[0]);
  }
  return runs;
}

function materializeRun(
  xy: Float32Array,
  n: number,
  closed: boolean,
  keep: Uint8Array,
  dist: Float32Array,
  threshold: number,
  indices: number[]
): { xy: Float32Array; n: number; closed: boolean } | null {
  if (indices.length === 0) return null;
  const pts: number[] = [];
  const first = indices[0];
  const last = indices[indices.length - 1];
  const p = pred(first, n, closed);
  if (p !== null && !keep[p]) {
    const t = crossingT(dist[p], dist[first], threshold);
    const q = lerpXY(xy, p, first, t);
    pts.push(q[0], q[1]);
  }
  for (const idx of indices) {
    pts.push(xy[idx * 2], xy[idx * 2 + 1]);
  }
  const s = succ(last, n, closed);
  if (s !== null && !keep[s]) {
    const t = crossingT(dist[last], dist[s], threshold);
    const q = lerpXY(xy, last, s, t);
    pts.push(q[0], q[1]);
  }
  const outN = pts.length / 2;
  if (outN < 2) return null;
  return { xy: new Float32Array(pts), n: outN, closed: false };
}

function cutAgainst(
  frag: Frag,
  obstacles: { xy: Float32Array; n: number; closed: boolean; thresh: number }[],
  minLength: number,
  longestOnly: boolean
): Frag[] {
  if (obstacles.length === 0) return [frag];
  const { xy, n, closed } = frag;
  const dist = new Float32Array(n);
  const keep = new Uint8Array(n);
  // Combined clearance: keep when the tightest obstacle still clears its
  // own threshold. Interpolation uses this same effective distance so
  // boundary samples land on the first crossing.
  for (let i = 0; i < n; i++) {
    let slack = Infinity;
    for (const o of obstacles) {
      const d = pointToPolyline(xy[i * 2], xy[i * 2 + 1], o.xy, o.n, o.closed);
      const s = d - o.thresh;
      if (s < slack) slack = s;
    }
    dist[i] = slack;
    keep[i] = slack >= 0 ? 1 : 0;
  }
  const fullyKept = keep[0] === 1 && keep.every((k) => k === 1);
  if (fullyKept) return [frag];

  const runs = keptRuns(n, closed, keep);
  const out: Frag[] = [];
  // Dist stored as (d - thresh); crossing is at 0.
  for (const indices of runs) {
    const geo = materializeRun(xy, n, closed, keep, dist, 0, indices);
    if (!geo) continue;
    if (polyLength(geo.xy, geo.n, geo.closed) < minLength) continue;
    out.push({
      xy: geo.xy,
      n: geo.n,
      closed: geo.closed,
      rTarget: frag.rTarget,
      sourceIndex: frag.sourceIndex,
    });
  }
  if (longestOnly && out.length > 1) {
    let best = 0;
    let bestL = -1;
    for (let i = 0; i < out.length; i++) {
      const L = polyLength(out[i].xy, out[i].n, out[i].closed);
      if (L > bestL) {
        bestL = L;
        best = i;
      }
    }
    return [out[best]];
  }
  return out;
}

function toSubpath(
  piece: Placed,
  packIndex: number,
  W: number,
  H: number,
  maxWidth: number
): SplineSubpath | null {
  const aspect = W / Math.max(1, H);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < piece.n; i++) {
    pts.push([piece.xy[i * 2], piece.xy[i * 2 + 1]]);
  }
  const simp = simplifyPolyline(pts, SIMPLIFY_TOL_PX, piece.closed);
  if (simp.length < 2) return null;
  const closed = piece.closed && simp.length >= 3;
  const anchors: SplineAnchor[] = simp.map((p) => ({
    pos: authoredOf(p[0], p[1], W, H, aspect),
  }));
  const width = piece.r * 2;
  const driver = maxWidth > 1e-9 ? width / maxWidth : 1;
  return {
    anchors,
    closed,
    groupIndex: piece.sourceIndex,
    driver,
    attrs: {
      width,
      packIndex,
      sourceIndex: piece.sourceIndex,
    },
  };
}

export function packSplines(
  src: SplineValue,
  opts: SplinePackOpts
): SplineSubpath[] {
  const W = Math.max(1, opts.width);
  const H = Math.max(1, opts.height);
  const minWidth = Math.max(0.5, opts.minWidth);
  const maxWidth = Math.max(minWidth, opts.maxWidth);
  const rMin = minWidth / 2;
  const rMax = maxWidth / 2;
  const gap = Math.max(0, opts.gap);
  const minLength = Math.max(0, opts.minLength);
  const spacing = Math.max(0.5, opts.spacing);
  const rng = mulberry32(opts.seed);

  const pending: Frag[] = [];
  for (let i = 0; i < src.subpaths.length; i++) {
    const flat = flattenSubpath(src.subpaths[i], spacing, W, H);
    if (!flat) continue;
    const closed = !!src.subpaths[i].closed && flat.n >= 3;
    if (polyLength(flat.xy, flat.n, closed) < minLength) continue;
    const u = rng();
    const rTarget = opts.randomizeWidth ? rMin + u * (rMax - rMin) : rMax;
    pending.push({
      xy: flat.xy,
      n: flat.n,
      closed,
      rTarget,
      sourceIndex: i,
    });
  }

  const placed: Placed[] = [];
  while (pending.length) {
    const pick = Math.floor(rng() * pending.length);
    const cand = pending.splice(pick, 1)[0];

    let r = cand.rTarget;
    if (placed.length) {
      let fit = r;
      for (const p of placed) {
        const d = symmetricDist(cand, p);
        const allow = d - p.r - gap;
        if (allow < fit) fit = allow;
      }
      r = fit;
      if (r < rMin) continue;
      const recut = cutAgainst(
        cand,
        placed.map((p) => ({
          xy: p.xy,
          n: p.n,
          closed: p.closed,
          thresh: p.r + r + gap,
        })),
        minLength,
        true
      );
      if (recut.length === 0) continue;
      const kept = recut[0];
      placed.push({
        xy: kept.xy,
        n: kept.n,
        closed: kept.closed,
        r,
        sourceIndex: kept.sourceIndex,
      });
    } else {
      placed.push({
        xy: cand.xy,
        n: cand.n,
        closed: cand.closed,
        r,
        sourceIndex: cand.sourceIndex,
      });
    }

    const neu = placed[placed.length - 1];
    const next: Frag[] = [];
    const obstacle = [
      {
        xy: neu.xy,
        n: neu.n,
        closed: neu.closed,
        thresh: neu.r + rMin + gap,
      },
    ];
    for (const f of pending) {
      const parts = cutAgainst(f, obstacle, minLength, false);
      for (const part of parts) next.push(part);
    }
    pending.length = 0;
    pending.push(...next);
  }

  const out: SplineSubpath[] = [];
  for (let i = 0; i < placed.length; i++) {
    const sub = toSubpath(placed[i], i, W, H, maxWidth);
    if (sub) out.push(sub);
  }
  return out;
}
