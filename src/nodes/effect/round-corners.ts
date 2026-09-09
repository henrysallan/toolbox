import type { NodeDefinition, SplineValue } from "@/engine/types";
import { roundCorners } from "@/engine/spline-math";

// Round Corners — Illustrator "Round Corners". Replaces each sharp corner of a
// spline (a straight-edged anchor) with a circular fillet. Works on any spline
// that has corners — Polygon, Star, Rectangle, Cross, Arrow, or one you draw /
// import — which is why corner rounding was left out of the primitives
// themselves. Already-curved anchors pass through untouched; the endpoints of
// open subpaths aren't rounded. Output is a spline — view it with Stroke or
// Rasterize Spline. Radius keyframes for free. Spec:
// specdocs/archive/062526_node-expansion.md §3.

export const roundCornersNode: NodeDefinition = {
  type: "round-corners",
  name: "Round Corners",
  category: "spline",
  subcategory: "modifier",
  description:
    "Round the sharp corners of a spline with circular fillets. Radius is in normalized space (0.5 = half the canvas), capped per corner at half each edge. Curved anchors and open-path endpoints are left as-is. Outputs a spline — view it with Stroke or Rasterize Spline.",
  facts: {
    space: { "param:radius": "canvas01" },
    gotchas: [
      "radius is a canvas01 distance like anchor positions, capped per corner at half the length of each adjacent edge, so tight polygons round less than the slider value.",
      "Only handle-less (straight) interior corners round; anchors that already carry a handle and the endpoints of an open subpath pass through untouched.",
      "A per-anchor cornerStyle (chamfer/scoop) set upstream via Spline Draw's live corner tool is still honored even though this node exposes only one uniform radius.",
      "radius<=0 returns the input spline unchanged (same object reference), skipping the fillet pass entirely.",
    ],
  },
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
