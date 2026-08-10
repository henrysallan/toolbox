// check-spline-trails: guards the Spline Trails node's temporal policy
// (src/nodes/effect/spline-trails.ts — 080926_spline-trails.md). The
// accumulation rules — scene-time growth + age expiry, paused head-move
// without growth, rewind clear, stationary contraction, groupIndex:ordinal
// identity through membership churn, tail-width taper — are pure ctx.state
// logic the browser can't cheaply verify, so they live or die here.
//
//   npx tsx scripts/check-spline-trails.mts

import type { NodeOutput, RenderContext, SplineValue } from "../src/engine/types";
import { pointsFromArray } from "../src/engine/points";
import { splineTrailsNode } from "../src/nodes/effect/spline-trails";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeCtx(): RenderContext {
  // The node touches only ctx.time and ctx.state.
  return { time: 0, state: {} } as unknown as RenderContext;
}

const DEFAULTS = {
  length: 0.75,
  curve: "smooth",
  tail_width: 0,
  clear_on_loop: true,
};

function evalAt(
  ctx: RenderContext,
  time: number,
  positions: Array<[number, number]>,
  params: Record<string, unknown> = {},
  groupIndices?: number[]
): SplineValue {
  ctx.time = time;
  const pts = pointsFromArray(
    positions.map((pos, i) => ({
      pos,
      ...(groupIndices ? { groupIndex: groupIndices[i] } : {}),
    }))
  );
  const out = splineTrailsNode.compute({
    inputs: { points: pts },
    auxIn: {},
    params: { ...DEFAULTS, ...params },
    ctx,
    nodeId: "t1",
  } as Parameters<typeof splineTrailsNode.compute>[0]) as NodeOutput;
  return out.primary as SplineValue;
}

// ---- growth: a moving point accumulates one subpath, oldest → newest ----
{
  const ctx = makeCtx();
  let out: SplineValue = { kind: "spline", subpaths: [] };
  for (let f = 0; f < 10; f++) {
    out = evalAt(ctx, f / 30, [[0.1 + f * 0.02, 0.5]]);
  }
  check("growth: one subpath", out.subpaths.length === 1);
  const anchors = out.subpaths[0]?.anchors ?? [];
  check("growth: 10 anchors after 10 moving evals", anchors.length === 10,
    `got ${anchors.length}`);
  check(
    "growth: oldest first, head last",
    anchors.length === 10 &&
      Math.abs(anchors[0].pos[0] - 0.1) < 1e-6 &&
      Math.abs(anchors[9].pos[0] - 0.28) < 1e-6
  );
  check("growth: open subpath", out.subpaths[0]?.closed === false);

  // ---- expiry: samples older than `length` drop off the tail ----
  // At dt = 1/30 and length = 0.2 the window holds ~7 samples.
  let out2: SplineValue = out;
  for (let f = 10; f < 40; f++) {
    out2 = evalAt(ctx, f / 30, [[0.1 + f * 0.02, 0.5]], { length: 0.2 });
  }
  const n2 = out2.subpaths[0]?.anchors.length ?? 0;
  check("expiry: window caps the trail", n2 >= 6 && n2 <= 8, `got ${n2}`);

  // ---- paused: head follows the point, history doesn't grow ----
  const tPause = 39 / 30;
  const outP = evalAt(ctx, tPause, [[0.9, 0.9]], { length: 0.2 });
  const aP = outP.subpaths[0]?.anchors ?? [];
  check("paused: anchor count unchanged", aP.length === n2, `got ${aP.length}`);
  check(
    "paused: head repositioned",
    aP.length > 0 &&
      Math.abs(aP[aP.length - 1].pos[0] - 0.9) < 1e-6 &&
      Math.abs(aP[aP.length - 1].pos[1] - 0.9) < 1e-6
  );

  // ---- rewind: clear_on_loop resets; first eval re-seeds (no subpath) ----
  const outR = evalAt(ctx, 0, [[0.5, 0.5]], { length: 0.2 });
  check("rewind: cleared to empty", outR.subpaths.length === 0);
}

// ---- stationary: trail contracts by expiry instead of clumping ----
{
  const ctx = makeCtx();
  for (let f = 0; f < 10; f++) {
    evalAt(ctx, f / 30, [[0.1 + f * 0.05, 0.5]], { length: 0.3 });
  }
  // Point stops; time keeps advancing well past `length`.
  let out: SplineValue = { kind: "spline", subpaths: [] };
  for (let f = 10; f < 30; f++) {
    out = evalAt(ctx, f / 30, [[0.55, 0.5]], { length: 0.3 });
  }
  check("stationary: trail fully contracts", out.subpaths.length === 0,
    `got ${out.subpaths.length} subpaths`);
}

