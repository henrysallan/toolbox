import type {
  NodeDefinition,
  RenderContext,
  SplineValue,
} from "@/engine/types";
import {
  outlineSpline,
  type OutlineCap,
  type OutlineJoin,
} from "@/engine/spline-outline";
import { resolveStrokePx, strokeUnitsParam } from "@/engine/stroke-units";

// Give a spline a uniform thickness and output the silhouette of the
// result as a spline — the geometry Rasterize Stroke would paint, kept as
// vectors so it can still be offset, booleaned, or rasterized later.
// Overlaps between and within subpaths collapse into one clean boundary;
// closed subpaths keep their hole. Engine: engine/spline-outline.ts.
//
// Params mirror Rasterize Stroke's thickness / units / cap / join so a
// stroke can be swapped for an Outline → Rasterize (fill) pair with the
// same numbers.

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

// The sweep + union is CPU polygon-clipping; cache the result and only
// recompute when geometry, params, or the canvas size change.
interface OutlineState {
  lastSig: string | null;
  result: SplineValue;
}

function ensureState(ctx: RenderContext, nodeId: string): OutlineState {
  const key = `spline-outline:${nodeId}`;
  const existing = ctx.state[key] as OutlineState | undefined;
  if (existing) return existing;
  const s: OutlineState = { lastSig: null, result: EMPTY_SPLINE };
  ctx.state[key] = s;
  return s;
}

export const outlineNode: NodeDefinition = {
  type: "spline-outline",
  name: "Outline",
  category: "spline",
  subcategory: "modifier",
  description:
    "Sweep a spline with a uniform thickness and output the silhouette as a closed spline — the shape Rasterize Stroke would paint, kept as geometry. Overlapping strokes merge into one outline; closed paths keep their hole. Cap and join match Rasterize Stroke, so wire the result into Rasterize Spline with Fill on to draw it.",
  facts: {
    space: { "param:thickness": "pixels" },
    reads: ["attr:width"],
    gotchas: [
      "Output is polygonal (flattened curves): resolution sets line segments per curved bezier segment; straight constant-width segments stay one quad.",
      "Each anchor's width multiplier scales the local thickness (smoothstep between anchors), so a tapered stroke outlines to its taper, like Rasterize Stroke.",
      "Everything unions: crossings, self-overlaps and tight corners resolve to one boundary, but closed subpaths keep their interior hole (a circle becomes a ring).",
      "thickness is canvas px at render resolution unless units=%, which is percent of canvas width — the same toggle as Rasterize Stroke.",
      "miter_limit only applies when join=miter and uses the canvas rule (tip distance / half-width); sharper corners fall back to a bevel.",
      "Fill the output with Rasterize Spline (even-odd) — its rings already carry the holes; stroking it draws both edges of the original stroke.",
    ],
  },
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "thickness",
      label: "Thickness",
      type: "scalar",
      min: 0,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 4,
    },
    strokeUnitsParam("units", undefined, { governs: ["thickness"] }),
    {
      name: "cap",
      label: "Cap",
      type: "enum",
      options: ["round", "butt", "square"],
      default: "round",
      control: "segmented",
    },
    {
      name: "join",
      label: "Join",
      type: "enum",
      options: ["round", "miter", "bevel"],
      default: "round",
      control: "segmented",
    },
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
    {
      // Line segments per curved bezier segment when flattening — higher is
      // smoother but heavier. Same control as Spline Boolean / Spline Merge.
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
    if (!src || src.kind !== "spline") return { primary: EMPTY_SPLINE };

    const W = Math.max(1, ctx.width);
    const H = Math.max(1, ctx.height);
    const thicknessPx = resolveStrokePx(
      (params.thickness as number) ?? 4,
      params.units,
      W
    );
    const cap = ((params.cap as string) ?? "round") as OutlineCap;
    const join = ((params.join as string) ?? "round") as OutlineJoin;
    const miterLimit = (params.miter_limit as number) ?? 10;
    const steps = Math.max(3, Math.round((params.resolution as number) ?? 24));

    const state = ensureState(ctx, nodeId);
    const sig = JSON.stringify({
      s: src.subpaths,
      thicknessPx,
      cap,
      join,
      miterLimit,
      steps,
      W,
      H,
    });
    if (sig !== state.lastSig) {
      state.result = outlineSpline(src, W, H, {
        thicknessPx,
        cap,
        join,
        miterLimit,
        steps,
      });
      state.lastSig = sig;
    }
    return { primary: state.result };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`spline-outline:${nodeId}`];
  },
};
