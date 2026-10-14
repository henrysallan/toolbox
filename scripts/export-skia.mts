// export-skia: write the React Native Skia bundle for one SkSL Shader node
// (specdocs/101326_skia-target.md). The editor's export action is spec M1;
// until then this takes a flattened engine graph from disk or a built-in
// fixture.
//
//   npx tsx scripts/export-skia.mts --fixture aurora --out skia-harness/src/bundle
//   npx tsx scripts/export-skia.mts --graph g.json --node <id> --out <dir> [--name N]
//
// g.json: { nodes: GraphNode[], edges: GraphEdge[], timeline?, canvas? }
// (engine/evaluator.ts shapes; timeline = { fps, ticksPerFrame, sceneDurationTicks }).
// Exit 1 with the planner's problems when the node can't export as-is.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { planSkiaExport, emitSkiaBundle } = await import("@/lib/skia-export");

const out = arg("out");
if (!out) {
  console.error("usage: export-skia.mts (--fixture aurora | --graph g.json --node id) --out dir");
  process.exit(2);
}

let nodes, edges, targetId: string, timeline, canvas, name: string;
const fixture = arg("fixture");
if (fixture) {
  if (fixture !== "aurora") throw new Error(`unknown fixture "${fixture}" (have: aurora)`);
  const fx = await import("./fixtures/skia/aurora.ts");
  ({ nodes, edges, targetId } = fx.auroraGraph());
  timeline = fx.AURORA_TIMELINE;
  canvas = { width: 512, height: 512 };
  name = "Aurora";
} else {
  const file = arg("graph");
  const node = arg("node");
  if (!file || !node) throw new Error("--graph and --node are required without --fixture");
  const g = JSON.parse(fs.readFileSync(file, "utf8"));
  nodes = g.nodes;
  edges = g.edges;
  targetId = node;
  timeline = g.timeline ?? { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 300_000 };
  canvas = g.canvas ?? { width: 512, height: 512 };
  name = arg("name") ?? node;
}

const { plan, problems } = planSkiaExport(nodes, edges, targetId, { name, canvas, timeline });
if (!plan) {
  console.error(`Cannot export "${targetId}":`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const runtime = fs.readFileSync(
  path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"),
  "utf8"
);
const files = emitSkiaBundle(plan, runtime);
fs.mkdirSync(out, { recursive: true });
for (const [f, text] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, f), text);
  console.log(`wrote ${path.join(out, f)}`);
}
for (const w of plan.warnings) console.warn(`warning: ${w}`);
console.log(
  `${plan.uniforms.length} uniforms (${plan.uniforms.filter((u) => u.track).length} animated), ` +
    `${plan.timeline.durationTicks / plan.timeline.ticksPerFrame} frames @ ${plan.timeline.fps} fps`
);
