// Guards the shared subpath-driver attr read, transformSubpath's
// non-geometric field preservation, and Copy to Points' driver write +
// points→splines attr gather.
//
//   npx tsx scripts/check-subpath-driver.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
  SplineSubpath,
  SplineValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { copyPointsWith, makePoints } from "../src/engine/points.ts";
import { makeSubpathDriverFn } from "../src/engine/spline-color-source.ts";
import { transformSubpath } from "../src/engine/spline-transform.ts";
import { collectNode } from "../src/nodes/effect/collect.ts";
import { copyToPointsNode } from "../src/nodes/effect/copy-to-points.ts";
import { rasterizeSplineNode } from "../src/nodes/effect/rasterize-spline.ts";
import { strokeNode } from "../src/nodes/effect/stroke.ts";

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

function square(extra?: Partial<SplineSubpath>): SplineSubpath {
  return {
    closed: true,
    anchors: [
      { pos: [0.4, 0.4], width: 2, attrs: { w: 0.25 } },
      { pos: [0.6, 0.4] },
      { pos: [0.6, 0.6] },
      { pos: [0.4, 0.6] },
    ],
    groupIndex: 3,
    driver: 0.2,
    attrs: { existing: 9, weight: 0.1 },
    ...extra,
  };
}

{
  const moved = transformSubpath(square(), {
    translateX: 0.1,
    translateY: -0.05,
    scaleX: 1.5,
    scaleY: 0.5,
    rotateDeg: 30,
    pivotX: 0.5,
    pivotY: 0.5,
  });
  check(
    "transformSubpath keeps closed / groupIndex / driver",
    moved.closed === true && moved.groupIndex === 3 && moved.driver === 0.2
  );
  check(
    "transformSubpath keeps subpath attrs",
    moved.attrs?.existing === 9 && moved.attrs?.weight === 0.1
  );
  check(
    "transformSubpath keeps anchor width + attrs",
    moved.anchors[0].width === 2 && moved.anchors[0].attrs?.w === 0.25
  );
  check(
    "transformSubpath actually moved geometry",
    !close(moved.anchors[0].pos[0], 0.4)
  );
}

{
  const subs: SplineSubpath[] = [
    { ...square(), driver: 0.8, attrs: { heat: 0.25, rgb: [0.9, 0.1, 0] } },
    { ...square(), driver: 0.1, attrs: {} },
  ];
  const byDriver = makeSubpathDriverFn(subs, {
    by: "driver",
    seed: 0,
    angleDeg: 0,
  });
  check("driver by with no attr reads sub.driver", close(byDriver(0, subs[0]), 0.8));

  const byHeat = makeSubpathDriverFn(subs, {
    by: "driver",
    seed: 0,
    angleDeg: 0,
    attr: "heat",
  });
  check("driver by named attr reads component 0", close(byHeat(0, subs[0]), 0.25));

  const byRgb = makeSubpathDriverFn(subs, {
    by: "driver",
    seed: 0,
    angleDeg: 0,
    attr: "rgb",
  });
  check("driver by vec attr uses component 0", close(byRgb(0, subs[0]), 0.9));

  const missing = makeSubpathDriverFn(subs, {
    by: "driver",
    seed: 0,
    angleDeg: 0,
    attr: "heat",
  });
  check(
    "missing named attr falls back to sub.driver",
    close(missing(1, subs[1]), 0.1)
  );
}

{
  const ctx = makeCtx();
  const pts = makePoints(2);
  pts.positions.set([0.2, 0.3, 0.8, 0.7]);
  const targets: PointsValue = copyPointsWith(pts, {
    attributes: {
      weight: { arity: 1, data: new Float32Array([0.2, 0.9]) },
      rgb: { arity: 3, data: new Float32Array([1, 0, 0, 0, 1, 0]) },
    },
  });
  const inst: SplineValue = {
    kind: "spline",
    subpaths: [square()],
  };
  const out = copyToPointsNode.compute({
    inputs: {
      points: coerceValue(targets, "points", ctx),
      instance: coerceValue(inst, "spline", ctx),
    },
    auxIn: {},
    params: { mode: "spline", driver_attr: "weight" },
    ctx,
    nodeId: "ctp",
  }) as NodeOutput;
  const subs = out.primary?.kind === "spline" ? out.primary.subpaths : [];
  check("copy-to-points spline emits one subpath per target", subs.length === 2);
  check(
    "copy-to-points writes driver_attr onto sub.driver",
    close(subs[0]?.driver ?? -1, 0.2) && close(subs[1]?.driver ?? -1, 0.9)
  );
  check(
    "copy-to-points gathers target attrs onto copies",
    close((subs[0]?.attrs?.weight as number) ?? -1, 0.2) &&
      Array.isArray(subs[1]?.attrs?.rgb) &&
      close((subs[1].attrs!.rgb as number[])[1], 1),
    `weight=${String(subs[0]?.attrs?.weight)} rgb=${JSON.stringify(subs[1]?.attrs?.rgb)}`
  );
  check(
    "copy-to-points keeps instance attrs under the gather",
    subs[0]?.attrs?.existing === 9
  );
  check(
    "copy-to-points preserves instance width profiles",
    subs[0]?.anchors[0].width === 2 && subs[1]?.anchors[0].width === 2
  );
}

