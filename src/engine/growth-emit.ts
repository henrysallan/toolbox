import type {
  PointsValue,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "./types";
import { EMPTY_POINTS, makePoints } from "./points";
import { marchingSquares } from "./marching-squares";

// Shared emission layer for the accretive growth family (specdocs/
// 080226_accretive-growth.md §5). Every Family A algorithm — space
// colonization, DLA, Laplacian/DBM, percolation, L-systems, cracks,
// hyphal networks — produces the SAME structure: elements that attach to
// an existing element and never move again. That structure is a parent
// array plus a birth ordering, and this module turns it into splines.
//
// The defining property, and the reason this can be sliced instead of
// re-simulated: the structure at frame N CONTAINS the structure at frame
// N-1. Elements are appended in growth order, so `parent[i] < i` always
// holds and any prefix of the arrays is itself a valid tree. `progress`
// therefore just picks a prefix length — scrubbing either direction is
// free, backwards included.
//
// Growth happens in ITERATIONS, not one element at a time: a space
// colonization pass extends every active tip simultaneously. Slicing on
// element index would reveal those siblings one by one and read as a
// sequential scribble, so the slice is keyed on `iter` — whole growth
// rings appear together, and the partially-revealed ring interpolates out
// from its parents so the frontier sweeps smoothly instead of popping.
//
// NOTE (spec §2.5): Shortest Path's tree mode has its own inline copy of
// a parent-array emitter. That duplication is deliberate for now —
// tree mode shipped 2026-07-31 and still needs its in-browser pass, so
// consolidating it onto this module is deferred until it's verified.

export interface GrowthTrace {
  count: number;
  // Canvas PIXEL coordinates, y-down. Growth runs in px space because px
  // are square — radii and step lengths stay isotropic on any canvas
  // aspect. Converted to normalized [0,1]² at emit.
  x: Float32Array;
  y: Float32Array;
  // -1 = root (a seed). Always < the element's own index.
  parent: Int32Array;
  // Hops from the seed.
  depth: Int32Array;
  // Growth iteration the element was placed in. The slice key.
  iter: Int32Array;
  // iter normalized to 0..1 — rides the subpath `driver` channel so
  // Stroke/Rasterize ramps can colour by age (spec §2.4).
  birth: Float32Array;
  // Da Vinci thickness in 0..1, root thickest. Rides SplineAnchor.width
  // (a multiplier on the consuming stroke's base thickness) and the aux
  // points' `scales`.
  width: Float32Array;
  // Direction of arrival from the parent, radians, px space.
  heading: Float32Array;
  // Which seed this element descends from.
  root: Int32Array;
  // Dense branch id — increments at every split, so a whole limb shares
  // one id whether it's emitted as a chain or as loose segments.
  branch: Int32Array;
  // Total iterations the trace ran. Slicing divides `progress` by this.
  iters: number;
  // Non-tree edges (fusions, T-junctions) as flat (i,j) index pairs.
  // Populated by the network modes (M4); `branches` emission falls back
  // to `segments` when this is non-empty.
  extraEdges?: Int32Array;
  // Occupancy grid for the grid-based modes (M2), used by `boundary`
  // emission via marching squares.
  occupancy?: Float32Array;
  gridW?: number;
  gridH?: number;
}

export type GrowthEmitMode = "limbs" | "branches" | "segments" | "boundary";
export type GrowthIdMode = "branch" | "depth" | "root" | "birth";

export interface GrowthEmitOptions {
  progress: number;
  emit: GrowthEmitMode;
  idMode: GrowthIdMode;
  idGroups: number;
  // Canvas size, for px → normalized.
  width: number;
  height: number;
  // `boundary` only: silhouette grid resolution across the canvas width,
  // and the radius in px each element contributes to the union of discs.
  boundaryGrid?: number;
  boundaryRadiusPx?: number;
}

// Cap on how far one element's disc is stamped, in grid cells per axis —
// a runaway `boundaryRadiusPx` on a fine grid would otherwise make the
// splat quadratic in the radius.
const MAX_STAMP_CELLS = 48;

export const EMPTY_TRACE: GrowthTrace = {
  count: 0,
  x: new Float32Array(0),
  y: new Float32Array(0),
  parent: new Int32Array(0),
  depth: new Int32Array(0),
  iter: new Int32Array(0),
  birth: new Float32Array(0),
  width: new Float32Array(0),
  heading: new Float32Array(0),
  root: new Int32Array(0),
  branch: new Int32Array(0),
  iters: 0,
};

// Resolved slice geometry. `full` elements sit at their recorded
// position; elements in [full, partialEnd) are the frontier ring and are
// interpolated `frac` of the way out from their parents.
interface Slice {
  full: number;
  partialEnd: number;
  frac: number;
}

function resolveSlice(trace: GrowthTrace, progress: number): Slice {
  const p = Math.max(0, Math.min(1, progress));
  // progress 0 is fully empty, seeds included. Iteration 0 holds the
  // seeds, so a `<=` slice would leave a stray dot per seed sitting at the
  // start of a draw-on reveal — `progress` is a reveal, and 0 means
  // nothing has been revealed yet.
  if (trace.count === 0 || trace.iters === 0 || p <= 0) {
    return { full: 0, partialEnd: 0, frac: 0 };
  }
  const t = p * trace.iters;
  const fullIter = Math.floor(t);
  const frac = t - fullIter;
  const { iter, count } = trace;
  // iter is non-decreasing, so both bounds are prefix lengths.
  let full = 0;
  while (full < count && iter[full] <= fullIter) full++;
  if (frac <= 0) return { full, partialEnd: full, frac: 0 };
  let partialEnd = full;
  while (partialEnd < count && iter[partialEnd] === fullIter + 1) partialEnd++;
  return { full, partialEnd, frac };
}

// Position of element i under the slice, in px.
function posOf(
  trace: GrowthTrace,
  i: number,
  slice: Slice
): [number, number] {
  if (i < slice.full) return [trace.x[i], trace.y[i]];
  const p = trace.parent[i];
  if (p < 0) return [trace.x[i], trace.y[i]];
  const f = slice.frac;
  return [
    trace.x[p] + (trace.x[i] - trace.x[p]) * f,
    trace.y[p] + (trace.y[i] - trace.y[p]) * f,
  ];
}

function groupIdOf(
  trace: GrowthTrace,
  i: number,
  o: GrowthEmitOptions
): number {
  switch (o.idMode) {
    case "depth":
      return trace.depth[i];
    case "root":
      return trace.root[i];
    case "birth":
      return Math.min(
        o.idGroups - 1,
        Math.floor(trace.birth[i] * o.idGroups)
      );
    default:
      return trace.branch[i];
  }
}

export function emitGrowth(
  trace: GrowthTrace,
  o: GrowthEmitOptions
): { spline: SplineValue; points: PointsValue } {
  const slice = resolveSlice(trace, o.progress);
  const n = slice.partialEnd;
  if (n === 0) {
    return { spline: { kind: "spline", subpaths: [] }, points: EMPTY_POINTS };
  }

  const { width: W, height: H } = o;
  // Cache resolved positions once — both emissions and the aux points
  // read them, and the partial ring would otherwise be re-lerped per use.
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [x, y] = posOf(trace, i, slice);
    px[i] = x;
    py[i] = y;
  }

  // A network trace has edges the parent array can't express, so a
  // root→leaf chain walk would silently drop them. Only `branches` depends
  // on that walk, so only `branches` falls back.
  const hasExtra = !!trace.extraEdges && trace.extraEdges.length > 0;
  const mode: GrowthEmitMode =
    o.emit === "branches" && hasExtra ? "segments" : o.emit;

  const subpaths: SplineSubpath[] = [];

  if (mode === "boundary") {
    // Silhouette of the grown mass: rasterize the revealed elements as a
    // union of discs into a signed field (positive inside), then trace the
    // zero crossing. Built from the SLICE, not the trace, so the outline
    // grows with `progress` like every other emission.
    //
    // This is what makes the grid modes (DLA clusters, Eden blobs,
    // percolation fronts) into fillable shapes rather than line work.
    const r = Math.max(1e-3, o.boundaryRadiusPx ?? 8);
    const gw = Math.max(2, Math.round(o.boundaryGrid ?? 256));
    const gh = Math.max(2, Math.round((gw * H) / W));
    // Grid samples sit on cell CORNERS spanning the canvas, matching
    // marchingSquares' own gx/(width-1) → uv mapping.
    const sx = W / (gw - 1);
    const sy = H / (gh - 1);
    const spanX = Math.min(MAX_STAMP_CELLS, Math.ceil((r * 2) / sx));
    const spanY = Math.min(MAX_STAMP_CELLS, Math.ceil((r * 2) / sy));
    // Pad the grid past the canvas by more than one stamp radius, so a
    // cluster touching the canvas edge still closes its silhouette out in
    // the padding instead of emitting an open contour that can't be
    // filled. The outer ring is provably never stamped.
    const padX = spanX + 1;
    const padY = spanY + 1;
    const fw = gw + padX * 2;
    const fh = gh + padY * 2;
    // Accumulate SQUARED distance to the nearest element and take the
    // root once per cell at the end. The inner loop runs
    // elements × stamp-area times (hundreds of thousands), the conversion
    // only cells times — and Math.hypot is far slower than a plain
    // multiply, so keeping it out of the hot loop is most of the win.
    // Measured: 10.0ms → ~2ms for 5k elements on a 268×156 grid.
    const r2 = r * r;
    const grid = new Float32Array(fw * fh).fill(r2 * 4);
    for (let i = 0; i < n; i++) {
      const ex = px[i];
      const ey = py[i];
      const cx = ex / sx + padX;
      const cy = ey / sy + padY;
      const gx0 = Math.max(0, Math.floor(cx) - spanX);
      const gx1 = Math.min(fw - 1, Math.ceil(cx) + spanX);
      const gy0 = Math.max(0, Math.floor(cy) - spanY);
      const gy1 = Math.min(fh - 1, Math.ceil(cy) + spanY);
      for (let gy = gy0; gy <= gy1; gy++) {
        const dy = (gy - padY) * sy - ey;
        const dy2 = dy * dy;
        const row = gy * fw;
        for (let gx = gx0; gx <= gx1; gx++) {
          const dx = (gx - padX) * sx - ex;
          const d2 = dx * dx + dy2;
          if (d2 < grid[row + gx]) grid[row + gx] = d2;
        }
      }
    }
    // Union of discs as a signed field, floored at -r so it stays bounded
    // and the iso interpolation is well-conditioned.
    for (let c = 0; c < grid.length; c++) {
      const v = r - Math.sqrt(grid[c]);
      grid[c] = v < -r ? -r : v;
    }
    // Map the padded grid back so sample `padX` lands on uv 0 and sample
    // `padX + gw - 1` on uv 1.
    const uvW = (fw - 1) / (gw - 1);
    const uvH = (fh - 1) / (gh - 1);
    // marchingSquares emits a sub-cell OPEN sliver wherever the iso
    // crossing passes almost exactly through a grid corner — the same
    // geometric point comes out of several cells with float noise, so the
    // chain walk can't link them. They're invisible but they inflate the
    // subpath count and break fills. Drop open fragments shorter than a
    // cell; genuine open contours (clipped at the grid border) survive.
    const cellUv = Math.min(1 / (gw - 1), 1 / (gh - 1));
    const contours = marchingSquares(grid, fw, fh, {
      uvOrigin: [-padX / (gw - 1), -padY / (gh - 1)],
      uvSize: [uvW, uvH],
    });
    for (const c of contours) {
      if (!c.closed) {
        let len = 0;
        for (let k = 1; k < c.anchors.length; k++) {
          len += Math.hypot(
            c.anchors[k].pos[0] - c.anchors[k - 1].pos[0],
            c.anchors[k].pos[1] - c.anchors[k - 1].pos[1]
          );
        }
        if (len < cellUv) continue;
      }
      c.groupIndex = subpaths.length;
      subpaths.push(c);
    }
  } else if (mode === "segments") {
    for (let i = 0; i < n; i++) {
      const p = trace.parent[i];
      if (p < 0) continue;
      subpaths.push({
        anchors: [
          { pos: [px[p] / W, py[p] / H], width: trace.width[p] },
          { pos: [px[i] / W, py[i] / H], width: trace.width[i] },
        ],
        closed: false,
        groupIndex: groupIdOf(trace, i, o),
        driver: trace.birth[i],
      });
    }
    if (hasExtra) {
      const e = trace.extraEdges!;
      for (let k = 0; k + 1 < e.length; k += 2) {
        const a = e[k];
        const b = e[k + 1];
        if (a >= n || b >= n || a < 0 || b < 0) continue;
        subpaths.push({
          anchors: [
            { pos: [px[a] / W, py[a] / H], width: trace.width[a] },
            { pos: [px[b] / W, py[b] / H], width: trace.width[b] },
          ],
          closed: false,
          groupIndex: groupIdOf(trace, b, o),
          driver: trace.birth[b],
        });
      }
    }
  } else if (mode === "limbs") {
    // limbs: one open subpath per branch id — the maximal chain between
    // two junctions. Continuous polylines (so width profiles, Offset Path
    // and Along Path all behave) at LINEAR size: every element appears
    // exactly once, plus one anchor per limb repeating its junction so
    // limbs visually connect.
    //
    // This is the default because `branches` costs Σ depth(leaf) anchors —
    // 1.5M for a 15k-element tree — and its one advantage over this
    // (a common Trim Path growing the whole tree outward) is something
    // `progress` already does natively and far more cheaply.
    //
    // Branch ids come from the FULL trace, not the slice, so a limb keeps
    // its identity — and therefore its colour — as the tree grows.
    const limbs: (SplineAnchor[] | undefined)[] = [];
    const limbTip: number[] = [];
    for (let i = 0; i < n; i++) {
      const b = trace.branch[i];
      let limb = limbs[b];
      if (!limb) {
        limb = [];
        limbs[b] = limb;
        const p = trace.parent[i];
        if (p >= 0) {
          limb.push({ pos: [px[p] / W, py[p] / H], width: trace.width[p] });
        }
      }
      limb.push({ pos: [px[i] / W, py[i] / H], width: trace.width[i] });
      limbTip[b] = i;
    }
    for (let b = 0; b < limbs.length; b++) {
      const limb = limbs[b];
      if (!limb || limb.length < 2) continue;
      const tip = limbTip[b];
      subpaths.push({
        anchors: limb,
        closed: false,
        groupIndex: groupIdOf(trace, tip, o),
        driver: trace.birth[tip],
      });
    }
    // Limbs tile the TREE edges; the fusion/T-junction edges live outside
    // the parent array, so append them as their own short subpaths.
    // Without this the joins that make a network a network are silently
    // dropped and the output reads as a plain tree.
    if (hasExtra) {
      const e = trace.extraEdges!;
      for (let k = 0; k + 1 < e.length; k += 2) {
        const a = e[k];
        const b = e[k + 1];
        if (a >= n || b >= n || a < 0 || b < 0) continue;
        subpaths.push({
          anchors: [
            { pos: [px[a] / W, py[a] / H], width: trace.width[a] },
            { pos: [px[b] / W, py[b] / H], width: trace.width[b] },
          ],
          closed: false,
          groupIndex: groupIdOf(trace, b, o),
          driver: trace.birth[b],
        });
      }
    }
  } else {
    // branches: one open subpath per leaf-in-slice, root → leaf. Subpaths
    // overlap on shared trunks by design — a common Trim Path then grows
    // the whole structure outward from the root, branches splitting as
    // they're reached. Anchor count is Σ depth(leaf), which on a bushy or
    // deep tree runs into the millions; prefer `limbs` unless you
    // specifically need root-to-tip continuity.
    const childCount = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const p = trace.parent[i];
      if (p >= 0) childCount[p]++;
    }
    const chain: number[] = [];
    for (let i = 0; i < n; i++) {
      if (childCount[i] !== 0) continue;
      chain.length = 0;
      let v = i;
      while (v >= 0) {
        chain.push(v);
        v = trace.parent[v];
      }
      if (chain.length < 2) continue;
      const anchors: SplineAnchor[] = new Array(chain.length);
      for (let k = chain.length - 1, a = 0; k >= 0; k--, a++) {
        const idx = chain[k];
        anchors[a] = {
          pos: [px[idx] / W, py[idx] / H],
          width: trace.width[idx],
        };
      }
      subpaths.push({
        anchors,
        closed: false,
        groupIndex: groupIdOf(trace, i, o),
        driver: trace.birth[i],
      });
    }
  }

  // Aux points: every revealed element, in growth order, carrying the
  // Stage-0 attributes (spec §2.4).
  const points = makePoints(n, {
    withScales: true,
    withRotations: true,
    withGroupIndices: true,
  });
  for (let i = 0; i < n; i++) {
    points.positions[i * 2] = px[i] / W;
    points.positions[i * 2 + 1] = py[i] / H;
    points.scales![i * 2] = trace.width[i];
    points.scales![i * 2 + 1] = trace.width[i];
    points.rotations![i] = trace.heading[i];
    points.groupIndices![i] = groupIdOf(trace, i, o);
  }

  return { spline: { kind: "spline", subpaths }, points };
}

