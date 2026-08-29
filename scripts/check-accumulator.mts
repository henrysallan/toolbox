// check-accumulator: guards the Accumulator node's scalar integral and
// points-pile paths (src/nodes/effect/accumulator.ts). Points append is
// scene-time state — paused / same-timestamp re-evals must not grow the
// set, rewind clears, index modes stamp groupIndex differently, overflow
// caps. Autocoerce (spline/vec2 → points) is compute-side.
//
//   npx tsx scripts/check-accumulator.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
  SocketValue,
  SplineValue,
} from "../src/engine/types";
import { coerceValue } from "../src/engine/coerce";
import { copyPointsWith, overlayAge, POINT_AGE_ATTR, pointsFromArray } from "../src/engine/points";
import { accumulatorNode } from "../src/nodes/effect/accumulator";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Positions live in Float32Arrays — 1e-9 is tighter than f32 vs f64.
function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-5;
}

function makeCtx(): RenderContext {
  return { time: 0, playing: true, state: {} } as unknown as RenderContext;
}

const SCALAR_DEFAULTS = {
  type: "scalar",
  mode: "sum",
  initial: 0,
  range: "free",
  min: 0,
  max: 1,
};

const POINTS_DEFAULTS = {
  type: "points",
  index_mode: "append",
  max_points: 4096,
  overflow: "stop",
};

function evalNode(
  ctx: RenderContext,
  time: number,
  input: SocketValue | undefined,
  params: Record<string, unknown>,
  extra: { playing?: boolean; reset?: number } = {}
): SocketValue | undefined {
  ctx.time = time;
  ctx.playing = extra.playing ?? true;
  const inputs: Record<string, SocketValue | undefined> = { input };
  if (extra.reset !== undefined) {
    inputs.reset = { kind: "scalar", value: extra.reset };
  }
  const sockets = accumulatorNode.resolveInputs!(params, {
    connectedTypes: { input: input?.kind as never },
  });
  const inputSock = sockets.find((s) => s.name === "input");
  const coerced = coerceValue(input, inputSock?.type ?? "scalar", ctx);
  const out = accumulatorNode.compute({
    inputs: { ...inputs, input: coerced },
    auxIn: {},
    params,
    ctx,
    nodeId: "a1",
  } as Parameters<typeof accumulatorNode.compute>[0]) as NodeOutput;
  return out.primary;
}

function pts(positions: Array<[number, number]>, groups?: number[]): PointsValue {
  return pointsFromArray(
    positions.map((pos, i) => ({
      pos,
      ...(groups ? { groupIndex: groups[i] } : {}),
    }))
  );
}

function asPoints(v: SocketValue | undefined): PointsValue {
  if (!v || v.kind !== "points") {
    return { kind: "points", count: -1, positions: new Float32Array(0), points: [] };
  }
  return v;
}

function agesOf(p: PointsValue): number[] {
  const a = p.attributes?.[POINT_AGE_ATTR];
  return a ? Array.from(a.data) : [];
}

function agesClose(p: PointsValue, expected: number[]): boolean {
  const got = agesOf(p);
  if (got.length !== expected.length) return false;
  for (let i = 0; i < got.length; i++) if (!close(got[i], expected[i])) return false;
  return true;
}

// ---- scalar regression: sum mode adds each playing eval ----
{
  const ctx = makeCtx();
  let out = evalNode(ctx, 0, { kind: "scalar", value: 2 }, SCALAR_DEFAULTS);
  check(
    "scalar sum: first playing eval at t=0 adds",
    out?.kind === "scalar" && close(out.value, 2),
    `got ${out && out.kind === "scalar" ? out.value : out?.kind}`
  );
  out = evalNode(ctx, 1 / 30, { kind: "scalar", value: 3 }, SCALAR_DEFAULTS);
  check(
    "scalar sum: second eval adds again",
    out?.kind === "scalar" && close(out.value, 5),
    `got ${out && out.kind === "scalar" ? out.value : out?.kind}`
  );
  out = evalNode(ctx, 1 / 30, { kind: "scalar", value: 9 }, SCALAR_DEFAULTS, {
    playing: false,
  });
  check(
    "scalar sum: paused does not add",
    out?.kind === "scalar" && close(out.value, 5)
  );
}

