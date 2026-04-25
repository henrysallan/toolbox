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

    const subpaths: SplineSubpath[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      for (let j = i + 1; j < points.length; j++) {
        const b = points[j];
        const dx = a.pos[0] - b.pos[0];
        const dy = a.pos[1] - b.pos[1];
        if (dx * dx + dy * dy > d2) continue;
        const shared =
          a.groupIndex !== undefined && a.groupIndex === b.groupIndex
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
