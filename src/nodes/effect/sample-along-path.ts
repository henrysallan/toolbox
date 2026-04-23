import type { NodeDefinition, Vec2Value } from "@/engine/types";
import { measureSpline, sampleSplineAt } from "@/engine/spline-math";

// Sample a spline at arc-length parameter t ∈ [0,1]. The primary output is
// the position (vec2); the aux output is the unit tangent (vec2). Measured
// by ARC LENGTH across the concatenation of all subpaths — so a multi-
// subpath SVG animates evenly along its total painted distance rather than
// snapping segment boundaries.
//
// `t` is a regular param (0..1) that the user can expose as a scalar socket
// if they want to drive it from Scene Time or another node — standard
// exposed-param pattern; the evaluator overrides the stored value with the
// incoming socket value when an edge is attached.

export const sampleAlongPathNode: NodeDefinition = {
  type: "sample-along-path",
  name: "Sample Along Path",
  category: "effect",
  description:
    "Output the position (and tangent) at a given arc-length t ∈ [0,1] along a spline. Expose `t` as a socket to animate along the path.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "t",
      label: "t",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0,
    },
  ],
  primaryOutput: "vec2",
  auxOutputs: [{ name: "tangent", type: "vec2" }],

  compute({ inputs, params }) {
    const src = inputs.path;
    if (!src || src.kind !== "spline") {
      const zero: Vec2Value = { kind: "vec2", value: [0, 0] };
      return { primary: zero, aux: { tangent: zero } };
    }
    const lengths = measureSpline(src);
    const t = Math.max(0, Math.min(1, (params.t as number) ?? 0));
    const sample = sampleSplineAt(src, lengths, t);
    return {
      primary: { kind: "vec2", value: sample.pos } satisfies Vec2Value,
      aux: {
        tangent: { kind: "vec2", value: sample.tangent } satisfies Vec2Value,
      },
    };
  },
};
