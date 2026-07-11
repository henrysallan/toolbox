import { OPACITY_PARAM } from "@/engine/conventions";
import type {
  NodeDefinition,
  OutputSocketDef,
  RenderContext,
  SplineValue,
} from "@/engine/types";
import {
  clipSplineByRegion,
  splineBoolean,
  type SplineBooleanOp,
} from "@/engine/spline-boolean";
import {
  SPLINE_FILL_INPUT,
  disposeSplineRasterAux,
  rasterizeSplineAux,
} from "@/nodes/source/spline-raster-aux";

// Boolean combination of two splines. Defaults to Subtract (A − B) on the
// FILLED REGIONS: the area inside A but outside B — i.e. B cuts a hole in
// A. Also unions, intersects, and excludes (XOR). The result there is a
// (polygonal) spline.
//
// For subtract/intersect, `treat_a` flips A's interpretation to a LINE:
// A's curves are cut where they cross B's region and only the pieces
// outside (subtract → gaps in the stroke) or inside (intersect → the
// overlapping arcs) survive — see clipSplineByRegion. Line output keeps
// A's true bezier geometry (no polygonalization) and closed loops become
// open arcs, so it feeds Stroke / Trim Path cleanly. Fill still rasterizes
// open pieces by auto-closing them (same as Spline Draw) — usually you
// want stroke-only in line mode.
//
// An optional rasterized image is exposed exactly like the spline
// primitives (Spline Draw / SVG Source) when stroke or fill is enabled —
// including the optional `fill` image input.

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

// Cache for the (expensive) boolean clip, keyed by its inputs — the raster
// itself is handled by the shared rasterizeSplineAux (own ctx.state entry).
interface BoolState {
  lastBoolSig: string | null;
  result: SplineValue;
}

function ensureState(ctx: RenderContext, nodeId: string): BoolState {
  const key = `spline-boolean:${nodeId}`;
  const existing = ctx.state[key] as BoolState | undefined;
  if (existing) return existing;
  const s: BoolState = { lastBoolSig: null, result: EMPTY_SPLINE };
  ctx.state[key] = s;
  return s;
}

export const splineBooleanNode: NodeDefinition = {
  type: "spline-boolean",
  name: "Spline Boolean",
  category: "spline",
  subcategory: "modifier",
  description:
    "Boolean of two splines. Subtract (A − B) cuts B out of A's filled region; also union, intersect, and exclude (XOR). For subtract/intersect, 'Treat A as line' cuts A's curves instead — gaps where B covers them (subtract) or only the covered arcs (intersect), keeping true bezier geometry. Outputs a spline, plus an image when stroke or fill is on.",
  backend: "webgl2",
  inputs: [
    { name: "a", type: "spline", required: true, label: "A (base)" },
    // Optional — with B unwired, A passes through unchanged.
    { name: "b", type: "spline", required: false, label: "B (cut)" },
    // Optional fill image — fills the boolean result with that image when
    // wired (and fill is on), same as the spline primitives.
    SPLINE_FILL_INPUT,
  ],
  params: [
    OPACITY_PARAM,
    {
      name: "operation",
      label: "Operation",
      type: "enum",
      options: ["subtract", "union", "intersect", "exclude"],
      default: "subtract",
    },
    // Line mode — only meaningful when B carves A directionally. Default
    // "shape" preserves the pre-param behavior for old saves (invariant #2).
    {
      name: "treat_a",
      label: "Treat A as",
      type: "enum",
      options: ["shape", "line"],
      control: "segmented",
      default: "shape",
      visibleIf: (p) => {
        const op = (p.operation as string) ?? "subtract";
        return op === "subtract" || op === "intersect";
      },
    },
    {
      // Line segments per curve when flattening for the boolean.
      // Higher is smoother but heavier.
      name: "resolution",
      label: "Curve resolution",
      type: "scalar",
      min: 3,
      max: 96,
      softMax: 48,
      step: 1,
      default: 24,
    },
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
      default: 4,
      visibleIf: (p) => !!p.stroke_enabled,
    },
    {
      name: "stroke_color",
      label: "Stroke color",
      type: "color",
      default: "#ffffff",
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
  // Image aux only when something would actually be drawn.
  resolveAuxOutputs(params): OutputSocketDef[] {
    const hasRaster = !!params.stroke_enabled || !!params.fill_enabled;
    return hasRaster ? [{ name: "image", type: "image" }] : [];
  },

  compute({ inputs, params, ctx, nodeId }) {
    const a = inputs.a;
    const b = inputs.b;
    const aSpline: SplineValue =
      a && a.kind === "spline" ? a : EMPTY_SPLINE;
    const bSpline: SplineValue =
      b && b.kind === "spline" ? b : EMPTY_SPLINE;

    const op = ((params.operation as string) ?? "subtract") as SplineBooleanOp;
    const lineMode =
      ((params.treat_a as string) ?? "shape") === "line" &&
      (op === "subtract" || op === "intersect");
    const steps = Math.max(
      3,
      Math.round((params.resolution as number) ?? 24)
    );

    const state = ensureState(ctx, nodeId);

    // Recompute the boolean only when geometry / op / mode / resolution change.
    const boolSig = JSON.stringify({
      a: aSpline.subpaths,
      b: bSpline.subpaths,
      op,
      lineMode,
      steps,
    });
    if (boolSig !== state.lastBoolSig) {
      state.result = lineMode
        ? clipSplineByRegion(
            aSpline,
            bSpline,
            op === "subtract" ? "outside" : "inside",
            steps
          )
        : splineBoolean(aSpline, bSpline, op, steps);
      state.lastBoolSig = boolSig;
    }
    const resultSpline = state.result;

    const strokeOn = !!params.stroke_enabled;
    const fillOn = !!params.fill_enabled;
    if (!strokeOn && !fillOn) {
      return { primary: resultSpline };
    }

    // Shared rasterizer — same stroke/fill (+ optional `fill` image) the
    // spline primitives use. Boolean results carry holes as separate rings,
    // which the shared even-odd fill handles.
    const fillImage = inputs.fill?.kind === "image" ? inputs.fill : null;
    const image = rasterizeSplineAux(
      ctx,
      nodeId,
      resultSpline.subpaths,
      params,
      fillImage
    );
    if (!image) return { primary: resultSpline };
    return { primary: resultSpline, aux: { image } };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`spline-boolean:${nodeId}`];
    disposeSplineRasterAux(ctx, nodeId);
  },
};
