// check-output-gating: guards `NodeDefinition.gatesOutputs`.
//
// A cacheable def that skips building outputs nobody consumes (Bloom skips its
// full-canvas `bloom_only` pass — spec 080726_perf-profiler.md) has a trap:
// the fingerprint knows nothing about WHICH outputs were requested, so wiring
// a previously-unbuilt aux would hit the cache and hand back a texture that
// was never rendered. `gatesOutputs` folds the consumed handle set into the
// fingerprint to force exactly one recompute when consumers change.
//
// This is the failure mode that would never show up in a screenshot of the
// happy path: it only bites the moment a user connects that output, and it
// looks like "the node is broken", not "the cache is stale".
//
//   npx tsx scripts/check-output-gating.mts
/* eslint-disable @typescript-eslint/no-explicit-any */

const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= { createElement: stub, createElementNS: stub, fonts: { add() {}, forEach() {} }, body: { appendChild() {} }, addEventListener() {} };
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};

const { registerNode } = await import("@/engine/registry");
const { evaluateGraph } = await import("@/engine/evaluator");
import type { EvalCache } from "@/engine/evaluator";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`
  );
}

// Two GL-free defs that only record what they were asked to build. The
// evaluator itself needs no GL as long as the defs don't touch it.
let gatedBuilds = 0;
let gatedBuiltAux = 0;
let plainBuilds = 0;

registerNode({
  type: "test-gated",
  name: "Gated",
  category: "utility",
  backend: "webgl2",
  inputs: [],
  params: [],
  primaryOutput: "scalar",
  auxOutputs: [{ name: "extra", type: "scalar" }],
  gatesOutputs: true,
  compute({ consumedOutputs }: { consumedOutputs?: ReadonlySet<string> }) {
    gatedBuilds++;
    const want = !consumedOutputs || consumedOutputs.has("aux:extra");
    if (want) gatedBuiltAux++;
    return {
      primary: { kind: "scalar", value: 1 },
      ...(want ? { aux: { extra: { kind: "scalar", value: 2 } } } : {}),
    };
  },
} as any);

// Same shape WITHOUT the flag — proves the fingerprint change is opt-in and
// doesn't silently start busting every node's cache on selection changes.
registerNode({
  type: "test-plain",
  name: "Plain",
  category: "utility",
  backend: "webgl2",
  inputs: [],
  params: [],
  primaryOutput: "scalar",
  auxOutputs: [{ name: "extra", type: "scalar" }],
  compute() {
    plainBuilds++;
    return { primary: { kind: "scalar", value: 1 } };
  },
} as any);

registerNode({
  type: "test-sink",
  name: "Sink",
  category: "utility",
  backend: "webgl2",
  inputs: [{ name: "a", type: "scalar" }],
  params: [],
  primaryOutput: "scalar",
  terminal: true,
  compute() {
    return { primary: { kind: "scalar", value: 0 } };
  },
} as any);

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

const node = (id: string, type: string) =>
  ({ id, type, params: {} }) as any;
const edge = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
  ({ id: `${source}-${target}-${targetHandle}`, source, sourceHandle, target, targetHandle }) as any;

// --- gated def: primary only, then aux wired in ---------------------------
{
  const cache: EvalCache = new Map();
  const nodes = [node("g", "test-gated"), node("s", "test-sink")];
  const primaryOnly = [edge("g", "out:primary", "s", "in:a")];

  gatedBuilds = 0;
  gatedBuiltAux = 0;
  evaluateGraph(nodes, primaryOnly, ctx, cache);
  check("gated: first eval computes", gatedBuilds, 1);
  check("gated: aux skipped when unconsumed", gatedBuiltAux, 0);

  // Identical graph again ⇒ cache hit, no recompute.
  evaluateGraph(nodes, primaryOnly, ctx, cache);
  check("gated: unchanged graph cache-hits", gatedBuilds, 1);

  // Now wire the aux. THE regression this file exists for: without
  // gatesOutputs folding the consumed set into the fingerprint, this
  // cache-hits and the sink receives an aux that was never built.
  const nodes2 = [node("g", "test-gated"), node("s2", "test-sink"), node("s", "test-sink")];
  const withAux = [
    edge("g", "out:primary", "s", "in:a"),
    edge("g", "out:aux:extra", "s2", "in:a"),
  ];
  const res = evaluateGraph(nodes2, withAux, ctx, cache);
  check("gated: wiring the aux forces a recompute", gatedBuilds, 2);
  check("gated: aux built once consumed", gatedBuiltAux, 1);
  check(
    "gated: the aux value actually reaches the graph",
    (res.outputs.get("g")?.aux?.extra as any)?.value,
    2
  );

  // And it settles again — the bust is one-shot, not permanent.
  evaluateGraph(nodes2, withAux, ctx, cache);
  check("gated: settles back to cache hits", gatedBuilds, 2);
}

// --- plain def: consumed set must NOT touch the fingerprint ---------------
{
  const cache: EvalCache = new Map();
  const nodes = [node("p", "test-plain"), node("s", "test-sink")];
  const primaryOnly = [edge("p", "out:primary", "s", "in:a")];

  plainBuilds = 0;
  evaluateGraph(nodes, primaryOnly, ctx, cache);
  check("plain: first eval computes", plainBuilds, 1);

  const nodes2 = [node("p", "test-plain"), node("s2", "test-sink"), node("s", "test-sink")];
  const withAux = [
    edge("p", "out:primary", "s", "in:a"),
    edge("p", "out:aux:extra", "s2", "in:a"),
  ];
  evaluateGraph(nodes2, withAux, ctx, cache);
  check(
    "plain: consumers changing does NOT bust an unflagged node",
    plainBuilds,
    1
  );
}

console.log(
  failures === 0
    ? "\nall output-gating checks passed"
    : `\n${failures} output-gating check(s) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
