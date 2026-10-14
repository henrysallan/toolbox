// export-skia: write a React Native Skia bundle (specdocs/101326_skia-target.md)
// for one SkSL Shader node or one Skia Canvas node — everything dispatches
// through exportSkia (src/lib/skia-export/api.ts), the editor's entry point.
//
//   npx tsx scripts/export-skia.mts --fixture aurora --out skia-harness/src/bundle
//   npx tsx scripts/export-skia.mts --fixture scene --out <dir>
//   npx tsx scripts/export-skia.mts --fixture aurora-scene --out skia-harness/src/bundle-scene
//   npx tsx scripts/export-skia.mts --fixture split --out skia-harness/src/bundle-split
//   npx tsx scripts/export-skia.mts --graph g.json --node <id> --out <dir> [--name N]
//   npx tsx scripts/export-skia.mts --scene ir.json --out <dir> [--name N]
//   … --animation baked   program uniforms as SkSL functions of iTime
//                         (emit-baked.ts; default: the worklet timeline)
//   … --animation native  Reanimated-native animations (emit-native.ts):
//   npx tsx scripts/export-skia.mts --fixture easings --animation native --out skia-harness/src/bundle-native-easings
//   npx tsx scripts/export-skia.mts --fixture image --out skia-harness/src/bundle-image
//   npx tsx scripts/export-skia.mts --fixture procedural --out skia-harness/src/bundle-procedural
//   npx tsx scripts/export-skia.mts --fixture procedural --animation baked --out skia-harness/src/bundle-procedural-baked
//   npx tsx scripts/export-skia.mts --fixture text --out skia-harness/src/bundle-text
//   … --fetch             also fetch http(s) asset URLs (default: offline —
//                         /fonts/… come from public/, data: / blob: / file:
//                         resolve locally, anything else ships unbundled
//                         with a warning)
//   npx tsx scripts/export-skia.mts --fixture filters --out skia-harness/src/bundle-filters [--node <canvas>]
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
const { exportSkia, exportSkiaScene, collectSkiaExportAssets, resolveSkiaExportAssets, sceneAssetIds } = await import("@/lib/skia-export");
const { nodeAssetHandles, nodeResolveAsset } = await import("./skia/node-assets.ts");
type AssetUse = { asset: import("@/engine/skia/scene-ir").AssetIR; owners: string[] };

// Assets resolve BEFORE the synchronous export, through the same seam the
// editor uses (lib/skia-export/assets.ts) with a Node resolver
// (scripts/skia/node-assets.ts): /fonts/… from public/, data:, blob:,
// file:; http(s) only with --fetch (offline by default — an unresolved
// asset ships unbundled with a warning naming its node).
const remote = process.argv.includes("--fetch");
async function resolveAssets(uses: AssetUse[]) {
  const mine = uses.filter((u) => nodeAssetHandles(u.asset.url, { remote }));
  return mine.length ? resolveSkiaExportAssets(mine, nodeResolveAsset({ remote })) : undefined;
}

