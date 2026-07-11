import type {
  NodeDefinition,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { catmullRomSubpath } from "@/engine/spline-math";

// Points to Spline — chain a points value into spline subpaths, in point
// index order. The inverse of Points on Path / the ordered sibling of
// Connect Points (which pairs by proximity instead of order). groupIndex
// tags split the input: each distinct group becomes its own subpath
// (tagged, so per-index downstream nodes keep working); wholly untagged
// input becomes one untagged subpath. Groups with fewer than 2 points
// emit nothing.
//
// `curve` picks the anchor style: linear = corner anchors (polyline),
// smooth = catmull-rom auto handles through every point (same math as
// Spiral / Sine Wave). Chain Set Spline Type to change your mind later.
//
// Spec: specdocs/071026_spline-points-nodes.md.

type V2 = [number, number];

export const pointsToSplineNode: NodeDefinition = {
  type: "points-to-spline",
  name: "Points to Spline",
  category: "spline",
  subcategory: "generator",
  description:
    "Chain points into a spline in index order. Each groupIndex becomes its own subpath (Copy to Points / Collect output splits naturally). Curve = linear polyline or smooth catmull-rom through every point; close wraps each subpath.",
  backend: "webgl2",
  inputs: [{ name: "points", type: "points", required: true }],
  params: [
    {
      name: "curve",
      label: "Curve",
      type: "enum",
      options: ["linear", "smooth"],
      default: "linear",
    },
    { name: "closed", label: "Close", type: "boolean", default: false },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params }) {
    const src = inputs.points;
    if (!src || src.kind !== "points" || src.count < 2) {
      const empty: SplineValue = { kind: "spline", subpaths: [] };
      return { primary: empty };
    }
    const smooth = ((params.curve as string) ?? "linear") === "smooth";
    const closed = !!params.closed;

    // Split by groupIndex, preserving index order within each group.
    // Untagged input (no groupIndices array) is a single anonymous run.
    const pos = src.positions;
    const groups = src.groupIndices;
    const runs = new Map<number | undefined, V2[]>();
    for (let i = 0; i < src.count; i++) {
      const key = groups ? groups[i] : undefined;
      let run = runs.get(key);
      if (!run) {
        run = [];
        runs.set(key, run);
      }
      run.push([pos[i * 2], pos[i * 2 + 1]]);
    }

    // Emit subpaths in ascending group order so output order is stable
    // regardless of input interleaving (the anonymous run sorts first).
    const keys = Array.from(runs.keys()).sort(
      (a, b) => (a ?? -Infinity) - (b ?? -Infinity)
    );
    const subpaths: SplineSubpath[] = [];
    for (const key of keys) {
      const run = runs.get(key)!;
      if (run.length < 2) continue;
      const sub: SplineSubpath = smooth
        ? catmullRomSubpath(run, closed)
        : { anchors: run.map((p) => ({ pos: p })), closed };
      if (key !== undefined) sub.groupIndex = key;
      subpaths.push(sub);
    }

    const out: SplineValue = { kind: "spline", subpaths };
    return { primary: out };
  },
};
