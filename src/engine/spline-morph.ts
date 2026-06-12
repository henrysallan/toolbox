import type { SplineAnchor, SplineSubpath, SplineValue } from "./types";
import { resampleSubpath } from "./spline-math";

// Shape morphing between two splines. A morph is a per-anchor lerp once
// the two shapes are put into correspondence: both resampled to a matched
// anchor count, then aligned so anchor i of A pairs with the geometrically
// nearest run of B (orientation + cyclic start-vertex for closed loops).
//
// The expensive part (resample + alignment) depends only on the two input
// shapes and the resolution — NOT on the morph amount t. So we build a
// `MorphCorrespondence` once and re-apply it cheaply every frame as t
// animates. The node caches the correspondence by an input signature.
//
// Handles are OFFSETS from their anchor (see SplineAnchor), so lerping
// them is direct — no absolute/relative conversion. Reversing a subpath's
// travel direction swaps each anchor's in/out handle.

const ZERO: [number, number] = [0, 0];

interface AlignedPair {
  aAnchors: SplineAnchor[];
  bAnchors: SplineAnchor[]; // same length as aAnchors
  closed: boolean;
}
export type MorphCorrespondence = AlignedPair[];

function lerp2(
  a: readonly [number, number],
  b: readonly [number, number],
  t: number
): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function anchorLerp(a: SplineAnchor, b: SplineAnchor, t: number): SplineAnchor {
  return {
    pos: lerp2(a.pos, b.pos, t),
    inHandle: lerp2(a.inHandle ?? ZERO, b.inHandle ?? ZERO, t),
    outHandle: lerp2(a.outHandle ?? ZERO, b.outHandle ?? ZERO, t),
  };
}

// Reverse travel direction: reverse anchor order AND swap each anchor's
// in/out handle (the outgoing control point of a forward traversal is the
// incoming one when walked backward), reproducing the identical geometry.
function reverseAnchors(anchors: SplineAnchor[]): SplineAnchor[] {
  return anchors
    .slice()
    .reverse()
    .map((a) => ({
      pos: a.pos,
      inHandle: a.outHandle,
      outHandle: a.inHandle,
    }));
}

