import type {
  InputSocketDef,
  NodeDefinition,
  PointsValue,
  RenderContext,
  ResolveCtx,
  ScalarValue,
  SocketType,
  SocketValue,
  SplineValue,
} from "@/engine/types";
import {
  accumulatorDomain,
  accumulatorDomainForSource,
  accumulatorInputType,
} from "@/engine/graph-helpers";
import {
  concatPoints,
  copyPointsWith,
  EMPTY_POINTS,
  gatherPoints,
  is3DPoints,
  makePoints,
  overlayAge,
  POINT_AGE_ATTR,
} from "@/engine/points";

// Polymorphic accumulator. Scalar mode integrates a number over time
// (the original node). Points mode appends each playing frame's input
// onto a persistent set — Scatter with seed driven by time piles up
// instead of replacing. The input autocoerces: wiring points, a spline
// (anchors become points), or a vec2 (one point) flips the node to
// points and the output follows.
//
// Scalar modes:
//   - integrate: output += input × dt (frame-rate independent; an input
//     of 90 means "90 units/second")
//   - sum: output += input (adds per evaluation regardless of elapsed
//     wall-clock time)
//
// Range (scalar): free / clamp / wrap.
//
// Points index modes:
//   - append ("add on top"): concatenate; incoming groupIndex tags
//     survive, untagged stay untagged. Array indices just continue.
//   - generation: each batch is stamped with an incrementing groupIndex
//     (0, 1, 2…) so downstream can style/filter by when it appeared.
//   - unique: every point gets a monotonic groupIndex id.
//
// Age: each piled point gets a well-known `age` channel (seconds since
// it joined this node). Birth times live in state; age is derived on
// emit so pause/scrub stay honest. Incoming `age` is overwritten.
//
// Reset: auto-reset on scene time 0 (matches RD and Sim Zones);
// `reset` > 0.5 clears and holds while high. Points grow only when
// scene time actually advances (paused / re-eval at the same timestamp
// does not double-add). Rewind freezes rather than running in reverse.

type IndexMode = "append" | "generation" | "unique";

interface ScalarAccumState {
  kind: "scalar";
  value: number;
  lastTime: number;
  initialized: boolean;
}

interface PointsAccumState {
  kind: "points";
  acc: PointsValue;
  // Scene-time join stamp per piled point, parallel to acc. Age on the
  // wire is max(0, ctx.time − births[i]) — not stored on acc itself.
  births: Float32Array;
  lastTime: number;
  lastAccumTime: number;
  generation: number;
  nextId: number;
  initialized: boolean;
}

type AccumState = ScalarAccumState | PointsAccumState;

function applyRange(
  v: number,
  range: string,
  min: number,
  max: number
): number {
  if (range === "clamp") return Math.max(min, Math.min(max, v));
  if (range === "wrap") {
    const width = max - min;
    if (width <= 0) return min;
    return min + ((((v - min) % width) + width) % width);
  }
  return v;
}

function stateKey(nodeId: string): string {
  return `accumulator:${nodeId}`;
}

function readIndexMode(v: unknown): IndexMode {
  if (v === "generation" || v === "unique") return v;
  return "append";
}

function splineToPoints(spline: SplineValue): PointsValue {
  let count = 0;
  for (const sub of spline.subpaths) count += sub.anchors.length;
  if (count === 0) return EMPTY_POINTS;
  const out = makePoints(count, { withGroupIndices: true });
  const pos = out.positions;
  const groups = out.groupIndices!;
  let i = 0;
  for (let s = 0; s < spline.subpaths.length; s++) {
    const sub = spline.subpaths[s];
    const tag = sub.groupIndex ?? s;
    for (const a of sub.anchors) {
      pos[i * 2] = a.pos[0];
      pos[i * 2 + 1] = a.pos[1];
      groups[i] = tag;
      i++;
    }
  }
  return out;
}

