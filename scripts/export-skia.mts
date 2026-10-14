// export-skia: write a React Native Skia bundle (specdocs/101326_skia-target.md)
// for one SkSL Shader node or one Skia Canvas node — everything dispatches
// through exportSkia (src/lib/skia-export/api.ts), the editor's entry point.
//
//   npx tsx scripts/export-skia.mts --fixture aurora --out skia-harness/src/bundle
//   npx tsx scripts/export-skia.mts --fixture scene --out <dir>
//   npx tsx scripts/export-skia.mts --fixture aurora-scene --out skia-harness/src/bundle-scene
//   npx tsx scripts/export-skia.mts --graph g.json --node <id> --out <dir> [--name N]
//   npx tsx scripts/export-skia.mts --scene ir.json --out <dir> [--name N]
//   … --animation baked   program uniforms as SkSL functions of iTime
//                         (emit-baked.ts; default: the worklet timeline)
//   … --animation native  Reanimated-native animations (emit-native.ts):
//   npx tsx scripts/export-skia.mts --fixture easings --animation native --out skia-harness/src/bundle-native-easings
//
// g.json: { nodes: GraphNode[], edges: GraphEdge[], timeline?, canvas? }
// (engine/evaluator.ts shapes; timeline = { fps, ticksPerFrame,
// sceneDurationTicks, markers? } — markers [{ id, name, frame, duration? }]
// become the bundle's SEGMENTS). The aurora fixtures ship AURORA_MARKERS.
// --node is an sksl-shader or a skia-canvas node.
//
// ir.json: { scene: SkiaScene, nodes?, edges?, timeline?, name? } — a
// hand-written scene IR plus the graph its binds' refs point into. There is
// no producer to re-evaluate, so binds derived from animated params refuse
// (export the skia-canvas node from a graph for those).
//
// Exit 1 with the planner's problems when the target can't export as-is.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkiaExportResult } from "@/lib/skia-export";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { exportSkia, exportSkiaScene } = await import("@/lib/skia-export");

const out = arg("out");
if (!out) {
  console.error(
    "usage: export-skia.mts (--fixture aurora|aurora-scene|scene|easings | --graph g.json --node id | --scene ir.json) --out dir [--animation worklet|baked|native]"
  );
  process.exit(2);
}

const DEFAULT_TIMELINE = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 300_000 };
// --animation baked: program uniforms compiled into the SkSL (emit-baked.ts);
// --animation native: Reanimated-native animations (emit-native.ts) instead
// of the worklet master clock.
const animationArg = arg("animation");
if (animationArg && animationArg !== "worklet" && animationArg !== "baked" && animationArg !== "native") {
  console.error(`--animation must be worklet, baked or native, got "${animationArg}"`);
  process.exit(2);
}
const animation = animationArg as "worklet" | "baked" | "native" | undefined;
const runtimeSource = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");

