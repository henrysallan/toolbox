import type {
  NodeDefinition,
  RenderContext,
  SplineValue,
} from "@/engine/types";
import {
  splineSelfMerge,
  type SplineMergeOp,
} from "@/engine/spline-boolean";
import { runSplineFlow, disposeFlowState } from "@/engine/spline-flow";

// Self-combine every subpath of a SINGLE spline into merged region(s).
//
// The headline use is `union`: overlapping copies (e.g. from Copy to Points)
// collapse into one silhouette, so a downstream Rasterize Spline draws a single
// clean outer stroke with no interior seams. `intersect` keeps the region
// common to all subpaths; `exclude` is the even-odd XOR the rest of the app
// fills splines with (nested subpaths punch holes).
//
// Two engines, one node:
//   - EXACT (default): discrete CPU polygon-clipping — the precise boolean,
//     recomputed only when geometry/op/resolution change. Lives in
//     engine/spline-boolean.ts.
//   - FLOW (the `flow` toggle): a "liquid" union — a persistent scalar field
//     relaxes toward the target silhouette over time, so shapes bridge and
//     snap together and separating necks stretch and pinch off instead of
//     popping. Ping-pong fragment sim in engine/spline-flow.ts. Spec:
//     specdocs/archive/071226_spline-merge-flow.md (devlist #177).
//
// Geometry-only (no fill/stroke here) — wire the output spline into Rasterize
// Spline to draw it.

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

// Flow Speed is a friendly 0..1 dial, but the sim consumes a much smaller
// value — even the old raw 0.001 read fast. So the dial maps its full travel
// onto [0, FLOW_SPEED_SCALE]: slider 1.0 → 0.001 actual, putting the usable
// slow range across the whole slider instead of bunched at the bottom.
const FLOW_SPEED_SCALE = 0.001;
const FLOW_SPEED_DEFAULT = 0.3;

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
    "Merge all subpaths of one spline into combined region(s). Union collapses overlapping shapes into a single silhouette (one clean outer stroke when rasterized); also intersect and exclude (even-odd XOR). Flow turns the merge into a liquid simulation — the silhouette flows toward the new shape, bridging and snapping as parts meet and stretching before it pinches off as they part. Outputs a spline — wire into Rasterize Spline to draw. Note: union treats each subpath as solid, so holes inside a single shape fill in.",
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
      // smoother but heavier. Matches Spline Boolean's control. Exact mode
      // only (Flow rasterizes true beziers, no flattening).
      name: "resolution",
      label: "Curve resolution",
      type: "scalar",
      min: 3,
      max: 96,
      softMax: 48,
      step: 1,
      default: 24,
      visibleIf: (p) => !p.flow,
    },
    {
      name: "flow",
      label: "Flow",
      type: "boolean",
      default: true,
    },
    {
      // 0..1 dial; scaled by FLOW_SPEED_SCALE into the sim's actual speed.
      name: "flow_speed",
      label: "Flow Speed",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: FLOW_SPEED_DEFAULT,
      visibleIf: (p) => !!p.flow,
    },
    {
      name: "tension",
      label: "Surface Tension",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.35,
      visibleIf: (p) => !!p.flow,
    },
    {
      name: "adhesion",
      label: "Adhesion",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => !!p.flow,
    },
    {
      name: "blend",
      label: "Blend",
      type: "scalar",
      min: 0,
      max: 0.25,
      softMax: 0.15,
      step: 0.001,
      default: 0.06,
      visibleIf: (p) => !!p.flow,
    },
    {
      name: "detail",
      label: "Detail",
      type: "scalar",
      min: 128,
      max: 768,
      softMax: 512,
      step: 1,
      default: 320,
      visibleIf: (p) => !!p.flow,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  // Flow is a live simulation — bust the cache every tick so it advances.
  // Exact mode returns "" and keeps full fingerprint caching.
  fingerprintExtras(params, ctx) {
    return params.flow ? `flow:${ctx.tick}` : "";
  },

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.path;
    if (!src || src.kind !== "spline" || src.subpaths.length === 0) {
      return { primary: EMPTY_SPLINE };
    }

    const op = ((params.operation as string) ?? "union") as SplineMergeOp;

    if (params.flow) {
      const result = runSplineFlow(ctx, nodeId, src, {
        operation: op,
        speed:
          ((params.flow_speed as number) ?? FLOW_SPEED_DEFAULT) *
          FLOW_SPEED_SCALE,
        tension: (params.tension as number) ?? 0.35,
        adhesion: (params.adhesion as number) ?? 0.5,
        blend: (params.blend as number) ?? 0.06,
        detail: (params.detail as number) ?? 320,
      });
      return { primary: result };
    }

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
    disposeFlowState(ctx, nodeId);
  },
};
