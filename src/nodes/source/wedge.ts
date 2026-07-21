import type {
  NodeDefinition,
  SocketType,
  SocketValue,
  WedgeValueItem,
} from "@/engine/types";

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

// Value type of the wedge. Non-scalar types are always explicit value lists
// (range/random/index only make sense for numbers); the output socket
// retypes to match (`resolvePrimaryOutput`).
const TYPES = ["scalar", "color", "vec2", "string"] as const;
type WedgeType = (typeof TYPES)[number];

const SOCKET_OF: Record<WedgeType, SocketType> = {
  scalar: "scalar",
  color: "vec4",
  vec2: "vec2",
  string: "string",
};

const DEFAULT_VALUES: WedgeValueItem[] = [
  { id: "w-1", value: 0 },
  { id: "w-2", value: 1 },
];

// Fresh row value when the user adds a row (or a stored row has the wrong
// shape for the current type).
export const WEDGE_TYPE_DEFAULTS: Record<
  WedgeType,
  WedgeValueItem["value"]
> = {
  scalar: 0,
  color: "#ffffff",
  vec2: [0, 0],
  string: "",
};

export function newWedgeValueId(): string {
  return `w-${Math.random().toString(36).slice(2, 8)}`;
}

export function wedgeValueType(params: Record<string, unknown>): WedgeType {
  const t = params.type as WedgeType;
  return TYPES.includes(t) ? t : "scalar";
}

function mode(params: Record<string, unknown>): Mode {
  if (wedgeValueType(params) !== "scalar") return "values";
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
// zipped index — clamping to this wedge's own count happens here). Scalar
// type only; the typed entry point below routes non-scalar types.
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

// Same hex parse as Color Literal (3- and 6-digit forms). Color rows store
// hex strings — the stored form of every color param in the app.
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  if (Number.isNaN(n)) return [1, 1, 1];
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ];
}

// The typed SocketValue this wedge emits at batch iteration `index`.
export function wedgeValueAt(
  params: Record<string, unknown>,
  index: number
): SocketValue {
  const type = wedgeValueType(params);
  if (type === "scalar") {
    return { kind: "scalar", value: wedgeScalarAt(params, index) };
  }
  const count = wedgeIterationCount(params);
  const i = Math.max(0, Math.min(count - 1, Math.round(index)));
  const raw = valueList(params)[i]?.value;
  switch (type) {
    case "color": {
      const [r, g, b] = hexToRgb(typeof raw === "string" ? raw : "#ffffff");
      return { kind: "vec4", value: [r, g, b, 1] };
    }
    case "vec2": {
      const v = Array.isArray(raw) ? raw : [0, 0];
      return {
        kind: "vec2",
        value: [
          typeof v[0] === "number" ? v[0] : 0,
          typeof v[1] === "number" ? v[1] : 0,
        ],
      };
    }
    case "string":
      return { kind: "string", value: typeof raw === "string" ? raw : "" };
  }
}

// Filename-token form of the value at `index` ({wedge:Name} tokens —
// export-naming.ts sanitizes the result before substitution). Scalar with
// trimmed float noise, color as bare hex, vec2 as "x-y", string verbatim.
export function wedgeTokenValue(
  params: Record<string, unknown>,
  index: number
): string {
  const fmt = (n: number) =>
    String(Math.round(n * 10000) / 10000);
  const v = wedgeValueAt(params, index);
  switch (v.kind) {
    case "scalar":
      return fmt(v.value);
    case "vec4": {
      const c = (x: number) =>
        Math.max(0, Math.min(255, Math.round(x * 255)))
          .toString(16)
          .padStart(2, "0");
      return `${c(v.value[0])}${c(v.value[1])}${c(v.value[2])}`;
    }
    case "vec2":
      return `${fmt(v.value[0])}-${fmt(v.value[1])}`;
    case "string":
      return v.value;
    default:
      return "";
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
    "Batch-render variation source. Defines a set of values — scalar (explicit list, range, seeded random, or the bare iteration index), color, vec2, or string — and emits one per render when the export runs a wedge batch: wire it into a seed, a Switch index, a fill color, a Text string, or any exposed param. Outside a batch it emits the value at Preview, so scrubbing Preview auditions variations live. Multiple Wedge nodes zip: the batch runs max(counts) iterations and shorter wedges hold their last value.",
  backend: "webgl2",
  // Pure CPU value — no image to matte.
  noMaskInput: true,
  inputs: [],
  headerControl: { paramName: "type" },
  params: [
    {
      name: "type",
      label: "Type",
      type: "enum",
      options: TYPES as unknown as string[],
      default: "scalar",
    },
    {
      // Scalar-only: non-scalar types are always explicit value lists.
      name: "mode",
      label: "Mode",
      type: "enum",
      options: MODES as unknown as string[],
      default: "values",
      visibleIf: (p) => (p.type ?? "scalar") === "scalar",
    },
    {
      name: "values",
      label: "Values",
      type: "wedge_values",
      default: DEFAULT_VALUES,
      visibleIf: (p) =>
        (p.type ?? "scalar") !== "scalar" || (p.mode ?? "values") === "values",
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
      visibleIf: (p) =>
        (p.type ?? "scalar") === "scalar" && (p.mode ?? "values") !== "values",
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
      visibleIf: (p) => (p.type ?? "scalar") === "scalar" && p.mode === "range",
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
      visibleIf: (p) => (p.type ?? "scalar") === "scalar" && p.mode === "range",
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
      visibleIf: (p) =>
        (p.type ?? "scalar") === "scalar" && p.mode === "random",
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
      visibleIf: (p) =>
        (p.type ?? "scalar") === "scalar" && p.mode === "random",
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
      visibleIf: (p) =>
        (p.type ?? "scalar") === "scalar" && p.mode === "random",
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
  resolvePrimaryOutput(params) {
    return SOCKET_OF[wedgeValueType(params)];
  },
  auxOutputs: [],
  // The only non-param input is ctx.wedgeIndex; fold the clamped effective
  // index so caches bust exactly when the emitted value can change.
  fingerprintExtras(params, ctx) {
    return `wedge:${effectiveIndex(params, ctx.wedgeIndex)}`;
  },
  compute({ params, ctx }) {
    const i = effectiveIndex(params, ctx.wedgeIndex);
    return { primary: wedgeValueAt(params, i) };
  },
};
