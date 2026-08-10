// Blend Intersections — implicit-field fusion of a stroke network.
//
// Turns a multi-subpath spline (open or closed strokes, self-crossings
// welcome) into ONE closed outline: thin stroke bodies that swell into
// webbed ink-pools wherever strokes cross or pass within a blend radius.
// The look is an SDF smooth-union: every stroke is a distance field,
// polynomial smooth-min combines them, and the iso-contour at the stroke
// radius is the outline. Spec: specdocs/archive/071926_blend-intersections.md
// (devlist #49 — the implicit-surface fusion deferred from #71).
//
// All distance work happens in CANVAS-PIXEL space so strokes stay round
// on non-square canvases (same rule as multi-stroke's px-space offsets);
// the marching-squares step maps straight back into [0,1]² Y-DOWN UV.
//
// Structure: buildFieldJob (flatten + grid + spatial hash) feeds a field
// evaluator that fills the gw×gh sample grid; marching squares + the
// bezier refit consume only that grid. The evaluator is swappable —
// evaluateFieldCpu below is THE REFERENCE (fp64, bit-stable), and
// spline-blend-intersections-gpu.ts is a fragment-shader port that must
// match it to <1e-3 px (gate: npm run check:blend-gpu) and falls back
// here on any failure. Do not "optimize" the CPU loop — when in doubt,
// the CPU path is the spec (see specdocs/080826_blend-intersections-gpu.md).

import type { SplineAnchor, SplineSubpath, SplineValue } from "./types";
import { flattenSpline } from "./spline-flatten";
import { marchingSquares } from "./marching-squares";
import { fitSplineToPolyline } from "./spline-math";
import {
  evaluateFieldGpu,
  type BlendFieldGpuContext,
} from "./spline-blend-intersections-gpu";

export interface BlendIntersectionsOptions {
  // Stroke body thickness (diameter) in canvas px.
  widthPx: number;
  // Smooth-min k in canvas px — the webbing radius. 0 = plain union.
  blendPx: number;
  // Field samples across the network bbox's larger span.
  resolution: number;
  // 0..1 bezier-fit tolerance. 0 = raw marching-squares polygons.
  smoothing: number;
}

// Line segments per flattened curve. Uniform subdivision is fine here —
// the field only sees distances, so sub-cell flattening error is
// invisible at any sane resolution.
const CURVE_STEPS = 16;

// Segments of one subpath whose ordinals are within this gap of each
// other belong to the same local "branch" of the stroke. Two passes of a
// self-crossing loop are far apart in ordinal space, so they land in
// separate branches and blend; adjacent segments of one pass collapse
// into a single branch and can't inflate the field (the sum-of-blobs
// artifact of naive per-segment metaballs).
export const BRANCH_GAP = 8;

// Hard cap on field samples — a runaway resolution × elongated bbox
// guard, far above any useful setting.
const MAX_SAMPLES = 1_500_000;

const EMPTY: SplineValue = { kind: "spline", subpaths: [] };

