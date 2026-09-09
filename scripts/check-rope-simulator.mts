// Guards Rope Simulator named-attribute bake: per-anchor / per-subpath
// channels are sampled onto particles at reseed (rest pose) and emitted
// on the output spline and aux points, surviving playback so an image
// sampled before the sim does not rebind as the rope drapes.
//
//   npx tsx scripts/check-rope-simulator.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
  SplineValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { ropeSimulatorNode } from "../src/nodes/effect/rope-simulator.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) < eps;
}

function makeCtx(time = 0, playing = false): RenderContext {
  return {
    time,
    playing,
    state: {},
    width: 1920,
    height: 1080,
  } as unknown as RenderContext;
}

const ROPE_PARAMS = {
  segment_px: 512,
  max_points: 2000,
  pin_mode: "both",
  output_mode: "polyline",
  gravity_x: 0,
  gravity_y: 0.35,
  forceCount: 0,
  colliderCount: 0,
  tearing: false,
  self_collide: false,
  boundsMode: "off",
  follow_input: false,
};

function evalRope(
  ctx: RenderContext,
  spline: SplineValue,
  extra: Record<string, unknown> = {}
): { spline: SplineValue; points: PointsValue | undefined } {
  const coerced = coerceValue(spline, "spline", ctx);
  const out = ropeSimulatorNode.compute({
    inputs: { splines: coerced },
    auxIn: {},
    params: { ...ROPE_PARAMS, ...extra },
    ctx,
    nodeId: "rope",
  }) as NodeOutput;
  return {
    spline:
      out.primary?.kind === "spline"
        ? out.primary
        : { kind: "spline", subpaths: [] },
    points: out.aux?.points?.kind === "points" ? out.aux.points : undefined,
  };
}

const rest: SplineValue = {
  kind: "spline",
  subpaths: [
    {
      closed: false,
      groupIndex: 3,
      attrs: { tag: 9 },
      anchors: [
        { pos: [0.1, 0.4], attrs: { weight: 0, tint: [1, 0, 0] } },
        { pos: [0.9, 0.4], attrs: { weight: 1, tint: [0, 0, 1] } },
      ],
    },
  ],
};

{
  const ctx = makeCtx(0, false);
  const { spline, points } = evalRope(ctx, rest);
  const sub = spline.subpaths[0];
  const n = sub?.anchors.length ?? 0;
  check("seed emits a polyline with ≥ 2 anchors", n >= 2);
  check(
    "output subpath keeps groupIndex and subpath attrs",
    sub?.groupIndex === 3 && sub?.attrs?.tag === 9
  );
  const w0 = sub?.anchors[0].attrs?.weight as number;
  const w1 = sub?.anchors[n - 1].attrs?.weight as number;
  check(
    "endpoint particles bake rest-pose anchor attrs",
    close(w0, 0) && close(w1, 1)
  );
  if (n >= 3) {
    const mid = sub!.anchors[Math.floor(n / 2)].attrs?.weight as number;
    check(
      "interior particle interpolates along rest arc length",
      mid > 0.1 && mid < 0.9
    );
  }
  check(
    "aux points carry the same baked channels",
    !!points &&
      points.count === n &&
      close(points.attributes?.weight?.data[0] ?? -1, 0) &&
      close(points.attributes?.weight?.data[points.count - 1] ?? -1, 1) &&
      close(points.attributes?.tag?.data[0] ?? -1, 9)
  );
}

{
  const ctx = makeCtx(0, false);
  evalRope(ctx, rest);
  const seeded = ctx.state["rope-simulator:rope"] as
    | { particleAttrs: Array<{ weight?: number } | undefined> }
    | undefined;
  const baked = seeded?.particleAttrs.map((a) => a?.weight ?? -1) ?? [];
  ctx.time = 0.25;
  ctx.playing = true;
  const { spline, points } = evalRope(ctx, rest);
  const after = spline.subpaths[0]?.anchors.map(
    (a) => a.attrs?.weight as number
  );
  check(
    "playback keeps baked attrs (does not re-sample the moving pose)",
    baked.length > 0 &&
      !!after &&
      after.length === baked.length &&
      after.every((w, i) => close(w, baked[i])) &&
      !!points &&
      close(points.attributes?.weight?.data[0] ?? -1, baked[0])
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