// ---- identity: Collect-regime shared groupIndex → per-ordinal trails ----
{
  const ctx = makeCtx();
  let out: SplineValue = { kind: "spline", subpaths: [] };
  for (let f = 0; f < 5; f++) {
    out = evalAt(
      ctx,
      f / 30,
      [
        [0.2 + f * 0.02, 0.3],
        [0.2 + f * 0.02, 0.7],
      ],
      {},
      [7, 7]
    );
  }
  check("identity: shared tag splits by ordinal", out.subpaths.length === 2);
  check(
    "identity: subpaths inherit the tag",
    out.subpaths.every((s) => s.groupIndex === 7)
  );
  check(
    "identity: trails stay separate",
    out.subpaths.length === 2 &&
      out.subpaths[0].anchors.every((a) => Math.abs(a.pos[1] - 0.3) < 1e-6) &&
      out.subpaths[1].anchors.every((a) => Math.abs(a.pos[1] - 0.7) < 1e-6)
  );
}

// ---- identity: unique-id regime (Cursor Trail ring) survives shifts ----
{
  const ctx = makeCtx();
  // ids [3,4] for 5 evals, then 3 dies and 5 is born: [4,5].
  for (let f = 0; f < 5; f++) {
    evalAt(
      ctx,
      f / 30,
      [
        [0.1 + f * 0.02, 0.2],
        [0.1 + f * 0.02, 0.8],
      ],
      {},
      [3, 4]
    );
  }
  let out: SplineValue = { kind: "spline", subpaths: [] };
  for (let f = 5; f < 8; f++) {
    out = evalAt(
      ctx,
      f / 30,
      [
        [0.1 + f * 0.02, 0.8],
        [0.1 + f * 0.02, 0.5],
      ],
      {},
      [4, 5]
    );
  }
  const byTag = new Map(out.subpaths.map((s) => [s.groupIndex, s]));
  check(
    "churn: survivor keeps accumulating",
    (byTag.get(4)?.anchors.length ?? 0) === 8,
    `got ${byTag.get(4)?.anchors.length}`
  );
  check(
    "churn: dead id's trail lingers (fading)",
    (byTag.get(3)?.anchors.length ?? 0) === 5,
    `got ${byTag.get(3)?.anchors.length}`
  );
  check(
    "churn: newborn starts fresh",
    (byTag.get(5)?.anchors.length ?? 0) === 3,
    `got ${byTag.get(5)?.anchors.length}`
  );
}

// ---- taper: tail_width ramps anchor.width oldest → 1 at the head ----
{
  const ctx = makeCtx();
  let out: SplineValue = { kind: "spline", subpaths: [] };
  for (let f = 0; f < 6; f++) {
    out = evalAt(ctx, f / 30, [[0.1 + f * 0.05, 0.5]], { tail_width: 0 });
  }
  const a = out.subpaths[0]?.anchors ?? [];
  check(
    "taper: 0 at tail, 1 at head, monotonic",
    a.length === 6 &&
      a[0].width === 0 &&
      a[a.length - 1].width === 1 &&
      a.every((x, i) => i === 0 || (x.width ?? 1) >= (a[i - 1].width ?? 1))
  );
  const outU = evalAt(ctx, 7 / 30, [[0.6, 0.5]], { tail_width: 1 });
  check(
    "taper: 1 writes no widths",
    (outU.subpaths[0]?.anchors ?? []).every((x) => x.width === undefined)
  );
}

// ---- smooth vs linear anchors ----
{
  const ctx = makeCtx();
  let out: SplineValue = { kind: "spline", subpaths: [] };
  for (let f = 0; f < 4; f++) {
    out = evalAt(ctx, f / 30, [[0.1 + f * 0.1, 0.5 + (f % 2) * 0.1]], {
      curve: "linear",
    });
  }
  check(
    "linear: corner anchors (no handles)",
    (out.subpaths[0]?.anchors ?? []).every(
      (a) => !a.inHandle && !a.outHandle
    )
  );
  const ctx2 = makeCtx();
  let out2: SplineValue = { kind: "spline", subpaths: [] };
  for (let f = 0; f < 4; f++) {
    out2 = evalAt(ctx2, f / 30, [[0.1 + f * 0.1, 0.5 + (f % 2) * 0.1]], {
      curve: "smooth",
    });
  }
  check(
    "smooth: interior anchors get handles",
    (out2.subpaths[0]?.anchors ?? [])
      .slice(1, -1)
      .every((a) => a.inHandle && a.outHandle)
  );
}

if (failures > 0) {
  console.error(`\ncheck-spline-trails: ${failures} FAILED`);
  process.exit(1);
}
console.log("\ncheck-spline-trails: all passed");
