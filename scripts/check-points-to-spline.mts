// Guards Points to Spline layouts: chain stays index-order (+ group
// splits); grid walks rows then columns from ix/iy or a columns param,
// so a warped lattice stays a lattice instead of a zigzag; stride
// windows every k consecutive points into one subpath (k=2 is pairs).
//
//   npx tsx scripts/check-points-to-spline.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
  SplineValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { makePoints } from "../src/engine/points.ts";
import { pointsToSplineNode } from "../src/nodes/effect/points-to-spline.ts";
import { splineToPointsNode } from "../src/nodes/effect/spline-to-points.ts";
import { gridNode } from "../src/nodes/source/grid.ts";

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

function posClose(
  a: [number, number],
  b: [number, number],
  eps = 1e-6
): boolean {
  return close(a[0], b[0], eps) && close(a[1], b[1], eps);
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

function evalSpline(
  pts: PointsValue,
  params: Record<string, unknown>
): SplineValue {
  const ctx = makeCtx();
  const coerced = coerceValue(pts, "points", ctx);
  const out = pointsToSplineNode.compute({
    inputs: { points: coerced },
    auxIn: {},
    params: {
      layout: "chain",
      columns: 5,
      stride: 2,
      curve: "linear",
      closed: false,
      ...params,
    },
    ctx,
    nodeId: "pts",
  }) as NodeOutput;
  if (out.primary?.kind !== "spline") {
    return { kind: "spline", subpaths: [] };
  }
  return out.primary;
}

function anchorsOf(s: SplineValue, i: number): [number, number][] {
  return (s.subpaths[i]?.anchors ?? []).map((a) => a.pos);
}

{
  const pts = makePoints(6);
  for (let i = 0; i < 6; i++) {
    pts.positions[i * 2] = i;
    pts.positions[i * 2 + 1] = 0;
  }
  const out = evalSpline(pts, { layout: "chain" });
  check(
    "chain: untagged input is one subpath in index order",
    out.subpaths.length === 1 &&
      !out.subpaths[0].closed &&
      out.subpaths[0].groupIndex === undefined &&
      anchorsOf(out, 0).length === 6 &&
      posClose(anchorsOf(out, 0)[5], [5, 0])
  );
}

{
  const pts = makePoints(4, { withGroupIndices: true });
  pts.positions.set([0, 0, 1, 0, 0, 1, 1, 1]);
  pts.groupIndices!.set([0, 0, 1, 1]);
  const out = evalSpline(pts, { layout: "chain" });
  check(
    "chain: groupIndex splits into separate subpaths",
    out.subpaths.length === 2 &&
      out.subpaths[0].groupIndex === 0 &&
      out.subpaths[1].groupIndex === 1 &&
      posClose(anchorsOf(out, 0)[1], [1, 0]) &&
      posClose(anchorsOf(out, 1)[1], [1, 1])
  );
}

{
  const ctx = makeCtx();
  const grid = gridNode.compute({
    inputs: {},
    auxIn: {},
    params: {
      countX: 3,
      countY: 3,
      spacingMode: "step",
      spacingX: 0.1,
      spacingY: 0.1,
      x: 0.5,
      y: 0.5,
    },
    ctx,
    nodeId: "grid",
  }) as NodeOutput;
  const pts = grid.primary as PointsValue;
  check(
    "grid source stamps ix/iy",
    pts.attributes?.ix?.data[8] === 2 && pts.attributes?.iy?.data[8] === 2
  );

  const out = evalSpline(pts, { layout: "grid" });
  // 3 rows + 3 columns
  check("grid layout: 3×3 emits 6 polylines", out.subpaths.length === 6);

  const row0 = anchorsOf(out, 0);
  const col0 = anchorsOf(out, 3);
  check(
    "grid layout: first subpath is row 0 left-to-right",
    row0.length === 3 &&
      posClose(row0[0], [pts.positions[0], pts.positions[1]]) &&
      posClose(row0[2], [pts.positions[4], pts.positions[5]])
  );
  check(
    "grid layout: fourth subpath is column 0 top-to-bottom",
    col0.length === 3 &&
      posClose(col0[0], [pts.positions[0], pts.positions[1]]) &&
      posClose(col0[2], [pts.positions[12], pts.positions[13]])
  );
}

{
  // 3×3 lattice shuffled in index order; ix/iy still encode the cell.
  const pts = makePoints(9);
  const ix = new Float32Array(9);
  const iy = new Float32Array(9);
  const order = [8, 0, 5, 2, 7, 1, 4, 6, 3];
  for (let k = 0; k < 9; k++) {
    const cell = order[k];
    const col = cell % 3;
    const row = Math.floor(cell / 3);
    pts.positions[k * 2] = col;
    pts.positions[k * 2 + 1] = row;
    ix[k] = col;
    iy[k] = row;
  }
  pts.attributes = { ix: { arity: 1, data: ix }, iy: { arity: 1, data: iy } };
  const out = evalSpline(pts, { layout: "grid", columns: 99 });
  const row1 = anchorsOf(out, 1);
  check(
    "grid layout: ix/iy beat a wrong columns param after a shuffle",
    out.subpaths.length === 6 &&
      row1.length === 3 &&
      posClose(row1[0], [0, 1]) &&
      posClose(row1[1], [1, 1]) &&
      posClose(row1[2], [2, 1])
  );
}

{
  const pts = makePoints(6);
  for (let i = 0; i < 6; i++) {
    pts.positions[i * 2] = i % 3;
    pts.positions[i * 2 + 1] = Math.floor(i / 3);
  }
  const out = evalSpline(pts, { layout: "grid", columns: 3, closed: true });
  check(
    "grid layout: columns fallback, close ignored",
    out.subpaths.length === 5 &&
      out.subpaths.every((s) => !s.closed) &&
      anchorsOf(out, 0).length === 3 &&
      anchorsOf(out, 2).length === 2
  );
}

{
  const pts = makePoints(6);
  for (let i = 0; i < 6; i++) {
    pts.positions[i * 2] = i;
    pts.positions[i * 2 + 1] = 0;
  }
  const out = evalSpline(pts, { layout: "stride", stride: 2 });
  check(
    "stride: 6 points at k=2 emit 3 pair subpaths",
    out.subpaths.length === 3 &&
      out.subpaths[0].groupIndex === 0 &&
      out.subpaths[1].groupIndex === 1 &&
      out.subpaths[2].groupIndex === 2 &&
      anchorsOf(out, 0).length === 2 &&
      posClose(anchorsOf(out, 0)[0], [0, 0]) &&
      posClose(anchorsOf(out, 0)[1], [1, 0]) &&
      posClose(anchorsOf(out, 2)[0], [4, 0]) &&
      posClose(anchorsOf(out, 2)[1], [5, 0])
  );
}

{
  const pts = makePoints(5);
  for (let i = 0; i < 5; i++) {
    pts.positions[i * 2] = i;
    pts.positions[i * 2 + 1] = 0;
  }
  const out = evalSpline(pts, { layout: "stride", stride: 2 });
  check(
    "stride: leftover shorter than k is dropped",
    out.subpaths.length === 2 &&
      posClose(anchorsOf(out, 1)[1], [3, 0])
  );
}

{
  const pts = makePoints(7);
  for (let i = 0; i < 7; i++) {
    pts.positions[i * 2] = i;
    pts.positions[i * 2 + 1] = 0;
  }
  const out = evalSpline(pts, { layout: "stride", stride: 3 });
  check(
    "stride: k=3 windows, remainder dropped even when leftover ≥ 2",
    out.subpaths.length === 2 &&
      anchorsOf(out, 0).length === 3 &&
      anchorsOf(out, 1).length === 3 &&
      posClose(anchorsOf(out, 1)[2], [5, 0])
  );
}

{
  const pts = makePoints(6, { withGroupIndices: true });
  pts.positions.set([0, 0, 1, 0, 2, 0, 10, 0, 11, 0, 12, 0]);
  pts.groupIndices!.set([0, 0, 0, 1, 1, 1]);
  const out = evalSpline(pts, { layout: "stride", stride: 2 });
  check(
    "stride: each input group is windowed on its own",
    out.subpaths.length === 2 &&
      posClose(anchorsOf(out, 0)[0], [0, 0]) &&
      posClose(anchorsOf(out, 0)[1], [1, 0]) &&
      posClose(anchorsOf(out, 1)[0], [10, 0]) &&
      posClose(anchorsOf(out, 1)[1], [11, 0])
  );
}

{
  const pts = makePoints(4);
  for (let i = 0; i < 4; i++) {
    pts.positions[i * 2] = i;
    pts.positions[i * 2 + 1] = 0;
  }
  const out = evalSpline(pts, { layout: "stride", stride: 2, closed: true });
  check(
    "stride: close applies per window",
    out.subpaths.length === 2 && out.subpaths.every((s) => s.closed)
  );
}

{
  const pts = makePoints(4);
  for (let i = 0; i < 4; i++) {
    pts.positions[i * 2] = i;
    pts.positions[i * 2 + 1] = 0;
  }
  const out = evalSpline(pts, { layout: "stride", stride: 1 });
  check(
    "stride: k < 2 clamps to pairs",
    out.subpaths.length === 2 &&
      anchorsOf(out, 0).length === 2 &&
      posClose(anchorsOf(out, 1)[1], [3, 0])
  );
}

{
  const pts = makePoints(4);
  for (let i = 0; i < 4; i++) {
    pts.positions[i * 2] = i * 0.2;
    pts.positions[i * 2 + 1] = 0.5;
  }
  pts.attributes = {
    weight: { arity: 1, data: new Float32Array([0, 0.3, 0.7, 1]) },
    tint: { arity: 3, data: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0]) },
  };
  const out = evalSpline(pts, { layout: "chain", curve: "linear" });
  const a = out.subpaths[0].anchors;
  check(
    "chain: point channels land on matching anchors",
    a.length === 4 &&
      a[0].attrs?.weight === 0 &&
      a[3].attrs?.weight === 1 &&
      Array.isArray(a[1].attrs?.tint) &&
      close((a[1].attrs!.tint as number[])[1], 1)
  );

  const smooth = evalSpline(pts, { layout: "chain", curve: "smooth" });
  check(
    "chain: smooth catmull-rom keeps anchor attrs",
    close(smooth.subpaths[0].anchors[2].attrs?.weight as number, 0.7)
  );

  const ctx = makeCtx();
  const back = splineToPointsNode.compute({
    inputs: { spline: coerceValue(out, "spline", ctx) },
    auxIn: {},
    params: {},
    ctx,
    nodeId: "s2p",
  }) as NodeOutput;
  const restored = back.primary as PointsValue;
  check(
    "round-trip: Spline to Points restores SoA channels",
    restored.count === 4 &&
      close(restored.attributes?.weight?.data[2] ?? -1, 0.7) &&
      close(restored.attributes?.tint?.data[0] ?? -1, 1) &&
      restored.attributes?.tint?.arity === 3
  );
}

