import { Bezier } from "bezier-js";
import type { SplineAnchor, SplineSubpath, SplineValue } from "./types";
import { measureSpline, measureSubpath } from "./spline-math";

// Trim Paths — keep only the arc-length window [start, end] of a spline,
// measured across ALL subpaths concatenated into one length domain (After
// Effects "Trim Paths → Trim Multiple Shapes: Simultaneously"). Animating the
// window (keyframed scalars) draws a stroke on/off. An optional `offset`
// slides the whole window along the domain cyclically (AE's Offset): the
// window wraps at the ends, so a shifted window can straddle the seam — part
// re-emerging at the start while the rest still shows at the end. Offset is
// unbounded (taken mod 1), so keyframing 0→N loops the trim N times. Pure,
// engine-side; the boundary cubics are split with bezier-js. See
// specdocs/062526_node-expansion.md.

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Rebuild an OPEN subpath from a contiguous chain of bezier-js cubics. Each
// cubic contributes its endpoint as an anchor; in/out handles come from the
// adjacent control points — the same reconstruction `offsetSubpath` uses.
// Exported for the other cut-a-curve consumers (spline-boolean's line mode).
export function cubicsToSubpath(curves: Bezier[]): SplineSubpath | null {
  if (curves.length === 0) return null;
  const anchors: SplineAnchor[] = [];
  const head = curves[0].points;
  anchors.push({
    pos: [head[0].x, head[0].y],
    outHandle: [head[1].x - head[0].x, head[1].y - head[0].y],
  });
  for (let i = 0; i < curves.length; i++) {
    const p = curves[i].points;
    const endAnchor: SplineAnchor = {
      pos: [p[3].x, p[3].y],
      inHandle: [p[2].x - p[3].x, p[2].y - p[3].y],
    };
    const next = curves[i + 1];
    if (next) {
      const nc1 = next.points[1];
      endAnchor.outHandle = [nc1.x - p[3].x, nc1.y - p[3].y];
    }
    anchors.push(endAnchor);
  }
  return { anchors, closed: false };
}

// Extract the portion of `sub` between arc lengths [lo, hi] in the subpath's
// OWN length domain. Each segment is clipped to the window independently (a
// boundary that lands on a segment join is handled by adjacent clips — no
// degenerate split(1,1) at the seam). Returns an open subpath, or null when
// the window is degenerate.
function trimSubpathByLength(
  sub: SplineSubpath,
  lo: number,
  hi: number
): SplineSubpath | null {
  const m = measureSubpath(sub);
  if (m.total <= 0 || m.segments.length === 0) return null;
  lo = Math.max(0, Math.min(m.total, lo));
  hi = Math.max(0, Math.min(m.total, hi));
  if (hi - lo <= 1e-9) return null;

  const curves: Bezier[] = [];
  let prevCum = 0;
  for (let i = 0; i < m.segments.length; i++) {
    const seg = m.segments[i];
    const cum = m.cumulative[i];
    // Overlap of [lo,hi] with this segment's arc range [prevCum, cum].
    if (seg.length > 1e-12 && hi > prevCum && lo < cum) {
      const segLo = clamp01((lo - prevCum) / seg.length);
      const segHi = clamp01((hi - prevCum) / seg.length);
      if (segHi - segLo > 1e-6) {
        // Whole segment → use it directly; otherwise split out the sub-arc.
        curves.push(
          segLo <= 0 && segHi >= 1 ? seg.curve : seg.curve.split(segLo, segHi)
        );
      }
    }
    prevCum = cum;
  }
  return cubicsToSubpath(curves);
}

// Extract one non-wrapping window [s, e] (fractions, 0 ≤ s < e ≤ 1) using a
// pre-computed measurement. The per-subpath loop of the original trim.
function trimWindow(
  subpaths: SplineSubpath[],
  lengths: ReturnType<typeof measureSpline>,
  s: number,
  e: number
): SplineSubpath[] {
  const total = lengths.total;
  const loLen = s * total;
  const hiLen = e * total;

  const out: SplineSubpath[] = [];
  for (let i = 0; i < subpaths.length; i++) {
    const subStart = lengths.offsets[i];
    const subTotal = lengths.perSubpath[i].total;
    if (subTotal <= 0) continue;
    const subEnd = subStart + subTotal;
    const lo = Math.max(loLen, subStart);
    const hi = Math.min(hiLen, subEnd);
    if (hi - lo <= 1e-9) continue; // no overlap with this subpath
    if (lo <= subStart + 1e-9 && hi >= subEnd - 1e-9) {
      out.push(subpaths[i]); // wholly inside — keep as-is (closed preserved)
      continue;
    }
    const trimmed = trimSubpathByLength(
      subpaths[i],
      lo - subStart,
      hi - subStart
    );
    if (trimmed && trimmed.anchors.length >= 2) out.push(trimmed);
  }
  return out;
}

