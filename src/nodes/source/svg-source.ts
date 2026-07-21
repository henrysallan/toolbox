import { OPACITY_PARAM } from "@/engine/conventions";
import type {
  NodeDefinition,
  OutputSocketDef,
  SplineValue,
  SvgFileParamValue,
} from "@/engine/types";
import { transformSpline } from "@/engine/spline-transform";
import {
  SPLINE_FILL_INPUT,
  disposeSplineRasterAux,
  rasterizeSplineAux,
} from "./spline-raster-aux";

// SVG source. The file param holds a pre-parsed payload (see lib/svg-parse)
// in [0,1]² Y-DOWN space. Compute applies the built-in transform (same
// param shape the Text and Transform nodes use, same on-canvas gizmo) and
// optionally rasterizes to an image if stroke or fill is on. The shared
// spline rasterizer also gives it an optional `fill` image input.

export const svgSourceNode: NodeDefinition = {
  type: "svg-source",
  name: "SVG Source",
  category: "spline",
  subcategory: "generator",
  description:
    "Load an SVG file and emit it as spline data. Built-in translate/scale/rotate operate on the result; stroke and fill rasterize to an image.",
  backend: "webgl2",
  supportsTransformGizmo: true,
  // Optional `fill` image input — fills the shape with that image when wired.
  inputs: [SPLINE_FILL_INPUT],
  params: [
    OPACITY_PARAM,
    { name: "file", label: "SVG", type: "svg_file", default: null },
    {
      name: "stroke_enabled",
      label: "Stroke",
      type: "boolean",
      default: false,
    },
    {
      name: "stroke_thickness",
      label: "Thickness (px)",
      type: "scalar",
      min: 0,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 2,
      visibleIf: (p) => !!p.stroke_enabled,
    },
    // alpha: rendered by the shared rasterizeSplineAux, whose paths are
    // 8-digit-safe (see SPLINE_RASTER_PARAMS in spline-raster-aux.ts).
    {
      name: "stroke_color",
      label: "Stroke color",
      type: "color",
      default: "#ffffff",
      alpha: true,
      visibleIf: (p) => !!p.stroke_enabled,
    },
    {
      name: "fill_enabled",
      label: "Fill",
      type: "boolean",
      default: true,
    },
    {
      name: "fill_color",
      label: "Fill color",
      type: "color",
      default: "#ffffff",
      alpha: true,
      visibleIf: (p) => !!p.fill_enabled,
    },
    {
      name: "fill_fit",
      label: "Fill fit",
      type: "enum",
      options: ["window", "contain", "cover"],
      default: "window",
      visibleIf: (p) => !!p.fill_enabled,
    },

    // Transform block. Same names the Text and Transform nodes use so the
    // shared gizmo knows how to drive them.
    {
      name: "translateX",
      label: "Translate X",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.001,
      default: 0,
    },
    {
      name: "translateY",
      label: "Translate Y",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.001,
      default: 0,
    },
    {
      name: "scaleX",
      label: "Scale X",
      type: "scalar",
      min: -5,
      max: 5,
      softMax: 3,
      step: 0.001,
      default: 1,
    },
    {
      name: "scaleY",
      label: "Scale Y",
      type: "scalar",
      min: -5,
      max: 5,
      softMax: 3,
      step: 0.001,
      default: 1,
    },
    {
      name: "rotate",
      label: "Rotate (deg)",
      type: "scalar",
      min: -360,
      max: 360,
      step: 0.1,
      default: 0,
    },
    {
      name: "pivotX",
      label: "Pivot X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "pivotY",
      label: "Pivot Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "image", type: "image" }],
  resolveAuxOutputs(params): OutputSocketDef[] {
    const hasRaster = !!params.stroke_enabled || !!params.fill_enabled;
    return hasRaster ? [{ name: "image", type: "image" }] : [];
  },

  compute({ inputs, params, ctx, nodeId }) {
    const file = params.file as SvgFileParamValue | null | undefined;
    const raw: SplineValue = {
      kind: "spline",
      subpaths: file?.subpaths ?? [],
    };
    const transformed = transformSpline(raw, {
      translateX: (params.translateX as number) ?? 0,
      translateY: (params.translateY as number) ?? 0,
      scaleX: (params.scaleX as number) ?? 1,
      scaleY: (params.scaleY as number) ?? 1,
      rotateDeg: (params.rotate as number) ?? 0,
      pivotX: (params.pivotX as number) ?? 0.5,
      pivotY: (params.pivotY as number) ?? 0.5,
    });

    const strokeOn = !!params.stroke_enabled;
    const fillOn = !!params.fill_enabled;
    if (!strokeOn && !fillOn) {
      return { primary: transformed };
    }

    const fillImage = inputs.fill?.kind === "image" ? inputs.fill : null;
    const image = rasterizeSplineAux(
      ctx,
      nodeId,
      transformed.subpaths,
      params,
      fillImage
    );
    if (!image) return { primary: transformed };
    return { primary: transformed, aux: { image } };
  },

  dispose: disposeSplineRasterAux,
};
