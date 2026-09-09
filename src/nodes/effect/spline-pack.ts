import type {
  NodeDefinition,
  RenderContext,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { packSplines } from "@/engine/spline-pack";
import { splineGeomHash } from "@/engine/spline-flatten";
import { resolveStrokePx, strokeUnitsParam } from "@/engine/stroke-units";

// Greedy collision-packing of a dense overlapping spline bundle into
// non-overlapping fragments of mixed constant width. Geometry-only — wire
// into Stroke / Rasterize Spline to draw. Spec: specdocs/090126_spline-pack.md.

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

interface PackState {
  lastSig: string | null;
  pieces: SplineSubpath[];
}

function ensureState(ctx: RenderContext, nodeId: string): PackState {
  const key = `spline-pack:${nodeId}`;
  const existing = ctx.state[key] as PackState | undefined;
  if (existing) return existing;
  const s: PackState = { lastSig: null, pieces: [] };
  ctx.state[key] = s;
  return s;
}

export const splinePackNode: NodeDefinition = {
  type: "spline-pack",
  name: "Spline Pack",
  category: "spline",
  subcategory: "modifier",
  description:
    "Greedy collision-packing of spline fragments so no two overlap. The staggered brickwork, mixed widths, and gaps all emerge from collision-cutting — no dashes, no offset curves. Outputs a spline — wire into Stroke / Rasterize Spline to draw. Stroke recipe: thickness = Max Width (same units), cap: butt, thickness_source: vary, thickness_by: driver, thickness_lo: 0, thickness_hi: 1. Rendered width then equals each piece's packed width. Count reveals pieces in pack order (−1 = all).",
  facts: {
    space: {
      "param:min_width": "pixels",
      "param:max_width": "pixels",
      "param:gap": "pixels",
      "param:min_length": "pixels",
      "param:spacing": "pixels",
    },
    writes: ["attr:group", "attr:driver", "attr:width"],
    gotchas: [
      "min_width/max_width/gap/min_length/spacing default to raw pixels; units=% resolves them against canvas width instead (same convention as Stroke).",
      "Each piece stamps attr:group = source subpath index, attr:driver = width/max_width in 0..1 (for Stroke's thickness_by=driver), and attr:width = its own packed pixel width.",
      "randomize_width off targets every piece at max_width before collision-shrinking, so seed only has an effect when it's on.",
      "A piece shrunk below min_width by collisions, or shorter than min_length after cutting, is discarded rather than kept undersized.",
      "count only reslices the already-packed order (−1 = all); it never triggers a repack, so scrubbing it is instant.",
    ],
  },
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "min_width",
      label: "Min Width",
      type: "scalar",
      min: 0.5,
      max: 500,
      softMax: 60,
      step: 0.5,
      default: 4,
    },
    {
      name: "max_width",
      label: "Max Width",
      type: "scalar",
      min: 0.5,
      max: 500,
      softMax: 60,
      step: 0.5,
      default: 24,
    },
    {
      name: "randomize_width",
      label: "Randomize Width",
      type: "boolean",
      default: true,
    },
    {
      name: "gap",
      label: "Gap",
      type: "scalar",
      min: 0,
      max: 100,
      softMax: 20,
      step: 0.5,
      default: 0,
    },
    {
      name: "min_length",
      label: "Min Length",
      type: "scalar",
      min: 0,
      max: 2000,
      softMax: 300,
      step: 1,
      default: 20,
    },
    {
      name: "spacing",
      label: "Sample spacing",
      type: "scalar",
      min: 0.5,
      max: 20,
      softMax: 8,
      step: 0.5,
      default: 2,
    },
    strokeUnitsParam("units"),
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 9999,
      step: 1,
      default: 0,
    },
    {
      name: "count",
      label: "Count",
      type: "scalar",
      min: -1,
      max: 2000,
      softMax: 300,
      step: 1,
      default: -1,
    },
  ],
  linkedPairs: [{ a: "min_width", b: "max_width" }],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.path;
    if (!src || src.kind !== "spline" || src.subpaths.length === 0) {
      return { primary: EMPTY_SPLINE };
    }

    const units = params.units;
    const W = ctx.width;
    const minWidth = resolveStrokePx(
      (params.min_width as number) ?? 4,
      units,
      W
    );
    const maxWidth = resolveStrokePx(
      (params.max_width as number) ?? 24,
      units,
      W
    );
    const gap = resolveStrokePx((params.gap as number) ?? 0, units, W);
    const minLength = resolveStrokePx(
      (params.min_length as number) ?? 20,
      units,
      W
    );
    const spacing = resolveStrokePx(
      (params.spacing as number) ?? 2,
      units,
      W
    );
    const randomizeWidth = params.randomize_width !== false;
    const seed = Math.floor((params.seed as number) ?? 0);

    const state = ensureState(ctx, nodeId);
    // Count is the reveal filter — excluded so scrubbing it is a slice,
    // never a repack. Canvas size is in the signature: packing is px-space.
    const sig = `${splineGeomHash(src)}|${minWidth}|${maxWidth}|${
      randomizeWidth ? 1 : 0
    }|${gap}|${minLength}|${spacing}|${seed}|${ctx.width}x${ctx.height}`;
    if (sig !== state.lastSig) {
      state.pieces = packSplines(src, {
        minWidth,
        maxWidth,
        randomizeWidth,
        gap,
        minLength,
        spacing,
        seed,
        width: ctx.width,
        height: ctx.height,
      });
      state.lastSig = sig;
    }

    const countRaw = (params.count as number) ?? -1;
    const count = countRaw < 0 ? state.pieces.length : Math.floor(countRaw);
    const pieces =
      count >= state.pieces.length
        ? state.pieces
        : state.pieces.slice(0, Math.max(0, count));
    return { primary: { kind: "spline", subpaths: pieces } };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`spline-pack:${nodeId}`];
  },
};