{
  const rNames = rasterizeSplineNode.params.map((p) => p.name);
  check(
    "Rasterize declares fill/stroke driver_attr + thickness block",
    rNames.includes("driver_attr") &&
      rNames.includes("stroke_driver_attr") &&
      rNames.includes("thickness_source") &&
      rNames.includes("thickness_by") &&
      rNames.includes("thickness_driver_attr") &&
      rNames.includes("thickness_lo") &&
      rNames.includes("thickness_hi")
  );
  const sNames = strokeNode.params.map((p) => p.name);
  check(
    "Stroke declares color/thickness driver_attr",
    sNames.includes("driver_attr") && sNames.includes("thickness_driver_attr")
  );
  const cInputs = copyToPointsNode.inputs.map((s) => s.name);
  check(
    "Copy to Points declares driver_field input",
    cInputs.includes("driver_field")
  );
}

// Combine (collect) in spline mode concatenates subpaths and retags
// groupIndex — and since 2026-09-20 carries `driver`, per-subpath `attrs`
// and the anchors (with their attrs) through untouched. Stripping them was
// what silently broke a Rasterize ramp driven by a per-subpath channel
// downstream of a Combine.
{
  const ctx = makeCtx();
  const a: SplineValue = {
    kind: "spline",
    subpaths: [square({ groupIndex: 7, driver: 0.2, attrs: { fade: 0.1, tint: [1, 0, 0] } })],
  };
  const b: SplineValue = {
    kind: "spline",
    subpaths: [
      square({ closed: false, driver: 0.9, attrs: { fade: 0.8 } }),
      // A bare subpath: no driver / attrs at all — stays bare.
      { closed: true, anchors: [{ pos: [0, 0] }, { pos: [1, 0] }, { pos: [1, 1] }] },
    ],
  };
  const out = collectNode.compute({
    inputs: {
      a: coerceValue(a, "spline", ctx),
      b: coerceValue(b, "spline", ctx),
    },
    auxIn: {},
    params: { mode: "spline", slots: ["a", "b", "c"] },
    ctx,
    nodeId: "combine",
    consumedOutputs: new Set(["primary"]),
  } as Parameters<typeof collectNode.compute>[0]) as NodeOutput;
  const sp = out.primary?.kind === "spline" ? out.primary.subpaths : [];
  check("Combine spline: three subpaths out (disconnected c dropped)", sp.length === 3);
  check(
    "Combine spline: groupIndex is the connected-socket ordinal, replacing the input's own",
    sp[0]?.groupIndex === 0 && sp[1]?.groupIndex === 1 && sp[2]?.groupIndex === 1
  );
  check(
    "Combine spline: driver carried through",
    close(sp[0]?.driver ?? -1, 0.2) && close(sp[1]?.driver ?? -1, 0.9) && sp[2]?.driver === undefined
  );
  check(
    "Combine spline: per-subpath attrs carried through (scalar and vector)",
    sp[0]?.attrs?.fade === 0.1 &&
      Array.isArray(sp[0]?.attrs?.tint) &&
      (sp[0]!.attrs!.tint as number[])[0] === 1 &&
      sp[1]?.attrs?.fade === 0.8 &&
      sp[2]?.attrs === undefined
  );
  check(
    "Combine spline: anchors (and their attrs) are the same objects, closed flag kept",
    sp[0]?.anchors === a.subpaths[0].anchors &&
      sp[0]?.anchors[0].attrs?.w === 0.25 &&
      sp[0]?.closed === true &&
      sp[1]?.closed === false
  );
  // The carried channel reaches the shared driver read that Rasterize /
  // Stroke ramps use.
  const byAttr = makeSubpathDriverFn(sp, { by: "driver", seed: 0, angleDeg: 0, attr: "fade" });
  const byDriver = makeSubpathDriverFn(sp, { by: "driver", seed: 0, angleDeg: 0 });
  check(
    "Combine spline: a per-subpath channel still drives a ramp downstream",
    close(byAttr(0, sp[0]), 0.1) && close(byAttr(1, sp[1]), 0.8)
  );
  check(
    "Combine spline: driver still drives a ramp downstream",
    close(byDriver(0, sp[0]), 0.2) && close(byDriver(1, sp[1]), 0.9)
  );
  check(
    "Combine spline: inputs are not mutated",
    a.subpaths[0].groupIndex === 7 && b.subpaths[0].groupIndex === 3
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll subpath-driver checks passed.");