// ---- points: append over advancing time ----
{
  const ctx = makeCtx();
  const batch = (x: number) => pts([[x, 0.1], [x, 0.2]]);
  let out = asPoints(evalNode(ctx, 0, batch(0.1), POINTS_DEFAULTS));
  check("append: first frame has 2 points", out.count === 2, `got ${out.count}`);
  out = asPoints(evalNode(ctx, 1 / 30, batch(0.2), POINTS_DEFAULTS));
  check("append: second frame piles to 4", out.count === 4, `got ${out.count}`);
  out = asPoints(evalNode(ctx, 2 / 30, batch(0.3), POINTS_DEFAULTS));
  check("append: third frame piles to 6", out.count === 6, `got ${out.count}`);
  check(
    "append: first point stays put",
    close(out.positions[0], 0.1) && close(out.positions[1], 0.1)
  );
  check(
    "append: newest batch is on top",
    close(out.positions[8], 0.3) && close(out.positions[10], 0.3)
  );

  const same = asPoints(
    evalNode(ctx, 2 / 30, batch(0.9), POINTS_DEFAULTS)
  );
  check(
    "append: same-timestamp re-eval does not double-add",
    same.count === 6,
    `got ${same.count}`
  );

  const paused = asPoints(
    evalNode(ctx, 3 / 30, batch(0.4), POINTS_DEFAULTS, { playing: false })
  );
  check("append: paused does not grow", paused.count === 6, `got ${paused.count}`);
}

// ---- loop / rewind clears ----
{
  const ctx = makeCtx();
  evalNode(ctx, 0, pts([[0.1, 0.1]]), POINTS_DEFAULTS);
  evalNode(ctx, 1.0, pts([[0.2, 0.2]]), POINTS_DEFAULTS);
  const looped = asPoints(evalNode(ctx, 0, pts([[0.5, 0.5]]), POINTS_DEFAULTS));
  check(
    "loop: time wrapping to 0 resets then adds the new batch",
    looped.count === 1 && close(looped.positions[0], 0.5),
    `count=${looped.count}`
  );
}

// ---- explicit reset holds empty ----
{
  const ctx = makeCtx();
  evalNode(ctx, 0, pts([[0.1, 0.1]]), POINTS_DEFAULTS);
  const held = asPoints(
    evalNode(ctx, 1 / 30, pts([[0.2, 0.2]]), POINTS_DEFAULTS, { reset: 1 })
  );
  check("reset: held high clears", held.count === 0, `got ${held.count}`);
  const after = asPoints(
    evalNode(ctx, 2 / 30, pts([[0.3, 0.3]]), POINTS_DEFAULTS, { reset: 0 })
  );
  check(
    "reset: release resumes from empty with the new batch",
    after.count === 1 && close(after.positions[0], 0.3),
    `count=${after.count}`
  );
}

// ---- index modes ----
{
  const ctx = makeCtx();
  const g0 = pts([[0.1, 0.1], [0.2, 0.2]], [7, 8]);
  const g1 = pts([[0.3, 0.3]], [9]);
  let out = asPoints(evalNode(ctx, 0, g0, POINTS_DEFAULTS));
  out = asPoints(evalNode(ctx, 1 / 30, g1, POINTS_DEFAULTS));
  check(
    "append: preserves incoming groupIndex",
    !!out.groupIndices &&
      out.groupIndices[0] === 7 &&
      out.groupIndices[1] === 8 &&
      out.groupIndices[2] === 9
  );
}

{
  const ctx = makeCtx();
  const params = { ...POINTS_DEFAULTS, index_mode: "generation" };
  let out = asPoints(evalNode(ctx, 0, pts([[0.1, 0.1], [0.2, 0.2]]), params));
  out = asPoints(evalNode(ctx, 1 / 30, pts([[0.3, 0.3]]), params));
  out = asPoints(evalNode(ctx, 2 / 30, pts([[0.4, 0.4]]), params));
  check(
    "generation: batches tagged 0,1,2",
    !!out.groupIndices &&
      out.groupIndices[0] === 0 &&
      out.groupIndices[1] === 0 &&
      out.groupIndices[2] === 1 &&
      out.groupIndices[3] === 2,
    `got ${out.groupIndices ? Array.from(out.groupIndices).join(",") : "none"}`
  );
}