// Join two open cut pieces that meet at the wrap seam into one continuous
// open subpath: `a` ends exactly where `b` begins (the closed loop's own
// start/end anchor), so the joint anchor takes a's arriving in-handle and
// b's departing out-handle.
function joinAtSeam(a: SplineSubpath, b: SplineSubpath): SplineSubpath {
  const aEnd = a.anchors[a.anchors.length - 1];
  const bStart = b.anchors[0];
  const joint: SplineAnchor = { pos: bStart.pos };
  if (aEnd.inHandle) joint.inHandle = aEnd.inHandle;
  if (bStart.outHandle) joint.outHandle = bStart.outHandle;
  return {
    anchors: [...a.anchors.slice(0, -1), joint, ...b.anchors.slice(1)],
    closed: false,
  };
}

// Trim a spline (as subpaths) to the arc-length fraction window [start, end],
// optionally slid along the domain by `offset` (cyclic, any value — taken
// mod 1). A partially-included closed subpath becomes open. When the shifted
// window wraps past the end of the domain it re-enters at the start, emitting
// the tail piece then the head piece; if the seam falls inside a single
// closed loop the two pieces are stitched into one continuous subpath (so a
// stroke sliding around a circle never shows cap breaks). Returns the input
// unchanged when not trimming (identity fast-path), or [] when the window is
// empty (including start >= end).
export function trimSubpaths(
  subpaths: SplineSubpath[],
  start: number,
  end: number,
  offset = 0
): SplineSubpath[] {
  if (!subpaths || subpaths.length === 0) return subpaths;
  const s = clamp01(Number.isFinite(start) ? start : 0);
  const e = clamp01(Number.isFinite(end) ? end : 1);
  if (s <= 0 && e >= 1) return subpaths; // full window — offset can't matter
  if (e - s <= 1e-9) return []; // empty window

  const oRaw = Number.isFinite(offset) ? offset : 0;
  let o = oRaw - Math.floor(oRaw); // wrap to [0, 1)
  if (o <= 1e-9 || o >= 1 - 1e-9) o = 0;

  const lengths = measureSpline({ kind: "spline", subpaths } as SplineValue);
  if (lengths.total <= 0) return subpaths;
  if (o === 0) return trimWindow(subpaths, lengths, s, e);

  let lo = s + o;
  if (lo >= 1) lo -= 1; // s ≤ 1 and o < 1, so one subtract re-enters [0, 1)
  const hi = lo + (e - s);
  if (hi <= 1) return trimWindow(subpaths, lengths, lo, hi);

  // Window straddles the seam: emit [lo, 1] then [0, hi−1].
  const tail = 1 - lo > 1e-9 ? trimWindow(subpaths, lengths, lo, 1) : [];
  const head = hi - 1 > 1e-9 ? trimWindow(subpaths, lengths, 0, hi - 1) : [];

  // The seam joins the END of the last nonzero-length subpath to the START
  // of the first — the same physical point only when they're one closed
  // loop. (Both pieces are then guaranteed genuine open cuts: a window with
  // an interior edge can't wholly contain a subpath spanning the domain.)
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < subpaths.length; i++) {
    if (lengths.perSubpath[i].total <= 0) continue;
    if (firstIdx < 0) firstIdx = i;
    lastIdx = i;
  }
  const seamInsideLoop =
    firstIdx >= 0 && firstIdx === lastIdx && !!subpaths[firstIdx].closed;
  if (seamInsideLoop && tail.length > 0 && head.length > 0) {
    return [
      ...tail.slice(0, -1),
      joinAtSeam(tail[tail.length - 1], head[0]),
      ...head.slice(1),
    ];
  }
  return [...tail, ...head];
}
