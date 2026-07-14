import type { NodeDefinition, SplineValue } from "@/engine/types";
import { defaultFloatCurve, sanitizeFloatCurve } from "@/engine/float-curve";
import {
  buildRepeatStrokes,
  type RepeatDirection,
} from "@/engine/spline-repeat";
import type { OverlapStyle } from "@/engine/spline-offset-resolve";

// Multi-stroke geometry: emit N parallel-offset copies of the input path
// (spec: 071226_multi-stroke.md). Fixed-band model — `count` strokes span a
// band of total `width`, placed by the spacing curve — so the outer bound is
// predictable and the default linear curve gives even spacing with copy 0
// exactly on the source path. Feed the result into Stroke, Trim Path,
// Spline Boolean, Rasterize Spline… each copy is a full subpath set tagged
// with its own groupIndex, so group-aware nodes can address rings
// individually. For one-node stroked output with per-ring styling, use the
// Stroke node's Repeats section instead.

export const repeatPathNode: NodeDefinition = {
  type: "spline-repeat",
  name: "Repeat Path",
  category: "spline",
  subcategory: "modifier",
  description:
    "Repeat a path as parallel-offset copies — count, inner/outer/both direction, band width, and a spacing curve that places each copy within the band. Closed shapes are winding-normalized (outer always expands); for open paths inner/outer mean left/right of the travel direction. Each copy is tagged with its own group index. When sharp corners make an offset copy overlap itself, the Overlap mode cuts the crossing loop — Sharp resolves it to a single point, Smooth rounds the cut.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "count",
      label: "Count",
      type: "scalar",
      min: 1,
      max: 64,
      softMax: 16,
      step: 1,
      default: 3,
    },
    {
      name: "direction",
      label: "Direction",
      type: "enum",
      options: ["outer", "inner", "both"],
      default: "outer",
    },
    {
      name: "width",
      label: "Width",
      type: "scalar",
      min: 0,
      max: 0.5,
      softMax: 0.2,
      step: 0.001,
      default: 0.05,
    },
    {
      name: "spacing_curve",
      label: "Spacing",
      type: "float_curve",
      default: defaultFloatCurve(0, 1),
    },
    {
      name: "overlap",
      label: "Overlap",
      type: "enum",
      options: ["keep", "sharp", "smooth"],
      default: "keep",
      control: "segmented",
    },
    {
      name: "smoothing",
      label: "Smoothing",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => p.overlap === "smooth",
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const src = inputs.path;
    if (!src || src.kind !== "spline") {
      const empty: SplineValue = { kind: "spline", subpaths: [] };
      return { primary: empty };
    }
    const strokes = buildRepeatStrokes(src.subpaths, {
      count: (params.count as number) ?? 3,
      direction: (params.direction as RepeatDirection) ?? "outer",
      width: (params.width as number) ?? 0.05,
      spacingCurve: sanitizeFloatCurve(params.spacing_curve, 0, 1),
      widthPx: ctx.width,
      heightPx: ctx.height,
      overlap: {
        style: (params.overlap as OverlapStyle) ?? "keep",
        smoothing: (params.smoothing as number) ?? 0.5,
      },
    });
    const out: SplineValue = {
      kind: "spline",
      subpaths: strokes.flatMap((s, ring) =>
        s.subpaths.map((sub) => ({ ...sub, groupIndex: ring }))
      ),
    };
    return { primary: out };
  },
};
