// check-point-labels: guards the shared point-data → string formatter
// (src/engine/point-labels.ts) and the Points to String join node.
// Per-point labels (Point Labels / Points to Text) and the joined caption
// (Points to String) share formatPointLabels; this file locks both the
// per-point tokens and the comma / lines / grid collapse.
//
//   npx tsx scripts/check-point-labels.mts

import type {
  NodeOutput,
  PointsValue,
  RenderContext,
  SocketValue,
} from "../src/engine/types";
import { coerceValue } from "../src/engine/coerce";
import { copyPointsWith, makePoints } from "../src/engine/points";
import {
  formatPointLabels,
  joinPointLabelStrings,
} from "../src/engine/point-labels";
import { pointsToStringNode } from "../src/nodes/effect/points-to-string";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function samplePoints(): PointsValue {
  const pts = makePoints(4, { withScales: true, withRotations: true });
  pts.positions.set([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
  pts.scales!.set([1, 1, 2, 2, 1, 1, 1, 1]);
  pts.rotations![0] = 0;
  pts.rotations![1] = Math.PI / 2;
  return copyPointsWith(pts, {
    attributes: {
      progress: { arity: 1, data: new Float32Array([0.65, 0.75, 0.85, 0.95]) },
    },
  });
}

const pts = samplePoints();
const baseOpts = {
  field: "y" as const,
  template: "{x}, {y}",
  units: "normalized" as const,
  precision: 2,
  width: 1920,
  height: 1080,
};

{
  const ys = formatPointLabels(pts, baseOpts);
  check("y field formats 4 values", ys.length === 4 && ys[0] === "0.20" && ys[3] === "0.80", ys.join("|"));
}

{
  const xs = formatPointLabels(pts, { ...baseOpts, field: "x" });
  check("x field", xs[0] === "0.10" && xs[1] === "0.30", xs.join("|"));
}

{
  const px = formatPointLabels(pts, { ...baseOpts, field: "x", units: "pixels" });
  check("pixel units multiply by canvas width", px[0] === "192.00", px[0]);
}

{
  const prog = formatPointLabels(pts, {
    ...baseOpts,
    field: "custom",
    template: "{attr:progress}",
    precision: 2,
  });
  check(
    "named attr token",
    prog.join(",") === "0.65,0.75,0.85,0.95",
    prog.join(",")
  );
}

{
  const missing = formatPointLabels(pts, {
    ...baseOpts,
    field: "custom",
    template: "{attr:nope}",
  });
  check("missing attr reads 0", missing.every((s) => s === "0.00"), missing.join("|"));
}

{
  const joined = joinPointLabelStrings(["0.20", "0.40", "0.60", "0.80"], "comma");
  check("comma join", joined === "0.20, 0.40, 0.60, 0.80", joined);
}

{
  const joined = joinPointLabelStrings(["a", "b", "c"], "lines");
  check("lines join", joined === "a\nb\nc", JSON.stringify(joined));
}

{
  const joined = joinPointLabelStrings(
    ["0.20", "0.40", "0.60", "0.80"],
    "grid",
    2,
    "space"
  );
  check("grid 2 columns, space sep", joined === "0.20  0.40\n0.60  0.80", JSON.stringify(joined));
}

{
  const joined = joinPointLabelStrings(
    ["1", "2", "3", "4", "5"],
    "grid",
    3,
    "comma"
  );
  check(
    "grid remainder row",
    joined === "1, 2, 3\n4, 5",
    JSON.stringify(joined)
  );
}

{
  check("empty join is empty string", joinPointLabelStrings([], "comma") === "");
  check("grid columns clamp to ≥1", joinPointLabelStrings(["a", "b"], "grid", 0) === "a\nb");
}

function makeCtx(): RenderContext {
  return { time: 0, playing: true, state: {}, width: 1920, height: 1080 } as unknown as RenderContext;
}

function evalNode(
  input: SocketValue | undefined,
  params: Record<string, unknown>
): SocketValue | undefined {
  const ctx = makeCtx();
  const coerced = coerceValue(input, "points", ctx);
  const out = pointsToStringNode.compute({
    inputs: { points: coerced },
    auxIn: {},
    params,
    ctx,
    nodeId: "p2s",
  } as Parameters<typeof pointsToStringNode.compute>[0]) as NodeOutput;
  return out.primary;
}

const DEFAULTS = {
  field: "y",
  attr_name: "weight",
  template: "{x}, {y}",
  layout: "comma",
  columns: 4,
  column_sep: "space",
  units: "normalized",
  precision: 2,
};

{
  const out = evalNode(undefined, DEFAULTS);
  check(
    "unwired points → empty string",
    out?.kind === "string" && out.value === "",
    JSON.stringify(out)
  );
}

{
  const empty = makePoints(0);
  const out = evalNode(empty, DEFAULTS);
  check(
    "zero-count points → empty string",
    out?.kind === "string" && out.value === "",
    JSON.stringify(out)
  );
}

{
  const out = evalNode(pts, DEFAULTS);
  check(
    "node y comma",
    out?.kind === "string" && out.value === "0.20, 0.40, 0.60, 0.80",
    out && out.kind === "string" ? out.value : JSON.stringify(out)
  );
}

{
  const out = evalNode(pts, { ...DEFAULTS, field: "attribute", attr_name: "progress", precision: 2 });
  check(
    "node named attribute",
    out?.kind === "string" && out.value === "0.65, 0.75, 0.85, 0.95",
    out && out.kind === "string" ? out.value : JSON.stringify(out)
  );
}

{
  const out = evalNode(pts, { ...DEFAULTS, layout: "lines" });
  check(
    "node lines layout",
    out?.kind === "string" && out.value === "0.20\n0.40\n0.60\n0.80",
    out && out.kind === "string" ? JSON.stringify(out.value) : JSON.stringify(out)
  );
}

{
  const out = evalNode(pts, {
    ...DEFAULTS,
    layout: "grid",
    columns: 2,
    column_sep: "comma",
  });
  check(
    "node grid layout",
    out?.kind === "string" && out.value === "0.20, 0.40\n0.60, 0.80",
    out && out.kind === "string" ? JSON.stringify(out.value) : JSON.stringify(out)
  );
}

{
  const out = evalNode(pts, {
    ...DEFAULTS,
    field: "custom",
    template: "P{i}:{y}",
  });
  check(
    "node custom template",
    out?.kind === "string" && out.value === "P0:0.20, P1:0.40, P2:0.60, P3:0.80",
    out && out.kind === "string" ? out.value : JSON.stringify(out)
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