function valueToPoints(value: SocketValue | undefined): PointsValue | null {
  if (!value) return null;
  if (value.kind === "points") return is3DPoints(value) ? null : value;
  if (value.kind === "vec2") {
    const out = makePoints(1);
    out.positions[0] = value.value[0];
    out.positions[1] = value.value[1];
    return out;
  }
  if (value.kind === "spline") return splineToPoints(value);
  return null;
}

function tagIncoming(
  src: PointsValue,
  mode: IndexMode,
  generation: number,
  nextId: number
): { pts: PointsValue; generation: number; nextId: number } {
  const n = src.count;
  if (n === 0 || mode === "append") {
    return { pts: src, generation, nextId };
  }
  const gi = new Int32Array(n);
  if (mode === "generation") {
    gi.fill(generation);
    return {
      pts: copyPointsWith(src, { groupIndices: gi }),
      generation: generation + 1,
      nextId,
    };
  }
  for (let i = 0; i < n; i++) gi[i] = nextId + i;
  return {
    pts: copyPointsWith(src, { groupIndices: gi }),
    generation,
    nextId: nextId + n,
  };
}

function capPoints(
  current: PointsValue,
  incoming: PointsValue,
  max: number,
  overflow: string
): PointsValue {
  if (incoming.count === 0) return current;
  if (current.count + incoming.count <= max) {
    return concatPoints([current, incoming]);
  }
  if (overflow === "ring") {
    const combined = concatPoints([current, incoming]);
    const start = combined.count - max;
    const map = new Int32Array(max);
    for (let i = 0; i < max; i++) map[i] = start + i;
    return gatherPoints(combined, map);
  }
  const room = max - current.count;
  if (room <= 0) return current;
  const map = new Int32Array(room);
  for (let i = 0; i < room; i++) map[i] = i;
  return concatPoints([current, gatherPoints(incoming, map)]);
}

// Parallel cap for the birth-time channel — same stop/ring rules as
// capPoints, kept in lockstep with acc.count.
function capScalarChannel(
  current: Float32Array,
  currentCount: number,
  incoming: Float32Array,
  incomingCount: number,
  max: number,
  overflow: string
): Float32Array {
  if (incomingCount === 0) return current;
  if (currentCount + incomingCount <= max) {
    const out = new Float32Array(currentCount + incomingCount);
    out.set(current.subarray(0, currentCount));
    out.set(incoming.subarray(0, incomingCount), currentCount);
    return out;
  }
  if (overflow === "ring") {
    const combined = new Float32Array(currentCount + incomingCount);
    combined.set(current.subarray(0, currentCount));
    combined.set(incoming.subarray(0, incomingCount), currentCount);
    return new Float32Array(combined.subarray(combined.length - max));
  }
  const room = max - currentCount;
  if (room <= 0) return current;
  const out = new Float32Array(currentCount + room);
  out.set(current.subarray(0, currentCount));
  out.set(incoming.subarray(0, room), currentCount);
  return out;
}

// Accumulator owns `age` on its output; drop any incoming channel of
// that name so it doesn't sit stale on the piled value.
function stripAge(src: PointsValue): PointsValue {
  if (!src.attributes || !(POINT_AGE_ATTR in src.attributes)) return src;
  const rest = { ...src.attributes };
  delete rest[POINT_AGE_ATTR];
  return copyPointsWith(src, {
    attributes: Object.keys(rest).length > 0 ? rest : undefined,
  });
}

