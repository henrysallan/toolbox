// check-scalar-fp: wired scalar inputs fingerprint by VALUE, not producer
// identity (evaluator.ts `wiredInputFp`).
//
// Floor(v/period) emits the same integer for many frames while its own
// fingerprint still changes every frame (it embeds the moving driver).
// Downstream used to miss on that identity. This gate is the regression
// for that class — quantize, step, floor, gating.
//
//   npx tsx scripts/check-scalar-fp.mts
/* eslint-disable @typescript-eslint/no-explicit-any */

const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= {
  createElement: stub,
  createElementNS: stub,
  fonts: { add() {}, forEach() {} },
  body: { appendChild() {} },
  addEventListener() {},
};
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.OffscreenCanvas ??= class {
  getContext() {
    return null;
  }
};
g.WebGL2RenderingContext ??= class {};

const { registerNode } = await import("@/engine/registry");
const { evaluateGraph, fpNumber, wiredInputFp } = await import(
  "@/engine/evaluator"
);
import type { EvalCache } from "@/engine/evaluator";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`
  );
}

const ctx = {
  gl: {},
  width: 8,
  height: 8,
  time: 0,
  frame: 0,
  tick: 0,
  ticksPerFrame: 1000,
  fps: 30,
  playing: false,
  offline: false,
  cursor: { x: 0, y: 0, active: false },
  state: {},
  allocImage: () => ({ kind: "image", texture: {}, width: 8, height: 8 }),
  allocMask: () => ({ kind: "mask", texture: {}, width: 8, height: 8 }),
  allocUv: () => ({ kind: "uv", texture: {}, width: 8, height: 8 }),
  releaseTexture: () => {},
  drawFullscreen: () => {},
  clearTarget: () => {},
  getShader: () => ({}),
} as any;

const node = (id: string, type: string, extra?: Record<string, unknown>) =>
  ({ id, type, params: {}, ...extra }) as any;
const edge = (
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string
) =>
  ({
    id: `${source}-${target}-${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
  }) as any;

function setTime(t: number) {
  ctx.time = t;
  ctx.frame = t;
  ctx.tick = t * ctx.ticksPerFrame;
}

let driverBuilds = 0;
let floorBuilds = 0;
let sinkBuilds = 0;
let constBuilds = 0;
let vecSinkBuilds = 0;
let lowSinkBuilds = 0;
let highSinkBuilds = 0;
let knobBuilds = 0;

registerNode({
  type: "test-fp-driver",
  name: "Driver",
  category: "utility",
  backend: "webgl2",
  stable: false,
  inputs: [],
  params: [],
  primaryOutput: "scalar",
  auxOutputs: [],
  compute({ ctx }: { ctx: { time: number } }) {
    driverBuilds++;
    return { primary: { kind: "scalar", value: ctx.time } };
  },
} as any);

registerNode({
  type: "test-fp-floor",
  name: "Floor",
  category: "utility",
  backend: "webgl2",
  inputs: [{ name: "v", type: "scalar" }],
  params: [{ name: "period", type: "scalar", default: 90 }],
  primaryOutput: "scalar",
  auxOutputs: [],
  compute({
    inputs,
    params,
  }: {
    inputs: Record<string, { kind?: string; value?: number }>;
    params: Record<string, unknown>;
  }) {
    floorBuilds++;
    const v = inputs.v?.kind === "scalar" ? (inputs.v.value as number) : 0;
    const period = (params.period as number) ?? 90;
    return { primary: { kind: "scalar", value: Math.floor(v / period) } };
  },
} as any);

registerNode({
  type: "test-fp-sink",
  name: "Sink",
  category: "utility",
  backend: "webgl2",
  inputs: [{ name: "a", type: "scalar" }],
  params: [],
  primaryOutput: "scalar",
  auxOutputs: [],
  terminal: true,
  compute({
    inputs,
  }: {
    inputs: Record<string, { kind?: string; value?: number }>;
  }) {
    sinkBuilds++;
    const v = inputs.a?.kind === "scalar" ? inputs.a.value : 0;
    return { primary: { kind: "scalar", value: v } };
  },
} as any);

registerNode({
  type: "test-fp-const",
  name: "Const",
  category: "utility",
  backend: "webgl2",
  inputs: [],
  params: [],
  primaryOutput: "scalar",
  auxOutputs: [],
  compute() {
    constBuilds++;
    return { primary: { kind: "scalar", value: 0 } };
  },
} as any);

// Unstable, but the vec2 VALUE never changes. Identity-keyed consumers
// must miss every frame; a mistaken value-short-circuit would hit.
registerNode({
  type: "test-fp-vec2-unstable",
  name: "Vec2Unstable",
  category: "utility",
  backend: "webgl2",
  stable: false,
  inputs: [],
  params: [],
  primaryOutput: "vec2",
  auxOutputs: [],
  compute() {
    return { primary: { kind: "vec2", value: [1, 2] } };
  },
} as any);

