// Point-data → string formatter, shared by the Points to Text node and the
// self-contained Point Labels node. Pure (no GL, no DOM) so it lives engine-
// side and both nodes import it.
//
// A `points` value has a fixed, knowable schema (positions + optional scale/
// rotation/groupIndex typed arrays, plus implicit index/count), so the "which
// data" choice is a stable enum, not a per-connection scrape. Each `field`
// preset maps to a built-in token template; `custom` uses the user's template.
//
// Coordinate convention (see AGENTS devguide): positions are normalized [0,1]²,
// Y-DOWN. Pixel units multiply x by canvas width and y by canvas height —
// deliberately anisotropic, matching every other engine value (a point at
// canvas center reads e.g. "960, 540" at 1080p, not one aspect-scaled number).

import type { PointsValue } from "./types";
import { getGroupIndex, getRotation, getScaleX, getScaleY } from "./points";

export const POINT_LABEL_FIELDS = [
  "position",
  "x",
  "y",
  "index",
  "rotation",
  "scale",
  "group",
  "custom",
] as const;
export type PointLabelField = (typeof POINT_LABEL_FIELDS)[number];

export const POINT_LABEL_UNITS = ["normalized", "pixels"] as const;
export type PointLabelUnits = (typeof POINT_LABEL_UNITS)[number];

// Built-in template per non-custom field. Tokens are substituted per point.
const FIELD_TEMPLATES: Record<Exclude<PointLabelField, "custom">, string> = {
  position: "{x}, {y}",
  x: "{x}",
  y: "{y}",
  index: "{i}",
  rotation: "{rot}",
  scale: "{sx}, {sy}",
  group: "{g}",
};

export interface PointLabelOpts {
  field: PointLabelField;
  // Used only when field === "custom".
  template: string;
  units: PointLabelUnits;
  // Decimal places for x / y / rotation / scale. Index / count / group are
  // always integers. Clamped to [0, 6].
  precision: number;
  // Canvas pixel dimensions, for pixel units. Ignored for normalized.
  width: number;
  height: number;
}

// The effective template for the chosen field.
export function resolveTemplate(
  field: PointLabelField,
  custom: string
): string {
  return field === "custom" ? custom : FIELD_TEMPLATES[field];
}

// Recognized tokens. Unknown `{…}` sequences pass through literally (the regex
// only matches this set), so free-form templates like "P{i}: ({x}, {y})" work.
//   {x} {y}  position (normalized or pixels)
//   {i}      index (0-based)   {n}  total count
//   {rot}    rotation, degrees {rad} rotation, radians
//   {sx} {sy} per-axis scale   {g}  group tag
const TOKEN_RE = /\{(x|y|i|n|rot|rad|sx|sy|g)\}/g;

export function formatPointLabel(
  pts: PointsValue,
  i: number,
  tpl: string,
  opts: PointLabelOpts
): string {
  const prec = Math.max(0, Math.min(6, Math.round(opts.precision)));
  const px = opts.units === "pixels";
  const rawX = pts.positions[i * 2];
  const rawY = pts.positions[i * 2 + 1];
  const x = px ? rawX * opts.width : rawX;
  const y = px ? rawY * opts.height : rawY;
  return tpl.replace(TOKEN_RE, (_m, tok: string) => {
    switch (tok) {
      case "x":
        return x.toFixed(prec);
      case "y":
        return y.toFixed(prec);
      case "i":
        return String(i);
      case "n":
        return String(pts.count);
      case "rot":
        return ((getRotation(pts, i) * 180) / Math.PI).toFixed(prec);
      case "rad":
        return getRotation(pts, i).toFixed(prec);
      case "sx":
        return getScaleX(pts, i).toFixed(prec);
      case "sy":
        return getScaleY(pts, i).toFixed(prec);
      case "g":
        return String(getGroupIndex(pts, i));
      default:
        return "";
    }
  });
}

// Format every point → strings[] parallel to the points, in point order.
export function formatPointLabels(
  pts: PointsValue,
  opts: PointLabelOpts
): string[] {
  const tpl = resolveTemplate(opts.field, opts.template);
  const out = new Array<string>(pts.count);
  for (let i = 0; i < pts.count; i++) {
    out[i] = formatPointLabel(pts, i, tpl, opts);
  }
  return out;
}