// Da Vinci's rule: a limb's cross-section equals the sum of its children's,
// i.e. t(parent)² = Σ t(child)². Run once over a completed trace, leaves
// outward. Elements are appended in growth order so a single reverse pass
// visits every child before its parent.
//
// Raw widths start at 1 on the leaves; the result is remapped so leaves
// land exactly on `tipWidth` and the thickest root on 1.
export function computeDaVinciWidths(
  parent: Int32Array,
  count: number,
  tipWidth: number
): Float32Array {
  const width = new Float32Array(count);
  if (count === 0) return width;
  const sq = new Float32Array(count);
  const hasChild = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if (parent[i] >= 0) hasChild[parent[i]] = 1;
  }
  for (let i = 0; i < count; i++) if (!hasChild[i]) sq[i] = 1;
  for (let i = count - 1; i >= 0; i--) {
    const p = parent[i];
    if (p >= 0) sq[p] += sq[i];
  }
  let maxRaw = 1;
  for (let i = 0; i < count; i++) {
    const raw = Math.sqrt(sq[i]);
    width[i] = raw;
    if (raw > maxRaw) maxRaw = raw;
  }
  const tw = Math.max(0, Math.min(1, tipWidth));
  const span = maxRaw - 1;
  for (let i = 0; i < count; i++) {
    width[i] = span > 1e-6 ? tw + (1 - tw) * ((width[i] - 1) / span) : 1;
  }
  return width;
}

// Dense branch ids: a new id starts at every seed and at every split, so
// an entire limb between two junctions shares one id. Requires
// parent[i] < i (growth order).
export function computeBranchIds(
  parent: Int32Array,
  count: number
): Int32Array {
  const branch = new Int32Array(count);
  if (count === 0) return branch;
  const childCount = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    if (parent[i] >= 0) childCount[parent[i]]++;
  }
  let next = 0;
  for (let i = 0; i < count; i++) {
    const p = parent[i];
    branch[i] = p < 0 || childCount[p] > 1 ? next++ : branch[p];
  }
  return branch;
}
