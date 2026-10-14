import type { NodeDefinition, SkiaDrawValue, SplineValue } from "@/engine/types";
import { bindDerived, bindParam, bindStatic, type PaintIR, type PathEffectIR } from "@/engine/skia/scene-ir";
import { splineToSvgPathD } from "@/engine/svg-serialize";
import { hexToRgba01 } from "@/engine/spline-fill";
import { subpathHasWidthProfile } from "@/engine/spline-width";
import { strokeUnitsParam } from "@/engine/stroke-units";
import { bindScaled, num, unitScale } from "./paint-shared";

// Stroke (Skia) — the Skia-layer mirror of Stroke (spline-stroke): a spline
// stroked as one React Native Skia <Path>, with Stroke's own params — color,
// thickness (px or % of the canvas width), solid / dashed / dotted, cap,
// join, miter limit, close open paths. The path data is the SVG
// serialization Rasterize Spline and Stroke share (buildPath2D's mapping),
// so the outline lands on the same pixels; only the rasterizer differs
// (Skia's AA vs Canvas2D's).
//
//   dashed  a DashPathEffect [length, gap], phase 0 — Canvas2D's
//           setLineDash: the pattern restarts on every subpath, in both.
//   dotted  [0, spacing] with round caps: Skia emits a zero-length segment
//           per dot and the round cap draws it, as Canvas2D does.
//
// Stroke's per-subpath ramps, thickness variation, repeats and per-anchor
// width profiles are not part of this node; a width profile on the input is
// reported (Skia strokes one width).

const STYLES = ["solid", "dashed", "dotted"] as const;

export const skiaStrokeNode: NodeDefinition = {
  type: "skia-stroke",
  name: "Stroke (Skia)",
  category: "spline",
  subcategory: "modifier",
  description:
    "Strokes a spline as a Skia path (React Native Skia <Path style=\"stroke\">) with Stroke's params: color, thickness in px or % of the canvas width, solid / dashed / dotted, cap, join and miter limit. Wire it into Skia Group or Skia Canvas.",
  searchAliases: ["skia", "stroke", "outline", "dash", "dotted", "react native"],
  facts: {
    space: {
      out: "pixels",
      "param:thickness": "pixels",
      "param:dash_length": "pixels",
      "param:dash_gap": "pixels",
      "param:dot_spacing": "pixels",
    },
    gotchas: [
      "thickness, dash_length, dash_gap and dot_spacing are canvas pixels; units=% reads them as a percent of the canvas width, like Stroke.",
      "Dashes restart on every subpath (Skia and Canvas2D agree); dotted forces round caps so each zero-length dash is a dot.",
      "thickness 0 draws nothing (opacity 0): Skia's width 0 would be a hairline.",
      "Stroke's ramp colors, thickness variation, repeats and per-anchor width profiles are not ported; a width profile on the input is reported and stroked at the base width.",
    ],
  },
  backend: "webgl2",
  skia: { class: "native", mirrors: "spline-stroke" },
  noMaskInput: true,
  inputs: [{ name: "path", label: "Path", type: "spline", required: true }],
  params: [
    { name: "color", label: "Color", type: "color", default: "#ffffff", alpha: true },
    { name: "thickness", label: "Thickness", type: "scalar", min: 0, max: 200, softMax: 40, step: 0.5, default: 4 },
    strokeUnitsParam("units", undefined, { governs: ["thickness", "dash_length", "dash_gap", "dot_spacing"] }),
    { name: "style", label: "Style", type: "enum", options: [...STYLES], default: "solid" },
    {
      name: "dash_length",
      label: "Dash length",
      type: "scalar",
      min: 0.5,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 10,
      visibleIf: (p) => p.style === "dashed",
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
      visibleIf: (p) => p.style === "dashed",
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
    {
      name: "cap",
      label: "Cap",
      type: "enum",
      options: ["round", "butt", "square"],
      default: "round",
      visibleIf: (p) => p.style !== "dotted",
    },
    { name: "join", label: "Join", type: "enum", options: ["round", "miter", "bevel"], default: "round" },
    {
      name: "miter_limit",
      label: "Miter limit",
      type: "scalar",
      min: 1,
      max: 20,
      step: 0.1,
      default: 10,
      visibleIf: (p) => p.join === "miter",
    },
    { name: "close_open_paths", label: "Close open paths", type: "boolean", default: false },
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const W = ctx.width;
    const u = unitScale(params.units, W);
    const v = inputs.path;
    const subpaths = v?.kind === "spline" ? (v as SplineValue).subpaths : [];
    const close = params.close_open_paths === true;
    const d = splineToSvgPathD(close ? subpaths.map((s) => (s.closed ? s : { ...s, closed: true })) : subpaths, W, ctx.height);
    const problems: string[] = [];
    if (subpaths.some(subpathHasWidthProfile)) {
      problems.push(`Stroke (Skia) "${nodeId}": the spline carries per-anchor widths (a width profile), which a Skia stroke can't vary — stroked at the base thickness.`);
    }

    const style = STYLES.includes(params.style as (typeof STYLES)[number]) ? (params.style as (typeof STYLES)[number]) : "solid";
    const thickness = Math.max(0, num(params.thickness, 4));
    const scaled = (param: string, value: number) => bindScaled(value, nodeId, param, u);
    const join = params.join === "miter" || params.join === "bevel" ? params.join : "round";
    const cap = style === "dotted" ? "round" : params.cap === "butt" || params.cap === "square" ? params.cap : "round";
    const paint: PaintIR = {
      style: "stroke",
      color: bindParam(hexToRgba01((params.color as string) ?? "#ffffff"), nodeId, "color"),
      strokeWidth: scaled("thickness", thickness * u),
      // Canvas2D skips a zero-width stroke; Skia would draw a hairline.
      opacity: bindDerived(thickness > 0 ? 1 : 0, [{ node: nodeId, param: "thickness" }]),
      strokeCap: cap,
      strokeJoin: join,
      ...(join === "miter" ? { strokeMiter: Math.max(1, num(params.miter_limit, 10)) } : {}),
      antiAlias: true,
    };
    if (style !== "solid") {
      const effect: PathEffectIR =
        style === "dashed"
          ? {
              k: "dash",
              intervals: [
                scaled("dash_length", Math.max(0.5, num(params.dash_length, 10) * u)),
                scaled("dash_gap", Math.max(0.5, num(params.dash_gap, 8) * u)),
              ],
              phase: bindStatic(0),
            }
          : { k: "dash", intervals: [bindStatic(0), scaled("dot_spacing", Math.max(1, num(params.dot_spacing, 12) * u))], phase: bindStatic(0) };
      paint.pathEffects = [effect];
    }
    const out: SkiaDrawValue = {
      kind: "skia_draw",
      node: { k: "shape", id: nodeId, geom: { k: "path", d: bindDerived(d, []) }, paint },
      ...(problems.length ? { problems } : {}),
    };
    return { primary: out };
  },
};
