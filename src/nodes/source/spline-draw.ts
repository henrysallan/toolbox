import { OPACITY_PARAM } from "@/engine/conventions";
import { roundCornersPerAnchor } from "@/engine/spline-math";
import { strokeUnitsParam } from "@/engine/stroke-units";
import type {
  NodeDefinition,
  OutputSocketDef,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import {
  SPLINE_FILL_INPUT,
  SPLINE_TRIM_PARAMS,
  applyTrimParams,
  disposeSplineRasterAux,
  rasterizeSplineAux,
} from "./spline-raster-aux";

// Stored param envelope for the `spline_anchors` param type. Mirrors the
// runtime SplineValue shape but without the `kind` discriminator, since the
// param is always a spline.
export interface SplineParamValue {
  subpaths: SplineSubpath[];
}

const EMPTY_SPLINE: SplineParamValue = {
  subpaths: [{ anchors: [], closed: false }],
};

export const splineDrawNode: NodeDefinition = {
  type: "spline-draw",
  name: "Spline Draw",
  category: "spline",
  subcategory: "generator",
  description:
    "Author a bezier path with the pen tool over the preview canvas. Outputs the spline as data and, when stroke or fill is enabled, as a rasterized image.",
  backend: "webgl2",
  // Optional `fill` image input — when wired (and fill is on) the shape is
  // filled with that image instead of the flat fill color.
  inputs: [SPLINE_FILL_INPUT],
  params: [
    OPACITY_PARAM,
    // Anchor data is mutated by the on-canvas overlay, not the params panel —
    // hidden from the UI but still round-trips through save/load.
    {
      name: "spline",
      // Shown only as the "Path Animation" keyframe row (ParamPanel renders a
      // dedicated row for it) and as the Track Editor track label; the anchor
      // data itself is authored on-canvas, never in the params panel.
      label: "Path Animation",
      type: "spline_anchors",
      default: EMPTY_SPLINE,
      hidden: true,
    },
    ...SPLINE_TRIM_PARAMS,
    {
      name: "stroke_enabled",
      label: "Stroke",
      type: "boolean",
      default: true,
    },
    {
      name: "stroke_thickness",
      label: "Thickness",
      type: "scalar",
      min: 0,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 4,
      visibleIf: (p) => !!p.stroke_enabled,
    },
    // px = absolute pixels (legacy); % = percent of canvas width, so the
    // stroke keeps its look at any resolution (#174). Read by the shared
    // rasterizeSplineAux.
    strokeUnitsParam("stroke_units", (p) => !!p.stroke_enabled),
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
      label: "Fill (closes path)",
      type: "boolean",
      default: false,
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
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "image", type: "image" }],
  // Expose the image aux only when at least one of stroke/fill is on — the
  // socket is pointless otherwise (would always emit transparent pixels).
  resolveAuxOutputs(params): OutputSocketDef[] {
    const hasRaster = !!params.stroke_enabled || !!params.fill_enabled;
    return hasRaster ? [{ name: "image", type: "image" }] : [];
  },

  compute({ inputs, params, ctx, nodeId }) {
    const spline =
      (params.spline as SplineParamValue | null | undefined) ?? EMPTY_SPLINE;
    // Live Corners: resolve per-anchor cornerRadius fillets BEFORE trim, so
    // trim (and everything downstream) operates on the geometry the user
    // sees. Identity (same array reference) when no anchor carries a radius.
    // Spec: 071926_spline-draw-authoring-upgrade.md M1.
    const subpaths = applyTrimParams(
      roundCornersPerAnchor(spline.subpaths),
      params
    );
    const splineOut: SplineValue = {
      kind: "spline",
      subpaths,
    };

    const strokeOn = !!params.stroke_enabled;
    const fillOn = !!params.fill_enabled;
    if (!strokeOn && !fillOn) {
      // No raster requested — emit spline data only.
      return { primary: splineOut };
    }

    const fillImage = inputs.fill?.kind === "image" ? inputs.fill : null;
    const image = rasterizeSplineAux(
      ctx,
      nodeId,
      subpaths,
      params,
      fillImage
    );
    if (!image) return { primary: splineOut };
    return { primary: splineOut, aux: { image } };
  },

  dispose: disposeSplineRasterAux,
};
