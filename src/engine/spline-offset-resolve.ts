import { Bezier } from "bezier-js";
import type { SplineAnchor, SplineSubpath } from "./types";
import { subpathToBeziers } from "./spline-math";

// Resolve self-overlaps introduced by parallel-curve offsetting.
//
// `offsetSubpath` (spline-math) offsets each cubic independently and joins
// consecutive segment-offsets with a round corner arc, but does no
// intersection handling. At a sharp corner the two neighbouring
// segment-offsets cross on the concave side, so the join arc there closes a
// little "bowtie" self-intersection loop; large offsets add global crossings
// where a narrow feature collapses. This module cuts those loops so the path
// resolves to a single point at each crossing (Sharp), optionally rounding
// the cut with a local fillet (Smooth).
//
// The algorithm is a cubic-exact loop cull: find every self-intersection on
// the post-offset cubic chain, then walk the chain skipping the geometry
// between each crossing's two feet — the two feet ARE the same physical point,
// so the kept pieces meet seamlessly. Closed rings rotate to a seam outside
// every loop first, so the linear walk is sound; a ring whose chain is
// entirely covered by loops has fully inverted and is dropped (returns null).
//
// Space-agnostic: it operates in whatever space the input subpath lives in.
// Callers run it in CANVAS-PIXEL space so intersection tolerances and fillet
// radii are isotropic on non-square canvases (Repeat Path / Stroke already
// offset in px; Offset Path scales to px for the resolve step). Spec:
// specdocs/archive/071426_offset-overlap-resolve.md.

export type OverlapStyle = "keep" | "sharp" | "smooth";

// t-parameter epsilon (chain-coordinate) and point-distance epsilon. Callers
// work in px space, so PT_EPS is a fraction of a pixel.
const T_EPS = 1e-4;
const PT_EPS = 0.25;
const MAX_ROUNDS = 4;

type V2 = [number, number];
type Pt = { x: number; y: number };

const dist2 = (a: Pt, b: Pt) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const vLen = (v: V2) => Math.hypot(v[0], v[1]);
const vDot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const vNorm = (v: V2): V2 => {
  const l = vLen(v);
  return l > 1e-12 ? [v[0] / l, v[1] / l] : [0, 0];
};

// One self-crossing, stored as its two feet in chain coordinates (segIndex +
// t), always g1 < g2. The loop to cull is the geometry in (g1, g2).
interface Hit {
  g1: number;
  g2: number;
  pt: Pt; // the crossing point (shared by both feet)
}

function parsePair(s: string): [number, number] {
  const slash = s.indexOf("/");
  return [Number(s.slice(0, slash)), Number(s.slice(slash + 1))];
}

// AABB overlap on control points — a cheap reject before the exact solve.
function bboxOverlap(a: Bezier, b: Bezier): boolean {
  const ba = a.bbox();
  const bb = b.bbox();
  return !(
    ba.x.max < bb.x.min ||
    bb.x.max < ba.x.min ||
    ba.y.max < bb.y.min ||
    bb.y.max < ba.y.min
  );
}

// Point on the linear cubic chain at chain coordinate g (segIndex + t).
function chainPoint(curves: Bezier[], g: number): Pt {
  const n = curves.length;
  if (g >= n) return curves[n - 1].get(1);
  let s = Math.floor(g);
  if (s < 0) s = 0;
  return curves[s].get(g - s);
}

