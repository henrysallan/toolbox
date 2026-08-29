// check-advect-points: accumulate-mode age channel and seed-count
// migration (src/nodes/effect/advect-points.ts). Integrate mode is
// stateless and must not stamp age. Accumulate derives age from
// per-slot birth times so pause/scrub stay honest; the node owns `age`
// on output. Offline — no field image required (null velocity holds
// positions).
//
//   npx tsx scripts/check-advect-points.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
} from "../src/engine/types";
import { coerceValue } from "../src/engine/coerce";
import { copyPointsWith, makePoints, POINT_AGE_ATTR } from "../src/engine/points";
import { advectPointsNode } from "../src/nodes/effect/advect-points";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-5;
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

const ACCUM = {
  mode: "accumulate",
  field_mode: "angle",
  substeps: 1,
  step_size: 0.002,
  invert: false,
  boundary: "clamp",
  speed_jitter: 0,
  seed: 1,
  align_rotation: false,
  trail_length: 24,
};

const INTEGRATE = {
  ...ACCUM,
  mode: "integrate",
  steps: 10,
  trail_stride: 1,
};

function seed(count: number, extra?: Partial<PointsValue>): PointsValue {
  const pts = makePoints(count, { withScales: true });
  for (let i = 0; i < count; i++) {
    pts.positions[i * 2] = 0.1 + i * 0.1;
    pts.positions[i * 2 + 1] = 0.5;
    pts.scales![i * 2] = 1;
    pts.scales![i * 2 + 1] = 1;
  }
  return extra ? copyPointsWith(pts, extra) : pts;
}

function evalAdvect(
  ctx: RenderContext,
  time: number,
  points: PointsValue,
  params: Record<string, unknown>
): PointsValue {
  ctx.time = time;
  const coerced = coerceValue(points, "points", ctx);
  const out = advectPointsNode.compute({
    inputs: { points: coerced },
    auxIn: {},
    params,
    ctx,
    nodeId: "adv",
  } as Parameters<typeof advectPointsNode.compute>[0]) as NodeOutput;
  if (out.primary?.kind !== "points") {
    return { kind: "points", count: -1, positions: new Float32Array(0), points: [] };
  }
  return out.primary;
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

{
  const ctx = makeCtx();
  let out = evalAdvect(ctx, 0, seed(2), ACCUM);
  check("accum: seeds at t=0", out.count === 2);
  check(
    "accum: first eval ages are 0",
    agesClose(out, [0, 0]),
    `got ${agesOf(out).join(",")}`
  );
  out = evalAdvect(ctx, 1, seed(2), ACCUM);
  check(
    "accum: static count ages with the playhead",
    agesClose(out, [1, 1]),
    `got ${agesOf(out).join(",")}`
  );
  out = evalAdvect(ctx, 1, seed(2), ACCUM);
  check(
    "accum: same-timestamp re-eval does not change age",
    agesClose(out, [1, 1])
  );
  out = evalAdvect(ctx, 4, seed(2), ACCUM);
  check(
    "accum: pause-equivalent jump still derives age from time",
    agesClose(out, [4, 4]),
    `got ${agesOf(out).join(",")}`
  );
}

{
  const ctx = makeCtx();
  evalAdvect(ctx, 0, seed(2), ACCUM);
  let out = evalAdvect(ctx, 1, seed(4), ACCUM);
  check("accum grow: count migrates to 4", out.count === 4, `got ${out.count}`);
  check(
    "accum grow: original slots aged, joiners born now",
    agesClose(out, [1, 1, 0, 0]),
    `got ${agesOf(out).join(",")}`
  );
  out = evalAdvect(ctx, 3, seed(4), ACCUM);
  check(
    "accum grow: joiners age from their join time",
    agesClose(out, [3, 3, 2, 2]),
    `got ${agesOf(out).join(",")}`
  );
  out = evalAdvect(ctx, 3, seed(2), ACCUM);
  check("accum shrink: truncates from the top", out.count === 2);
  check(
    "accum shrink: surviving slots keep their births",
    agesClose(out, [3, 3]),
    `got ${agesOf(out).join(",")}`
  );
}

{
  const ctx = makeCtx();
  const weighted = copyPointsWith(seed(2), {
    attributes: {
      weight: { arity: 1, data: new Float32Array([0.2, 0.8]) },
      [POINT_AGE_ATTR]: { arity: 1, data: new Float32Array([99, 99]) },
    },
  });
  evalAdvect(ctx, 0, weighted, ACCUM);
  const out = evalAdvect(ctx, 2, weighted, ACCUM);
  check(
    "accum: seed channels re-read (weight survives)",
    close(out.attributes?.weight?.data[0] ?? -1, 0.2) &&
      close(out.attributes?.weight?.data[1] ?? -1, 0.8)
  );
  check(
    "accum: incoming age is overwritten (node owns the name)",
    agesClose(out, [2, 2]),
    `got ${agesOf(out).join(",")}`
  );
}

{
  const ctx = makeCtx();
  evalAdvect(ctx, 0, seed(2), ACCUM);
  evalAdvect(ctx, 2, seed(2), ACCUM);
  const looped = evalAdvect(ctx, 0, seed(2), ACCUM);
  check(
    "accum: time wrap re-seeds ages at 0",
    looped.count === 2 && agesClose(looped, [0, 0]),
    `ages=${agesOf(looped).join(",")}`
  );
}

{
  const ctx = makeCtx();
  const withAge = copyPointsWith(seed(2), {
    attributes: {
      [POINT_AGE_ATTR]: { arity: 1, data: new Float32Array([7, 8]) },
    },
  });
  const out = evalAdvect(ctx, 0, withAge, INTEGRATE);
  check("integrate: count passes through", out.count === 2);
  check(
    "integrate: does not stamp its own age (seed age carries)",
    agesClose(out, [7, 8]),
    `got ${agesOf(out).join(",")}`
  );
}

{
  const ctx = makeCtx();
  const out = evalAdvect(ctx, 1, seed(3), INTEGRATE);
  check(
    "integrate: no age channel when the seed has none",
    !out.attributes?.[POINT_AGE_ATTR]
  );
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
