import type {
  NodeDefinition,
  PointsValue,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { ensurePointArray, pointsFromArray } from "@/engine/points";
import {
  computeSegmentShapeHandles,
  readSegmentShapeParams,
  segmentShapeModeParams,
  segmentShapePathParam,
  type SegmentShapeEdge,
} from "@/engine/segment-shape";

// Connect nearby points with spline segments. The user's control is a
// max-distance threshold (UV space): every pair of input points within
// that threshold gets a 2-anchor open subpath. A `path` mode decides
// each segment's SHAPE — straight chords, arcs / S-curves, sag, flow,
// network tangents, bundling, attract — via the shared segment-shape
// machinery (engine/segment-shape.ts, also consumed by Shortest Path).
// Spec: specdocs/archive/073126_connect-points-curved-paths.md.
// Output is the set of segments as a single SplineValue; a passthrough
// `points` aux output lets downstream nodes consume both the new
// connections AND the original points without a re-wire.
//
// Classification: Spline → Generator (purpose: produce splines from
// a point set). Parallels scatter-points (Point Generator from an
// image) on the other side of the type boundary.
//
// `min_connections` is a DEGREE FILTER, not a floor: it never invents
// edges past max_distance, it only removes ones whose endpoints were
// too lonely. Single-pass and non-cascading — see the comment on the
// pruning block.
//
// groupIndex handling: a segment inherits the groupIndex only when
// both endpoints share one. Cross-group edges (A from group 0 to B
// from group 1) are left un-tagged so downstream per-index nodes
// see them as free-floating rather than mis-attributed to one side.

interface Edge extends SegmentShapeEdge {
  group: number | undefined;
}

export const connectPointsNode: NodeDefinition = {
  type: "connect-points",
  name: "Connect Points",
  category: "spline",
  subcategory: "generator",
  description:
    "Connect pairs of input points within a max-distance threshold. Path modes shape each connection: straight chords, circular arcs / S-curves (curved), hanging-wire droop (sag), noise-field tangents (flow), smooth curves flowing through shared points (network), parallel connections merging into trunks (bundle), or bowing toward/away from a center (attract). `Min connections` prunes the sparse fringe: an edge survives only when BOTH its endpoints found at least that many neighbours inside the threshold, so stringy one-off segments drop out and the dense core stays. Primary output is the segments as a spline; the passthrough `points` aux keeps the original points available on the same wire for further downstream use.",
  backend: "webgl2",
  inputs: [{ name: "points", type: "points", required: true }],
  headerControl: { paramName: "path" },
  params: [
    segmentShapePathParam(),
    {
      name: "max_distance",
      label: "Max distance",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.3,
      step: 0.001,
      default: 0.1,
    },
    // Degree filter — see the pruning pass in compute. 0 (and 1, which
    // can only drop points that had no edges to begin with) are no-ops,
    // so the default leaves every existing project untouched.
    {
      name: "min_connections",
      label: "Min connections",
      type: "scalar",
      min: 0,
      max: 16,
      softMax: 6,
      step: 1,
      default: 0,
    },
    ...segmentShapeModeParams(),
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "points", type: "points" }],

  compute({ inputs, params, ctx }) {
    const srcVal = inputs.points;
    const points: PointsValue["points"] =
      srcVal?.kind === "points" ? ensurePointArray(srcVal) : [];
    const maxD = Math.max(0, (params.max_distance as number) ?? 0.1);
    const d2 = maxD * maxD;
    const N = points.length;

    // Spatial hash bucket: cell size = max_distance, so any pair
    // within threshold lives in the same cell or in one of the 8
    // neighbors. Reduces O(N²) pair-checks to O(N · k) where k is
    // local density. With max_distance = 0.1 the grid is at most
    // 11×11 buckets; for very small thresholds the grid grows but
    // each bucket stays sparse, so the gain only widens.
    //
    // Distances stay RAW UV (not iso) on purpose — changing that
    // would silently rewire existing projects on non-square canvases.
    const edges: Edge[] = [];
    if (N > 0 && maxD > 0) {
      const cell = maxD;
      const grid = new Map<string, number[]>();
      const cellKey = (cx: number, cy: number) => `${cx}|${cy}`;
      // Bucket every point by its cell coordinate. floor() rather
      // than round() so cell membership matches "this point is in
      // the [cx*cell, (cx+1)*cell) range."
      for (let i = 0; i < N; i++) {
        const p = points[i];
        const cx = Math.floor(p.pos[0] / cell);
        const cy = Math.floor(p.pos[1] / cell);
        const k = cellKey(cx, cy);
        let arr = grid.get(k);
        if (!arr) {
          arr = [];
          grid.set(k, arr);
        }
        arr.push(i);
      }
      // For each point, scan its own bucket + the 8 neighbors. The
      // i < j guard avoids double-counting and self-pairing in one
      // pass without needing a "visited" set.
      for (let i = 0; i < N; i++) {
        const a = points[i];
        const cx = Math.floor(a.pos[0] / cell);
        const cy = Math.floor(a.pos[1] / cell);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const arr = grid.get(cellKey(cx + dx, cy + dy));
            if (!arr) continue;
            for (let k = 0; k < arr.length; k++) {
              const j = arr[k];
              if (j <= i) continue;
              const b = points[j];
              const ex = a.pos[0] - b.pos[0];
              const ey = a.pos[1] - b.pos[1];
              if (ex * ex + ey * ey > d2) continue;
              const shared =
                a.groupIndex !== undefined && a.groupIndex === b.groupIndex
                  ? a.groupIndex
                  : undefined;
              edges.push({ i, j, group: shared });
            }
          }
        }
      }
    }

    // Degree filter. Points on the sparse fringe of a cloud produce
    // stringy one-off segments that read as noise; dropping every edge
    // whose endpoints didn't BOTH reach `min_connections` prunes them
    // and leaves the dense core intact.
    //
    // Degrees are measured ONCE, on the full threshold graph, and the
    // pass does not cascade: removing an edge never re-tests the
    // neighbours it just demoted. That's deliberate — an iterative
    // version is the k-core, which collapses whole regions from a
    // one-step parameter nudge and is miserable to art-direct. Here the
    // result is always "the threshold graph, minus its fringe."
    const minConn = Math.max(0, Math.round((params.min_connections as number) ?? 0));
    let kept = edges;
    if (minConn > 1 && edges.length > 0) {
      const degree = new Int32Array(N);
      for (const e of edges) {
        degree[e.i]++;
        degree[e.j]++;
      }
      kept = edges.filter(
        (e) => degree[e.i] >= minConn && degree[e.j] >= minConn
      );
    }

    const x = new Float64Array(N);
    const y = new Float64Array(N);
    for (let p = 0; p < N; p++) {
      x[p] = points[p].pos[0];
      y[p] = points[p].pos[1];
    }
    const handles = computeSegmentShapeHandles({
      edges: kept,
      x,
      y,
      aspect: ctx.height > 0 ? ctx.width / ctx.height : 1,
      p: readSegmentShapeParams(params),
    });

    const subpaths: SplineSubpath[] = [];
    for (let k = 0; k < kept.length; k++) {
      const e = kept[k];
      const h = handles[k];
      const a = points[e.i];
      const b = points[e.j];
      const anchorA: SplineAnchor = { pos: [a.pos[0], a.pos[1]] };
      if (h.out) anchorA.outHandle = h.out;
      const anchorB: SplineAnchor = { pos: [b.pos[0], b.pos[1]] };
      if (h.in) anchorB.inHandle = h.in;
      const sub: SplineSubpath = { closed: false, anchors: [anchorA, anchorB] };
      if (e.group !== undefined) sub.groupIndex = e.group;
      subpaths.push(sub);
    }

    const spline: SplineValue = { kind: "spline", subpaths };
    // Pass the original points through untouched so downstream nodes
    // that need both the connections and the source points don't
    // need to re-split the wire.
    const passthrough: PointsValue =
      srcVal?.kind === "points" ? srcVal : pointsFromArray([]);
    return { primary: spline, aux: { points: passthrough } };
  },
};
