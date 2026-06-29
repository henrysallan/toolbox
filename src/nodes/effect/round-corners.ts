import type { NodeDefinition, SplineValue } from "@/engine/types";
import { roundCorners } from "@/engine/spline-math";

// Round Corners — Illustrator "Round Corners". Replaces each sharp corner of a
// spline (a straight-edged anchor) with a circular fillet. Works on any spline
// that has corners — Polygon, Star, Rectangle, Cross, Arrow, or one you draw /
// import — which is why corner rounding was left out of the primitives
// themselves. Already-curved anchors pass through untouched; the endpoints of
// open subpaths aren't rounded. Output is a spline — view it with Stroke or
// Rasterize Spline. Radius keyframes for free. Spec:
// specdocs/062526_node-expansion.md §3.

export const roundCornersNode: NodeDefinition = {
  type: "round-corners",
  name: "Round Corners",
  category: "spline",
  subcategory: "modifier",
  description:
    "Round the sharp corners of a spline with circular fillets. Radius is in normalized space (0.5 = half the canvas), capped per corner at half each edge. Curved anchors and open-path endpoints are left as-is. Outputs a spline — view it with Stroke or Rasterize Spline.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 0,
      max: 0.5,
      softMax: 0.15,
      step: 0.001,
      default: 0.04,
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
    const radius = Math.max(0, (params.radius as number) ?? 0);
    if (radius <= 0) {
      return { primary: src };
    }
    const out: SplineValue = {
      kind: "spline",
      subpaths: roundCorners(src.subpaths, radius),
    };
    return { primary: out };
  },
};