// Polynomial smooth-min (Quilez). Deepens the union by at most k/4 where
// the two fields are equal, which is exactly the concave junction fillet.
function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// SQUARED distance from point p to segment a→b (all px space).
//
// Squared, because the caller's first use of the result is a cull against
// `influence`, and d² ≤ influence² answers that identically without the root.
// The candidate lists come from a 3×3 bucket neighborhood, which reaches ~3×
// further than `influence` does, so most candidates are rejected — taking the
// root before the cull spent it on points that were about to be discarded.
// Survivors are rooted by the caller.
function segDistSq(
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
  let t = 0;
  if (len2 > 1e-12) {
    t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const ex = px - (ax + dx * t);
  const ey = py - (ay + dy * t);
  return ex * ex + ey * ey;
}

// Everything the field-sample loop needs, produced once per call by
// buildFieldJob. Segment coordinates stay fp64 (number[]) — the CPU
// reference consumes them exactly; the GPU packer rounds to fp32 on
// upload, which is that path's accepted divergence.
export interface BlendFieldJob {
  // Flattened segments in canvas px with (subpath, ordinal) identity.
  segX0: number[];
  segY0: number[];
  segX1: number[];
  segY1: number[];
  segSub: number[];
  segOrd: number[];
  subSegCount: number[];
  subClosed: boolean[];
  segCount: number;
  // Sample grid: origin + cell in canvas px, gw×gh samples.
  bx0: number;
  by0: number;
  cell: number;
  gw: number;
  gh: number;
  // Field parameters (canvas px).
  r: number;
  k: number;
  influence: number;
  influenceSq: number;
  farSlack: number;
  // Spatial hash: segment indices per bucket cell.
  bucket: number;
  bCols: number;
  bRows: number;
  buckets: Map<number, number[]>;
}

export function buildFieldJob(
  spline: SplineValue,
  canvasW: number,
  canvasH: number,
  opts: BlendIntersectionsOptions
): BlendFieldJob | null {
  // ---- Flatten each subpath separately so segments keep (subpath,
  // ordinal) identity for branch clustering.
  const segX0: number[] = [];
  const segY0: number[] = [];
  const segX1: number[] = [];
  const segY1: number[] = [];
  const segSub: number[] = [];
  const segOrd: number[] = [];
  const subSegCount: number[] = [];
  const subClosed: boolean[] = [];

  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;

  for (const sub of spline.subpaths) {
    if (sub.anchors.length < 2) continue;
    const flat = flattenSpline(
      { kind: "spline", subpaths: [sub] },
      CURVE_STEPS
    );
    const subIdx = subSegCount.length;
    subSegCount.push(flat.segCount);
    subClosed.push(sub.closed);
    for (let i = 0; i < flat.segCount; i++) {
      const x0 = flat.segments[i * 4] * canvasW;
      const y0 = flat.segments[i * 4 + 1] * canvasH;
      const x1 = flat.segments[i * 4 + 2] * canvasW;
      const y1 = flat.segments[i * 4 + 3] * canvasH;
      segX0.push(x0);
      segY0.push(y0);
      segX1.push(x1);
      segY1.push(y1);
      segSub.push(subIdx);
      segOrd.push(i);
      if (x0 < bx0) bx0 = x0;
      if (x1 < bx0) bx0 = x1;
      if (y0 < by0) by0 = y0;
      if (y1 < by0) by0 = y1;
      if (x0 > bx1) bx1 = x0;
      if (x1 > bx1) bx1 = x1;
      if (y0 > by1) by1 = y0;
      if (y1 > by1) by1 = y1;
    }
  }
  const segCount = segSub.length;
  if (segCount === 0) return null;

  const r = Math.max(0.25, opts.widthPx / 2);
  const k = Math.max(0, opts.blendPx);

  // ---- Grid over the network bbox. The iso surface reaches at most
  // r + k/4 beyond a stroke centerline; pad a couple cells past that.
  const res = Math.max(16, Math.min(1024, Math.round(opts.resolution)));
  const roughCell = Math.max(bx1 - bx0, by1 - by0, 1e-3) / (res - 1);
  const margin = r + k * 0.25 + roughCell * 2;
  bx0 -= margin;
  by0 -= margin;
  bx1 += margin;
  by1 += margin;

  let cell = Math.max(bx1 - bx0, by1 - by0) / (res - 1);
  // Thin-feature guard: the stroke tube must span ≥ ~3 cells or marching
  // squares hits saddle-heavy topology (speckle + broken chains) along
  // its length. Resolution remains the ceiling via MAX_SAMPLES below.
  cell = Math.min(cell, Math.max(0.5, r * 0.75));
  let gw = Math.max(2, Math.round((bx1 - bx0) / cell) + 1);
  let gh = Math.max(2, Math.round((by1 - by0) / cell) + 1);
  if (gw * gh > MAX_SAMPLES) {
    cell *= Math.sqrt((gw * gh) / MAX_SAMPLES);
    gw = Math.max(2, Math.round((bx1 - bx0) / cell) + 1);
    gh = Math.max(2, Math.round((by1 - by0) / cell) + 1);
  }

  // ---- Spatial hash. A branch only matters near the iso if its
  // distance is within ~k of the running minimum (≤ r + k/4 there), so
  // this radius bounds what any sample must gather.
  const influence = r + k * 1.25 + cell * Math.SQRT2;
  const influenceSq = influence * influence;
  const bucket = Math.max(influence, cell);
  const bCols = Math.max(1, Math.ceil((bx1 - bx0) / bucket));
  const bRows = Math.max(1, Math.ceil((by1 - by0) / bucket));
  const buckets = new Map<number, number[]>();
  const bIdx = (cx: number, cy: number) => cy * bCols + cx;
  for (let i = 0; i < segCount; i++) {
    const minX = Math.min(segX0[i], segX1[i]);
    const maxX = Math.max(segX0[i], segX1[i]);
    const minY = Math.min(segY0[i], segY1[i]);
    const maxY = Math.max(segY0[i], segY1[i]);
    const c0 = Math.max(0, Math.floor((minX - bx0) / bucket));
    const c1 = Math.min(bCols - 1, Math.floor((maxX - bx0) / bucket));
    const r0 = Math.max(0, Math.floor((minY - by0) / bucket));
    const r1 = Math.min(bRows - 1, Math.floor((maxY - by0) / bucket));
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const key = bIdx(cx, cy);
        let list = buckets.get(key);
        if (!list) {
          list = [];
          buckets.set(key, list);
        }
        list.push(i);
      }
    }
  }

  // Beyond this the smooth-min deepening (≤ k/4) can't move the iso into
  // a neighboring cell — plain nearest-distance is exact enough there.
  const farSlack = k * 0.25 + cell * 2;

  return {
    segX0,
    segY0,
    segX1,
    segY1,
    segSub,
    segOrd,
    subSegCount,
    subClosed,
    segCount,
    bx0,
    by0,
    cell,
    gw,
    gh,
    r,
    k,
    influence,
    influenceSq,
    farSlack,
    bucket,
    bCols,
    bRows,
    buckets,
  };
}

