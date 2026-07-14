import type { NodeDefinition, TextInstanceValue } from "@/engine/types";
import {
  DEFAULT_TEXT_STYLE,
  emptyTextInstance,
  type TextStyle,
} from "@/engine/text-raster";
import {
  formatPointLabels,
  POINT_LABEL_FIELDS,
  POINT_LABEL_UNITS,
  type PointLabelField,
  type PointLabelUnits,
} from "@/engine/point-labels";
import { CURATED_FONTS } from "@/lib/fonts";

// Points to Text — format each point's OWN data (position, index, rotation,
// scale, group) into a string, one per point in point order, and emit a
// `text_instance` (the still-editable strings + a resolved base style). Copy
// to Points' `text` mode with `by index` pairing then places string[i] on
// point[i]. This is the composable primitive; the self-contained Point Labels
// node wraps the same formatter + placement.
//
// The `field` dropdown is the "which data" choice (a points value has a fixed
// schema, so it's a stable enum, not a scrape); `custom` reveals a token
// template ({x} {y} {i} {n} {rot} {rad} {sx} {sy} {g}). Style comes from a
// wired Text node's `instances` output when present; otherwise the local
// font/size/color params. Formatting-only — no GL, so it caches cheaply.
//
// Coupling note (documented): placement pairs by INDEX, so the SAME points must
// feed both this node and Copy to Points, in the same order — a filter/reorder/
// resample between them desyncs labels from dots. Reach for the self-contained
// Point Labels node to avoid that.

export const pointsToTextNode: NodeDefinition = {
  type: "points-to-text",
  name: "Points to Text",
  category: "point",
  subcategory: "modifier",
  description:
    "Format each point's own data into a string — position (x, y), index, rotation, scale, or group — one label per point. Pick a field or write a custom token template ({x} {y} {i} {n} {rot} {rad} {sx} {sy} {g}); coordinates read normalized [0,1] or in pixels, with adjustable precision. Emits a text_instance: wire it into Copy to Points (text mode, 'by index' pairing) to place each label on its point. Style comes from a wired Text node, or the local font/size/color params.",
  backend: "webgl2",
  // Output is a text_instance, not an image — the universal mask/opacity
  // conventions don't apply, so skip the appended mask input.
  noMaskInput: true,
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "style", type: "text_instance", required: false, label: "Style" },
  ],
  params: [
    {
      name: "field",
      label: "Data",
      type: "enum",
      options: POINT_LABEL_FIELDS as unknown as string[],
      default: "position",
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
      name: "units",
      label: "Units",
      type: "enum",
      options: POINT_LABEL_UNITS as unknown as string[],
      default: "normalized",
      // Only affects the {x}/{y} position tokens.
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
    // Local fallback style — used only when no `style` input is wired (a wired
    // Text style overrides these at compute). Shown always; visibleIf can't see
    // socket connections, only params.
    {
      name: "font_family",
      label: "Font",
      type: "enum",
      control: "font",
      options: CURATED_FONTS,
      default: "Inter",
    },
    {
      name: "size",
      label: "Size (px)",
      type: "scalar",
      min: 1,
      max: 512,
      softMax: 128,
      step: 1,
      default: 32,
    },
    {
      name: "color",
      label: "Color",
      type: "color",
      default: "#ffffff",
    },
    {
      name: "alignment",
      label: "Align",
      type: "enum",
      options: ["left", "center", "right"],
      default: "center",
    },
  ],
  primaryOutput: "text_instance",
  auxOutputs: [],

  // Pixel units depend on canvas size, which isn't in the default fingerprint —
  // fold it in so a canvas resize busts the cache. No-op for normalized units.
  fingerprintExtras(params, ctx) {
    return params.units === "pixels" ? `${ctx.width}x${ctx.height}` : "";
  },

  compute({ inputs, params, ctx }) {
    const src = inputs.points;
    if (!src || src.kind !== "points" || src.count === 0) {
      return { primary: emptyTextInstance() };
    }

    // Base style: a wired Text node's style wins; else build from local params.
    const styleIn = inputs.style;
    const base: TextStyle =
      styleIn?.kind === "text_instance"
        ? styleIn.base
        : {
            ...DEFAULT_TEXT_STYLE,
            family: (params.font_family as string) ?? DEFAULT_TEXT_STYLE.family,
            size: (params.size as number) ?? DEFAULT_TEXT_STYLE.size,
            color: (params.color as string) ?? DEFAULT_TEXT_STYLE.color,
            alignment:
              (params.alignment as TextStyle["alignment"]) ?? "center",
          };

    const strings = formatPointLabels(src, {
      field: ((params.field as PointLabelField) ?? "position"),
      template: (params.template as string) ?? "{x}, {y}",
      units: ((params.units as PointLabelUnits) ?? "normalized"),
      precision: (params.precision as number) ?? 2,
      width: ctx.width,
      height: ctx.height,
    });

    const out: TextInstanceValue = { kind: "text_instance", base, strings };
    return { primary: out };
  },
};
