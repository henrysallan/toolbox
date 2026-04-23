import type { NodeDefinition, SplineValue } from "@/engine/types";
import { resampleSubpath } from "@/engine/spline-math";

// Redistribute each subpath's anchors evenly along arc length. New anchors
// get auto-smooth handles derived from the curve's tangent at each sample
// point, so the resampled path closely follows the original curvature
// rather than collapsing to a polyline of corners.
//
// Prerequisite for Jitter, Simplify, and uniform Points-on-Path — anything
// downstream that wants predictable per-anchor spacing.

export const resampleNode: NodeDefinition = {
  type: "spline-resample",
  name: "Resample",
  category: "effect",
  description:
    "Redistribute anchors evenly along the arc length of the spline. Preserves subpath count and closed/open state.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "count",
      label: "Anchors per subpath",
      type: "scalar",
      min: 2,
      max: 512,
      softMax: 64,
      step: 1,
      default: 16,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params }) {
    const src = inputs.path;
    if (!src || src.kind !== "spline") {
      const empty: SplineValue = { kind: "spline", subpaths: [] };
      return { primary: empty };
    }
    const count = Math.max(2, Math.floor((params.count as number) ?? 16));
    const out: SplineValue = {
      kind: "spline",
      subpaths: src.subpaths.map((sub) => resampleSubpath(sub, count)),
    };
    return { primary: out };
  },
};