// ---- Sample the field (CPU reference). Candidate gathering is cached
// per hash bucket (every sample inside a bucket sees the same 3×3
// neighborhood); distances + branch folding run per sample on reusable
// scratch, allocation-free in the hot loop.
export function evaluateFieldCpu(job: BlendFieldJob): Float32Array {
  const {
    segX0,
    segY0,
    segX1,
    segY1,
    segSub,
    segOrd,
    subSegCount,
    subClosed,
    segCount,
    bx0,
    by0,
    cell,
    gw,
    gh,
    r,
    k,
    influence,
    influenceSq,
    farSlack,
    bucket,
    bCols,
    bRows,
    buckets,
  } = job;

  const grid = new Float32Array(gw * gh);
  const segKey = new Float64Array(segCount);
  for (let i = 0; i < segCount; i++) {
    segKey[i] = segSub[i] * 1048576 + segOrd[i];
  }
  const bIdx = (cx: number, cy: number) => cy * bCols + cx;
  const bucketCand: (Int32Array | null)[] = new Array(bCols * bRows).fill(
    null
  );
  const stamp = new Int32Array(segCount).fill(-1);
  const gatherScratch: number[] = [];
  const gatherBucket = (cx: number, cy: number): Int32Array => {
    const key = bIdx(cx, cy);
    const cached = bucketCand[key];
    if (cached) return cached;
    gatherScratch.length = 0;
    for (let ny = cy - 1; ny <= cy + 1; ny++) {
      if (ny < 0 || ny >= bRows) continue;
      for (let nx = cx - 1; nx <= cx + 1; nx++) {
        if (nx < 0 || nx >= bCols) continue;
        const list = buckets.get(bIdx(nx, ny));
        if (!list) continue;
        for (const si of list) {
          if (stamp[si] === key) continue;
          stamp[si] = key;
          gatherScratch.push(si);
        }
      }
    }
    const arr = Int32Array.from(gatherScratch);
    bucketCand[key] = arr;
    return arr;
  };

  const candSeg: number[] = [];
  const candDist: number[] = [];
  const branchDists: number[] = [];

  for (let gy = 0; gy < gh; gy++) {
    const py = by0 + gy * cell;
    const cy = Math.max(0, Math.min(bRows - 1, Math.floor((py - by0) / bucket)));
    for (let gx = 0; gx < gw; gx++) {
      const px = bx0 + gx * cell;
      const cx = Math.max(
        0,
        Math.min(bCols - 1, Math.floor((px - bx0) / bucket))
      );
      const gi = gy * gw + gx;

      const cand = gatherBucket(cx, cy);
      let m = 0;
      let minD = Infinity;
      for (let ci = 0; ci < cand.length; ci++) {
        const si = cand[ci];
        const d2 = segDistSq(px, py, segX0[si], segY0[si], segX1[si], segY1[si]);
        if (d2 <= influenceSq) {
          const d = Math.sqrt(d2);
          candSeg[m] = si;
          candDist[m] = d;
          m++;
          if (d < minD) minD = d;
        }
      }

      if (m === 0) {
        grid[gi] = influence;
        continue;
      }
      if (m === 1 || minD - r > farSlack) {
        grid[gi] = minD - r;
        continue;
      }

      // Insertion-sort candidates by (subpath, ordinal) so contiguous
      // runs are adjacent, then split into branches at ordinal gaps.
      for (let i = 1; i < m; i++) {
        const s = candSeg[i];
        const d = candDist[i];
        const sk = segKey[s];
        let j = i - 1;
        while (j >= 0 && segKey[candSeg[j]] > sk) {
          candSeg[j + 1] = candSeg[j];
          candDist[j + 1] = candDist[j];
          j--;
        }
        candSeg[j + 1] = s;
        candDist[j + 1] = d;
      }

      branchDists.length = 0;
      let curSub = -1;
      let prevOrd = 0;
      let curMin = 0;
      let subFirstBranch = -1; // branchDists index of this subpath's first branch
      let subFirstOrd = 0;
      for (let i = 0; i <= m; i++) {
        const sub = i < m ? segSub[candSeg[i]] : -2; // sentinel flushes the tail
        const ord = i < m ? segOrd[candSeg[i]] : 0;
        const d = i < m ? candDist[i] : 0;
        if (sub !== curSub) {
          if (curSub >= 0) {
            branchDists.push(curMin);
            // Closed subpath whose candidate runs touch both ends of the
            // ordinal range: the seam-spanning runs are ONE local branch.
            if (subClosed[curSub] && branchDists.length > subFirstBranch + 1) {
              const n = subSegCount[curSub];
              const wrapGap = subFirstOrd + (n - 1 - prevOrd);
              if (wrapGap <= BRANCH_GAP) {
                const last = branchDists.pop()!;
                branchDists[subFirstBranch] = Math.min(
                  branchDists[subFirstBranch],
                  last
                );
              }
            }
          }
          if (i === m) break;
          curSub = sub;
          curMin = d;
          subFirstBranch = branchDists.length;
          subFirstOrd = ord;
        } else if (ord - prevOrd > BRANCH_GAP) {
          branchDists.push(curMin);
          curMin = d;
        } else if (d < curMin) {
          curMin = d;
        }
        prevOrd = ord;
      }

      // Fold ascending for a deterministic smooth-min.
      //
      // Insertion sort, not Array.prototype.sort. This runs on ~26% of grid
      // samples — tens of thousands per call — over a handful of branches
      // each, where sort()'s comparator dispatch and setup dwarf the compare
      // itself. Same ascending order, and the values are plain numbers, so
      // the fold sees an identical sequence.
      const bn = branchDists.length;
      for (let i = 1; i < bn; i++) {
        const v = branchDists[i];
        let j = i - 1;
        while (j >= 0 && branchDists[j] > v) {
          branchDists[j + 1] = branchDists[j];
          j--;
        }
        branchDists[j + 1] = v;
      }
      let acc = branchDists[0];
      for (let i = 1; i < bn; i++) {
        acc = smin(acc, branchDists[i], k);
      }
      grid[gi] = acc - r;
    }
  }

  return grid;
}

