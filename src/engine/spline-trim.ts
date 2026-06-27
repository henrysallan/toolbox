import { Bezier } from "bezier-js";
import type { SplineAnchor, SplineSubpath, SplineValue } from "./types";
import { measureSpline, measureSubpath } from "./spline-math";

// Trim Paths — keep only the arc-length window [start, end] of a spline,
// measured across ALL subpaths concatenated into one length domain (After
// Effects "Trim Paths → Trim Multiple Shapes: Simultaneously"). Animating the
// window (keyframed scalars) draws a stroke on/off. Pure, engine-side; the
// boundary cubics are split with bezier-js. See specdocs/062526_node-expansion.md.

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Rebuild an OPEN subpath from a contiguous chain of bezier-js cubics. Each
// cubic contributes its endpoint as an anchor; in/out handles come from the
// adjacent control points — the same reconstruction `offsetSubpath` uses.
function cubicsToSubpath(curves: Bezier[]): SplineSubpath | null {
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

// Trim a spline (as subpaths) to the arc-length fraction window [start, end].
// A partially-included closed subpath becomes open. Returns the input
// unchanged when not trimming (identity fast-path), or [] when the window is
// empty (including start >= end).
export function trimSubpaths(
  subpaths: SplineSubpath[],
  start: number,
  end: number
): SplineSubpath[] {
  if (!subpaths || subpaths.length === 0) return subpaths;
  const s = clamp01(Number.isFinite(start) ? start : 0);
  const e = clamp01(Number.isFinite(end) ? end : 1);
  if (s <= 0 && e >= 1) return subpaths; // identity — nothing trimmed
  if (e - s <= 1e-9) return []; // empty window

  const lengths = measureSpline({ kind: "spline", subpaths } as SplineValue);
  const total = lengths.total;
  if (total <= 0) return subpaths;
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
