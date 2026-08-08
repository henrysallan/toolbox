import type { NodeDefinition, RenderContext, SplineValue } from "@/engine/types";
import {
  blendIntersections,
  type BlendIntersectionsOptions,
} from "@/engine/spline-blend-intersections";
import { splineGeomHash } from "@/engine/spline-flatten";
import { resolveStrokePx, strokeUnitsParam } from "@/engine/stroke-units";

// Blend a network of strokes into one closed outline: thin stroke bodies
// that pool into webbed blobs wherever strokes cross or pass within the
// blend radius (SDF smooth-union of per-stroke distance fields; the
// classic "blend intersections" ink look). Implicit-field CPU pipeline in
// engine/spline-blend-intersections.ts. Spec:
// specdocs/archive/071926_blend-intersections.md (devlist #49).
//
// Geometry-only, like Spline Merge — wire the output into Rasterize
// Spline to fill (or outline-stroke) it.

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

interface BlendState {
  lastSig: string | null;
  result: SplineValue;
}

function ensureState(ctx: RenderContext, nodeId: string): BlendState {
  const key = `blend-intersections:${nodeId}`;
  const existing = ctx.state[key] as BlendState | undefined;
  if (existing) return existing;
  const s: BlendState = { lastSig: null, result: EMPTY_SPLINE };
  ctx.state[key] = s;
  return s;
}

export const blendIntersectionsNode: NodeDefinition = {
  type: "blend-intersections",
  name: "Blend Intersections",
  category: "spline",
  subcategory: "modifier",
  description:
    "Fuse a network of splines into one closed outline shape: thin stroke bodies that swell into webbed ink-pools wherever strokes cross or come within the Blend radius — including a stroke crossing itself. Width sets the stroke body thickness, Blend the webbing size (0 = plain union of the stroked bodies). Outputs a spline — wire into Rasterize Spline to fill it, or stroke its outline. Combine multiple splines upstream with Collect.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "width",
      label: "Width",
      type: "scalar",
      min: 0.5,
      max: 200,
      softMax: 64,
      step: 0.1,
      default: 6,
    },
    {
      name: "blend",
      label: "Blend",
      type: "scalar",
      min: 0,
      max: 400,
      softMax: 120,
      step: 0.1,
      default: 24,
    },
    strokeUnitsParam("units"),
    {
      // Field samples across the network bbox's larger span — the
      // quality/perf dial. The field covers only the network's bounding
      // box, not the whole canvas.
      name: "resolution",
      label: "Resolution",
      type: "scalar",
      min: 64,
      max: 768,
      softMax: 512,
      step: 1,
      default: 288,
    },
    {
      // Bezier-fit tolerance for the output contour. 0 keeps the raw
      // marching-squares polygons (dense anchors, exact); higher fits
      // fewer, smoother anchors.
      name: "smoothing",
      label: "Smoothing",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.path;
    if (!src || src.kind !== "spline" || src.subpaths.length === 0) {
      return { primary: EMPTY_SPLINE };
    }

    const units = params.units;
    const opts: BlendIntersectionsOptions = {
      widthPx: resolveStrokePx((params.width as number) ?? 6, units, ctx.width),
      blendPx: resolveStrokePx((params.blend as number) ?? 24, units, ctx.width),
      resolution: (params.resolution as number) ?? 288,
      smoothing: (params.smoothing as number) ?? 0.5,
    };

    // The evaluator fingerprint cache covers the steady state; this
    // signature guards against fingerprint churn from stable:false
    // upstreams whose geometry didn't actually change (Spline Merge's
    // pattern). Canvas dims participate — they change px resolve and
    // the UV mapping.
    const state = ensureState(ctx, nodeId);
    const sig = `${splineGeomHash(src)}|${opts.widthPx}|${opts.blendPx}|${
      opts.resolution
    }|${opts.smoothing}|${ctx.width}x${ctx.height}`;
    if (sig !== state.lastSig) {
      state.result = blendIntersections(src, ctx.width, ctx.height, opts);
      state.lastSig = sig;
    }
    return { primary: state.result };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`blend-intersections:${nodeId}`];
  },
};
