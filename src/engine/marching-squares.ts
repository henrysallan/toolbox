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

      // Iso-crossing along each of the four edges, as plain numbers.
      //
      // These were four arrow functions built per cell so that only the two
      // edges a case needs got evaluated. That traded four closure
      // ALLOCATIONS for two divisions — a bad trade at ~9k boundary cells a
      // frame, and the allocations landed in the hot path of the slowest
      // phase of Blend Intersections. isoT guards its own denominator, so
      // evaluating an edge the case ignores is harmless.
      const topX = x0 + isoT(tl, tr, iso) * stepX;
      const rightY = y0 + isoT(tr, br, iso) * stepY;
      const bottomX = x0 + isoT(bl, br, iso) * stepX;
      const leftY = y0 + isoT(tl, bl, iso) * stepY;

      switch (code) {
        case 1:
          segments.push({ a: { x: x0, y: leftY }, b: { x: bottomX, y: y1 } });
          break;
        case 2:
          segments.push({ a: { x: bottomX, y: y1 }, b: { x: x1, y: rightY } });
          break;
        case 3:
          segments.push({ a: { x: x0, y: leftY }, b: { x: x1, y: rightY } });
          break;
        case 4:
          segments.push({ a: { x: topX, y: y0 }, b: { x: x1, y: rightY } });
          break;
        case 5:
          // Saddle. Disconnected interpretation: two arcs that
          // don't touch, drawn so each "in" diagonal forms a
          // separate cap.
          segments.push({ a: { x: x0, y: leftY }, b: { x: topX, y: y0 } });
          segments.push({ a: { x: bottomX, y: y1 }, b: { x: x1, y: rightY } });
          break;
        case 6:
          segments.push({ a: { x: topX, y: y0 }, b: { x: bottomX, y: y1 } });
          break;
        case 7:
          segments.push({ a: { x: x0, y: leftY }, b: { x: topX, y: y0 } });
          break;
        case 8:
          segments.push({ a: { x: x0, y: leftY }, b: { x: topX, y: y0 } });
          break;
        case 9:
          segments.push({ a: { x: topX, y: y0 }, b: { x: bottomX, y: y1 } });
          break;
        case 10:
          // Saddle (other parity). Same disconnected split.
          segments.push({ a: { x: x0, y: leftY }, b: { x: bottomX, y: y1 } });
          segments.push({ a: { x: topX, y: y0 }, b: { x: x1, y: rightY } });
          break;
        case 11:
          segments.push({ a: { x: topX, y: y0 }, b: { x: x1, y: rightY } });
          break;
        case 12:
          segments.push({ a: { x: x0, y: leftY }, b: { x: x1, y: rightY } });
          break;
        case 13:
          segments.push({ a: { x: bottomX, y: y1 }, b: { x: x1, y: rightY } });
          break;
        case 14:
          segments.push({ a: { x: x0, y: leftY }, b: { x: bottomX, y: y1 } });
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

  // Endpoint identity as an INTEGER, not a string.
  //
  // This was a template literal (`${qx}:${qy}`) into a Map<string,...>,
  // evaluated twice per segment when building the adjacency and AGAIN on
  // every step of every walk. Two string allocations plus a string hash per
  // lookup made chaining the single most expensive phase of Blend
  // Intersections — more than the SDF field sampling it feeds on.
  //
  // Same quantization, so the same points match: the grid is 1/8 of a cell,
  // and both halves fit a float64's 53-bit integer range with room to spare
  // (|q| stays under 2^20 for any sane grid, and 2^20 * 2^21 = 2^41).
  const KOFF = 1 << 20;
  const KSTRIDE = 1 << 21;
  const keyOf = (p: Pt) =>
    (Math.round(p.y * inv) + KOFF) * KSTRIDE + (Math.round(p.x * inv) + KOFF);

  // Endpoint keys, computed once per segment rather than per lookup.
  const n = segments.length;
  const ka = new Float64Array(n);
  const kb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ka[i] = keyOf(segments[i].a);
    kb[i] = keyOf(segments[i].b);
  }

  // Map each endpoint key to the segment ends meeting there, encoded as
  // idx*2+1 for a start and idx*2 for an end — a small int instead of a
  // {segIdx, isStart} object. Most points are shared between exactly two
  // segments; saddles can have four, but the disconnected disambiguation
  // keeps them paired up along distinct chains so the walk still works.
  // Insertion order is preserved (a before b, segments in index order), which
  // the walk depends on to pick the same continuation as before.
  const adj = new Map<number, number[]>();
  for (let idx = 0; idx < n; idx++) {
    const ha = ka[idx];
    const hb = kb[idx];
    let la = adj.get(ha);
    if (!la) { la = []; adj.set(ha, la); }
    la.push(idx * 2 + 1);
    let lb = adj.get(hb);
    if (!lb) { lb = []; adj.set(hb, lb); }
    lb.push(idx * 2);
  }

  const visited = new Uint8Array(segments.length);
  const subpaths: SplineSubpath[] = [];

  // Points and their keys travel together so no step ever re-derives a key.
  function walk(startIdx: number, forward: boolean): { pts: Pt[]; keys: number[] } {
    const pts: Pt[] = [];
    const keys: number[] = [];
    let curIdx = startIdx;
    const seg = segments[curIdx];
    pts.push(forward ? seg.a : seg.b);
    keys.push(forward ? ka[curIdx] : kb[curIdx]);
    let curEnd = forward ? seg.b : seg.a;
    let curKey = forward ? kb[curIdx] : ka[curIdx];
    pts.push(curEnd);
    keys.push(curKey);
    visited[curIdx] = 1;
    while (true) {
      const candidates = adj.get(curKey);
      let next = -1;
      if (candidates) {
        for (let ci = 0; ci < candidates.length; ci++) {
          const c = candidates[ci];
          const segIdx = c >> 1;
          if (segIdx === curIdx) continue;
          if (visited[segIdx]) continue;
          next = c;
          break;
        }
      }
      if (next < 0) break;
      curIdx = next >> 1;
      visited[curIdx] = 1;
      // Entered through this segment's start -> leave by its end, and vice
      // versa. (next & 1) is the isStart flag.
      const isStart = (next & 1) === 1;
      curEnd = isStart ? segments[curIdx].b : segments[curIdx].a;
      curKey = isStart ? kb[curIdx] : ka[curIdx];
      pts.push(curEnd);
      keys.push(curKey);
      // Closed: arrived back at start.
      if (curKey === keys[0]) break;
    }
    return { pts, keys };
  }

  for (let i = 0; i < segments.length; i++) {
    if (visited[i]) continue;
    // Walk forward from i, then backward from i to capture both ends
    // of an open chain. For closed loops the forward walk hits its
    // own start and we stop.
    const fwd = walk(i, true);
    const forwardPts = fwd.pts;
    let pts = forwardPts;
    let keys = fwd.keys;
    const closed =
      keys[0] === keys[keys.length - 1] && pts.length > 2;
    if (!closed) {
      // Try walking backward from the original segment's start to
      // pick up any chain prefix not yet visited.
      visited[i] = 0; // unvisit for backward pass
      const back = walk(i, false);
      // The backward walk starts at segments[i].b and leaves via
      // segments[i].a, so its first point is the end the forward walk
      // already covered. Reversing it yields "far end ... b", and the
      // forward walk yields "a b ... far end" — so reversed + forward
      // minus its duplicated head splices the two halves of one open chain.
      // Adjacent duplicates are removed afterwards rather than reasoned
      // about index by index.
      const reversed = back.pts.slice().reverse();
      const reversedKeys = back.keys.slice().reverse();
      pts = reversed.concat(forwardPts.slice(1));
      keys = reversedKeys.concat(fwd.keys.slice(1));
      const deduped = dedupeAdjacent(pts, keys);
      pts = deduped.pts;
      keys = deduped.keys;
    }
    if (pts.length < 2) continue;
    const wasClosed = pts.length > 2 && keys[0] === keys[keys.length - 1];
    if (wasClosed) pts.pop();
    subpaths.push({
      anchors: pts.map((p) => ({ pos: [p.x, p.y] as [number, number] })),
      closed: wasClosed,
    });
  }
  return subpaths;
}

// Drops repeated points, carrying each point's endpoint key along so the
// caller's closed-loop test stays key-based rather than re-deriving one.
function dedupeAdjacent(
  pts: Pt[],
  keys: number[]
): { pts: Pt[]; keys: number[] } {
  const outPts: Pt[] = [];
  const outKeys: number[] = [];
  let prev: Pt | null = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (
      prev &&
      Math.abs(p.x - prev.x) < 1e-9 &&
      Math.abs(p.y - prev.y) < 1e-9
    ) {
      continue;
    }
    outPts.push(p);
    outKeys.push(keys[i]);
    prev = p;
  }
  return { pts: outPts, keys: outKeys };
}
