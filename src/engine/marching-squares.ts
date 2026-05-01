// 2D marching-squares contour extraction.
//
// Input is a NxN grid of scalar values (typically signed distances).
// Output is a list of subpaths tracing the iso-contour at value=0.
// Negative values are "inside"; the algorithm walks edges where the
// sign changes.
//
// V1 deals with the two ambiguous saddle cases (5 and 10) by always
// choosing the "disconnected" interpretation — two short segments
// that don't cross. That's the most common SDF convention and avoids
// a sample of the cell center.
//
// Endpoint chaining hashes points to a quantized grid (1/(N*8)
// precision) so segments from adjacent cells line up exactly. Output
// subpaths are closed when the chain returns to its starting point;
// open chains (which happen at the grid's outer border) are emitted
// as open subpaths.

import type { SplineSubpath } from "./types";

interface Pt {
  x: number;
  y: number;
}

interface Segment {
  a: Pt;
  b: Pt;
}

export interface MarchOptions {
  // Iso-level. Default 0 = SDF zero-crossing.
  iso?: number;
  // Region of normalized [0,1] UV space the grid covers. Default
  // covers the whole canvas. Used to map grid coordinates back into
  // canvas-UV when emitting the output subpaths.
  uvOrigin?: [number, number];
  uvSize?: [number, number];
}

// Linear interpolation parameter where the iso-level crosses an edge
// between two corner values `a` and `b`. Guarded against the
// degenerate `a == b` case where any value is valid (we pick 0.5).
function isoT(a: number, b: number, iso: number): number {
  const denom = a - b;
  if (Math.abs(denom) < 1e-9) return 0.5;
  return (a - iso) / denom;
}

export function marchingSquares(
  grid: Float32Array,
  width: number,
  height: number,
  opts: MarchOptions = {}
): SplineSubpath[] {
  const iso = opts.iso ?? 0;
  const [ox, oy] = opts.uvOrigin ?? [0, 0];
  const [ow, oh] = opts.uvSize ?? [1, 1];

  const segments: Segment[] = [];

  // Cell width/height in grid-coordinate units (one full grid step).
  // The output mapping: gridX → ox + (gridX / (width - 1)) * ow, same
  // for Y. Computed inline below.
  const cellsX = width - 1;
  const cellsY = height - 1;
  const stepX = ow / cellsX;
  const stepY = oh / cellsY;

  for (let gy = 0; gy < cellsY; gy++) {
    for (let gx = 0; gx < cellsX; gx++) {
      const tl = grid[gy * width + gx];
      const tr = grid[gy * width + (gx + 1)];
      const bl = grid[(gy + 1) * width + gx];
      const br = grid[(gy + 1) * width + (gx + 1)];

      // Bit encoding: TL=8, TR=4, BR=2, BL=1, set when value < iso
      // ("inside the shape").
      let code = 0;
      if (tl < iso) code |= 8;
      if (tr < iso) code |= 4;
      if (br < iso) code |= 2;
      if (bl < iso) code |= 1;
      if (code === 0 || code === 15) continue;

      const x0 = ox + gx * stepX;
      const y0 = oy + gy * stepY;
      const x1 = x0 + stepX;
      const y1 = y0 + stepY;

      // Iso-crossing points on each of the four edges. Computed
      // lazily — most cases only need two of these.
      const top = (): Pt => ({
        x: x0 + isoT(tl, tr, iso) * stepX,
        y: y0,
      });
      const right = (): Pt => ({
        x: x1,
        y: y0 + isoT(tr, br, iso) * stepY,
      });
      const bottom = (): Pt => ({
        x: x0 + isoT(bl, br, iso) * stepX,
        y: y1,
      });
      const left = (): Pt => ({
        x: x0,
        y: y0 + isoT(tl, bl, iso) * stepY,
      });

      switch (code) {
        case 1:
          segments.push({ a: left(), b: bottom() });
          break;
        case 2:
          segments.push({ a: bottom(), b: right() });
          break;
        case 3:
          segments.push({ a: left(), b: right() });
          break;
        case 4:
          segments.push({ a: top(), b: right() });
          break;
        case 5:
          // Saddle. Disconnected interpretation: two arcs that
          // don't touch, drawn so each "in" diagonal forms a
          // separate cap.
          segments.push({ a: left(), b: top() });
          segments.push({ a: bottom(), b: right() });
          break;
        case 6:
          segments.push({ a: top(), b: bottom() });
          break;
        case 7:
          segments.push({ a: left(), b: top() });
          break;
        case 8:
          segments.push({ a: left(), b: top() });
          break;
        case 9:
          segments.push({ a: top(), b: bottom() });
          break;
        case 10:
          // Saddle (other parity). Same disconnected split.
          segments.push({ a: left(), b: bottom() });
          segments.push({ a: top(), b: right() });
          break;
        case 11:
          segments.push({ a: top(), b: right() });
          break;
        case 12:
          segments.push({ a: left(), b: right() });
          break;
        case 13:
          segments.push({ a: bottom(), b: right() });
          break;
        case 14:
          segments.push({ a: left(), b: bottom() });
          break;
      }
    }
  }

  return chainSegments(segments, Math.min(stepX, stepY));
}