const out = arg("out");
if (!out) {
  console.error(
    "usage: export-skia.mts (--fixture aurora|aurora-scene|scene|easings|atlas|image|procedural|text|filters [--node canvas]|split | --graph g.json --node id | --scene ir.json) --out dir [--animation worklet|baked|native]"
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
  const uses: AssetUse[] = [...sceneAssetIds(j.scene.root)].flatMap(([id, owners]) =>
    j.scene.assets?.[id] ? [{ asset: j.scene.assets[id], owners: [...owners].map((o) => `"${o}"`) }] : []
  );
  const assets = await resolveAssets(uses);
  result = exportSkiaScene(j.scene, j.nodes ?? [], j.edges ?? [], {
    name: label,
    timeline: j.timeline ?? DEFAULT_TIMELINE,
    runtimeSource,
    animation,
    ...(assets ? { assets } : {}),
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
  } else if (fixture === "atlas") {
    // Copy to Points (Skia), atlas-graph.ts `combo_skc`: two sprite-sheet
    // atlases (static, keyframed spin / zoom → tracks) and a vector copy
    // group on a moving point (sampled) — the harness's ?bundle=atlas slot.
    const fx = await import("./fixtures/skia/atlas-graph.ts");
    ({ nodes, edges } = fx.atlasGraph());
    targetId = "combo_skc";
    timeline = fx.ATLAS_EXPORT_TIMELINE;
    canvas = { width: fx.ATLAS_SIZE, height: fx.ATLAS_SIZE };
    name = "Copy to Points (Skia)";
  } else if (fixture === "image") {
    // An Image Source into iImage1 + ramp / curve channels + a keyframed
    // channel (image-graph.ts): the ?bundle=image slot (bundle-image).
    const fx = await import("./fixtures/skia/image-graph.ts");
    ({ nodes, edges, targetId } = fx.imageEffectGraph(fx.imageFixtureStandIn(fx.imageFixturePng())));
    // The Aurora markers, so the harness's SEGMENTS type is one type.
    timeline = { ...fx.IMAGE_TIMELINE, markers: (await import("./fixtures/skia/aurora-graph.ts")).AURORA_MARKERS };
    canvas = { width: 512, height: 512 };
    name = "Image tint";
  } else if (fixture === "procedural") {
    // Aurora on procedural drivers (procedural-graph.ts: LFO, Expression ← LFO,
    // Expression ← Scene Time, a Color track): ?bundle=procedural, and with
    // `--animation baked` ?bundle=procedural-baked.
    const fx = await import("./fixtures/skia/aurora.ts");
    const pfx = await import("./fixtures/skia/procedural-graph.ts");
    ({ nodes, edges, targetId } = pfx.proceduralAuroraGraph(fx.AURORA_SKSL));
    timeline = { ...pfx.PROCEDURAL_TIMELINE, markers: pfx.PROCEDURAL_MARKERS };
    canvas = { width: 512, height: 512 };
    name = "Aurora (procedural)";
  } else if (fixture === "text") {
    // Text (Skia) through every text path (text-graph.ts textBundleGraph):
    // the harness's ?bundle=text slot, its fonts the bundled Inter / Geist
    // (their bytes + OFL texts ship through the asset seam).
    const fx = await import("./fixtures/skia/text-graph.ts");
    ({ nodes, edges, targetId } = fx.textBundleGraph());
    timeline = { ...fx.TEXT_TIMELINE, sceneDurationTicks: fx.TEXT_SCENE_TICKS, markers: (await import("./fixtures/skia/aurora-graph.ts")).AURORA_MARKERS };
    canvas = { width: fx.TEXT_SIZE, height: fx.TEXT_SIZE };
    name = "Text (Skia)";
  } else if (fixture === "filters") {
    // The Skia filter family (filters-graph.ts): by default its web-playable
    // canvas (keyframed blur, shadow, morphology, colour matrix) for the
    // harness's ?bundle=filters slot; --node picks another canvas.
    const fx = await import("./fixtures/skia/filters-graph.ts");
    ({ nodes, edges } = fx.filtersGraph());
    targetId = arg("node") ?? fx.FILTERS_HARNESS_CANVAS;
    timeline = { ...fx.FILTERS_TIMELINE, markers: fx.FILTERS_MARKERS };
    canvas = { width: fx.FILTERS_SIZE, height: fx.FILTERS_SIZE };
    name = "Skia filters";
  } else if (fixture === "split") {
    // Stage splitting (split-graph.ts `combo`): two nested runtime-filter
    // layers, one read by a gather and a plain read (?bundle=split).
    const fx = await import("./fixtures/skia/split-graph.ts");
    ({ nodes, edges } = fx.splitGraph());
    targetId = fx.SPLIT_PARITY_CANVAS;
    timeline = { ...fx.SPLIT_TIMELINE, markers: fx.SPLIT_MARKERS };
    canvas = { width: 512, height: 512 };
    name = "Split stages";
  } else if (fixture) {
    throw new Error(`unknown fixture "${fixture}" (have: aurora, aurora-scene, scene, easings, atlas, image, procedural, text, filters, split)`);
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
  const req = { nodes, edges, targetId, name, canvas, timeline, runtimeSource, animation };
  const assets = await resolveAssets(collectSkiaExportAssets(req));
  result = exportSkia({ ...req, ...(assets ? { assets } : {}) });
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