{
  const pts = makePoints(4, { withGroupIndices: true });
  pts.positions.set([0, 0, 1, 0, 0, 1, 1, 1]);
  pts.groupIndices!.set([0, 0, 1, 1]);
  pts.attributes = {
    weight: { arity: 1, data: new Float32Array([10, 11, 20, 21]) },
  };
  const out = evalSpline(pts, { layout: "chain" });
  check(
    "chain: grouped subpaths keep per-point attrs",
    out.subpaths[0].anchors[1].attrs?.weight === 11 &&
      out.subpaths[1].anchors[0].attrs?.weight === 20
  );
}

{
  const pts = makePoints(4);
  pts.positions.set([0, 0, 1, 0, 2, 0, 3, 0]);
  pts.attributes = {
    weight: { arity: 1, data: new Float32Array([1, 2, 3, 4]) },
  };
  const out = evalSpline(pts, { layout: "stride", stride: 2 });
  check(
    "stride: each window copies its points' attrs",
    out.subpaths[0].anchors[0].attrs?.weight === 1 &&
      out.subpaths[0].anchors[1].attrs?.weight === 2 &&
      out.subpaths[1].anchors[0].attrs?.weight === 3 &&
      out.subpaths[1].anchors[1].attrs?.weight === 4
  );
}