function rotateAnchors(anchors: SplineAnchor[], k: number): SplineAnchor[] {
  const n = anchors.length;
  if (k % n === 0) return anchors;
  const out: SplineAnchor[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = anchors[(i + k) % n];
  return out;
}

function centroid(anchors: SplineAnchor[]): [number, number] {
  if (anchors.length === 0) return [0.5, 0.5];
  let sx = 0;
  let sy = 0;
  for (const a of anchors) {
    sx += a.pos[0];
    sy += a.pos[1];
  }
  return [sx / anchors.length, sy / anchors.length];
}

function pointAnchors(n: number, p: [number, number]): SplineAnchor[] {
  const out: SplineAnchor[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { pos: [p[0], p[1]] };
  return out;
}

// Sum of squared distances between anchor i of A and anchor (i+offset) of
// B, with an early-out once it exceeds the best cost so far.
function offsetCost(
  a: SplineAnchor[],
  b: SplineAnchor[],
  offset: number,
  ceil: number
): number {
  const n = a.length;
  let cost = 0;
  for (let i = 0; i < n; i++) {
    const pa = a[i].pos;
    const pb = b[(i + offset) % n].pos;
    const dx = pa[0] - pb[0];
    const dy = pa[1] - pb[1];
    cost += dx * dx + dy * dy;
    if (cost >= ceil) return cost;
  }
  return cost;
}

function bestOffset(a: SplineAnchor[], b: SplineAnchor[]): {
  offset: number;
  cost: number;
} {
  const n = a.length;
  let bestOff = 0;
  let bestCost = Infinity;
  for (let k = 0; k < n; k++) {
    const c = offsetCost(a, b, k, bestCost);
    if (c < bestCost) {
      bestCost = c;
      bestOff = k;
    }
  }
  return { offset: bestOff, cost: bestCost };
}

// Direct (offset-0) sum of squared distances — for open subpaths, which
// have no cyclic freedom.
function directCost(a: SplineAnchor[], b: SplineAnchor[]): number {
  let cost = 0;
  for (let i = 0; i < a.length; i++) {
    const dx = a[i].pos[0] - b[i].pos[0];
    const dy = a[i].pos[1] - b[i].pos[1];
    cost += dx * dx + dy * dy;
  }
  return cost;
}

// A rough size metric to pair the biggest A subpath with the biggest B
// subpath, etc. Polygon area of the anchor positions, falling back to the
// bounding-box diagonal for near-degenerate (thin/open) subpaths.
function sizeOf(sub: SplineSubpath): number {
  const a = sub.anchors;
  if (a.length < 2) return 0;
  let area = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < a.length; i++) {
    const p = a[i].pos;
    const q = a[(i + 1) % a.length].pos;
    area += p[0] * q[1] - q[0] * p[1];
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  const absArea = Math.abs(area) * 0.5;
  if (absArea > 1e-6) return absArea;
  return Math.hypot(maxX - minX, maxY - minY);
}

function sortedBySizeDesc(subs: SplineSubpath[]): SplineSubpath[] {
  return subs
    .map((s) => ({ s, k: sizeOf(s) }))
    .sort((x, y) => y.k - x.k)
    .map((e) => e.s);
}

// Resample to n anchors, aligning B to A by the lowest-cost orientation +
// (for closed loops) cyclic start vertex. Returns matched-length anchor
// arrays ready to lerp.
function alignPair(
  sa: SplineSubpath,
  sb: SplineSubpath,
  n: number
): AlignedPair {
  const ra = resampleSubpath(sa, n).anchors;
  let rb = resampleSubpath(sb, n).anchors;
  const closed = sa.closed && sb.closed;

  // Degenerate resample (zero-length/single-anchor) can return a count
  // other than n — fall back to a direct min-length zip, no alignment.
  if (ra.length !== rb.length) {
    const m = Math.min(ra.length, rb.length);
    return {
      aAnchors: ra.slice(0, m),
      bAnchors: rb.slice(0, m),
      closed,
    };
  }

  const rev = reverseAnchors(rb);
  if (closed) {
    // Try both orientations, each with its best cyclic offset; keep the
    // cheaper. This subsumes winding alignment and finds the start vertex.
    const fwd = bestOffset(ra, rb);
    const rvs = bestOffset(ra, rev);
    rb =
      rvs.cost < fwd.cost
        ? rotateAnchors(rev, rvs.offset)
        : rotateAnchors(rb, fwd.offset);
  } else {
    // Open: no cyclic freedom — just pick the better travel direction.
    if (directCost(ra, rev) < directCost(ra, rb)) rb = rev;
  }
  return { aAnchors: ra, bAnchors: rb, closed };
}

// Build the (t-independent) correspondence between two splines. Subpaths
// are paired biggest-to-biggest; a surplus subpath on one side morphs
// to/from a collapsed point at its centroid so it shrinks/grows cleanly.
export function buildMorphCorrespondence(
  a: SplineValue,
  b: SplineValue,
  resolution: number
): MorphCorrespondence {
  const n = Math.max(2, Math.round(resolution));
  const aSubs = sortedBySizeDesc(a.subpaths.filter((s) => s.anchors.length >= 2));
  const bSubs = sortedBySizeDesc(b.subpaths.filter((s) => s.anchors.length >= 2));
  const pairs: MorphCorrespondence = [];
  const m = Math.min(aSubs.length, bSubs.length);

  for (let i = 0; i < m; i++) pairs.push(alignPair(aSubs[i], bSubs[i], n));

  // Surplus A subpaths collapse to their centroid as t→1 (they vanish).
  for (let i = m; i < aSubs.length; i++) {
    const ra = resampleSubpath(aSubs[i], n).anchors;
    pairs.push({
      aAnchors: ra,
      bAnchors: pointAnchors(ra.length, centroid(ra)),
      closed: aSubs[i].closed,
    });
  }
  // Surplus B subpaths grow from their centroid as t→1.
  for (let i = m; i < bSubs.length; i++) {
    const rb = resampleSubpath(bSubs[i], n).anchors;
    pairs.push({
      aAnchors: pointAnchors(rb.length, centroid(rb)),
      bAnchors: rb,
      closed: bSubs[i].closed,
    });
  }
  return pairs;
}

// Cheap per-frame step: lerp every paired anchor by t.
export function applyMorph(
  corr: MorphCorrespondence,
  t: number
): SplineValue {
  const tc = Math.max(0, Math.min(1, t));
  const subpaths: SplineSubpath[] = corr.map((p) => ({
    anchors: p.aAnchors.map((aa, i) => anchorLerp(aa, p.bAnchors[i], tc)),
    closed: p.closed,
  }));
  return { kind: "spline", subpaths };
}

// One-shot convenience (no caching).
export function splineMorph(
  a: SplineValue,
  b: SplineValue,
  t: number,
  resolution: number
): SplineValue {
  return applyMorph(buildMorphCorrespondence(a, b, resolution), t);
}