{
  const ctx = makeCtx();
  const params = { ...POINTS_DEFAULTS, index_mode: "unique" };
  let out = asPoints(evalNode(ctx, 0, pts([[0.1, 0.1], [0.2, 0.2]]), params));
  out = asPoints(evalNode(ctx, 1 / 30, pts([[0.3, 0.3]]), params));
  check(
    "unique: sequential ids 0,1,2",
    !!out.groupIndices &&
      out.groupIndices[0] === 0 &&
      out.groupIndices[1] === 1 &&
      out.groupIndices[2] === 2,
    `got ${out.groupIndices ? Array.from(out.groupIndices).join(",") : "none"}`
  );
}

// ---- overflow ----
{
  const ctx = makeCtx();
  const params = { ...POINTS_DEFAULTS, max_points: 3, overflow: "stop" };
  evalNode(ctx, 0, pts([[0.1, 0.1], [0.2, 0.2]]), params);
  const out = asPoints(
    evalNode(ctx, 1 / 30, pts([[0.3, 0.3], [0.4, 0.4]]), params)
  );
  check("overflow stop: caps at max, prefix of incoming", out.count === 3, `got ${out.count}`);
  check(
    "overflow stop: kept the one new point that fit",
    close(out.positions[4], 0.3)
  );
}

{
  const ctx = makeCtx();
  const params = { ...POINTS_DEFAULTS, max_points: 3, overflow: "ring" };
  evalNode(ctx, 0, pts([[0.1, 0.1], [0.2, 0.2]]), params);
  const out = asPoints(
    evalNode(ctx, 1 / 30, pts([[0.3, 0.3], [0.4, 0.4]]), params)
  );
  check("overflow ring: stays at max", out.count === 3, `got ${out.count}`);
  check(
    "overflow ring: dropped the oldest, newest on top",
    close(out.positions[0], 0.2) &&
      close(out.positions[2], 0.3) &&
      close(out.positions[4], 0.4)
  );
}

// ---- autocoerce spline / vec2 ----
{
  const ctx = makeCtx();
  const spline: SplineValue = {
    kind: "spline",
    subpaths: [
      {
        anchors: [{ pos: [0.1, 0.2] }, { pos: [0.3, 0.4] }],
        closed: false,
      },
    ],
  };
  const sockets = accumulatorNode.resolveInputs!(
    { type: "scalar" },
    { connectedTypes: { input: "spline" } }
  );
  check(
    "resolveInputs: spline wire retypes input to spline",
    sockets.find((s) => s.name === "input")?.type === "spline"
  );
  check(
    "resolvePrimaryOutput: spline wire → points",
    accumulatorNode.resolvePrimaryOutput?.(
      { type: "scalar" },
      { connectedTypes: { input: "spline" } }
    ) === "points"
  );
  let out = asPoints(evalNode(ctx, 0, spline, { ...POINTS_DEFAULTS, type: "scalar" }));
  check("spline coerce: first frame has 2 anchors", out.count === 2, `got ${out.count}`);
  out = asPoints(
    evalNode(ctx, 1 / 30, spline, { ...POINTS_DEFAULTS, type: "scalar" })
  );
  check("spline coerce: second frame piles to 4", out.count === 4, `got ${out.count}`);
}

{
  const ctx = makeCtx();
  const out1 = asPoints(
    evalNode(ctx, 0, { kind: "vec2", value: [0.25, 0.75] }, POINTS_DEFAULTS)
  );
  const out2 = asPoints(
    evalNode(ctx, 1 / 30, { kind: "vec2", value: [0.5, 0.5] }, POINTS_DEFAULTS)
  );
  check("vec2 coerce: one point per frame", out1.count === 1 && out2.count === 2);
  check(
    "vec2 coerce: positions land as authored",
    close(out2.positions[0], 0.25) && close(out2.positions[2], 0.5)
  );
}

