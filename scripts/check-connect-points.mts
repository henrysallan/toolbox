// Guards Connect Points' distance band: max_distance is a ceiling,
// min_distance a floor (close pairs stay unconnected), and
// min_connections is a one-pass degree filter on the remaining graph.
// Offline — points in, spline out, through coerceValue.
//
//   npx tsx scripts/check-connect-points.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
  SplineValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { makePoints } from "../src/engine/points.ts";
import { connectPointsNode } from "../src/nodes/effect/connect-points.ts";

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
  return {
    time: 0,
    playing: true,
    state: {},
    width: 1920,
    height: 1080,
  } as unknown as RenderContext;
}

function pts(...xy: number[]): PointsValue {
  const n = xy.length / 2;
  const out = makePoints(n);
  out.positions.set(xy);
  return out;
}

function connect(
  src: PointsValue,
  params: Record<string, unknown> = {}
): SplineValue {
  const ctx = makeCtx();
  const coerced = coerceValue(src, "points", ctx);
  const out = connectPointsNode.compute({
    inputs: { points: coerced },
    auxIn: {},
    params: {
      path: "straight",
      max_distance: 0.1,
      min_distance: 0,
      min_connections: 0,
      ...params,
    },
    ctx,
    nodeId: "cp",
  }) as NodeOutput;
  if (out.primary?.kind !== "spline") {
    return { kind: "spline", subpaths: [] };
  }
  return out.primary;
}

function nEdges(s: SplineValue): number {
  return s.subpaths.length;
}

function segs(s: SplineValue): Array<[[number, number], [number, number]]> {
  return s.subpaths.map((sub) => {
    const a = sub.anchors[0]!.pos;
    const b = sub.anchors[sub.anchors.length - 1]!.pos;
    return [a, b];
  });
}

function hasSeg(
  s: SplineValue,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  eps = 1e-6
): boolean {
  const close = (p: [number, number], x: number, y: number) =>
    Math.abs(p[0] - x) < eps && Math.abs(p[1] - y) < eps;
  return segs(s).some(
    ([a, b]) =>
      (close(a, ax, ay) && close(b, bx, by)) ||
      (close(a, bx, by) && close(b, ax, ay))
  );
}

// Three collinear points: close pair + a farther one.
const line = pts(0, 0, 0.05, 0, 0.2, 0);

{
  const s = connect(line, { max_distance: 0.1, min_distance: 0 });
  check(
    "max only: the 0.05 pair connects, the 0.15/0.20 pairs do not",
    nEdges(s) === 1 && hasSeg(s, 0, 0, 0.05, 0),
    `got ${nEdges(s)} edges`
  );
}

{
  const s = connect(line, { max_distance: 0.1, min_distance: 0.06 });
  check(
    "min above the close pair: nothing in the 0..0.1 band survives",
    nEdges(s) === 0,
    `got ${nEdges(s)} edges`
  );
}

{
  const s = connect(line, { max_distance: 0.25, min_distance: 0.1 });
  check(
    "band keeps the long pairs and drops the 0.05 chord",
    nEdges(s) === 2 &&
      hasSeg(s, 0.05, 0, 0.2, 0) &&
      hasSeg(s, 0, 0, 0.2, 0) &&
      !hasSeg(s, 0, 0, 0.05, 0),
    `got ${nEdges(s)} edges`
  );
}

{
  const omitted = connect(line, { max_distance: 0.1 });
  const explicit = connect(line, { max_distance: 0.1, min_distance: 0 });
  check(
    "omitted min_distance matches the 0 default (existing projects)",
    nEdges(omitted) === nEdges(explicit) && nEdges(omitted) === 1
  );
}

// Unit square of side 0.1: four sides + two diagonals (≈0.1414).
const square = pts(0, 0, 0.1, 0, 0, 0.1, 0.1, 0.1);

{
  const s = connect(square, { max_distance: 0.15, min_distance: 0 });
  check("square under max=0.15 is K4 (6 edges)", nEdges(s) === 6, `got ${nEdges(s)}`);
}

{
  const s = connect(square, { max_distance: 0.15, min_distance: 0.12 });
  check(
    "min=0.12 keeps only the two diagonals",
    nEdges(s) === 2 &&
      hasSeg(s, 0, 0, 0.1, 0.1) &&
      hasSeg(s, 0.1, 0, 0, 0.1),
    `got ${nEdges(s)} edges`
  );
}

{
  const s = connect(square, { max_distance: 0.12, min_distance: 0 });
  check(
    "max=0.12 keeps the four sides, drops the diagonals",
    nEdges(s) === 4 &&
      hasSeg(s, 0, 0, 0.1, 0) &&
      !hasSeg(s, 0, 0, 0.1, 0.1),
    `got ${nEdges(s)} edges`
  );
}

{
  const s = connect(line, { max_distance: 0.1, min_distance: 0.2 });
  check("min_distance > max_distance yields no edges", nEdges(s) === 0);
}

{
  // Pair straddles a spatial-hash cell boundary (cell size = max_distance).
  const s = connect(pts(0.05, 0, 0.14, 0), {
    max_distance: 0.1,
    min_distance: 0.05,
  });
  check(
    "band still finds a pair that straddles hash cells",
    nEdges(s) === 1 && hasSeg(s, 0.05, 0, 0.14, 0),
    `got ${nEdges(s)} edges`
  );
}

// Four tight cluster points + one far point. After min_distance drops the
// cluster internals, the four long spokes remain; each cluster point has
// degree 1, so min_connections=2 must drop them all. If degree were counted
// on the pre-min graph (cluster internals included), those spokes would
// survive — that's the interaction this guards.
{
  const cloud = pts(
    0, 0,
    0.01, 0,
    0, 0.01,
    0.01, 0.01,
    0.2, 0
  );
  const band = connect(cloud, { max_distance: 0.25, min_distance: 0.05 });
  check(
    "min_distance drops cluster chords, keeps the four long spokes",
    nEdges(band) === 4,
    `got ${nEdges(band)} edges`
  );
  const pruned = connect(cloud, {
    max_distance: 0.25,
    min_distance: 0.05,
    min_connections: 2,
  });
  check(
    "min_connections counts degree on the band, not the full max disk",
    nEdges(pruned) === 0,
    `got ${nEdges(pruned)} edges`
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
