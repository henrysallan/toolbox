import type { NodeDefinition, PointAttribute, PointsValue } from "@/engine/types";
import {
  copyPointsWith,
  EMPTY_POINTS,
  pointAttrExists,
  readPointAttr,
  RESERVED_POINT_ATTR_NAMES,
} from "@/engine/points";

// Stagger — per-point timing as a channel (specdocs/090426_stagger-node.md).
//
// Cavalry's Stagger / After Effects' index-offset expression as a first-class
// point operation: every point gets its own start time from its rank in an
// ordering (index, reverse, center-out, edges-in, seeded random, or ascending
// by any point column), and the node writes a 0→1 `phase` channel that is 0
// before the point's start, ramps linearly over Duration, and holds 1 after.
// Downstream nodes read the channel through the existing attribute
// consumers — Map Attribute (its curve is the per-point easing), Filter
// Points (attribute mode), Copy to Points (tint / opacity / variant pick),
// point labels — so the timing logic lives on the graph instead of inside
// a Point Expression string.
//
// Contract:
//   - PURE function of (input, params, clock). No state, no pre-roll:
//     scrubbing and export are exact, and Time Offset can retime it.
//   - Units: one `unit` param (frames | seconds) governs Spacing / Total /
//     Duration / Jitter / Start AND a wired Clock. Internally everything is
//     frames; the unwired clock is the scoped playhead in fractional frames
//     (tick / ticksPerFrame — ctx.frame is floored).
//   - Ordering is a DENSE rank: ties share a step (a grid ordered by `y`
//     starts a whole row at once; center-out starts symmetric pairs
//     together). `steps` = number of distinct keys.
//   - Spacing mode: start_i = Start + rank_i × Spacing. Fit mode: the
//     whole sequence (last start + Duration) lands on Total, so
//     step = max(0, Total − Duration) / (steps − 1).
//   - Jitter adds hash(seed, index) × Jitter, positive only — nothing
//     starts before Start.
//   - Loop repeats the WHOLE sequence: period = (last start − Start) +
//     Duration. `cycle` wraps, `ping-pong` folds. Periodic everywhere, so a
//     scene loop whose length is a multiple of the period is seamless.
//   - Channels: `<name>` (phase, clamped 0..1) always; with Extras on, also
//     `<name>_t0` (each point's start, in the node's unit) and
//     `<name>_active` (1 while Start ≤ local time < Start + Duration, i.e.
//     in flight — so Filter Points can drop both unstarted and finished
//     points). No easing here on purpose: consumers shape phase (Map
//     Attribute's curve), the Text animators' "ease AFTER the split" rule.
//   - Reserved or empty name → input passes through unchanged. Existing
//     channels are carried; a same-name channel is replaced.
//
// The pure helpers (denseRanks / orderKeys / staggerStarts / staggerPhase)
// are exported for scripts/check-stagger.mts.

export const STAGGER_ORDER_OPTIONS = [
  "index",
  "reverse",
  "center",
  "edges",
  "random",
  "attribute",
] as const;
export type StaggerOrder = (typeof STAGGER_ORDER_OPTIONS)[number];

export const STAGGER_MODE_OPTIONS = ["spacing", "fit"] as const;
export type StaggerMode = (typeof STAGGER_MODE_OPTIONS)[number];

export const STAGGER_LOOP_OPTIONS = ["off", "cycle", "ping-pong"] as const;
export type StaggerLoop = (typeof STAGGER_LOOP_OPTIONS)[number];

export const STAGGER_UNIT_OPTIONS = ["frames", "seconds"] as const;
export type StaggerUnit = (typeof STAGGER_UNIT_OPTIONS)[number];

// Frame-independent per-seed hash → [0,1) — triple32 (Wellons), the same
// primitive Set Named Attribute's Random source and Point Expression's
// rand() use, so jitter and random order are stable across frames.
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

export function staggerSeedBase(seed: unknown): number {
  const s = typeof seed === "number" && Number.isFinite(seed) ? Math.floor(seed) : 0;
  return Math.imul(s + 1, 0x9e3779b9);
}

