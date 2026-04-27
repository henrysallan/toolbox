import type {
  NodeDefinition,
  PointsValue,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";

// Connect nearby points with straight-line spline segments. The
// user's control is a max-distance threshold (UV space): every pair
// of input points within that threshold gets a 2-anchor open subpath.
// Output is the set of segments as a single SplineValue; a passthrough
// `points` aux output lets downstream nodes consume both the new
// connections AND the original points without a re-wire.
//
// Classification: Spline → Generator (purpose: produce splines from
// a point set). Parallels scatter-points (Point Generator from an
// image) on the other side of the type boundary.
//
// Algorithm: O(N²) pairwise distance check. For typical sizes
// (N ≈ 50–200) this is nothing; past a few hundred points a spatial
// hash would matter, but that's an optimization for later.
//
// groupIndex handling: a segment inherits the groupIndex only when
// both endpoints share one. Cross-group edges (A from group 0 to B
// from group 1) are left un-tagged so downstream per-index nodes
// see them as free-floating rather than mis-attributed to one side.

export const connectPointsNode: NodeDefinition = {
  type: "connect-points",
  name: "Connect Points",
  category: "spline",
  subcategory: "generator",
  description:
    "Connect pairs of input points within a max-distance threshold with straight-line segments. Primary output is the segments as a spline; the passthrough `points` aux keeps the original points available on the same wire for further downstream use.",
  backend: "webgl2",
  inputs: [{ name: "points", type: "points", required: true }],
  params: [
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
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "points", type: "points" }],

  compute({ inputs, params }) {
    const srcVal = inputs.points;
    const points: PointsValue["points"] =
      srcVal?.kind === "points" ? srcVal.points : [];
    const maxD = Math.max(0, (params.max_distance as number) ?? 0.1);
    const d2 = maxD * maxD;
    const N = points.length;

    // Spatial hash bucket: cell size = max_distance, so any pair
    // within threshold lives in the same cell or in one of the 8
    // neighbors. Reduces O(N²) pair-checks to O(N · k) where k is
    // local density. With max_distance = 0.1 the grid is at most
    // 11×11 buckets; for very small thresholds the grid grows but
    // each bucket stays sparse, so the gain only widens.
    const subpaths: SplineSubpath[] = [];
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
                a.groupIndex !== undefined &&
                a.groupIndex === b.groupIndex
                  ? a.groupIndex
                  : undefined;
              const sub: SplineSubpath = {
                closed: false,
                anchors: [
                  { pos: [a.pos[0], a.pos[1]] },
                  { pos: [b.pos[0], b.pos[1]] },
                ],
              };
              if (shared !== undefined) sub.groupIndex = shared;
              subpaths.push(sub);
            }
          }
        }
      }
    }

    const spline: SplineValue = { kind: "spline", subpaths };
    // Pass the original points through untouched so downstream nodes
    // that need both the connections and the source points don't
    // need to re-split the wire.
    const passthrough: PointsValue =
      srcVal?.kind === "points"
        ? srcVal
        : { kind: "points", points: [] };
    return { primary: spline, aux: { points: passthrough } };
  },
};
