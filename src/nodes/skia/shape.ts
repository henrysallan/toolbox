import type { NodeDefinition, SkiaDrawValue, SplineValue } from "@/engine/types";
import { bindDerived, bindParam, type PaintIR } from "@/engine/skia/scene-ir";
import { splineToSvgPathD } from "@/engine/svg-serialize";
import { hexToRgba01 } from "@/engine/spline-fill";

// Skia Shape — a toolbox spline drawn as a React Native Skia <Path>, filled
// or stroked with one paint. The path data is the SVG serialization the SVG
// Export node writes (engine/svg-serialize.ts), so it maps exactly as the
// rasterizer does: canvas01 × canvas px with the aspect-corrected y, all
// subpaths in one path. Filling closes open subpaths with their closing
// cubic, as Rasterize Spline's fill does.
//
// Provenance: the path is DERIVED from whatever produced the spline, and a
// compute cannot see the graph, so its bind carries `deps: []` — the scene
// exporter resolves the producing node (this node's `spline` wire) and
// samples it when it animates.

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export const skiaShapeNode: NodeDefinition = {
  type: "skia-shape",
  name: "Skia Shape",
  category: "utility",
  description:
    "Draws a spline as one Skia path (React Native Skia <Path>), filled or stroked with a color. Wire it into Skia Group or Skia Canvas.",
  searchAliases: ["skia", "path", "shape", "stroke", "fill", "react native"],
  facts: {
    space: { out: "pixels", "param:stroke_width": "pixels" },
    gotchas: [
      "The spline maps to canvas pixels like Rasterize Spline (x × width, aspect-corrected y × height); all subpaths form one path, so fill_rule decides holes.",
      "style=fill closes open subpaths with their closing cubic; style=stroke leaves them open and ignores fill_rule.",
      "stroke_width is in pixels, centered on the path, and does not scale with render resolution.",
    ],
  },
  backend: "webgl2",
  skia: { class: "native", mirrors: "rasterize-spline" },
  noMaskInput: true,
  inputs: [{ name: "spline", label: "Spline", type: "spline", required: true }],
  params: [
    { name: "style", label: "Style", type: "enum", options: ["fill", "stroke"], default: "fill", control: "segmented" },
    { name: "color", label: "Color", type: "color", alpha: true, default: "#ffffff" },
    {
      name: "fill_rule",
      label: "Fill rule",
      type: "enum",
      options: ["evenodd", "nonzero"],
      default: "evenodd",
      visibleIf: (p) => p.style !== "stroke",
    },
    {
      name: "stroke_width",
      label: "Stroke width",
      type: "scalar",
      min: 0,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 4,
      visibleIf: (p) => p.style === "stroke",
    },
    {
      name: "cap",
      label: "Cap",
      type: "enum",
      options: ["butt", "round", "square"],
      default: "round",
      visibleIf: (p) => p.style === "stroke",
    },
    {
      name: "join",
      label: "Join",
      type: "enum",
      options: ["miter", "round", "bevel"],
      default: "round",
      visibleIf: (p) => p.style === "stroke",
    },
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const stroke = params.style === "stroke";
    const v = inputs.spline;
    const subpaths = v?.kind === "spline" ? (v as SplineValue).subpaths : [];
    const d = splineToSvgPathD(
      stroke ? subpaths : subpaths.map((s) => (s.closed ? s : { ...s, closed: true })),
      ctx.width,
      ctx.height
    );
    const paint: PaintIR = {
      style: stroke ? "stroke" : "fill",
      color: bindParam(hexToRgba01((params.color as string) ?? "#ffffff"), nodeId, "color"),
      antiAlias: true,
    };
    if (stroke) {
      paint.strokeWidth = bindParam(Math.max(0, num(params.stroke_width, 4)), nodeId, "stroke_width");
      paint.strokeCap = params.cap === "butt" || params.cap === "square" ? params.cap : "round";
      paint.strokeJoin = params.join === "miter" || params.join === "bevel" ? params.join : "round";
    }
    const out: SkiaDrawValue = {
      kind: "skia_draw",
      node: {
        k: "shape",
        id: nodeId,
        geom: {
          k: "path",
          d: bindDerived(d, []),
          ...(stroke ? {} : { fillType: params.fill_rule === "nonzero" ? ("winding" as const) : ("evenOdd" as const) }),
        },
        paint,
      },
    };
    return { primary: out };
  },
};
