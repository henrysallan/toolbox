import type {
  NodeDefinition,
  RenderContext,
  SplineValue,
} from "@/engine/types";
import {
  splineSelfMerge,
  type SplineMergeOp,
} from "@/engine/spline-boolean";

// Self-combine every subpath of a SINGLE spline into merged region(s).
//
// The headline use is `union`: overlapping copies (e.g. from Copy to Points)
// collapse into one silhouette, so a downstream Rasterize Spline draws a single
// clean outer stroke with no interior seams. `intersect` keeps the region
// common to all subpaths; `exclude` is the even-odd XOR the rest of the app
// fills splines with (nested subpaths punch holes).
//
// Geometry-only (no fill/stroke here) — wire the output spline into Rasterize
// Spline to draw it. Pure CPU math via polygon-clipping; the actual union lives
// in engine/spline-boolean.ts alongside the two-input Spline Boolean.

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

interface MergeState {
  lastSig: string | null;
  result: SplineValue;
}

function ensureState(ctx: RenderContext, nodeId: string): MergeState {
  const key = `spline-merge:${nodeId}`;
  const existing = ctx.state[key] as MergeState | undefined;
  if (existing) return existing;
  const s: MergeState = { lastSig: null, result: EMPTY_SPLINE };
  ctx.state[key] = s;
  return s;
}

export const splineMergeNode: NodeDefinition = {
  type: "spline-merge",
  name: "Spline Merge",
  category: "spline",
  subcategory: "modifier",
  description:
    "Merge all subpaths of one spline into combined region(s). Union collapses overlapping shapes into a single silhouette (one clean outer stroke when rasterized); also intersect and exclude (even-odd XOR). Outputs a spline — wire into Rasterize Spline to draw. Note: union treats each subpath as solid, so holes inside a single shape fill in.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "operation",
      label: "Operation",
      type: "enum",
      options: ["union", "intersect", "exclude"],
      default: "union",
    },
    {
      // Line segments per curve when flattening for the boolean — higher is
      // smoother but heavier. Matches Spline Boolean's control.
      name: "resolution",
      label: "Curve resolution",
      type: "scalar",
      min: 3,
      max: 96,
      softMax: 48,
      step: 1,
      default: 24,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.path;
    if (!src || src.kind !== "spline" || src.subpaths.length === 0) {
      return { primary: EMPTY_SPLINE };
    }

    const op = ((params.operation as string) ?? "union") as SplineMergeOp;
    const steps = Math.max(3, Math.round((params.resolution as number) ?? 24));

    const state = ensureState(ctx, nodeId);
    // Recompute the (expensive) merge only when geometry / op / resolution
    // change.
    const sig = JSON.stringify({ p: src.subpaths, op, steps });
    if (sig !== state.lastSig) {
      state.result = splineSelfMerge(src, op, steps);
      state.lastSig = sig;
    }
    return { primary: state.result };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`spline-merge:${nodeId}`];
  },
};
