import type { NodeDefinition, SplineValue } from "@/engine/types";
import { offsetSubpath } from "@/engine/spline-math";

// Parallel-curve offset. Each subpath is shifted perpendicular to its
// tangent by `distance` units (in normalized canvas space — so 0.05 ≈ 5%
// of the canvas dimension). Positive values offset to the right of the
// path's travel direction; negative to the left. Handled per-subpath so
// compound paths (letter holes, etc.) offset independently.
//
// Built on top of bezier-js's `.offset(d)`, which subdivides around high-
// curvature regions and returns a chain of cubics. We stitch those back
// into our SplineSubpath shape.

export const offsetPathNode: NodeDefinition = {
  type: "spline-offset",
  name: "Offset Path",
  category: "effect",
  description:
    "Offset each subpath perpendicular to its tangent. Useful for variable-width strokes and outline variants without rasterizing.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "distance",
      label: "Distance",
      type: "scalar",
      min: -0.5,
      max: 0.5,
      softMax: 0.1,
      step: 0.001,
      default: 0.02,
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
    const distance = (params.distance as number) ?? 0;
    if (distance === 0) {
      return { primary: src };
    }
    const offsetSubpaths = src.subpaths
      .map((s) => offsetSubpath(s, distance))
      .filter((s): s is NonNullable<typeof s> => s != null);
    const out: SplineValue = { kind: "spline", subpaths: offsetSubpaths };
    return { primary: out };
  },
};
