// check-stagger: the Stagger node's timing model — orderings (dense ranks,
// ties share a step), spacing vs fit, jitter, start, loop cycle/ping-pong,
// units, the wired clock, the pass-through rules, and channel carry.
//
//   npx tsx scripts/check-stagger.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
  SocketValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { copyPointsWith, makePoints } from "../src/engine/points.ts";
import {
  denseRanks,
  orderKeys,
  staggerNode,
  staggerSeedBase,
} from "../src/nodes/effect/stagger.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
}

function closeAll(arr: ArrayLike<number> | undefined, expected: number[], eps = 1e-5): boolean {
  if (!arr || arr.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) if (!close(arr[i], expected[i], eps)) return false;
  return true;
}

function equalAll(a: ArrayLike<number> | undefined, b: ArrayLike<number> | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function fmt(arr: ArrayLike<number> | undefined): string {
  if (!arr) return "undefined";
  return Array.from(arr as ArrayLike<number>)
    .map((v) => (Math.round(v * 1000) / 1000).toString())
    .join(",");
}

const TPF = 1000;
function makeCtx(frame = 0, fps = 30): RenderContext {
  return {
    time: frame / fps,
    frame: Math.floor(frame),
    tick: Math.round(frame * TPF),
    ticksPerFrame: TPF,
    fps,
    playing: true,
    state: {},
    width: 1920,
    height: 1080,
  } as unknown as RenderContext;
}

// Five points; x deliberately unsorted with one tie so "by attribute: x"
// exercises dense ranking on a built-in.
function samplePoints(): PointsValue {
  const pts = makePoints(5, { withScales: true, withRotations: true });
  pts.positions.set([0.9, 0.1, 0.1, 0.2, 0.5, 0.3, 0.5, 0.4, 0.3, 0.5]);
  pts.scales!.fill(1);
  pts.rotations!.fill(0);
  return copyPointsWith(pts, {
    attributes: {
      weight: { arity: 1, data: new Float32Array([0, 0.5, 1, 1, 0.25]) },
    },
  });
}

function run(
  input: SocketValue | undefined,
  params: Record<string, unknown>,
  opts: { frame?: number; fps?: number; clock?: number } = {}
): { out: PointsValue | undefined; aux: Record<string, SocketValue | undefined> } {
  const ctx = makeCtx(opts.frame ?? 0, opts.fps ?? 30);
  const coerced = coerceValue(input, "points", ctx);
  const clock =
    opts.clock === undefined
      ? undefined
      : coerceValue({ kind: "scalar", value: opts.clock }, "scalar", ctx);
  const res = staggerNode.compute({
    inputs: { points: coerced, clock },
    auxIn: {},
    params,
    ctx,
    nodeId: "stagger",
  } as Parameters<typeof staggerNode.compute>[0]) as NodeOutput;
  return {
    out: res.primary?.kind === "points" ? res.primary : undefined,
    aux: (res.aux ?? {}) as Record<string, SocketValue | undefined>,
  };
}

function chan(p: PointsValue | undefined, name: string): Float32Array | undefined {
  return p?.attributes?.[name]?.data;
}

const BASE: Record<string, unknown> = {
  attr_name: "phase",
  order: "index",
  order_attr: "x",
  unit: "frames",
  mode: "spacing",
  spacing: 2,
  total: 60,
  duration: 4,
  jitter: 0,
  seed: 0,
  start: 0,
  loop: "off",
  extras: true,
};

const pts = samplePoints();

// --- def sanity ----------------------------------------------------------
{
  const names = new Set(staggerNode.params.map((p) => p.name));
  check("def: every BASE param is declared", Object.keys(BASE).every((k) => names.has(k)));
  check(
    "def: every param has a default",
    staggerNode.params.every((p) => p.default !== undefined)
  );
  check(
    "def: enum params list their default",
    staggerNode.params
      .filter((p) => p.type === "enum")
      .every((p) => (p.options ?? []).includes(p.default as string))
  );
  check(
    "def: aux `name` string output declared",
    (staggerNode.auxOutputs ?? []).some((a) => a.name === "name" && a.type === "string")
  );
  check(
    "def: clock input is an optional scalar",
    staggerNode.inputs.some((i) => i.name === "clock" && i.type === "scalar" && !i.required)
  );
}

// --- A: index order, spacing --------------------------------------------
{
  const { out, aux } = run(pts, BASE, { frame: 5 });
  // t0 = 0,2,4,6,8; rel = 5,3,1,-1,-3
  check(
    "index/spacing: t0 = rank × spacing",
    closeAll(chan(out, "phase_t0"), [0, 2, 4, 6, 8]),
    fmt(chan(out, "phase_t0"))
  );
  check(
    "index/spacing: phase clamps 0..1 and ramps over duration",
    closeAll(chan(out, "phase"), [1, 0.75, 0.25, 0, 0]),
    fmt(chan(out, "phase"))
  );
  check(
    "index/spacing: active only while in flight",
    closeAll(chan(out, "phase_active"), [0, 1, 1, 0, 0]),
    fmt(chan(out, "phase_active"))
  );
  check(
    "aux name carries the channel name",
    aux.name?.kind === "string" && aux.name.value === "phase"
  );
  check(
    "carries existing channels by reference",
    !!out && out.attributes?.weight === pts.attributes?.weight
  );
  check(
    "shares untouched arrays (positions) by reference",
    !!out && out.positions === pts.positions && out.count === pts.count
  );
}

// --- orderings -----------------------------------------------------------
{
  const { out } = run(pts, { ...BASE, order: "reverse" }, { frame: 5 });
  check("reverse: t0 mirrors index", closeAll(chan(out, "phase_t0"), [8, 6, 4, 2, 0]), fmt(chan(out, "phase_t0")));
  check("reverse: phase mirrors", closeAll(chan(out, "phase"), [0, 0, 0.25, 0.75, 1]), fmt(chan(out, "phase")));
}
{
  const { ranks, steps } = denseRanks([2, 1, 0, 1, 2]);
  check("denseRanks: ties share a rank", closeAll(ranks, [2, 1, 0, 1, 2]) && steps === 3, `${fmt(ranks)} steps=${steps}`);
  const nf = denseRanks([Number.NaN, 1, Number.POSITIVE_INFINITY, 0]);
  check("denseRanks: non-finite keys read as 0", closeAll(nf.ranks, [0, 1, 0, 0]) && nf.steps === 2, fmt(nf.ranks));
  check("denseRanks: empty", denseRanks([]).steps === 0);
}
{
  const { out } = run(pts, { ...BASE, order: "center" });
  check("center: symmetric pairs start together", closeAll(chan(out, "phase_t0"), [4, 2, 0, 2, 4]), fmt(chan(out, "phase_t0")));
}
{
  const { out } = run(pts, { ...BASE, order: "edges" });
  check("edges: outermost first", closeAll(chan(out, "phase_t0"), [0, 2, 4, 2, 0]), fmt(chan(out, "phase_t0")));
}
{
  // weight = 0, .5, 1, 1, .25 → ranks 0,2,3,3,1
  const { out } = run(pts, { ...BASE, order: "attribute", order_attr: "weight" });
  check("attribute: ascending by named channel, ties share", closeAll(chan(out, "phase_t0"), [0, 4, 6, 6, 2]), fmt(chan(out, "phase_t0")));
}
{
  // x = .9, .1, .5, .5, .3 → ranks 3,0,2,2,1
  const { out } = run(pts, { ...BASE, order: "attribute", order_attr: "x" });
  check("attribute: built-in column (x)", closeAll(chan(out, "phase_t0"), [6, 0, 4, 4, 2]), fmt(chan(out, "phase_t0")));
}
{
  const { out } = run(pts, { ...BASE, order: "attribute", order_attr: "nope" });
  check("attribute: missing column falls back to index", closeAll(chan(out, "phase_t0"), [0, 2, 4, 6, 8]), fmt(chan(out, "phase_t0")));
}
{
  const big = makePoints(16, {});
  const k0 = orderKeys(big, "random", "", staggerSeedBase(0));
  const k0b = orderKeys(big, "random", "", staggerSeedBase(0));
  const k1 = orderKeys(big, "random", "", staggerSeedBase(1));
  const r0 = denseRanks(k0);
  const sorted = Array.from(r0.ranks).sort((a, b) => a - b);
  check("random: a permutation of 0..n-1", r0.steps === 16 && sorted.every((v, i) => v === i), fmt(r0.ranks));
  check("random: deterministic for a seed", equalAll(k0, k0b));
  check("random: seed changes the order", !closeAll(k0, Array.from(k1), 1e-9));
}

// --- fit mode ------------------------------------------------------------
{
  const { out } = run(pts, { ...BASE, mode: "fit", total: 30, duration: 10 }, { frame: 29.9 });
  check("fit: starts spread so last start + duration = total", closeAll(chan(out, "phase_t0"), [0, 5, 10, 15, 20]), fmt(chan(out, "phase_t0")));
  check("fit: last point still ramping just before total", !!out && close(chan(out, "phase")![4], 0.99), fmt(chan(out, "phase")));
  const done = run(pts, { ...BASE, mode: "fit", total: 30, duration: 10 }, { frame: 30 });
  check("fit: everything at 1 by total", closeAll(chan(done.out, "phase"), [1, 1, 1, 1, 1]), fmt(chan(done.out, "phase")));
  const tight = run(pts, { ...BASE, mode: "fit", total: 5, duration: 10 });
  check("fit: total < duration → all start together", closeAll(chan(tight.out, "phase_t0"), [0, 0, 0, 0, 0]), fmt(chan(tight.out, "phase_t0")));
  const one = makePoints(1, {});
  const single = run(one, { ...BASE, mode: "fit", total: 30, duration: 10 });
  check("fit: single point starts at Start", closeAll(chan(single.out, "phase_t0"), [0]), fmt(chan(single.out, "phase_t0")));
}

// --- jitter / seed / start ----------------------------------------------
{
  const a = run(pts, { ...BASE, jitter: 3 });
  const b = run(pts, { ...BASE, jitter: 3 });
  const c = run(pts, { ...BASE, jitter: 3, seed: 7 });
  const t0 = chan(a.out, "phase_t0")!;
  let bounded = true;
  for (let i = 0; i < 5; i++) if (t0[i] < i * 2 || t0[i] >= i * 2 + 3) bounded = false;
  check("jitter: positive-only, bounded by Jitter", bounded, fmt(t0));
  check("jitter: deterministic across evals", equalAll(t0, chan(b.out, "phase_t0")));
  check("jitter: seed changes it", !closeAll(t0, Array.from(chan(c.out, "phase_t0")!), 1e-9));
}
{
  const early = run(pts, { ...BASE, start: 10 }, { frame: 5 });
  check("start: nothing before Start", closeAll(chan(early.out, "phase"), [0, 0, 0, 0, 0]), fmt(chan(early.out, "phase")));
  const later = run(pts, { ...BASE, start: 10 }, { frame: 15 });
  check("start: shifts the whole sequence", closeAll(chan(later.out, "phase"), [1, 0.75, 0.25, 0, 0]) && closeAll(chan(later.out, "phase_t0"), [10, 12, 14, 16, 18]), `${fmt(chan(later.out, "phase"))} / ${fmt(chan(later.out, "phase_t0"))}`);
}

// --- loop ----------------------------------------------------------------
{
  // period = last start (8) − start (0) + duration (4) = 12
  const ref = [1, 0.75, 0.25, 0, 0];
  const cyc = run(pts, { ...BASE, loop: "cycle" }, { frame: 17 });
  check("loop cycle: clock 17 ≡ 5 (period 12)", closeAll(chan(cyc.out, "phase"), ref), fmt(chan(cyc.out, "phase")));
  const neg = run(pts, { ...BASE, loop: "cycle" }, { frame: -7 });
  check("loop cycle: periodic before Start too", closeAll(chan(neg.out, "phase"), ref), fmt(chan(neg.out, "phase")));
  const pp = run(pts, { ...BASE, loop: "ping-pong" }, { frame: 19 });
  check("loop ping-pong: clock 19 folds to 5", closeAll(chan(pp.out, "phase"), ref), fmt(chan(pp.out, "phase")));
  const ppFwd = run(pts, { ...BASE, loop: "ping-pong" }, { frame: 5 });
  check("loop ping-pong: forward half untouched", closeAll(chan(ppFwd.out, "phase"), ref), fmt(chan(ppFwd.out, "phase")));
  const off = run(pts, { ...BASE, loop: "off" }, { frame: 17 });
  check("loop off: holds at 1 after the sequence", closeAll(chan(off.out, "phase"), [1, 1, 1, 1, 1]), fmt(chan(off.out, "phase")));
}

// --- units + clock -------------------------------------------------------
{
  const sec = run(pts, { ...BASE, unit: "seconds", spacing: 0.5, duration: 1 }, { frame: 20, fps: 30 });
  // frames: spacing 15, duration 30; rel = 20, 5, −10 …
  check("unit seconds: params scale by fps", closeAll(chan(sec.out, "phase"), [20 / 30, 5 / 30, 0, 0, 0]), fmt(chan(sec.out, "phase")));
  check("unit seconds: t0 extra reads in seconds", closeAll(chan(sec.out, "phase_t0"), [0, 0.5, 1, 1.5, 2]), fmt(chan(sec.out, "phase_t0")));
}
{
  const wired = run(pts, BASE, { frame: 0, clock: 5 });
  check("wired clock overrides the playhead", closeAll(chan(wired.out, "phase"), [1, 0.75, 0.25, 0, 0]), fmt(chan(wired.out, "phase")));
  const wiredSec = run(pts, { ...BASE, unit: "seconds", spacing: 0.5, duration: 1 }, { frame: 0, clock: 20 / 30 });
  check("wired clock reads in the node's unit", closeAll(chan(wiredSec.out, "phase"), [20 / 30, 5 / 30, 0, 0, 0]), fmt(chan(wiredSec.out, "phase")));
  const frac = run(pts, BASE, { frame: 4.5 });
  check("unwired clock is fractional frames (tick / ticksPerFrame)", !!frac.out && close(chan(frac.out, "phase")![1], 2.5 / 4), fmt(chan(frac.out, "phase")));
}

// --- edge cases ----------------------------------------------------------
{
  const zero = run(pts, { ...BASE, duration: 0 }, { frame: 5 });
  check("duration 0: phase is a step", closeAll(chan(zero.out, "phase"), [1, 1, 1, 0, 0]), fmt(chan(zero.out, "phase")));
  check("duration 0: never in flight", closeAll(chan(zero.out, "phase_active"), [0, 0, 0, 0, 0]), fmt(chan(zero.out, "phase_active")));
}
{
  const { out } = run(pts, { ...BASE, extras: false }, { frame: 5 });
  check("extras off: only the phase channel is written", !!out && !!chan(out, "phase") && !chan(out, "phase_t0") && !chan(out, "phase_active"));
}
{
  const withPhase = copyPointsWith(pts, {
    attributes: { ...pts.attributes, phase: { arity: 1, data: new Float32Array([9, 9, 9, 9, 9]) } },
  });
  const { out } = run(withPhase, BASE, { frame: 5 });
  check("same-name channel is replaced", closeAll(chan(out, "phase"), [1, 0.75, 0.25, 0, 0]), fmt(chan(out, "phase")));
  const renamed = run(pts, { ...BASE, attr_name: "reveal" }, { frame: 5 });
  check("custom name: channels take the name", !!chan(renamed.out, "reveal") && !!chan(renamed.out, "reveal_t0") && !chan(renamed.out, "phase"));
}
{
  const reserved = run(pts, { ...BASE, attr_name: "index" });
  check("reserved name passes the input through untouched", reserved.out === pts && reserved.aux.name?.kind === "string" && reserved.aux.name.value === "index");
  const empty = run(pts, { ...BASE, attr_name: "  " });
  check("empty name passes the input through untouched", empty.out === pts);
  const none = run(undefined, BASE);
  check("no input → empty points", !!none.out && none.out.count === 0);
  const zeroPts = run(makePoints(0, {}), BASE);
  check("zero points pass through", !!zeroPts.out && zeroPts.out.count === 0);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll stagger checks passed");