let result: SkiaExportResult;
let label: string;
const fixture = arg("fixture");
const sceneFile = arg("scene");
if (sceneFile) {
  const j = JSON.parse(fs.readFileSync(sceneFile, "utf8"));
  label = arg("name") ?? j.name ?? path.basename(sceneFile, ".json");
  result = exportSkiaScene(j.scene, j.nodes ?? [], j.edges ?? [], {
    name: label,
    timeline: j.timeline ?? DEFAULT_TIMELINE,
    runtimeSource,
    animation,
  });
} else {
  let nodes, edges, targetId: string, timeline, canvas, name: string;
  if (fixture === "aurora") {
    const fx = await import("./fixtures/skia/aurora.ts");
    ({ nodes, edges, targetId } = fx.auroraGraph());
    timeline = { ...fx.AURORA_TIMELINE, markers: fx.AURORA_MARKERS };
    canvas = { width: 512, height: 512 };
    name = "Aurora";
  } else if (fixture === "scene") {
    const fx = await import("./fixtures/skia/scene-fixture.ts");
    const g = fx.sceneFixtureGraph();
    ({ nodes, edges } = g);
    targetId = g.canvasId;
    timeline = fx.SCENE_TIMELINE;
    canvas = fx.SCENE_CANVAS;
    name = "Scene fixture";
  } else if (fixture === "aurora-scene") {
    // Aurora through the Skia-layer nodes (aurora-scene-graph.ts): a scene
    // bundle (ToolboxScene) for the harness's ?bundle=scene slot.
    const fx = await import("./fixtures/skia/aurora.ts");
    const { auroraSceneGraph } = await import("./fixtures/skia/aurora-scene-graph.ts");
    ({ nodes, edges } = auroraSceneGraph(fx.AURORA_SKSL));
    targetId = "skc";
    timeline = { ...fx.AURORA_TIMELINE, markers: fx.AURORA_MARKERS };
    canvas = { width: 512, height: 512 };
    name = "Aurora (Skia layer)";
  } else if (fixture === "easings") {
    // Every easing kind on one SkSL node (easings-graph.ts): the native
    // mode's drift fixture (`--animation native`, ?bundle=native-easings).
    const fx = await import("./fixtures/skia/easings-graph.ts");
    ({ nodes, edges, targetId } = fx.easingsGraph());
    timeline = fx.EASINGS_TIMELINE;
    canvas = { width: fx.EASINGS_SIZE, height: fx.EASINGS_SIZE };
    name = "Easings";
  } else if (fixture) {
    throw new Error(`unknown fixture "${fixture}" (have: aurora, aurora-scene, scene, easings)`);
  } else {
    const file = arg("graph");
    const node = arg("node");
    if (!file || !node) throw new Error("--graph and --node are required without --fixture / --scene");
    const g = JSON.parse(fs.readFileSync(file, "utf8"));
    nodes = g.nodes;
    edges = g.edges;
    targetId = node;
    timeline = g.timeline ?? DEFAULT_TIMELINE;
    canvas = g.canvas ?? { width: 512, height: 512 };
    name = arg("name") ?? node;
  }
  label = targetId;
  result = exportSkia({ nodes, edges, targetId, name, canvas, timeline, runtimeSource, animation });
}

if (!result.files) {
  console.error(`Cannot export "${label}":`);
  for (const p of result.problems) console.error(`  - ${p}`);
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
for (const [f, text] of Object.entries(result.files)) {
  const dest = path.join(out, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (f.endsWith(".b64")) {
    fs.writeFileSync(dest.slice(0, -4), Buffer.from(text, "base64"));
    console.log(`wrote ${dest.slice(0, -4)}`);
  } else {
    fs.writeFileSync(dest, text);
    console.log(`wrote ${dest}`);
  }
}
for (const w of result.warnings) console.warn(`warning: ${w}`);
const manifest = JSON.parse(result.files["manifest.json"]);
if (manifest.segments?.length) {
  console.log(
    `segments: ${manifest.segments.map((s: { name: string; frames: number[] }) => `${s.name} [${s.frames[0]}, ${s.frames[1]})`).join(", ")}`
  );
}
if (manifest.kind === "scene") {
  const kinds: Record<string, number> = manifest.bindCounts;
  const total = Object.values(kinds).reduce((a, b) => a + b, 0);
  console.log(
    `${total} binds (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")}), ` +
      `${manifest.programs.length} programs, ${manifest.assets.length} assets, ` +
      `${manifest.timeline.durationTicks / manifest.timeline.ticksPerFrame} frames @ ${manifest.timeline.fps} fps`
  );
} else {
  console.log(
    `${manifest.uniforms.length} uniforms (${manifest.uniforms.filter((u: { animated: boolean }) => u.animated).length} animated), ` +
      `${manifest.timeline.durationTicks / manifest.timeline.ticksPerFrame} frames @ ${manifest.timeline.fps} fps`
  );
}
