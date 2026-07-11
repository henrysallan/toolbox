import type { NodeDefinition, SplineValue } from "@/engine/types";
import { SPLINE_TRIM_PARAMS, applyTrimParams } from "../source/spline-raster-aux";

// Trim Path — reveal only the [start, end] arc-length window of a wired spline
// (measured across all subpaths). The standalone counterpart to the trim
// sliders bundled into the spline primitives: reach for this to trim a spline
// built or imported downstream. Output is a spline — view it with Stroke or
// Rasterize Spline. All sliders keyframe, so animating `end` 0→1 draws on;
// `offset` slides the window along the path with wraparound (unbounded mod 1),
// so keyframing it orbits the trimmed piece around the path indefinitely.

export const trimPathNode: NodeDefinition = {
  type: "trim-path",
  name: "Trim Path",
  category: "spline",
  subcategory: "modifier",
  description:
    "Reveal only a portion of a path by arc length. Start/end (0–1, across all subpaths) animate a draw-on; offset slides the window along the path, wrapping past the ends (unbounded — keyframe it to orbit the piece around a loop). Outputs a spline — view it with Stroke or Rasterize Spline.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [...SPLINE_TRIM_PARAMS],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params }) {
    const src = inputs.path;
    if (!src || src.kind !== "spline") {
      const empty: SplineValue = { kind: "spline", subpaths: [] };
      return { primary: empty };
    }
    const out: SplineValue = {
      kind: "spline",
      subpaths: applyTrimParams(src.subpaths, params),
    };
    return { primary: out };
  },
};