// ---- age channel ----
{
  const ctx = makeCtx();
  const batch = (x: number) => pts([[x, 0.1], [x, 0.2]]);
  let out = asPoints(evalNode(ctx, 0, batch(0.1), POINTS_DEFAULTS));
  check(
    "age: first batch is born at t=0",
    agesClose(out, [0, 0]),
    `got ${agesOf(out).join(",")}`
  );
  out = asPoints(evalNode(ctx, 1, batch(0.2), POINTS_DEFAULTS));
  check("age: second batch piles to 4", out.count === 4, `got ${out.count}`);
  check(
    "age: older points aged by dt, new batch is 0",
    agesClose(out, [1, 1, 0, 0]),
    `got ${agesOf(out).join(",")}`
  );
  out = asPoints(evalNode(ctx, 2.5, batch(0.3), POINTS_DEFAULTS));
  check(
    "age: third batch continues the clock",
    agesClose(out, [2.5, 2.5, 1.5, 1.5, 0, 0]),
    `got ${agesOf(out).join(",")}`
  );

  const paused = asPoints(
    evalNode(ctx, 5, batch(0.9), POINTS_DEFAULTS, { playing: false })
  );
  check("age: paused does not grow the pile", paused.count === 6);
  check(
    "age: paused still derives from playhead",
    agesClose(paused, [5, 5, 4, 4, 2.5, 2.5]),
    `got ${agesOf(paused).join(",")}`
  );

  const same = asPoints(evalNode(ctx, 5, batch(0.9), POINTS_DEFAULTS, { playing: false }));
  check(
    "age: same-timestamp re-eval is stable",
    agesClose(same, [5, 5, 4, 4, 2.5, 2.5])
  );
}

{
  const ctx = makeCtx();
  const withAge = copyPointsWith(pts([[0.1, 0.1]]), {
    attributes: {
      [POINT_AGE_ATTR]: { arity: 1, data: new Float32Array([99]) },
      weight: { arity: 1, data: new Float32Array([0.4]) },
    },
  });
  evalNode(ctx, 0, withAge, POINTS_DEFAULTS);
  const out = asPoints(evalNode(ctx, 1, withAge, POINTS_DEFAULTS));
  check(
    "age: incoming age is overwritten (node owns the name)",
    agesClose(out, [1, 0]),
    `got ${agesOf(out).join(",")}`
  );
  check(
    "age: other incoming channels survive the pile",
    close(out.attributes?.weight?.data[0] ?? -1, 0.4) &&
      close(out.attributes?.weight?.data[1] ?? -1, 0.4)
  );
}

{
  const ctx = makeCtx();
  const params = { ...POINTS_DEFAULTS, max_points: 3, overflow: "ring" };
  evalNode(ctx, 0, pts([[0.1, 0.1], [0.2, 0.2]]), params);
  const out = asPoints(evalNode(ctx, 2, pts([[0.3, 0.3], [0.4, 0.4]]), params));
  check("age ring: stays at max", out.count === 3);
  check(
    "age ring: surviving point keeps its birth, new points are 0",
    agesClose(out, [2, 0, 0]),
    `got ${agesOf(out).join(",")}`
  );
}

{
  const ctx = makeCtx();
  evalNode(ctx, 0, pts([[0.1, 0.1]]), POINTS_DEFAULTS);
  evalNode(ctx, 1, pts([[0.2, 0.2]]), POINTS_DEFAULTS);
  const looped = asPoints(evalNode(ctx, 0, pts([[0.5, 0.5]]), POINTS_DEFAULTS));
  check(
    "age: time wrap resets births",
    looped.count === 1 && agesClose(looped, [0]),
    `count=${looped.count} ages=${agesOf(looped).join(",")}`
  );
}

{
  const data = overlayAge(pts([[0.2, 0.3]]), new Float32Array([1.25]), 3);
  check(
    "overlayAge: empty set stays empty",
    overlayAge(
      { kind: "points", count: 0, positions: new Float32Array(0), points: [] },
      new Float32Array(0),
      4
    ).count === 0
  );
  check("overlayAge: helper matches time − birth", close(data.attributes![POINT_AGE_ATTR].data[0], 1.75));
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
