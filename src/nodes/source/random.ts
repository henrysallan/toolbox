import type { NodeDefinition, RenderContext } from "@/engine/types";

// Pseudo-random scalar / vec2 generator.
//
// Mode `seeded` is deterministic — the value is a hash of (seed, frame
// index) so the same seed + frame always produces the same number.
// Marked stable:false so the evaluator re-fingerprints each frame and
// downstream sees the new value, even when seed didn't change.
//
// Mode `frame` re-rolls Math.random() each evaluation. The output is
// not reproducible across runs — useful for "just give me noise" but
// don't use it for things that need to look the same on replay.
//
// Distribution `uniform` returns values in [lo, hi]. Distribution
// `gauss` returns Box-Muller normals scaled by `(hi-lo)/2` and centered
// at `(lo+hi)/2`, so ~99.7% of samples fall within [lo, hi] (3σ).

interface RandomState {
  // Cache the last frame we sampled at and the value we returned, so
  // re-evaluations within the same frame stay consistent (e.g. when
  // multiple downstream nodes pull from us inside one tick).
  lastFrame?: number;
  lastSeed?: number;
  cachedX?: number;
  cachedY?: number;
}

function ensureState(ctx: RenderContext, nodeId: string): RandomState {
  const key = `random:${nodeId}`;
  let s = ctx.state[key] as RandomState | undefined;
  if (!s) {
    s = {};
    ctx.state[key] = s;
  }
  return s;
}

// Mulberry32-style integer hash — fast, decent distribution for
// per-frame noise where we don't need crypto-grade randomness.
function hash01(seed: number, frame: number, salt: number): number {
  let h = (seed | 0) ^ Math.imul(frame | 0, 0x27d4eb2d) ^ Math.imul(salt | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  // Map unsigned 32-bit hash → [0, 1).
  return (h >>> 0) / 4294967296;
}

function gaussFromUnit(u1: number, u2: number): number {
  // Box-Muller. Guard u1 from 0 so log() doesn't blow up.
  const safe = Math.max(u1, 1e-9);
  return Math.sqrt(-2 * Math.log(safe)) * Math.cos(2 * Math.PI * u2);
}

const MODES = ["seeded", "frame"] as const;
type Mode = (typeof MODES)[number];

const SHAPES = ["scalar", "vec2"] as const;
type Shape = (typeof SHAPES)[number];

const DISTRIBUTIONS = ["uniform", "gauss"] as const;
type Distribution = (typeof DISTRIBUTIONS)[number];

export const randomNode: NodeDefinition = {
  type: "random",
  name: "Random",
  category: "utility",
  description:
    "Random scalar or vec2. Seeded mode is deterministic per frame; Frame mode re-rolls each eval. Uniform draws from [Lo, Hi]; Gauss returns normals centered on (Lo+Hi)/2 with ±3σ ≈ Hi-Lo.",
  backend: "webgl2",
  stable: false,
  inputs: [],
  params: [
    {
      name: "shape",
      label: "Shape",
      type: "enum",
      options: SHAPES as unknown as string[],
      default: "scalar",
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: MODES as unknown as string[],
      default: "seeded",
    },
    {
      name: "distribution",
      label: "Distribution",
      type: "enum",
      options: DISTRIBUTIONS as unknown as string[],
      default: "uniform",
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 100000,
      step: 1,
      default: 42,
      visibleIf: (p) => p.mode === "seeded",
    },
    {
      name: "lo",
      label: "Lo",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "hi",
      label: "Hi",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 1,
      step: 0.001,
      default: 1,
    },
  ],
  primaryOutput: "scalar",
  resolvePrimaryOutput(params) {
    return (params.shape as string) === "vec2" ? "vec2" : "scalar";
  },
  auxOutputs: [],

  compute({ params, ctx, nodeId }) {
    const shape = ((params.shape as string) ?? "scalar") as Shape;
    const mode = ((params.mode as string) ?? "seeded") as Mode;
    const dist = ((params.distribution as string) ??
      "uniform") as Distribution;
    const lo = (params.lo as number) ?? 0;
    const hi = (params.hi as number) ?? 1;
    const seed = (params.seed as number) ?? 0;
    const state = ensureState(ctx, nodeId);

    let rx: number;
    let ry: number;

    // For seeded mode, reuse the cached value if frame + seed haven't
    // changed — multiple downstream pulls within one tick should agree.
    if (
      mode === "seeded" &&
      state.lastFrame === ctx.frame &&
      state.lastSeed === seed &&
      state.cachedX !== undefined
    ) {
      rx = state.cachedX;
      ry = state.cachedY ?? rx;
    } else {
      const u1 =
        mode === "seeded" ? hash01(seed, ctx.frame, 1) : Math.random();
      const u2 =
        mode === "seeded" ? hash01(seed, ctx.frame, 2) : Math.random();

      if (dist === "gauss") {
        // ±3σ window mapped to [lo, hi] keeps ~99.7% of samples in range.
        const center = (lo + hi) / 2;
        const halfRange = (hi - lo) / 2;
        const sigma = halfRange / 3;
        rx = center + gaussFromUnit(u1, u2) * sigma;
        const u3 =
          mode === "seeded" ? hash01(seed, ctx.frame, 3) : Math.random();
        const u4 =
          mode === "seeded" ? hash01(seed, ctx.frame, 4) : Math.random();
        ry = center + gaussFromUnit(u3, u4) * sigma;
      } else {
        rx = lo + u1 * (hi - lo);
        ry = lo + u2 * (hi - lo);
      }

      if (mode === "seeded") {
        state.lastFrame = ctx.frame;
        state.lastSeed = seed;
        state.cachedX = rx;
        state.cachedY = ry;
      }
    }

    if (shape === "vec2") {
      return { primary: { kind: "vec2", value: [rx, ry] } };
    }
    return { primary: { kind: "scalar", value: rx } };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`random:${nodeId}`];
  },
};
