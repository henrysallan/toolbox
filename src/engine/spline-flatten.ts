// Cubic Bézier subdivision — converts a SplineValue into a flat
// array of line segments that the SDF compiler can pack into a data
// texture and walk per-pixel.
//
// Each Bézier curve in a subpath gets `subdivisions` line segments
// (uniform parametric subdivision — simple, no adaptive flatness
// check). Straight segments (anchors with no handles on either end)
// emit a single line segment. Closed subpaths get an additional
// closing segment from the last anchor back to the first.
//
// Output is `Float32Array` of length `4 * segCount` — laid out
// [a0x, a0y, b0x, b0y, a1x, a1y, b1x, b1y, …] for direct upload to a
// 1×N RGBA32F texture.

import type { SplineSubpath, SplineValue } from "./types";

export interface FlattenResult {
  // Flat segment buffer, ready for texImage2D upload.
  segments: Float32Array;
  segCount: number;
  // True iff *every* subpath in the spline is closed. Used by the
  // SDF helper to decide whether to apply winding-based sign.
  allClosed: boolean;
}

export function flattenSpline(
  s: SplineValue,
  subdivisions: number = 16
): FlattenResult {
  const subs = Math.max(1, Math.floor(subdivisions));
  // Pre-count to size the array exactly.
  let total = 0;
  for (const sub of s.subpaths) {
    const n = sub.anchors.length;
    if (n < 2) continue;
    const segCount = sub.closed ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      const a = sub.anchors[i];
      const b = sub.anchors[(i + 1) % n];
      total += isStraight(a, b) ? 1 : subs;
    }
  }
  const segments = new Float32Array(total * 4);

  let w = 0;
  let allClosed = s.subpaths.length > 0;
  for (const sub of s.subpaths) {
    if (!sub.closed) allClosed = false;
    const n = sub.anchors.length;
    if (n < 2) continue;
    const segCount = sub.closed ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      w = emitCurve(sub, i, n, subs, segments, w);
    }
  }
  return { segments, segCount: total, allClosed };
}

function isStraight(
  a: SplineSubpath["anchors"][number],
  b: SplineSubpath["anchors"][number]
): boolean {
  // Anchors with no out-handle on the start AND no in-handle on the
  // end produce a straight segment — skip the cubic subdivision.
  const aOut = a.outHandle;
  const bIn = b.inHandle;
  const aFlat = !aOut || (aOut[0] === 0 && aOut[1] === 0);
  const bFlat = !bIn || (bIn[0] === 0 && bIn[1] === 0);
  return aFlat && bFlat;
}

function emitCurve(
  sub: SplineSubpath,
  i: number,
  n: number,
  subs: number,
  out: Float32Array,
  w: number
): number {
  const a = sub.anchors[i];
  const b = sub.anchors[(i + 1) % n];
  if (isStraight(a, b)) {
    out[w] = a.pos[0];
    out[w + 1] = a.pos[1];
    out[w + 2] = b.pos[0];
    out[w + 3] = b.pos[1];
    return w + 4;
  }
  // Cubic control points: P0 = a.pos, P1 = a.pos + a.outHandle,
  // P2 = b.pos + b.inHandle, P3 = b.pos. Handles default to (0,0)
  // when missing.
  const p0x = a.pos[0];
  const p0y = a.pos[1];
  const p1x = a.pos[0] + (a.outHandle?.[0] ?? 0);
  const p1y = a.pos[1] + (a.outHandle?.[1] ?? 0);
  const p2x = b.pos[0] + (b.inHandle?.[0] ?? 0);
  const p2y = b.pos[1] + (b.inHandle?.[1] ?? 0);
  const p3x = b.pos[0];
  const p3y = b.pos[1];

  let prevX = p0x;
  let prevY = p0y;
  for (let k = 1; k <= subs; k++) {
    const t = k / subs;
    const u = 1 - t;
    const uu = u * u;
    const uuu = uu * u;
    const tt = t * t;
    const ttt = tt * t;
    const nx = uuu * p0x + 3 * uu * t * p1x + 3 * u * tt * p2x + ttt * p3x;
    const ny = uuu * p0y + 3 * uu * t * p1y + 3 * u * tt * p2y + ttt * p3y;
    out[w] = prevX;
    out[w + 1] = prevY;
    out[w + 2] = nx;
    out[w + 3] = ny;
    w += 4;
    prevX = nx;
    prevY = ny;
  }
  return w;
}

// Cheap fingerprint of a spline's geometry — used by the SDF Spline
// node to decide when to re-flatten and re-upload its segment
// texture. Hashes anchor positions and handle offsets only; ignores
// metadata like groupIndex.
export function splineGeomHash(s: SplineValue): string {
  const parts: string[] = [];
  for (const sub of s.subpaths) {
    parts.push(sub.closed ? "c" : "o");
    for (const a of sub.anchors) {
      parts.push(
        `${a.pos[0].toFixed(5)},${a.pos[1].toFixed(5)}`
      );
      if (a.inHandle) {
        parts.push(`i${a.inHandle[0].toFixed(5)},${a.inHandle[1].toFixed(5)}`);
      }
      if (a.outHandle) {
        parts.push(`o${a.outHandle[0].toFixed(5)},${a.outHandle[1].toFixed(5)}`);
      }
    }
  }
  return parts.join("|");
}
