import type { NodeDefinition } from "@/engine/types";
import { bindStatic, type PathEffectIR } from "@/engine/skia/scene-ir";
import { strokeUnitsParam } from "@/engine/stroke-units";
import { bindScaled, copyShape, modifyDrawing, num, toolboxContour, unitScale } from "./paint-shared";

// Dash (Skia) — Stroke's dashed / dotted styles as a modifier over a
// drawing: every STROKED shape gets React Native Skia's DashPathEffect
// (fills pass through — toolbox never dashes a fill). The params are
// Stroke's (dash length / gap, dot spacing, px or % of the canvas width,
// the same 0.5 / 1 px floors) plus `dash_offset`, the dash phase, which
// Stroke doesn't have and Skia does (keyframe it for marching ants).
// Dotted is the [0, spacing] pattern with round caps, as Stroke draws it.
//
// The dash applies after the shape's own path effects (a corner effect
// ahead of it rounds the outline first, then dashes it). Composed effects
// play natively only — CanvasKit composes a dash ahead of another effect
// by pre-dashing the geometry, but not the reverse.

export const skiaDashNode: NodeDefinition = {
  type: "skia-dash",
  name: "Dash (Skia)",
  category: "spline",
  subcategory: "modifier",
  description:
    "Dashes or dots every stroked shape in a Skia drawing (React Native Skia DashPathEffect), with Stroke's dash length / gap and dot spacing in px or % of the canvas width, plus a dash offset.",
  searchAliases: ["skia", "dash", "dashed", "dotted", "dots", "marching ants", "react native"],
  facts: {
    space: {
      "param:dash_length": "pixels",
      "param:dash_gap": "pixels",
      "param:dot_spacing": "pixels",
      "param:dash_offset": "pixels",
    },
    gotchas: [
      "Applies to stroked shapes only; filled shapes pass through untouched.",
      "dotted sets round caps on the shapes it dashes (each dot is a zero-length dash's cap), so dot size = stroke width.",
      "The pattern restarts on every contour, like Stroke's dashes; dash_offset shifts it along each contour.",
      "Circles and ovals are redrawn as toolbox's circle (starting at the top), so the pattern starts where Circle → Stroke's does.",
      "Lengths are canvas pixels; units=% reads them as a percent of the canvas width.",
    ],
  },
  backend: "webgl2",
  skia: { class: "native", mirrors: "spline-stroke" },
  noMaskInput: true,
  inputs: [{ name: "drawing", label: "Drawing", type: "skia_draw", required: true }],
  params: [
    { name: "style", label: "Style", type: "enum", options: ["dashed", "dotted"], default: "dashed", control: "segmented" },
    {
      name: "dash_length",
      label: "Dash length",
      type: "scalar",
      min: 0.5,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 10,
      visibleIf: (p) => p.style !== "dotted",
    },
    {
      name: "dash_gap",
      label: "Dash gap",
      type: "scalar",
      min: 0.5,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 8,
      visibleIf: (p) => p.style !== "dotted",
    },
    {
      name: "dot_spacing",
      label: "Dot spacing",
      type: "scalar",
      min: 1,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 12,
      visibleIf: (p) => p.style === "dotted",
    },
    { name: "dash_offset", label: "Offset", type: "scalar", min: -400, max: 400, softMax: 100, step: 0.5, default: 0 },
    strokeUnitsParam("units", undefined, { governs: ["dash_length", "dash_gap", "dot_spacing", "dash_offset"] }),
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const u = unitScale(params.units, ctx.width);
    const dotted = params.style === "dotted";
    const s = (param: string, value: number) => bindScaled(value, nodeId, param, u);
    const effect: PathEffectIR = {
      k: "dash",
      intervals: dotted
        ? [bindStatic(0), s("dot_spacing", Math.max(1, num(params.dot_spacing, 12) * u))]
        : [s("dash_length", Math.max(0.5, num(params.dash_length, 10) * u)), s("dash_gap", Math.max(0.5, num(params.dash_gap, 8) * u))],
      phase: s("dash_offset", num(params.dash_offset, 0) * u),
    };
    const out = modifyDrawing(inputs.drawing, nodeId, (shape) => {
      if (shape.paint.style !== "stroke") return shape;
      const c = copyShape(toolboxContour(shape));
      c.paint.pathEffects = [...(c.paint.pathEffects ?? []), effect];
      if (dotted) c.paint.strokeCap = "round";
      return c;
    });
    return { primary: out };
  },
};