// All self-intersections of the cubic chain. `closed` means the chain is a
// ring: curves[0] and curves[last] share the seam point, so that join (like
// every consecutive join) is excluded — only genuine loops survive.
function findHits(curves: Bezier[], closed: boolean): Hit[] {
  const n = curves.length;
  const hits: Hit[] = [];
  const add = (i: number, ti: number, j: number, tj: number) => {
    let g1 = i + ti;
    let g2 = j + tj;
    if (g1 > g2) {
      const t = g1;
      g1 = g2;
      g2 = t;
    }
    if (g2 - g1 < T_EPS) return; // degenerate / tangential graze
    hits.push({ g1, g2, pt: chainPoint(curves, g1) });
  };

  // Shared-endpoint feet to exclude: consecutive joins, plus the ring seam.
  const sharedPoint = (i: number, j: number): Pt | null => {
    if (j === i + 1) return curves[i].get(1);
    if (closed && i === 0 && j === n - 1) return curves[0].get(0);
    return null;
  };

  for (let i = 0; i < n; i++) {
    let self: string[] = [];
    try {
      self = curves[i].selfintersects(T_EPS);
    } catch {
      self = [];
    }
    for (const s of self) {
      const [t1, t2] = parsePair(s);
      add(i, Math.min(t1, t2), i, Math.max(t1, t2));
    }
    for (let j = i + 1; j < n; j++) {
      if (!bboxOverlap(curves[i], curves[j])) continue;
      let res: (string | number)[] = [];
      try {
        res = curves[i].intersects(curves[j]) as (string | number)[];
      } catch {
        res = [];
      }
      if (res.length === 0) continue;
      const shared = sharedPoint(i, j);
      for (const r of res) {
        const [ti, tj] = parsePair(String(r));
        const pt = curves[i].get(ti);
        // Drop the intersection that IS the shared join between the pair —
        // point-based so a real crossing near the corner still counts.
        if (shared && dist2(pt, shared) < PT_EPS * PT_EPS) continue;
        add(i, ti, j, tj);
      }
    }
  }
  return dedupeHits(hits);
}

// Collapse near-identical crossings (a tangential grazing pair, float noise).
function dedupeHits(hits: Hit[]): Hit[] {
  const out: Hit[] = [];
  for (const h of hits) {
    const dup = out.some(
      (o) =>
        Math.abs(o.g1 - h.g1) < T_EPS * 10 &&
        Math.abs(o.g2 - h.g2) < T_EPS * 10
    );
    if (!dup) out.push(h);
  }
  return out;
}

// Sub-cubic of `c` on [a, b] ⊆ [0,1]; whole curve when the span is full.
function subCurve(c: Bezier, a: number, b: number): Bezier {
  if (a <= T_EPS && b >= 1 - T_EPS) return c;
  return c.split(a, b);
}

// Append the chain geometry on [from, to] (chain coordinates) to `out`.
function pushRange(out: Bezier[], curves: Bezier[], from: number, to: number) {
  const n = curves.length;
  const fs = Math.min(n - 1, Math.max(0, Math.floor(from)));
  const ft = from - fs;
  let ts: number;
  let tt: number;
  if (to >= n) {
    ts = n - 1;
    tt = 1;
  } else {
    ts = Math.min(n - 1, Math.max(0, Math.floor(to)));
    tt = to - ts;
  }
  if (fs === ts) {
    if (tt - ft > T_EPS) out.push(subCurve(curves[fs], ft, tt));
    return;
  }
  if (1 - ft > T_EPS) out.push(subCurve(curves[fs], ft, 1));
  for (let k = fs + 1; k < ts; k++) out.push(curves[k]);
  if (tt > T_EPS) out.push(subCurve(curves[ts], 0, tt));
}

// Greedy linear loop cull: walk the chain, and at each crossing (in order of
// its first foot) keep everything up to g1, then jump to g2 — dropping the
// loop. Crossings whose first foot lies inside an already-dropped run are
// absorbed. Records each cut's crossing point into `junctions`.
function cullLinear(
  curves: Bezier[],
  hits: Hit[],
  junctions: Pt[]
): Bezier[] {
  hits.sort((a, b) => a.g1 - b.g1);
  const out: Bezier[] = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.g1 < cursor - T_EPS) continue; // absorbed by an earlier cut
    pushRange(out, curves, cursor, h.g1);
    junctions.push(h.pt);
    cursor = h.g2;
  }
  pushRange(out, curves, cursor, curves.length);
  return out;
}