// Chain segments end-to-end into subpaths. Endpoints are quantized to
// 1/8 of a cell so that points coming from adjacent cells along the
// same shared edge match exactly. Each segment's endpoint can match
// at most one other segment in a well-behaved field — at saddles two
// segments touch the same cell, hence the disconnected disambiguation
// above.
function chainSegments(segments: Segment[], cellSize: number): SplineSubpath[] {
  if (segments.length === 0) return [];
  const PRECISION = cellSize / 8;
  const inv = 1 / PRECISION;
  const hash = (p: Pt) => `${Math.round(p.x * inv)}:${Math.round(p.y * inv)}`;

  // Map each endpoint hash to a list of (segIdx, isStart) pairs. Most
  // points are shared between exactly two segments; saddles can have
  // four, but the disconnected disambiguation keeps them paired up
  // along distinct chains so the walk still works.
  const adj = new Map<string, Array<{ segIdx: number; isStart: boolean }>>();
  segments.forEach((s, idx) => {
    const ha = hash(s.a);
    const hb = hash(s.b);
    if (!adj.has(ha)) adj.set(ha, []);
    if (!adj.has(hb)) adj.set(hb, []);
    adj.get(ha)!.push({ segIdx: idx, isStart: true });
    adj.get(hb)!.push({ segIdx: idx, isStart: false });
  });

  const visited = new Uint8Array(segments.length);
  const subpaths: SplineSubpath[] = [];

  function walk(startIdx: number, forward: boolean): Pt[] {
    const out: Pt[] = [];
    let curIdx = startIdx;
    let curEnd = forward ? segments[curIdx].b : segments[curIdx].a;
    out.push(forward ? segments[curIdx].a : segments[curIdx].b);
    out.push(curEnd);
    visited[curIdx] = 1;
    while (true) {
      const h = hash(curEnd);
      const candidates = adj.get(h) ?? [];
      let next: { segIdx: number; isStart: boolean } | null = null;
      for (const c of candidates) {
        if (c.segIdx === curIdx) continue;
        if (visited[c.segIdx]) continue;
        next = c;
        break;
      }
      if (!next) break;
      curIdx = next.segIdx;
      visited[curIdx] = 1;
      curEnd = next.isStart ? segments[curIdx].b : segments[curIdx].a;
      out.push(curEnd);
      // Closed: arrived back at start.
      if (hash(curEnd) === hash(out[0])) break;
    }
    return out;
  }

  for (let i = 0; i < segments.length; i++) {
    if (visited[i]) continue;
    // Walk forward from i, then backward from i to capture both ends
    // of an open chain. For closed loops the forward walk hits its
    // own start and we stop.
    const forwardPts = walk(i, true);
    let pts = forwardPts;
    const closed = hash(pts[0]) === hash(pts[pts.length - 1]) && pts.length > 2;
    if (!closed) {
      // Try walking backward from the original segment's start to
      // pick up any chain prefix not yet visited.
      visited[i] = 0; // unvisit for backward pass
      const backwardPts = walk(i, false);
      // backwardPts starts at segments[i].b and walks via segments[i].a
      // — which means backwardPts[0] is the same end the forward walk
      // already covered. Splice them: reverse backward (excluding its
      // first point, which equals forward's last) and prepend forward.
      // Actually backwardPts walks from b → a → previous chain links.
      // We want: ...prev links, a, b, next links, → forward points
      // (except its first, which is a). Reverse backward, prepend.
      const reversed = backwardPts.slice().reverse();
      // reversed ends at b; forward starts at a. Combine: drop
      // reversed's last (b) and forward's first (a) — they're
      // adjacent, but a appears twice if we keep both. Simpler: keep
      // reversed (which goes from far-end through to b), then append
      // forward starting from index 1 (skipping a, which equals
      // reversed[reversed.length-2] at this point... actually no, a
      // is reversed[reversed.length-1] in the rebuilt order? Let me
      // just dedupe at the end.)
      pts = reversed.concat(forwardPts.slice(1));
      pts = dedupeAdjacent(pts);
    }
    if (pts.length < 2) continue;
    const wasClosed =
      pts.length > 2 && hash(pts[0]) === hash(pts[pts.length - 1]);
    if (wasClosed) pts.pop();
    subpaths.push({
      anchors: pts.map((p) => ({ pos: [p.x, p.y] as [number, number] })),
      closed: wasClosed,
    });
  }
  return subpaths;
}

function dedupeAdjacent(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  let prev: Pt | null = null;
  for (const p of pts) {
    if (
      prev &&
      Math.abs(p.x - prev.x) < 1e-9 &&
      Math.abs(p.y - prev.y) < 1e-9
    ) {
      continue;
    }
    out.push(p);
    prev = p;
  }
  return out;
}