export const accumulatorNode: NodeDefinition = {
  type: "accumulator",
  name: "Accumulator",
  category: "utility",
  description:
    "Accumulate over time. Wire a scalar to integrate or sum a growing number. Wire points (or a spline / vec2 — autocoerced to points) and each playing frame appends onto a persistent set: Scatter with a time-driven seed piles up instead of replacing. Each piled point carries an `age` channel (seconds since it joined). Index mode defaults to add-on-top (append); generation tags each batch, unique assigns a stable id per point. Auto-resets on scene time 0; an optional reset input clears while held.",
  searchAliases: ["accumulate", "append", "pile"],
  backend: "webgl2",
  headerControl: { paramName: "type" },
  // State lives between frames; fingerprintExtras mixes in ctx.time so
  // the cache re-evaluates us every frame during playback.
  stable: false,
  simulation: true,
  inputs: [
    { name: "input", type: "scalar", required: true },
    { name: "reset", type: "scalar", required: false },
  ],
  resolveInputs(params, ctx?: ResolveCtx): InputSocketDef[] {
    const domain = accumulatorDomain(params, ctx?.connectedTypes?.input);
    const inputType: SocketType =
      domain === "points"
        ? accumulatorInputType(ctx?.connectedTypes?.input)
        : "scalar";
    return [
      { name: "input", type: inputType, required: true },
      { name: "reset", type: "scalar", required: false },
    ];
  },
  params: [
    {
      name: "type",
      label: "Type",
      type: "enum",
      options: ["scalar", "points"],
      default: "scalar",
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["integrate", "sum"],
      default: "integrate",
      visibleIf: (p) => p.type !== "points",
    },
    {
      name: "initial",
      label: "Initial",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.01,
      default: 0,
      visibleIf: (p) => p.type !== "points",
    },
    {
      name: "range",
      label: "Range",
      type: "enum",
      options: ["free", "clamp", "wrap"],
      default: "free",
      visibleIf: (p) => p.type !== "points",
    },
    {
      name: "min",
      label: "Min",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.01,
      default: 0,
      visibleIf: (p) => p.type !== "points" && p.range !== "free",
    },
    {
      name: "max",
      label: "Max",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.type !== "points" && p.range !== "free",
    },
    {
      name: "index_mode",
      label: "Indices",
      type: "enum",
      options: ["add on top", "generation", "unique"],
      default: "add on top",
      visibleIf: (p) => p.type === "points",
    },
    {
      name: "max_points",
      label: "Max points",
      type: "scalar",
      min: 1,
      max: 65536,
      softMax: 8192,
      step: 1,
      default: 4096,
      visibleIf: (p) => p.type === "points",
    },
    {
      name: "overflow",
      label: "Overflow",
      type: "enum",
      options: ["stop", "ring"],
      default: "stop",
      visibleIf: (p) => p.type === "points",
    },
  ],
  primaryOutput: "scalar",
  resolvePrimaryOutput(params, ctx?: ResolveCtx): SocketType {
    return accumulatorDomain(params, ctx?.connectedTypes?.input) === "points"
      ? "points"
      : "scalar";
  },
  auxOutputs: [],

  fingerprintExtras(_params, ctx) {
    return `t:${ctx.time.toFixed(4)}|p:${ctx.playing ? 1 : 0}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const domain = accumulatorDomain(
      params,
      accumulatorDomainForSource(inputs.input?.kind) === "points"
        ? (inputs.input!.kind as SocketType)
        : undefined
    );

    const key = stateKey(nodeId);
    const existing = ctx.state[key] as AccumState | undefined;

    if (domain === "points") {
      return computePoints(inputs, params, ctx, nodeId, existing);
    }
    return computeScalar(inputs, params, ctx, nodeId, existing);
  },

  dispose(ctx: RenderContext, nodeId: string) {
    delete ctx.state[stateKey(nodeId)];
  },
};

function shouldReset(state: { lastTime: number; initialized: boolean }, time: number) {
  const wasNonZero = state.lastTime > 0.05;
  const isNearZero = time < 0.05;
  return !state.initialized || (wasNonZero && isNearZero);
}

function computeScalar(
  inputs: Record<string, SocketValue | undefined>,
  params: Record<string, unknown>,
  ctx: RenderContext,
  nodeId: string,
  existing: AccumState | undefined
) {
  const initial = (params.initial as number) ?? 0;
  const mode = (params.mode as string) ?? "integrate";
  const range = (params.range as string) ?? "free";
  const min = (params.min as number) ?? 0;
  const max = (params.max as number) ?? 1;

  let state: ScalarAccumState;
  if (existing?.kind === "scalar") {
    state = existing;
  } else {
    state = {
      kind: "scalar",
      value: initial,
      lastTime: ctx.time,
      initialized: false,
    };
    ctx.state[stateKey(nodeId)] = state;
  }

  const explicitReset =
    inputs.reset?.kind === "scalar" ? inputs.reset.value > 0.5 : false;

  if (shouldReset(state, ctx.time) || explicitReset) {
    state.value = initial;
    state.initialized = true;
  }

  // Accumulate only when the scene is playing AND reset isn't being
  // held. Integrate by dt so an input of "90" feels like 90 units
  // per second regardless of frame rate. Negative dt (user scrubbed
  // backward) is clamped to zero so the accumulator freezes rather
  // than running in reverse — rewind semantics would require
  // keyframe storage, which is a bigger feature.
  if (ctx.playing && !explicitReset) {
    const dt = Math.max(0, ctx.time - state.lastTime);
    const input = inputs.input?.kind === "scalar" ? inputs.input.value : 0;
    const inc = mode === "integrate" ? input * dt : input;
    state.value += inc;
  }
  state.lastTime = ctx.time;

  const out = applyRange(state.value, range, min, max);
  return {
    primary: { kind: "scalar", value: out } satisfies ScalarValue,
  };
}

function computePoints(
  inputs: Record<string, SocketValue | undefined>,
  params: Record<string, unknown>,
  ctx: RenderContext,
  nodeId: string,
  existing: AccumState | undefined
) {
  const indexMode = readIndexMode(params.index_mode);
  const maxPoints = Math.max(1, Math.floor((params.max_points as number) ?? 4096));
  const overflow = (params.overflow as string) ?? "stop";

  let state: PointsAccumState;
  if (existing?.kind === "points") {
    state = existing;
    if (
      !(state.births instanceof Float32Array) ||
      state.births.length !== state.acc.count
    ) {
      state.births = new Float32Array(state.acc.count).fill(ctx.time);
    }
  } else {
    state = {
      kind: "points",
      acc: EMPTY_POINTS,
      births: new Float32Array(0),
      lastTime: ctx.time,
      lastAccumTime: -1,
      generation: 0,
      nextId: 0,
      initialized: false,
    };
    ctx.state[stateKey(nodeId)] = state;
  }

  const explicitReset =
    inputs.reset?.kind === "scalar" ? inputs.reset.value > 0.5 : false;

  if (shouldReset(state, ctx.time) || explicitReset) {
    state.acc = EMPTY_POINTS;
    state.births = new Float32Array(0);
    state.generation = 0;
    state.nextId = 0;
    state.lastAccumTime = -1;
    state.initialized = true;
  }

  // Append once per advancing scene-time sample. Same-timestamp re-evals
  // (param tweaks, extra graph passes) must not double the pile; rewind
  // freezes. First playing eval at t=0 still adds (lastAccumTime starts
  // at -1).
  if (ctx.playing && !explicitReset && ctx.time > state.lastAccumTime) {
    const incoming = valueToPoints(inputs.input);
    if (incoming && incoming.count > 0) {
      const tagged = tagIncoming(
        incoming,
        indexMode,
        state.generation,
        state.nextId
      );
      state.generation = tagged.generation;
      state.nextId = tagged.nextId;
      const stripped = stripAge(tagged.pts);
      const incomingBirths = new Float32Array(stripped.count).fill(ctx.time);
      const prevCount = state.acc.count;
      state.acc = capPoints(state.acc, stripped, maxPoints, overflow);
      state.births = capScalarChannel(
        state.births,
        prevCount,
        incomingBirths,
        stripped.count,
        maxPoints,
        overflow
      );
    }
    state.lastAccumTime = ctx.time;
  }
  state.lastTime = ctx.time;

  if (state.acc.count === 0) return { primary: EMPTY_POINTS };
  return { primary: overlayAge(state.acc, state.births, ctx.time) };
}