// Rotate a closed cubic chain so it starts at a seam outside every loop, so a
// linear cull never has to reason about a loop straddling the start. Seam =
// middle of the largest gap between crossing feet on the circle. Returns null
// when no gap exists (the whole ring is covered — fully inverted).
function rotateClosedToSafeSeam(curves: Bezier[], hits: Hit[]): Bezier[] | null {
  const n = curves.length;
  const marks: number[] = [];
  for (const h of hits) {
    marks.push(h.g1, h.g2);
  }
  marks.sort((a, b) => a - b);
  // Largest circular gap between consecutive marks.
  let bestGap = -1;
  let bestSeam = 0;
  for (let i = 0; i < marks.length; i++) {
    const a = marks[i];
    const b = i + 1 < marks.length ? marks[i + 1] : marks[0] + n;
    const gap = b - a;
    if (gap > bestGap) {
      bestGap = gap;
      bestSeam = (a + b) / 2;
    }
  }
  if (bestGap < T_EPS) return null; // no safe seam — ring fully inverted
  let seam = bestSeam;
  if (seam >= n) seam -= n;

  const s = Math.min(n - 1, Math.max(0, Math.floor(seam)));
  const t = seam - s;
  const rotated: Bezier[] = [];
  if (t < T_EPS) {
    for (let k = 0; k < n; k++) rotated.push(curves[(s + k) % n]);
  } else {
    rotated.push(curves[s].split(t, 1));
    for (let k = 1; k < n; k++) rotated.push(curves[(s + k) % n]);
    rotated.push(curves[s].split(0, t));
  }
  return rotated;
}

// Rebuild a subpath from a contiguous cubic chain. When `closed`, the chain's
// last endpoint coincides with its first point — merge them and mark closed.
function curvesToSubpath(curves: Bezier[], closed: boolean): SplineSubpath | null {
  if (curves.length === 0) return null;
  const anchors: SplineAnchor[] = [];
  const head = curves[0].points;
  anchors.push({
    pos: [head[0].x, head[0].y],
    outHandle: [head[1].x - head[0].x, head[1].y - head[0].y],
  });
  for (let i = 0; i < curves.length; i++) {
    const p = curves[i].points;
    const end: SplineAnchor = {
      pos: [p[3].x, p[3].y],
      inHandle: [p[2].x - p[3].x, p[2].y - p[3].y],
    };
    const next = curves[i + 1];
    if (next) {
      const nc1 = next.points[1];
      end.outHandle = [nc1.x - p[3].x, nc1.y - p[3].y];
    }
    anchors.push(end);
  }
  if (!closed) return { anchors, closed: false };
  // Fold the duplicated seam anchor: the last anchor's pos == the first's;
  // carry the last arriving in-handle onto the first, and the first's own
  // out-handle onto itself (already set), then drop the tail.
  if (anchors.length >= 2) {
    const first = anchors[0];
    const last = anchors[anchors.length - 1];
    if (last.inHandle) first.inHandle = last.inHandle;
    anchors.pop();
  }
  if (anchors.length < 2) return null;
  return { anchors, closed: true };
}

