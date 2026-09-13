// check-filter-points: Index select (every / equal / range / first / last /
// first and last) plus result=flag (write a 0/1 channel, keep every point).
// Also covers Attribute Math abs / greater than / step on points, and the
// flag → attribute-mode compact round trip.
//
//   npx tsx scripts/check-filter-points.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { copyPointsWith, makePoints } from "../src/engine/points.ts";
import { filterPointsNode } from "../src/nodes/effect/filter-points.ts";
import { attributeMathNode } from "../src/nodes/effect/attribute-math.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function makeCtx(): RenderContext {
  return {
    time: 0,
    playing: true,
    state: {},
    width: 1920,
    height: 1080,
  } as unknown as RenderContext;
}

function line(n: number): PointsValue {
  const pts = makePoints(n, {});
  for (let i = 0; i < n; i++) {
    pts.positions[i * 2] = n > 1 ? i / (n - 1) : 0;
    pts.positions[i * 2 + 1] = 0.5;
  }
  return pts;
}

function evalFilter(
  input: PointsValue | undefined,
  params: Record<string, unknown>,
  socket: "points" | "points3d" = "points"
): PointsValue | undefined {
  const ctx = makeCtx();
  const coerced = coerceValue(input, socket, ctx);
  const out = filterPointsNode.compute({
    inputs: { points: coerced },
    auxIn: {},
    params,
    ctx,
    nodeId: "fp",
  } as Parameters<typeof filterPointsNode.compute>[0]) as NodeOutput;
  return out.primary?.kind === "points" ? out.primary : undefined;
}

function evalMath(
  input: PointsValue | undefined,
  params: Record<string, unknown>
): PointsValue | undefined {
  const ctx = makeCtx();
  const coerced = coerceValue(input, "points", ctx);
  const out = attributeMathNode.compute({
    inputs: { points: coerced },
    auxIn: {},
    params,
    ctx,
    nodeId: "am",
  } as Parameters<typeof attributeMathNode.compute>[0]) as NodeOutput;
  return out.primary?.kind === "points" ? out.primary : undefined;
}

function chan(p: PointsValue | undefined, name: string): Float32Array | undefined {
  return p?.attributes?.[name]?.data;
}

const five = line(5);

{
  const out = evalFilter(five, { mode: "index", every: 2 });
  check(
    "index every (legacy default) keeps 0,2,4",
    !!out && out.count === 3 && close(out.positions[0], 0) && close(out.positions[4], 1)
  );
}

{
  const out = evalFilter(five, { mode: "index", index_by: "first" });
  check(
    "index first keeps only i=0",
    !!out && out.count === 1 && close(out.positions[0], 0)
  );
}

{
  const out = evalFilter(five, { mode: "index", index_by: "last" });
  check(
    "index last keeps only i=n-1",
    !!out && out.count === 1 && close(out.positions[0], 1)
  );
}

{
  const out = evalFilter(five, { mode: "index", index_by: "first and last" });
  check(
    "index first and last keeps two endpoints",
    !!out &&
      out.count === 2 &&
      close(out.positions[0], 0) &&
      close(out.positions[2], 1)
  );
}

{
  const one = line(1);
  const out = evalFilter(one, { mode: "index", index_by: "first and last" });
  check(
    "index first and last on n=1 keeps the single point",
    !!out && out.count === 1
  );
}

{
  const out = evalFilter(five, { mode: "index", index_by: "equal", index_value: 2 });
  check(
    "index equal keeps that index",
    !!out && out.count === 1 && close(out.positions[0], 0.5)
  );
}

{
  const out = evalFilter(five, {
    mode: "index",
    index_by: "range",
    index_min: 1,
    index_max: 3,
  });
  check(
    "index range is inclusive",
    !!out && out.count === 3 && close(out.positions[0], 0.25) && close(out.positions[4], 0.75)
  );
}

{
  const out = evalFilter(five, {
    mode: "index",
    index_by: "first and last",
    invert: true,
  });
  check(
    "invert first and last keeps the interior",
    !!out && out.count === 3 && close(out.positions[0], 0.25)
  );
}

{
  const out = evalFilter(five, {
    mode: "index",
    index_by: "first and last",
    result: "flag",
  });
  const flag = chan(out, "keep");
  check(
    "flag first and last keeps count and writes 1 at the ends",
    !!out &&
      out.count === 5 &&
      !!flag &&
      flag.length === 5 &&
      close(flag[0], 1) &&
      close(flag[1], 0) &&
      close(flag[2], 0) &&
      close(flag[3], 0) &&
      close(flag[4], 1)
  );
  check(
    "flag mode shares positions with the input",
    !!out && out.positions === five.positions
  );
}