export function blendIntersections(
  spline: SplineValue,
  canvasW: number,
  canvasH: number,
  opts: BlendIntersectionsOptions,
  gpu?: BlendFieldGpuContext | null
): SplineValue {
  if (canvasW <= 0 || canvasH <= 0) return EMPTY;

  const job = buildFieldJob(spline, canvasW, canvasH, opts);
  if (!job) return EMPTY;

  // GPU field when a context is provided; evaluateFieldGpu returns null on
  // any failure (no float-render support, compile error, branch-cap
  // overflow, forceCpu A/B override) and the CPU reference takes over.
  const grid =
    (gpu ? evaluateFieldGpu(gpu, job) : null) ?? evaluateFieldCpu(job);

  return recoverContours(job, grid, canvasW, canvasH, opts.smoothing);
}

// Marching squares + cleanup + optional bezier refit over an evaluated
// field grid. Exported (like the two field evaluators) so the
// check:blend-gpu harness can run the identical downstream on a GPU grid.
export function recoverContours(
  job: BlendFieldJob,
  grid: Float32Array,
  canvasW: number,
  canvasH: number,
  smoothingOpt: number
): SplineValue {
  const { cell, gw, gh, bx0, by0 } = job;

  // ---- Contour back into canvas UV.
  const contours = marchingSquares(grid, gw, gh, {
    iso: 0,
    uvOrigin: [bx0 / canvasW, by0 / canvasH],
    uvSize: [((gw - 1) * cell) / canvasW, ((gh - 1) * cell) / canvasH],
  });

  // ---- Cleanup + optional refit, all in px space (isotropic error).
  // Marching squares on thin/tangent features leaves saddle debris:
  // sub-cell slivers, and rings split into open chains whose endpoints
  // nearly meet. Drop the former, re-close the latter.
  const smoothing = Math.max(0, Math.min(1, smoothingOpt));
  const errPx = 0.25 + smoothing * cell * 1.5;
  const out: SplineSubpath[] = [];
  for (const c of contours) {
    const pts: [number, number][] = c.anchors.map((a) => [
      a.pos[0] * canvasW,
      a.pos[1] * canvasH,
    ]);
    let closed = c.closed;
    if (!closed && pts.length > 2) {
      const gap = Math.hypot(
        pts[0][0] - pts[pts.length - 1][0],
        pts[0][1] - pts[pts.length - 1][1]
      );
      if (gap <= cell * 1.5) closed = true;
    }
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    if (len < cell * 3) continue; // saddle debris

    if (smoothing <= 0.001) {
      out.push({ anchors: c.anchors, closed });
      continue;
    }

    // Refit as smooth beziers; anchors divide back into UV (positions
    // and handle offsets both scale linearly). Closed contours append
    // their seam point for the fit, then merge the duplicate end anchor
    // back into the start.
    if (closed) pts.push([pts[0][0], pts[0][1]]);
    // DO NOT thin this polyline before fitting. It looks like free money —
    // it carries one point per cell-edge crossing, far denser than Schneider's
    // fit needs, and simplifyPolyline(pts, errPx * 0.5) cuts the node from
    // ~24.5ms to ~18ms (-27%) with the subpath count unchanged.
    //
    // It was tried and reverted: it makes the output POP in motion. Measured
    // on a 12-frame animated sweep, mean frame-to-frame contour movement went
    // 7.60px -> 10.76px (+42%) for the same 1.41px of input motion. RDP picks
    // its keep-set by max deviation, so a sub-pixel change in the contour
    // flips which points survive, and the fit — now under-constrained between
    // the survivors — swings visibly. Static frames look fine, which is why
    // this needs to be checked in motion.
    //
    // scripts/bench-spline-chain.mts measures the speed; the jitter test that
    // caught it is described in specdocs/080726_perf-profiler.md.
    const fitted = fitSplineToPolyline(pts, errPx);
    if (fitted.length < 2) {
      out.push({ anchors: c.anchors, closed });
      continue;
    }
    if (closed) {
      const last = fitted[fitted.length - 1];
      fitted.pop();
      if (fitted.length < 2) {
        out.push({ anchors: c.anchors, closed });
        continue;
      }
      if (last.inHandle) fitted[0].inHandle = last.inHandle;
    }
    const anchors: SplineAnchor[] = fitted.map((a) => {
      const na: SplineAnchor = {
        pos: [a.pos[0] / canvasW, a.pos[1] / canvasH],
      };
      if (a.inHandle) {
        na.inHandle = [a.inHandle[0] / canvasW, a.inHandle[1] / canvasH];
      }
      if (a.outHandle) {
        na.outHandle = [a.outHandle[0] / canvasW, a.outHandle[1] / canvasH];
      }
      return na;
    });
    out.push({ anchors, closed });
  }
  return { kind: "spline", subpaths: out };
}