// Dense ascending rank of `keys` (ties share a rank; ties broken nowhere —
// equal keys ARE the same step). Non-finite keys read as 0 so the sort stays
// consistent. Returns the per-element rank and the number of distinct steps.
export function denseRanks(keys: ArrayLike<number>): {
  ranks: Int32Array;
  steps: number;
} {
  const n = keys.length;
  const clean = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    clean[i] = Number.isFinite(k) ? k : 0;
  }
  const idx = new Array<number>(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => clean[a] - clean[b] || a - b);
  const ranks = new Int32Array(n);
  let r = -1;
  let prev = Number.NaN;
  for (const i of idx) {
    const k = clean[i];
    if (k !== prev) {
      r++;
      prev = k;
    }
    ranks[i] = r;
  }
  return { ranks, steps: n === 0 ? 0 : r + 1 };
}

// Sort keys for one ordering. `attribute` reads any point column through
// readPointAttr (named channel, dotted component, or a built-in like `x`,
// `y`, `group`); a missing column falls back to index order — the name
// field's red tint (suggestAttrsRequire) is what tells the user why.
export function orderKeys(
  src: PointsValue,
  order: StaggerOrder,
  attrName: string,
  seedBase: number
): Float64Array {
  const n = src.count;
  const keys = new Float64Array(n);
  const c = (n - 1) / 2;
  switch (order) {
    case "reverse":
      for (let i = 0; i < n; i++) keys[i] = n - 1 - i;
      break;
    case "center":
      for (let i = 0; i < n; i++) keys[i] = Math.abs(i - c);
      break;
    case "edges":
      for (let i = 0; i < n; i++) keys[i] = -Math.abs(i - c);
      break;
    case "random":
      for (let i = 0; i < n; i++) keys[i] = hash01(seedBase ^ (i * 2));
      break;
    case "attribute": {
      const name = attrName.trim();
      if (name && pointAttrExists(src, name)) {
        for (let i = 0; i < n; i++) keys[i] = readPointAttr(src, name, i) ?? 0;
        break;
      }
      for (let i = 0; i < n; i++) keys[i] = i;
      break;
    }
    case "index":
    default:
      for (let i = 0; i < n; i++) keys[i] = i;
  }
  return keys;
}

// All fields in FRAMES.
export interface StaggerTiming {
  mode: StaggerMode;
  spacing: number;
  total: number;
  duration: number;
  jitter: number;
  seedBase: number;
  start: number;
}

// Per-point absolute start time (frames): Start + rank × step + jitter.
export function staggerStarts(
  ranks: Int32Array,
  steps: number,
  t: StaggerTiming
): Float32Array {
  const step =
    t.mode === "fit"
      ? steps > 1
        ? Math.max(0, t.total - t.duration) / (steps - 1)
        : 0
      : Math.max(0, t.spacing);
  const jitter = Math.max(0, t.jitter);
  const n = ranks.length;
  const t0 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = t.start + ranks[i] * step;
    if (jitter > 0) v += hash01(t.seedBase ^ (i * 2 + 1)) * jitter;
    t0[i] = v;
  }
  return t0;
}

// Phase (0..1, clamped) and active (0/1) per point at `clock` frames.
// Loop folds the local clock over the sequence period before the per-point
// evaluation so the whole cascade repeats, not each point on its own.
export function staggerPhase(
  t0: Float32Array,
  clock: number,
  start: number,
  duration: number,
  loop: StaggerLoop
): { phase: Float32Array; active: Float32Array } {
  const n = t0.length;
  const phase = new Float32Array(n);
  const active = new Float32Array(n);
  let T = clock - start;
  if (loop !== "off" && n > 0) {
    let maxT0 = -Infinity;
    for (let i = 0; i < n; i++) if (t0[i] > maxT0) maxT0 = t0[i];
    const period = maxT0 - start + Math.max(0, duration);
    if (period > 1e-9) {
      if (loop === "cycle") {
        T = ((T % period) + period) % period;
      } else {
        const two = period * 2;
        const m = ((T % two) + two) % two;
        T = m > period ? two - m : m;
      }
    }
  }
  const dur = Math.max(0, duration);
  for (let i = 0; i < n; i++) {
    const rel = T - (t0[i] - start);
    if (dur > 0) {
      phase[i] = rel <= 0 ? 0 : rel >= dur ? 1 : rel / dur;
    } else {
      phase[i] = rel >= 0 ? 1 : 0;
    }
    active[i] = rel >= 0 && rel < dur ? 1 : 0;
  }
  return { phase, active };
}