{
  const out = evalFilter(five, {
    mode: "index",
    index_by: "first and last",
    result: "flag",
    invert: true,
    flag_name: "sel",
  });
  const flag = chan(out, "sel");
  check(
    "flag invert + custom name writes interior 1s",
    !!out &&
      out.count === 5 &&
      !!flag &&
      close(flag[0], 0) &&
      close(flag[2], 1) &&
      close(flag[4], 0) &&
      !chan(out, "keep")
  );
}

{
  const out = evalFilter(five, {
    mode: "index",
    index_by: "every",
    every: 1,
    result: "flag",
  });
  const flag = chan(out, "keep");
  check(
    "flag all-match still writes a channel of 1s",
    !!out && out.count === 5 && !!flag && [...flag].every((v) => close(v, 1))
  );
}

{
  const out = evalFilter(five, {
    mode: "index",
    index_by: "equal",
    index_value: 99,
    result: "flag",
  });
  const flag = chan(out, "keep");
  check(
    "flag none-match keeps every point and writes 0s",
    !!out && out.count === 5 && !!flag && [...flag].every((v) => close(v, 0))
  );
}

{
  const out = evalFilter(five, {
    mode: "index",
    index_by: "equal",
    index_value: 99,
  });
  check("compact none-match is empty", !!out && out.count === 0);
}

{
  const out = evalFilter(five, {
    mode: "index",
    index_by: "first",
    result: "flag",
    flag_name: "index",
  });
  check(
    "reserved flag name passes the input through",
    out === five
  );
}

{
  const pts3d = makePoints(4, { withZ: true });
  pts3d.z!.set([0, 1, 2, 3]);
  const out = evalFilter(
    pts3d,
    {
      mode: "index",
      index_by: "first and last",
      result: "flag",
    },
    "points3d"
  );
  check(
    "flag on points3d preserves z and writes keep",
    !!out &&
      out.count === 4 &&
      !!out.z &&
      close(out.z[0], 0) &&
      close(out.z[3], 3) &&
      !!chan(out, "keep") &&
      close(chan(out, "keep")![0], 1) &&
      close(chan(out, "keep")![1], 0) &&
      close(chan(out, "keep")![3], 1)
  );
}

{
  const flagged = evalFilter(five, {
    mode: "index",
    index_by: "first and last",
    result: "flag",
  });
  const compacted = evalFilter(flagged, {
    mode: "attribute",
    attr_name: "keep",
    attr_threshold: 0.5,
  });
  check(
    "flag then attribute-mode compact is first and last",
    !!compacted &&
      compacted.count === 2 &&
      close(compacted.positions[0], 0) &&
      close(compacted.positions[2], 1)
  );
}

// --- Attribute Math comparison / step / abs on points -------------------

{
  const src = copyPointsWith(five, {
    attributes: { w: { arity: 1, data: new Float32Array([-2, -0.5, 0, 0.5, 2]) } },
  });
  const abs = evalMath(src, { attr_name: "w", op: "abs" });
  const a = chan(abs, "w");
  check(
    "attribute-math abs on points",
    !!a && close(a[0], 2) && close(a[1], 0.5) && close(a[2], 0) && close(a[4], 2)
  );

  const gt = evalMath(src, {
    attr_name: "w",
    op: "greater than",
    operand: "constant",
    value: 0,
    output_name: "flag",
  });
  const g = chan(gt, "flag");
  check(
    "attribute-math greater than is strict (0 → 0)",
    !!g &&
      close(g[0], 0) &&
      close(g[2], 0) &&
      close(g[3], 1) &&
      close(g[4], 1)
  );

  const lt = evalMath(src, {
    attr_name: "w",
    op: "less than",
    operand: "constant",
    value: 0,
    output_name: "flag",
  });
  const l = chan(lt, "flag");
  check(
    "attribute-math less than is strict",
    !!l && close(l[0], 1) && close(l[2], 0) && close(l[4], 0)
  );

  const step = evalMath(src, {
    attr_name: "w",
    op: "step",
    operand: "constant",
    value: 0,
    output_name: "flag",
  });
  const s = chan(step, "flag");
  check(
    "attribute-math step is inclusive on the edge (0 → 1)",
    !!s && close(s[0], 0) && close(s[2], 1) && close(s[3], 1)
  );
}

{
  const src = copyPointsWith(five, {
    attributes: {
      a: { arity: 1, data: new Float32Array([0, 1, 2, 3, 4]) },
      b: { arity: 1, data: new Float32Array([2, 2, 2, 2, 2]) },
    },
  });
  const out = evalMath(src, {
    attr_name: "a",
    op: "greater than",
    operand: "attribute",
    operand_attr: "b",
    output_name: "flag",
  });
  const g = chan(out, "flag");
  check(
    "attribute-math greater than vs a second channel",
    !!g && close(g[1], 0) && close(g[2], 0) && close(g[3], 1)
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll filter-points checks passed");
