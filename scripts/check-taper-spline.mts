// Guards Taper Spline (per-anchor scale over path progress) and Spiral
// startAngle / reverse.
//
//   npx tsx scripts/check-taper-spline.mts

import type {
  NodeOutput,
  RenderContext,
  SplineValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { defaultFloatCurve } from "../src/engine/float-curve.ts";
import { taperSplineNode } from "../src/nodes/effect/taper-spline.ts";
import { spiralNode } from "../src/nodes/source/spiral.ts";

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

function makeCtx(): RenderContext {
  return {
    time: 0,
    playing: true,
    state: {},
    width: 1920,
    height: 1080,
  } as unknown as RenderContext;
}

function evalTaper(
  path: SplineValue,
  params: Record<string, unknown>
): SplineValue {
  const ctx = makeCtx();
  const coerced = coerceValue(path, "spline", ctx);
  const out = taperSplineNode.compute({
    inputs: { path: coerced },
    auxIn: {},
    params: {
      pivot: "centroid",
      pivotX: 0.5,
      pivotY: 0.5,
      axis: "xy",
      curve: defaultFloatCurve(0, 1),
      out_lo: 1,
      out_hi: 0,
      ...params,
    },
    ctx,
    nodeId: "taper",
  } as Parameters<typeof taperSplineNode.compute>[0]) as NodeOutput;
  if (out.primary?.kind !== "spline") {
    return { kind: "spline", subpaths: [] };
  }
  return out.primary;
}

function evalSpiral(params: Record<string, unknown>): SplineValue {
  const ctx = makeCtx();
  const out = spiralNode.compute({
    inputs: {},
    auxIn: {},
    params: {
      centerX: 0.5,
      centerY: 0.5,
      turns: 1,
      innerRadius: 0.1,
      outerRadius: 0.3,
      pointsPerTurn: 8,
      startAngle: 0,
      direction: "clockwise",
      reverse: false,
      ...params,
    },
    ctx,
    nodeId: "spiral",
  } as Parameters<typeof spiralNode.compute>[0]) as NodeOutput;
  if (out.primary?.kind !== "spline") {
    return { kind: "spline", subpaths: [] };
  }
  return out.primary;
}

{
  const path: SplineValue = {
    kind: "spline",
    subpaths: [
      {
        closed: false,
        anchors: [
          { pos: [0.4, 0.5] },
          { pos: [0.5, 0.5] },
          { pos: [0.6, 0.5] },
        ],
      },
    ],
  };
  const out = evalTaper(path, { pivot: "custom", pivotX: 0.5, pivotY: 0.5 });
  const a = out.subpaths[0]?.anchors ?? [];
  check("taper: start (t=0) stays at full offset", close(a[0]?.pos[0] ?? 0, 0.4));
  check("taper: end (t=1) collapses onto the pivot", close(a[2]?.pos[0] ?? -1, 0.5));
}

{
  const path: SplineValue = {
    kind: "spline",
    subpaths: [
      {
        closed: false,
        anchors: [
          { pos: [0.4, 0.4] },
          { pos: [0.6, 0.6] },
        ],
      },
    ],
  };
  const out = evalTaper(path, {
    pivot: "custom",
    pivotX: 0.5,
    pivotY: 0.5,
    axis: "x",
    out_lo: 0,
    out_hi: 0,
  });
  const a = out.subpaths[0]?.anchors ?? [];
  check(
    "taper axis=x: x collapses, y is unchanged",
    close(a[0]?.pos[0] ?? -1, 0.5) &&
      close(a[0]?.pos[1] ?? -1, 0.4) &&
      close(a[1]?.pos[0] ?? -1, 0.5) &&
      close(a[1]?.pos[1] ?? -1, 0.6)
  );
}

{
  const fwd = evalSpiral({ startAngle: 0, reverse: false });
  const rot = evalSpiral({ startAngle: 90, reverse: false });
  const rev = evalSpiral({ startAngle: 0, reverse: true });
  const a0 = fwd.subpaths[0]?.anchors[0]?.pos;
  const r0 = rot.subpaths[0]?.anchors[0]?.pos;
  const v0 = rev.subpaths[0]?.anchors[0]?.pos;
  const vN = rev.subpaths[0]?.anchors.at(-1)?.pos;
  check(
    "spiral startAngle=0 begins at +X (inner radius)",
    !!a0 && close(a0[0], 0.5 + 0.1) && close(a0[1], 0.5)
  );
  check(
    "spiral startAngle=90° begins at +Y (Y-down)",
    !!r0 && close(r0[0], 0.5) && close(r0[1], 0.5 + 0.1)
  );
  check(
    "spiral reverse starts at outer radius",
    !!v0 && close(v0[0], 0.5 + 0.3) && close(v0[1], 0.5)
  );
  check(
    "spiral reverse ends at inner radius",
    !!vN && close(vN[0], 0.5 + 0.1) && close(vN[1], 0.5)
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
