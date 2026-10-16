import type { NodeDefinition, ParamDef, SplineValue } from "@/engine/types";
import { SPLINE_TRIM_PARAMS, applyTrimParams } from "../source/spline-raster-aux";
import {
  TRIM_MEASURES,
  TRIM_SOURCES,
  makeTrimSourceFn,
  trimSubpathsEach,
  type TrimMeasure,
  type TrimSource,
} from "@/engine/spline-trim";

// Trim Path — reveal only the [start, end] arc-length window of a wired spline.
// Combined (default) measures across all subpaths, matching AE "Trim Multiple
// Shapes: Simultaneously" and the sliders bundled into spline primitives.
// Per subpath trims each path in its own 0–1 domain (AE Individually); start /
// end / offset can then come from the slider, a named subpath attribute, or
// the shared driver keys (index / random / group / position / driver). Offset
// slides the window along the path with wraparound (unbounded mod 1). Output
// is a spline — view it with Stroke or Rasterize Spline.
//
// `measure` (2026-10-16) places the window's fractions on the path: arc
// length cuts at the exact arc-length point (React Native Skia's
// <Path start end>, AE); segment is the original mapping, which drifts
// inside each segment (spline-trim.ts header). New nodes get arc length from
// the def default (makeInstanceNode writes every default; so do the recipe
// builder and MCP inserts). A node saved before the param existed has no
// `measure` key — the loader (lib/project.ts deserializeParams) copies only
// the saved keys and no load step fills defaults — so an ABSENT measure
// reads as segment and every old project keeps its timing, with no schema
// bump. Copy to Points' `anchor` uses the same rule.

const perSubpath = (p: Record<string, unknown>) => p.mode === "per subpath";

// The measure a node's params select: absent (a pre-2026-10-16 save) or any
// unknown value is the original segment measure; only an explicit
// "arc length" opts in.
export function trimPathMeasure(params: Record<string, unknown>): TrimMeasure {
  return params.measure === "arc length" ? "arc length" : "segment";
}

function sourceParams(
  prefix: "start" | "end" | "offset",
  label: string
): ParamDef[] {
  const sourceName = `${prefix}_source`;
  return [
    {
      name: sourceName,
      label: `${label} source`,
      type: "enum",
      options: [...TRIM_SOURCES],
      default: "value",
      visibleIf: perSubpath,
    },
    {
      name: `${prefix}_attr`,
      label: `${label} attribute`,
      type: "string",
      default: "",
      placeholder: "attribute name",
      suggestAttrsFrom: "path",
      suggestAttrsRequire: true,
      visibleIf: (p) => perSubpath(p) && p[sourceName] === "attribute",
    },
  ];
}

export const trimPathNode: NodeDefinition = {
  type: "trim-path",
  name: "Trim Path",
  category: "spline",
  subcategory: "modifier",
  description:
    "Reveal only a portion of a path by arc length. Combined mode measures start/end across all subpaths (draw-on of a whole compound path); Per subpath trims each path in its own 0–1 domain. In Per subpath, start / end / offset can each come from the slider, a named subpath attribute, or index / random / group / position / driver. Offset slides the window along the path, wrapping past the ends (unbounded — keyframe it to orbit a loop). Measure: arc length cuts at the exact distance along the path (like React Native Skia and After Effects); segment is the original, uneven mapping that older saves keep. Outputs a spline — view it with Stroke or Rasterize Spline.",
  searchAliases: ["trim paths", "individually"],
  facts: {
    gotchas: [
      "mode=combined (default) treats all subpaths as one concatenated length domain; mode=per subpath gives each subpath its own 0-1 domain instead.",
      "In per subpath mode, start/end/offset each independently pull from the slider (value), a named subpath attribute, or the shared driver keys index/random/group/position/driver.",
      "trim_start/trim_end/trim_offset are fractions (0-1) of the measured path length, not canvas or pixel units.",
      "measure=arc length cuts at the exact distance along the path, as React Native Skia does; measure=segment maps length onto each segment's curve parameter, so cuts drift up to ~10% of a segment.",
      "A Trim Path saved before measure existed loads with measure=segment (pinned on load), so old projects keep their exact cuts; switch it to arc length to fix their drift.",
      "offset is unbounded and taken mod 1, sliding the window cyclically; a window that straddles the wrap seam on a closed subpath is stitched into one continuous piece.",
    ],
  },
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["combined", "per subpath"],
      default: "combined",
      control: "segmented",
    },
    {
      name: "measure",
      label: "Measure",
      type: "enum",
      options: [...TRIM_MEASURES],
      default: "arc length",
      control: "segmented",
    },
    ...SPLINE_TRIM_PARAMS,
    ...sourceParams("start", "Start"),
    ...sourceParams("end", "End"),
    ...sourceParams("offset", "Offset"),
    {
      name: "source_seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 9999,
      step: 1,
      default: 0,
      visibleIf: (p) =>
        perSubpath(p) &&
        (p.start_source === "random" ||
          p.end_source === "random" ||
          p.offset_source === "random"),
    },
    {
      name: "source_angle",
      label: "Gradient angle",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      visibleIf: (p) =>
        perSubpath(p) &&
        (p.start_source === "position" ||
          p.end_source === "position" ||
          p.offset_source === "position"),
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
    const mode = (params.mode as string) ?? "combined";
    const measure = trimPathMeasure(params);
    if (mode !== "per subpath") {
      return {
        primary: {
          kind: "spline",
          subpaths: applyTrimParams(src.subpaths, params, measure),
        },
      };
    }

    const start = typeof params.trim_start === "number" ? params.trim_start : 0;
    const end = typeof params.trim_end === "number" ? params.trim_end : 1;
    const offset =
      typeof params.trim_offset === "number" ? params.trim_offset : 0;
    const seed = Math.floor((params.source_seed as number) ?? 0);
    const angleDeg = (params.source_angle as number) ?? 0;
    const optsFor = (attrName: unknown) => ({
      attrName: typeof attrName === "string" ? attrName : "",
      seed,
      angleDeg,
    });
    const startAt = makeTrimSourceFn(
      src.subpaths,
      params.start_source as TrimSource,
      start,
      optsFor(params.start_attr)
    );
    const endAt = makeTrimSourceFn(
      src.subpaths,
      params.end_source as TrimSource,
      end,
      optsFor(params.end_attr)
    );
    const offsetAt = makeTrimSourceFn(
      src.subpaths,
      params.offset_source as TrimSource,
      offset,
      optsFor(params.offset_attr)
    );
    return {
      primary: {
        kind: "spline",
        subpaths: trimSubpathsEach(src.subpaths, startAt, endAt, offsetAt, measure),
      },
    };
  },
};