// Fillet a single cut-junction anchor: trim both adjacent cubics back along
// their tangents by `radius` (keeping their far control points fixed) and
// bridge with a rounded corner. Returns the two replacement anchors, or null
// when the junction is too straight/short to round.
function filletJunction(a: SplineAnchor, radius: number): [SplineAnchor, SplineAnchor] | null {
  const inH = a.inHandle;
  const outH = a.outHandle;
  if (!inH || !outH) return null;
  const lenIn = vLen(inH);
  const lenOut = vLen(outH);
  const dirPrev = vNorm(inH); // from anchor toward the incoming control point
  const dirNext = vNorm(outH); // from anchor toward the outgoing control point
  const d = Math.min(radius, 0.5 * lenIn, 0.5 * lenOut);
  if (!(d > 1e-6)) return null;
  // Turn angle between travel-in (−dirPrev) and travel-out (dirNext).
  const cosT = Math.max(-1, Math.min(1, -vDot(dirPrev, dirNext)));
  const theta = Math.acos(cosT);
  if (theta < 1e-4 || Math.PI - theta < 1e-4) return null;
  const R = d / Math.tan(theta / 2);
  const h = R * (4 / 3) * Math.tan(theta / 4);
  const p1: SplineAnchor = {
    pos: [a.pos[0] + dirPrev[0] * d, a.pos[1] + dirPrev[1] * d],
    inHandle: [inH[0] - dirPrev[0] * d, inH[1] - dirPrev[1] * d],
    outHandle: [-dirPrev[0] * h, -dirPrev[1] * h],
  };
  const p2: SplineAnchor = {
    pos: [a.pos[0] + dirNext[0] * d, a.pos[1] + dirNext[1] * d],
    inHandle: [-dirNext[0] * h, -dirNext[1] * h],
    outHandle: [outH[0] - dirNext[0] * d, outH[1] - dirNext[1] * d],
  };
  return [p1, p2];
}

// Replace each anchor whose position matches a recorded junction with a
// fillet. Only cut junctions are rounded — original corners are untouched.
function applyFillets(
  sub: SplineSubpath,
  junctions: Pt[],
  radius: number
): SplineSubpath {
  if (junctions.length === 0 || !(radius > 0)) return sub;
  const anchors = sub.anchors;
  const isJunction = (a: SplineAnchor) =>
    junctions.some(
      (j) => (a.pos[0] - j.x) ** 2 + (a.pos[1] - j.y) ** 2 < PT_EPS * PT_EPS
    );
  const out: SplineAnchor[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const isEndpoint = !sub.closed && (i === 0 || i === anchors.length - 1);
    if (!isEndpoint && isJunction(a)) {
      const fillet = filletJunction(a, radius);
      if (fillet) {
        out.push(fillet[0], fillet[1]);
        continue;
      }
    }
    out.push(a);
  }
  return { ...sub, anchors: out };
}

// Resolve self-overlaps in one subpath. `keep` returns the input untouched;
// `sharp` cuts each loop to a single point; `smooth` additionally fillets the
// cuts with the given radius (in the subpath's own coordinate space). Returns
// null only when a closed ring has fully inverted and should be dropped.
export function resolveSubpathOverlaps(
  sub: SplineSubpath,
  opts: { style: OverlapStyle; filletRadius?: number }
): SplineSubpath | null {
  if (opts.style === "keep") return sub;
  if (sub.anchors.length < 2) return sub;

  const junctions: Pt[] = [];
  let result: SplineSubpath | null;

  if (sub.closed) {
    let curves = subpathToBeziers({ ...sub, closed: true }).map((s) => s.curve);
    if (curves.length === 0) return sub;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const hits = findHits(curves, true);
      if (hits.length === 0) break;
      const rotated = rotateClosedToSafeSeam(curves, hits);
      if (!rotated) return null; // fully inverted
      const linHits = findHits(rotated, true);
      if (linHits.length === 0) {
        curves = rotated;
        break;
      }
      curves = cullLinear(rotated, linHits, junctions);
    }
    result = curvesToSubpath(curves, true);
  } else {
    let curves = subpathToBeziers({ ...sub, closed: false }).map((s) => s.curve);
    if (curves.length === 0) return sub;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const hits = findHits(curves, false);
      if (hits.length === 0) break;
      curves = cullLinear(curves, hits, junctions);
    }
    result = curvesToSubpath(curves, false);
  }

  if (!result) return null;
  // Re-carry the source subpath's non-geometry fields (e.g. groupIndex).
  result = { ...sub, anchors: result.anchors, closed: result.closed };
  if (opts.style === "smooth") {
    result = applyFillets(result, junctions, opts.filletRadius ?? 0);
  }
  return result;
}
