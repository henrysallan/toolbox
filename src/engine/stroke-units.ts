import type { ParamDef } from "./types";

// Shared px / % units for stroke metrics (thickness, dash/dot lengths) —
// the #174 fix (spec: 071226_multi-stroke.md). Stroke rasterizers
// historically measured in absolute canvas pixels, so the same project
// rendered visually thinner strokes at higher resolutions. The `%` unit
// resolves against the CANVAS WIDTH (value / 100 × width) — the same
// width-relative convention as multi-stroke band widths and SDF aspect
// correction — so a `%` stroke keeps its look at any resolution.
//
// Every node keeps `px` as its default: #174 is fixed by opting a project
// into `%`, never by silently changing saved output.

export type StrokeUnits = "px" | "%";

export function resolveStrokePx(
  value: number,
  units: unknown,
  canvasWidth: number
): number {
  return units === "%" ? (value / 100) * canvasWidth : value;
}

// The units toggle ParamDef. `name` varies per node ("units" on the stroke
// rasterizer nodes, "stroke_units" where params are prefixed).
export function strokeUnitsParam(
  name: string,
  visibleIf?: ParamDef["visibleIf"]
): ParamDef {
  const def: ParamDef = {
    name,
    label: "Units",
    type: "enum",
    options: ["px", "%"],
    default: "px",
    control: "segmented",
  };
  if (visibleIf) def.visibleIf = visibleIf;
  return def;
}