function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

export const staggerNode: NodeDefinition = {
  type: "stagger",
  name: "Stagger",
  category: "point",
  subcategory: "modifier",
  description:
    "Gives every point its own start time and writes a 0→1 `phase` channel: 0 before the point's start, a linear ramp over Duration, 1 after. Order picks who goes first — point index, reverse, center-out, edges-in, a seeded random, or ascending by any point column (a named channel, or a built-in like x / y / group; equal values start together). Spacing mode steps each start by Spacing; Fit mode spreads the starts so the whole sequence ends at Total. Jitter adds a stable per-point random delay, Start shifts the sequence, Loop repeats it (cycle or ping-pong). Unit sets whether all of those — and a wired Clock — read as frames or seconds; unwired, the Clock is the playhead. Read phase downstream with Map Attribute (its curve is the per-point easing), Filter Points, or Copy to Points' tint / opacity / variant pick. Extras also writes `<name>_t0` (each start) and `<name>_active` (1 only while in flight). Pure and stateless — scrub-exact, exportable, retimeable by Time Offset.",
  searchAliases: [
    "sequence",
    "delay",
    "cascade",
    "index offset",
    "offset",
    "phase",
    "timing",
    "ripple",
  ],
  facts: {
    gotchas: [
      "attr_name (default `phase`) names the written channel; empty or a reserved point-attribute name passes the input through unchanged.",
      "unit scales Spacing/Total/Duration/Jitter/Start and a wired Clock into frames internally; an unwired Clock uses the scoped playhead in fractional frames.",
      "order=attribute sorts by order_attr (a named channel or built-in like x/y/group); a missing/blank column falls back to index order silently.",
      "Ordering is a dense rank, so tied keys share one start time (an unsorted grid ordered by y starts a whole row together).",
      "jitter is a stable per-point hash of seed and index (not Math.random), always positive, so it only ever delays a start, never advances it.",
      "loop=cycle wraps and loop=ping-pong folds the local clock over the whole sequence's period, so the cascade repeats as a unit, not per point.",
      "extras also writes `<name>_t0` (each point's start, in the node's own unit) and `<name>_active` (1 only while Start ≤ local time < Start+Duration).",
      "Pure function of input/params/clock with no internal state, so scrubbing, export, and Time Offset retiming are exact.",
    ],
  },
  backend: "webgl2",
  // Pure CPU eval keyed on the scoped tick (fingerprintExtras) — same
  // caching contract as a time-dependent Point Expression.
  stable: true,
  noMaskInput: true,
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "clock", type: "scalar", required: false, label: "Clock" },
  ],
  params: [
    {
      name: "attr_name",
      label: "Name",
      type: "string",
      default: "phase",
      placeholder: "channel name",
      suggestAttrsFrom: "points",
    },
    {
      name: "order",
      label: "Order",
      type: "enum",
      options: STAGGER_ORDER_OPTIONS as unknown as string[],
      optionLabels: {
        index: "Index",
        reverse: "Reverse",
        center: "Center out",
        edges: "Edges in",
        random: "Random",
        attribute: "By attribute",
      },
      default: "index",
    },
    {
      name: "order_attr",
      label: "Order by",
      type: "string",
      default: "x",
      placeholder: "attribute name",
      suggestAttrsFrom: "points",
      suggestAttrsRequire: true,
      suggestAttrsIncludeBuiltins: true,
      visibleIf: (p) => p.order === "attribute",
    },
    {
      name: "unit",
      label: "Unit",
      type: "enum",
      options: STAGGER_UNIT_OPTIONS as unknown as string[],
      control: "segmented",
      default: "frames",
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: STAGGER_MODE_OPTIONS as unknown as string[],
      optionLabels: { spacing: "Spacing", fit: "Fit total" },
      control: "segmented",
      default: "spacing",
    },
    {
      name: "spacing",
      label: "Spacing",
      type: "scalar",
      min: 0,
      max: 100000,
      softMax: 30,
      step: 0.1,
      default: 2,
      visibleIf: (p) => p.mode !== "fit",
    },
    {
      name: "total",
      label: "Total",
      type: "scalar",
      min: 0,
      max: 100000,
      softMax: 300,
      step: 0.1,
      default: 60,
      visibleIf: (p) => p.mode === "fit",
    },
    {
      name: "duration",
      label: "Duration",
      type: "scalar",
      min: 0,
      max: 100000,
      softMax: 120,
      step: 0.1,
      default: 12,
    },
    {
      name: "jitter",
      label: "Jitter",
      type: "scalar",
      min: 0,
      max: 100000,
      softMax: 60,
      step: 0.1,
      default: 0,
    },
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
      name: "start",
      label: "Start",
      type: "scalar",
      min: -100000,
      max: 100000,
      softMax: 300,
      step: 0.1,
      default: 0,
    },
    {
      name: "loop",
      label: "Loop",
      type: "enum",
      options: STAGGER_LOOP_OPTIONS as unknown as string[],
      optionLabels: { off: "Off", cycle: "Cycle", "ping-pong": "Ping-pong" },
      default: "off",
    },
    {
      name: "extras",
      label: "Write t0 & active",
      type: "boolean",
      default: false,
    },
  ],
  primaryOutput: "points",
  // The channel's name as a string — the reference wire (081326 M4): expose
  // a consumer's name field and wire this in so renames ripple.
  auxOutputs: [{ name: "name", type: "string" }],

  // Unwired, the clock is the scoped playhead, so the output changes every
  // tick. (A WIRED clock is already in the inputs fingerprint; the tick
  // stamp then costs one O(n) recompute per frame — accepted, the hook
  // can't see wiring.)
  fingerprintExtras(_params, ctx) {
    return `t:${ctx.tick}`;
  },

  compute({ inputs, params, ctx }) {
    const name = ((params.attr_name as string) ?? "").trim();
    const aux = { name: { kind: "string", value: name } as const };
    const src = inputs.points;
    if (!src || src.kind !== "points") return { primary: EMPTY_POINTS, aux };
    if (!name || RESERVED_POINT_ATTR_NAMES.has(name) || src.count === 0) {
      return { primary: src, aux };
    }

    const unit: StaggerUnit = params.unit === "seconds" ? "seconds" : "frames";
    const fps = ctx.fps > 0 ? ctx.fps : 60;
    const k = unit === "seconds" ? fps : 1; // unit → frames
    const order = (
      STAGGER_ORDER_OPTIONS as readonly string[]
    ).includes(params.order as string)
      ? (params.order as StaggerOrder)
      : "index";
    const loop = (STAGGER_LOOP_OPTIONS as readonly string[]).includes(
      params.loop as string
    )
      ? (params.loop as StaggerLoop)
      : "off";
    const seedBase = staggerSeedBase(params.seed);
    const timing: StaggerTiming = {
      mode: params.mode === "fit" ? "fit" : "spacing",
      spacing: num(params.spacing, 2) * k,
      total: num(params.total, 60) * k,
      duration: num(params.duration, 12) * k,
      jitter: num(params.jitter, 0) * k,
      seedBase,
      start: num(params.start, 0) * k,
    };

    const clockIn = inputs.clock;
    const clock =
      clockIn?.kind === "scalar" && Number.isFinite(clockIn.value)
        ? clockIn.value * k
        : ctx.ticksPerFrame > 0
          ? ctx.tick / ctx.ticksPerFrame
          : ctx.frame;

    const keys = orderKeys(src, order, (params.order_attr as string) ?? "", seedBase);
    const { ranks, steps } = denseRanks(keys);
    const t0 = staggerStarts(ranks, steps, timing);
    const { phase, active } = staggerPhase(
      t0,
      clock,
      timing.start,
      timing.duration,
      loop
    );

    const attributes: Record<string, PointAttribute> = {
      ...src.attributes,
      [name]: { arity: 1, data: phase },
    };
    if (params.extras === true) {
      const t0Unit = new Float32Array(t0.length);
      for (let i = 0; i < t0.length; i++) t0Unit[i] = t0[i] / k;
      attributes[`${name}_t0`] = { arity: 1, data: t0Unit };
      attributes[`${name}_active`] = { arity: 1, data: active };
    }
    return { primary: copyPointsWith(src, { attributes }), aux };
  },
};