registerNode({
  type: "test-fp-vec2-sink",
  name: "Vec2Sink",
  category: "utility",
  backend: "webgl2",
  inputs: [{ name: "a", type: "vec2" }],
  params: [],
  primaryOutput: "vec2",
  auxOutputs: [],
  terminal: true,
  compute() {
    vecSinkBuilds++;
    return { primary: { kind: "vec2", value: [0, 0] } };
  },
} as any);

registerNode({
  type: "test-fp-bands",
  name: "Bands",
  category: "utility",
  backend: "webgl2",
  stable: false,
  inputs: [],
  params: [],
  primaryOutput: "scalar",
  auxOutputs: [
    { name: "low", type: "scalar" },
    { name: "high", type: "scalar" },
  ],
  compute({ ctx }: { ctx: { time: number } }) {
    return {
      primary: { kind: "scalar", value: 0 },
      aux: {
        low: { kind: "scalar", value: 1 },
        high: { kind: "scalar", value: ctx.time },
      },
    };
  },
} as any);

registerNode({
  type: "test-fp-low-sink",
  name: "LowSink",
  category: "utility",
  backend: "webgl2",
  inputs: [{ name: "a", type: "scalar" }],
  params: [],
  primaryOutput: "scalar",
  auxOutputs: [],
  terminal: true,
  compute() {
    lowSinkBuilds++;
    return { primary: { kind: "scalar", value: 0 } };
  },
} as any);

registerNode({
  type: "test-fp-high-sink",
  name: "HighSink",
  category: "utility",
  backend: "webgl2",
  inputs: [{ name: "a", type: "scalar" }],
  params: [],
  primaryOutput: "scalar",
  auxOutputs: [],
  terminal: true,
  compute() {
    highSinkBuilds++;
    return { primary: { kind: "scalar", value: 0 } };
  },
} as any);

registerNode({
  type: "test-fp-knob",
  name: "Knob",
  category: "utility",
  backend: "webgl2",
  inputs: [],
  params: [{ name: "amount", type: "scalar", default: 0 }],
  primaryOutput: "scalar",
  auxOutputs: [],
  terminal: true,
  compute({ params }: { params: Record<string, unknown> }) {
    knobBuilds++;
    return { primary: { kind: "scalar", value: (params.amount as number) ?? 0 } };
  },
} as any);

// Unstable producer, constant scalar — the short-circuit in isolation.
registerNode({
  type: "test-fp-held-unstable",
  name: "HeldUnstable",
  category: "utility",
  backend: "webgl2",
  stable: false,
  inputs: [],
  params: [],
  primaryOutput: "scalar",
  auxOutputs: [],
  compute() {
    return { primary: { kind: "scalar", value: 7 } };
  },
} as any);

// --- encoding -------------------------------------------------------------
check("fpNumber: finite", fpNumber(7), "7");
check("fpNumber: NaN", fpNumber(NaN), "NaN");
check("fpNumber: -0", fpNumber(-0), "-0");
check("fpNumber: +0", fpNumber(0), "0");
check("fpNumber: Inf", fpNumber(Infinity), "Infinity");
check("fpNumber: -Inf", fpNumber(-Infinity), "-Infinity");
check(
  "wiredInputFp: scalar drops identity",
  wiredInputFp("a", { kind: "scalar", value: 7 }, "PRODUCER_FP", "p"),
  "a=s:7"
);
check(
  "wiredInputFp: non-scalar keeps identity + handle",
  wiredInputFp("a", { kind: "vec2", value: [1, 2] }, "PRODUCER_FP", "p"),
  "a=PRODUCER_FP/p"
);
check(
  "wiredInputFp: omitted handleTag keeps historical form",
  wiredInputFp("zi__e_1", { kind: "vec2", value: [1, 2] }, "PRODUCER_FP"),
  "zi__e_1=PRODUCER_FP"
);
check(
  "wiredInputFp: scalar hidden edge also value-keys",
  wiredInputFp("zi__e_1", { kind: "scalar", value: 3 }, "PRODUCER_FP"),
  "zi__e_1=s:3"
);

// --- held scalar from an unstable producer --------------------------------
{
  const cache: EvalCache = new Map();
  const nodes = [node("h", "test-fp-held-unstable"), node("s", "test-fp-sink")];
  const edges = [edge("h", "out:primary", "s", "in:a")];
  sinkBuilds = 0;
  setTime(0);
  const r0 = evaluateGraph(nodes, edges, ctx, cache);
  check("held: first eval computes the sink", sinkBuilds, 1);
  check(
    "held: sink sees 7",
    (r0.outputs.get("s")?.primary as any)?.value,
    7
  );
  setTime(1);
  evaluateGraph(nodes, edges, ctx, cache);
  check("held: unstable producer, same number ⇒ sink cache-hits", sinkBuilds, 1);
}