{
  const spline: SplineValue = {
    kind: "spline",
    subpaths: [
      {
        closed: false,
        attrs: { tag: 5 },
        anchors: [
          { pos: [0, 0], attrs: { weight: 1 } },
          { pos: [1, 0] },
        ],
      },
    ],
  };
  const ctx = makeCtx();
  const back = splineToPointsNode.compute({
    inputs: { spline: coerceValue(spline, "spline", ctx) },
    auxIn: {},
    params: {},
    ctx,
    nodeId: "s2p-sub",
  }) as NodeOutput;
  const pts = back.primary as PointsValue;
  check(
    "Spline to Points: subpath attrs fall back onto every point; anchor wins",
    close(pts.attributes?.tag?.data[0] ?? -1, 5) &&
      close(pts.attributes?.tag?.data[1] ?? -1, 5) &&
      close(pts.attributes?.weight?.data[0] ?? -1, 1) &&
      close(pts.attributes?.weight?.data[1] ?? 0, 0)
  );
}

{
  const pts = makePoints(9);
  for (let i = 0; i < 9; i++) {
    pts.positions[i * 2] = i % 3;
    pts.positions[i * 2 + 1] = Math.floor(i / 3);
  }
  const rows = evalSpline(pts, { layout: "grid", columns: 3, gridWalk: "rows" });
  const cols = evalSpline(pts, { layout: "grid", columns: 3, gridWalk: "columns" });
  const both = evalSpline(pts, { layout: "grid", columns: 3, gridWalk: "both" });
  check("grid walk=rows emits 3 row polylines", rows.subpaths.length === 3);
  check("grid walk=columns emits 3 column polylines", cols.subpaths.length === 3);
  check("grid walk=both emits 6 (rows then columns)", both.subpaths.length === 6);
}

{
  const pts = makePoints(6, { withGroupIndices: true });
  // Two groups of 3: A=(0,0)(1,0)(2,0) and B=(0,1)(1,1)(2,1)
  pts.positions.set([0, 0, 1, 0, 2, 0, 0, 1, 1, 1, 2, 1]);
  pts.groupIndices!.set([0, 0, 0, 1, 1, 1]);
  const out = evalSpline(pts, { layout: "zip" });
  check("zip: 3 groups-of-2 become 3 pairing lines", out.subpaths.length === 3);
  check(
    "zip: first line connects a0→b0",
    posClose(anchorsOf(out, 0)[0], [0, 0]) && posClose(anchorsOf(out, 0)[1], [0, 1])
  );
  check(
    "zip: last line connects a2→b2",
    posClose(anchorsOf(out, 2)[0], [2, 0]) && posClose(anchorsOf(out, 2)[1], [2, 1])
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
