// Guards Point Expression's writable groupIndex: assigning
// `groupIndex = floor(index/2)` tags untagged input so Points to Spline
// (and Select by Index / Copy to Points) can partition by rule.
//
//   npx tsx scripts/check-point-expression.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { makePoints } from "../src/engine/points.ts";
import { pointExpressionNode } from "../src/nodes/effect/point-expression.ts";

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

function evalExpr(
  pts: PointsValue,
  expression: string,
  extraParams: Record<string, unknown> = {}
): PointsValue {
  const ctx = makeCtx();
  const coerced = coerceValue(pts, "points", ctx);
  const out = pointExpressionNode.compute({
    inputs: { points: coerced },
    auxIn: {},
    params: {
      target: "points",
      inputs: [],
      expression,
      on_error: "passthrough",
      ...extraParams,
    },
    ctx,
    nodeId: "pex",
  }) as NodeOutput;
  if (out.primary?.kind !== "points") {
    return { kind: "points", count: 0, positions: new Float32Array(0), points: [] };
  }
  return out.primary;
}

function seed(count: number, groups?: number[]): PointsValue {
  const pts = makePoints(count, {
    withScales: true,
    withRotations: true,
    withGroupIndices: !!groups,
  });
  for (let i = 0; i < count; i++) {
    pts.positions[i * 2] = i * 0.1;
    pts.positions[i * 2 + 1] = 0.5;
    pts.scales![i * 2] = 1;
    pts.scales![i * 2 + 1] = 1;
    pts.rotations![i] = 0;
    if (groups && pts.groupIndices) pts.groupIndices[i] = groups[i];
  }
  return pts;
}

{
  const problems = pointExpressionNode.validateParams!({
    expression: "groupIndex = floor(index / 2);",
  });
  check(
    "validateParams accepts groupIndex write",
    problems.length === 0,
    problems.join(",")
  );
}

{
  const out = evalExpr(seed(6), "groupIndex = floor(index / 2);");
  check("partition writes groupIndices on untagged input", !!out.groupIndices);
  const got = Array.from(out.groupIndices ?? []);
  check(
    "groupIndex = floor(index/2) on 6 points → 0,0,1,1,2,2",
    got.join(",") === "0,0,1,1,2,2",
    `got ${got.join(",")}`
  );
  check("partition preserves count", out.count === 6);
}

{
  const out = evalExpr(seed(4, [9, 8, 7, 6]), "x = px;\ny = py;");
  const got = Array.from(out.groupIndices ?? []);
  check(
    "identity preserves incoming groupIndex",
    got.join(",") === "9,8,7,6",
    `got ${got.join(",")}`
  );
}

{
  const out = evalExpr(
    seed(4),
    "groupIndex = floor(index / 2);\nkeep = index !== 1;"
  );
  check("cull shrinks count", out.count === 3);
  const got = Array.from(out.groupIndices ?? []);
  // indices 0,2,3 kept → groups 0, 1, 1
  check(
    "cull compacts written groupIndex",
    got.join(",") === "0,1,1",
    `got ${got.join(",")}`
  );
}

{
  const out = evalExpr(seed(3, [1, 1, 1]), "groupIndex = groupIndex + 1;");
  const got = Array.from(out.groupIndices ?? []);
  check(
    "groupIndex = groupIndex + 1 offsets the incoming tag",
    got.join(",") === "2,2,2",
    `got ${got.join(",")}`
  );
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
