import type { NodeDefinition } from "@/engine/types";
import {
  formatPointLabels,
  joinPointLabelStrings,
  POINT_LABEL_UNITS,
  POINT_STRING_COL_SEPS,
  POINT_STRING_LAYOUTS,
  type PointLabelField,
  type PointLabelUnits,
  type PointStringColSep,
  type PointStringLayout,
} from "@/engine/point-labels";

// Points to String — collapse a column of point data into ONE string for a
// Text node's `text` input. Sibling of Points to Text (which emits a
// per-point text_instance for Copy to Points) and Point Labels (which draws
// a label on each point). Same formatter; the new work is the join.
//
// Field enum is the stable points schema plus `attribute` (named channel
// via attr_name, suggestAttrsFrom the points wire) and `custom` (token
// template). Layout is serialization, not typography: comma / lines / grid.

const FIELDS = [
  "position",
  "x",
  "y",
  "index",
  "rotation",
  "scale",
  "group",
  "attribute",
  "custom",
] as const;
type Field = (typeof FIELDS)[number];

const ATTR_NAME_RE = /^[A-Za-z_][\w]*$/;

function formatOpts(
  field: Field,
  params: Record<string, unknown>
): { field: PointLabelField; template: string } {
  if (field === "attribute") {
    const name = ((params.attr_name as string) ?? "").trim();
    const safe = ATTR_NAME_RE.test(name) ? name : "";
    return {
      field: "custom",
      template: safe ? `{attr:${safe}}` : "{attr:_}",
    };
  }
  return {
    field: field as PointLabelField,
    template: (params.template as string) ?? "{x}, {y}",
  };
}

export const pointsToStringNode: NodeDefinition = {
  type: "points-to-string",
  name: "Points to String",
  category: "point",
  subcategory: "modifier",
  searchAliases: [
    "attribute to string",
    "join attributes",
    "points to caption",
  ],
  description:
    "Join a column of point data into one string — Y, X, index, rotation, scale, group, a named attribute, or a custom token template ({x} {y} {i} {attr:name}). Layout is comma-separated, one value per line, or a grid (N columns). Wire the string into a Text node's text. Coordinates read normalized [0,1] or in pixels, with adjustable precision. For a label sitting on each point, use Point Labels; for per-point strings into Copy to Points, use Points to Text.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "points", type: "points", required: true }],
  params: [
    {
      name: "field",
      label: "Data",
      type: "enum",
      options: FIELDS as unknown as string[],
      default: "y",
    },
    {
      name: "attr_name",
      label: "Name",
      type: "string",
      default: "weight",
      placeholder: "attribute name",
      suggestAttrsFrom: "points",
      suggestAttrsRequire: true,
      visibleIf: (p) => p.field === "attribute",
    },
    {
      name: "template",
      label: "Template",
      type: "string",
      default: "{x}, {y}",
      placeholder: "{x}, {y}",
      visibleIf: (p) => p.field === "custom",
    },
    {
      name: "layout",
      label: "Layout",
      type: "enum",
      control: "segmented",
      options: POINT_STRING_LAYOUTS as unknown as string[],
      default: "comma",
    },
    {
      name: "columns",
      label: "Columns",
      type: "scalar",
      min: 1,
      max: 64,
      step: 1,
      default: 4,
      visibleIf: (p) => p.layout === "grid",
    },
    {
      name: "column_sep",
      label: "Column sep",
      type: "enum",
      options: POINT_STRING_COL_SEPS as unknown as string[],
      default: "space",
      visibleIf: (p) => p.layout === "grid",
    },
    {
      name: "units",
      label: "Units",
      type: "enum",
      options: POINT_LABEL_UNITS as unknown as string[],
      default: "normalized",
      visibleIf: (p) =>
        p.field === "position" ||
        p.field === "x" ||
        p.field === "y" ||
        p.field === "custom",
    },
    {
      name: "precision",
      label: "Decimals",
      type: "scalar",
      min: 0,
      max: 6,
      step: 1,
      default: 2,
    },
  ],
  primaryOutput: "string",
  auxOutputs: [],

  fingerprintExtras(params, ctx) {
    return params.units === "pixels" ? `${ctx.width}x${ctx.height}` : "";
  },

  compute({ inputs, params, ctx }) {
    const src = inputs.points;
    if (!src || src.kind !== "points" || src.count === 0) {
      return { primary: { kind: "string", value: "" } };
    }

    const field = ((params.field as Field) ?? "y") as Field;
    const resolved = formatOpts(field, params);
    const strings = formatPointLabels(src, {
      field: resolved.field,
      template: resolved.template,
      units: ((params.units as PointLabelUnits) ?? "normalized"),
      precision: (params.precision as number) ?? 2,
      width: ctx.width,
      height: ctx.height,
    });

    const value = joinPointLabelStrings(
      strings,
      ((params.layout as PointStringLayout) ?? "comma"),
      (params.columns as number) ?? 4,
      ((params.column_sep as PointStringColSep) ?? "space")
    );
    return { primary: { kind: "string", value } };
  },
};
