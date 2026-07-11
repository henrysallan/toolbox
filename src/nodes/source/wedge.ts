import type { NodeDefinition, WedgeValueItem } from "@/engine/types";

// Wedge — batch-render variation source (Houdini's "wedge" concept; spec
// 071026_wedge-render-batching.md). Emits one scalar per batch iteration:
// wire it into a seed, a Switch index, or any exposed scalar param, and the
// export driver renders the tree once per variation (`ctx.wedgeIndex` set to
// 0..count−1). Outside a batch render — editor preview, live viewer,
// exported apps — `ctx.wedgeIndex` is undefined and the node emits the value
// at its `preview` param instead, so scrubbing Preview auditions variations
// live on the canvas.
//
// Batches are ZIPPED across multiple wedge nodes: the driver iterates
// max(counts) times and each wedge clamps the shared index to its own count,
// so a shorter wedge holds its last value for the remaining iterations.
//
// Cached like any static node — params are fingerprinted normally and the
// only external input, ctx.wedgeIndex, is folded in via fingerprintExtras
// (as the CLAMPED effective index, so out-of-range indices that resolve to
// the same value share a cache entry). Within one variation the node is a
// constant; between variations exactly the downstream branches recompute.

export const WEDGE_TYPE = "wedge";

const MODES = ["values", "range", "random", "index"] as const;
type Mode = (typeof MODES)[number];

const DEFAULT_VALUES: WedgeValueItem[] = [
  { id: "w-1", value: 0 },
  { id: "w-2", value: 1 },
];

export function newWedgeValueId(): string {
  return `w-${Math.random().toString(36).slice(2, 8)}`;
}

function mode(params: Record<string, unknown>): Mode {
  const m = params.mode as Mode;
  return MODES.includes(m) ? m : "values";
}

function valueList(params: Record<string, unknown>): WedgeValueItem[] {
  const v = params.values;
  return Array.isArray(v) ? (v as WedgeValueItem[]) : DEFAULT_VALUES;
}

// triple32 (Wellons) → [0,1). Same frame-independent hash as Point
// Expression's rand(): strong avalanche on sequential integer inputs, which
// is exactly the (seed, index) pattern here — variation i is stable across
// sessions and machines.
function hash01(seed: number): number {
  let x = seed >>> 0;
  x ^= x >>> 17;
  x = Math.imul(x, 0xed5ad4bb);
  x ^= x >>> 11;
  x = Math.imul(x, 0xac4c1b51);
  x ^= x >>> 15;
  x = Math.imul(x, 0x31848bab);
  x ^= x >>> 14;
  return (x >>> 0) / 4294967296;
}

// How many variations this wedge defines. The batch driver takes the max
// across all wedges upstream of the rendered Output; a disabled wedge
// contributes 1 (and always emits its preview value).
export function wedgeIterationCount(params: Record<string, unknown>): number {
  if (params.enabled === false) return 1;
  if (mode(params) === "values") return Math.max(1, valueList(params).length);
  const raw = (params.count as number) ?? 1;
  return Math.max(1, Math.round(raw));
}

// The scalar this wedge emits at batch iteration `index` (already the shared
// zipped index — clamping to this wedge's own count happens here).
export function wedgeScalarAt(
  params: Record<string, unknown>,
  index: number
): number {
  const count = wedgeIterationCount(params);
  const i = Math.max(0, Math.min(count - 1, Math.round(index)));
  switch (mode(params)) {
    case "values": {
      const v = valueList(params)[i]?.value;
      return typeof v === "number" ? v : 0;
    }
    case "range": {
      const start = (params.start as number) ?? 0;
      const step = (params.step as number) ?? 1;
      return start + step * i;
    }
    case "random": {
      const min = (params.min as number) ?? 0;
      const max = (params.max as number) ?? 1;
      const seed = Math.round((params.seed as number) ?? 0);
      // Decorrelate the seed from the sequential index before hashing so
      // adjacent seeds don't produce shifted copies of the same sequence.
      return min + (max - min) * hash01((Math.imul(seed, 0x9e3779b1) ^ i) >>> 0);
    }
    case "index":
      return i;
  }
}

function effectiveIndex(
  params: Record<string, unknown>,
  wedgeIndex: number | undefined
): number {
  const count = wedgeIterationCount(params);
  const raw =
    params.enabled === false
      ? ((params.preview as number) ?? 0)
      : wedgeIndex ?? ((params.preview as number) ?? 0);
  return Math.max(0, Math.min(count - 1, Math.round(raw)));
}

export const wedgeNode: NodeDefinition = {
  type: WEDGE_TYPE,
  name: "Wedge",
  category: "utility",
  description:
    "Batch-render variation source. Defines a set of scalar values (explicit list, range, seeded random, or the bare iteration index) and emits one per render when the export runs a wedge batch — wire it into a seed, a Switch index, or any exposed param. Outside a batch it emits the value at Preview, so scrubbing Preview auditions variations live. Multiple Wedge nodes zip: the batch runs max(counts) iterations and shorter wedges hold their last value.",
  backend: "webgl2",
  // Pure CPU scalar — no image to matte.
  noMaskInput: true,
  inputs: [],
  headerControl: { paramName: "mode" },
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: MODES as unknown as string[],
      default: "values",
    },
    {
      name: "values",
      label: "Values",
      type: "wedge_values",
      default: DEFAULT_VALUES,
      visibleIf: (p) => (p.mode ?? "values") === "values",
    },
    {
      name: "count",
      label: "Count",
      type: "scalar",
      min: 1,
      max: 10000,
      softMax: 50,
      step: 1,
      default: 5,
      visibleIf: (p) => (p.mode ?? "values") !== "values",
    },
    {
      name: "start",
      label: "Start",
      type: "scalar",
      min: -10000,
      max: 10000,
      softMax: 100,
      step: 0.001,
      default: 0,
      visibleIf: (p) => p.mode === "range",
    },
    {
      name: "step",
      label: "Step",
      type: "scalar",
      min: -10000,
      max: 10000,
      softMax: 10,
      step: 0.001,
      default: 1,
      visibleIf: (p) => p.mode === "range",
    },
    {
      name: "min",
      label: "Min",
      type: "scalar",
      min: -10000,
      max: 10000,
      softMax: 1,
      step: 0.001,
      default: 0,
      visibleIf: (p) => p.mode === "random",
    },
    {
      name: "max",
      label: "Max",
      type: "scalar",
      min: -10000,
      max: 10000,
      softMax: 1,
      step: 0.001,
      default: 1,
      visibleIf: (p) => p.mode === "random",
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 10000,
      softMax: 100,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "random",
    },
    {
      name: "preview",
      label: "Preview index",
      type: "scalar",
      min: 0,
      max: 10000,
      softMax: 9,
      step: 1,
      default: 0,
    },
    {
      // Off ⇒ this wedge reports count 1 to the batch driver and always
      // emits the preview value — "render just this variation" without
      // unwiring anything.
      name: "enabled",
      label: "Enabled",
      type: "boolean",
      default: true,
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],
  // The only non-param input is ctx.wedgeIndex; fold the clamped effective
  // index so caches bust exactly when the emitted value can change.
  fingerprintExtras(params, ctx) {
    return `wedge:${effectiveIndex(params, ctx.wedgeIndex)}`;
  },
  compute({ params, ctx }) {
    const i = effectiveIndex(params, ctx.wedgeIndex);
    return { primary: { kind: "scalar", value: wedgeScalarAt(params, i) } };
  },
};