// --- floor(v/period): the motivating class --------------------------------
{
  const cache: EvalCache = new Map();
  const nodes = [
    node("d", "test-fp-driver"),
    node("f", "test-fp-floor"),
    node("s", "test-fp-sink"),
  ];
  const edges = [
    edge("d", "out:primary", "f", "in:v"),
    edge("f", "out:primary", "s", "in:a"),
  ];
  driverBuilds = 0;
  floorBuilds = 0;
  sinkBuilds = 0;
  for (let t = 0; t < 90; t++) {
    setTime(t);
    evaluateGraph(nodes, edges, ctx, cache);
  }
  check("floor: driver runs every frame", driverBuilds, 90);
  check("floor: floor runs every frame (its input number moved)", floorBuilds, 90);
  check("floor: sink runs once while the integer holds", sinkBuilds, 1);

  setTime(90);
  const r = evaluateGraph(nodes, edges, ctx, cache);
  check("floor: sink recomputes when the integer steps", sinkBuilds, 2);
  check(
    "floor: sink value is the new integer",
    (r.outputs.get("s")?.primary as any)?.value,
    1
  );
}

// --- rewire to another producer of the same number ------------------------
{
  const cache: EvalCache = new Map();
  const nodes = [
    node("d", "test-fp-driver"),
    node("f", "test-fp-floor"),
    node("c", "test-fp-const"),
    node("s", "test-fp-sink"),
  ];
  const viaFloor = [
    edge("d", "out:primary", "f", "in:v"),
    edge("f", "out:primary", "s", "in:a"),
  ];
  sinkBuilds = 0;
  constBuilds = 0;
  setTime(0);
  evaluateGraph(nodes, viaFloor, ctx, cache);
  check("rewire: sink computed once via floor", sinkBuilds, 1);

  const viaConst = [edge("c", "out:primary", "s", "in:a")];
  evaluateGraph(nodes, viaConst, ctx, cache);
  check(
    "rewire: same number from a different node ⇒ sink still hits",
    sinkBuilds,
    1
  );
  check("rewire: constant node did compute (newly needed)", constBuilds, 1);
}

// --- vec2 identity is unchanged -------------------------------------------
{
  const cache: EvalCache = new Map();
  const nodes = [
    node("v", "test-fp-vec2-unstable"),
    node("s", "test-fp-vec2-sink"),
  ];
  const edges = [edge("v", "out:primary", "s", "in:a")];
  vecSinkBuilds = 0;
  setTime(0);
  evaluateGraph(nodes, edges, ctx, cache);
  setTime(1);
  evaluateGraph(nodes, edges, ctx, cache);
  check(
    "vec2: constant value from an unstable producer still poisons",
    vecSinkBuilds,
    2
  );
}

// --- per-handle: stable aux vs moving aux on the same node ----------------
{
  const cache: EvalCache = new Map();
  const nodes = [
    node("b", "test-fp-bands"),
    node("lo", "test-fp-low-sink"),
    node("hi", "test-fp-high-sink"),
  ];
  const edges = [
    edge("b", "out:aux:low", "lo", "in:a"),
    edge("b", "out:aux:high", "hi", "in:a"),
  ];
  lowSinkBuilds = 0;
  highSinkBuilds = 0;
  setTime(0);
  evaluateGraph(nodes, edges, ctx, cache);
  setTime(1);
  evaluateGraph(nodes, edges, ctx, cache);
  check("aux: Low (held 1) cache-hits", lowSinkBuilds, 1);
  check("aux: High (moving) misses", highSinkBuilds, 2);
}

// --- exposed param socket -------------------------------------------------
{
  const cache: EvalCache = new Map();
  const nodes = [
    node("d", "test-fp-driver"),
    node("f", "test-fp-floor"),
    node("k", "test-fp-knob", { exposedParams: ["amount"] }),
  ];
  const edges = [
    edge("d", "out:primary", "f", "in:v"),
    edge("f", "out:primary", "k", "in:param:amount"),
  ];
  knobBuilds = 0;
  for (let t = 0; t < 90; t++) {
    setTime(t);
    evaluateGraph(nodes, edges, ctx, cache);
  }
  check("param: knob runs once while the floored amount holds", knobBuilds, 1);
  setTime(90);
  evaluateGraph(nodes, edges, ctx, cache);
  check("param: knob recomputes when the integer steps", knobBuilds, 2);
}

console.log(
  failures === 0
    ? "\nall scalar-fp checks passed"
    : `\n${failures} scalar-fp check(s) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
