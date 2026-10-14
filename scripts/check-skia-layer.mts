// check-skia-layer: the editor surfaces of the Skia target
// (specdocs/101326_skia-target.md §3.1, §3.7 — Wave 1 lane L6). No GPU, no
// DOM beyond the persistence stubs:
//
//   1. the layer shell's `target` param: defaults to "default", survives a
//      save → load round trip as "skia", and a save from before the param
//      existed reads "default"; get_graph prints it only when non-default;
//   2. the catalog filter: NodeDefinition.skia + the structural utilities,
//      in the add-menu filter (presets / compound zones / AI rows) and in
//      get_catalog({ target: "skia" }); a def registered with `skia` lights
//      up with no other change (how the skia-* lanes land);
//   3. the validator: SKIA_LAYER_UNSUPPORTED names the node and the layer,
//      for a whole graph (parent chains), a recipe fragment landing in a
//      Skia layer, and an edit_group patch — and the MCP handlers surface it;
//   4. the export action's pure parts: Skia layer → the SkSL Shader feeding
//      its Layer Output → flattened SkiaExportRequest → the same bundle the
//      direct exporter writes; refusals; the plan summary; zip entries
//      (assets/*.b64 decoded) and a real zip round trip; the generated
//      runtime module is the file on disk.
//
//   npx tsx scripts/check-skia-layer.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Edge } from "@xyflow/react";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal DOM stubs — importing @/lib/project pulls the engine/registry in.
const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= {
  createElement: stub,
  createElementNS: stub,
  fonts: { add() {}, forEach() {} },
  body: { appendChild() {} },
  addEventListener() {},
};
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};

// Register first, then reach everything through dynamic imports so they
// share the registry instance registerAllNodes filled.
const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef, registerNode } = await import("@/engine/registry");
const lt = await import("@/engine/skia/layer-target");
const { validateGraph } = await import("@/engine/graph-validation");
const { vetParamValue } = await import("@/engine/node-catalog");
const { makeInstanceNode, makeLayerNodes, refreshNodeSockets, newEdgeId } = await import("@/state/graph-ops");
const { buildRecipe } = await import("@/state/recipe-builder");
const { applyRecipeEdit, graphToSpec } = await import("@/state/recipe-edit");
const { buildCatalogDsl } = await import("@/lib/ai/generate-recipe-client");
const { serializeGraph, deserializeGraph } = await import("@/lib/project");
const { exportSkia } = await import("@/lib/skia-export/api");
const ed = await import("@/lib/skia-export/editor");
const { TOOLBOX_TIMELINE_SOURCE } = await import("@/lib/skia-export/runtime.generated");
const { buildMcpHandlers } = await import("@/components/effects/mcp-handlers");
const fx = await import("./fixtures/skia/aurora.ts");
import type { GraphNode } from "@/state/graph-ops";
import type { NodeDefinition } from "@/engine/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const RUNTIME = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");

// A def the way the skia-* lanes add theirs: nothing but `skia` set.
const GATE_TYPE = "skia-gate-fill";
registerNode({
  type: GATE_TYPE,
  name: "Skia Gate Fill",
  category: "image",
  subcategory: "generator",
  description: "check-skia-layer fixture",
  backend: "webgl2",
  skia: { class: "native" },
  inputs: [],
  params: [],
  primaryOutput: "image",
  auxOutputs: [],
  compute: () => ({}),
} as unknown as NodeDefinition);

const val = (nodes: GraphNode[]) =>
  nodes.map((n) => ({
    id: n.id,
    defType: n.data.defType,
    params: n.data.params,
    parentId: n.data.parentId,
    name: n.data.name,
  }));
const valEdges = (edges: Edge[]) =>
  edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle ?? "",
    target: e.target,
    targetHandle: e.targetHandle ?? "",
  }));
const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): Edge => ({
  id: newEdgeId(),
  source,
  sourceHandle,
  target,
  targetHandle,
});
const node = (type: string, id: string, parentId?: string, params?: Record<string, unknown>): GraphNode => {
  const n = makeInstanceNode(type, { x: 0, y: 0 });
  n.id = id;
  n.data.parentId = parentId;
  if (params) n.data.params = { ...n.data.params, ...params };
  return refreshNodeSockets(n);
};
// A layer (named `name`) with its boundary nodes; `target` set as given.
function layerOf(name: string, target?: "skia" | "default") {
  const { layer, groupInput, groupOutput } = makeLayerNodes(name, { x: 0, y: 0 });
  if (target) layer.data.params = { ...layer.data.params, target };
  return { layer, groupInput, groupOutput };
}

// ---- 1. the layer target param ------------------------------------------------
{
  const pdef = getNodeDef("layer")?.params.find((p) => p.name === "target");
  check(
    "layer def declares target: hidden segmented enum default|skia, default \"default\"",
    !!pdef &&
      pdef.type === "enum" &&
      pdef.hidden === true &&
      pdef.control === "segmented" &&
      JSON.stringify(pdef.options) === '["default","skia"]' &&
      pdef.default === "default",
    JSON.stringify(pdef)
  );
  check(
    "set_param's vetter accepts skia and rejects anything else",
    !!pdef && vetParamValue(pdef, "skia").ok && !vetParamValue(pdef, "metal").ok
  );
  const { layer } = layerOf("Fresh");
  check("a new layer reads target default", layer.data.params.target === "default" && lt.readLayerTarget(layer.data.params) === "default");
  check(
    "readLayerTarget: only \"skia\" is skia (absent / junk read default)",
    lt.readLayerTarget({}) === "default" &&
      lt.readLayerTarget(undefined) === "default" &&
      lt.readLayerTarget({ target: "SKIA" }) === "default" &&
      lt.readLayerTarget({ target: "skia" }) === "skia"
  );

  const L = layerOf("Glow", "skia");
  const sk = node("sksl-shader", "sk", L.layer.id);
  const nodes = [L.layer, L.groupInput, L.groupOutput, sk];
  const edges = [edge(sk.id, "out:primary", L.groupOutput.id, "in:image")];
  const saved = JSON.parse(JSON.stringify(await serializeGraph(nodes, edges)));
  const savedLayer = saved.nodes.find((n: any) => n.id === L.layer.id);
  check("serialized layer carries target \"skia\"", savedLayer?.params?.target === "skia", JSON.stringify(savedLayer?.params));
  const loaded = await deserializeGraph(saved);
  const back = loaded.nodes.find((n) => n.id === L.layer.id);
  check("save → load keeps target \"skia\"", lt.readLayerTarget(back?.data.params) === "skia", JSON.stringify(back?.data.params));
  const resaved = JSON.parse(JSON.stringify(await serializeGraph(loaded.nodes, loaded.edges)));
  check(
    "load → save → load is stable",
    resaved.nodes.find((n: any) => n.id === L.layer.id)?.params?.target === "skia"
  );
  // A save from before the param existed.
  const legacy = JSON.parse(JSON.stringify(saved));
  delete legacy.nodes.find((n: any) => n.id === L.layer.id).params.target;
  const old = await deserializeGraph(legacy);
  const oldLayer = old.nodes.find((n) => n.id === L.layer.id);
  check(
    "a pre-target save loads as a default layer",
    !!oldLayer && oldLayer.data.params.target === undefined && lt.readLayerTarget(oldLayer.data.params) === "default"
  );
  const spec = graphToSpec(loaded.nodes, loaded.edges, undefined, { params: "non_default" });
  const specOld = graphToSpec(old.nodes, old.edges, undefined, { params: "non_default" });
  check(
    "get_graph prints target only when non-default",
    spec.nodes.find((n) => n.id === L.layer.id)?.params?.target === "skia" &&
      !("target" in (specOld.nodes.find((n) => n.id === L.layer.id)?.params ?? {})),
    JSON.stringify(spec.nodes.find((n) => n.id === L.layer.id))
  );
  check(
    "enclosingSkiaLayer walks node-groups up to the layer",
    (() => {
      const grp = node("node-group", "grp", L.layer.id);
      const all = [...nodes, grp];
      const look = (id: string) => {
        const n = all.find((x) => x.id === id);
        return n && { type: n.data.defType, parentId: n.data.parentId, params: n.data.params, name: n.data.name };
      };
      return (
        lt.enclosingSkiaLayer("grp", look)?.id === L.layer.id &&
        lt.enclosingSkiaLayer(L.layer.id, look)?.name === "Glow" &&
        lt.enclosingSkiaLayer(undefined, look) === null
      );
    })()
  );
}

// ---- 2. the catalog filter ------------------------------------------------------
{
  const offered = (t: string) => lt.isOfferedInSkiaLayer(getNodeDef(t));
  check(
    "def.skia types are offered (M0: SkSL Shader + the export's drivers)",
    ["sksl-shader", "animated-value", "constant", "color-literal"].every(offered)
  );
  check("a newly registered skia def lights up with no other change", offered(GATE_TYPE));
  check("ordinary defs are not offered", !["noise", "blur", "circle", "merge", "glsl-expression"].some(offered));
  check(
    "structural utilities stay: group structure, reroute, frame-zone",
    ["node-group", "group-input", "group-output", "reroute", "frame-zone"].every(lt.isSkiaLayerType)
  );
  check(
    "computing structure stays out: zones, Time Offset, simulation",
    !["iterate", "repeat", "foreach", "time-offset", "simulation-start", "simulation-zone"].some(lt.isSkiaLayerType)
  );
  const rows = [
    { type: "noise" },
    { type: "sksl-shader" },
    { type: "simulation-zone" },
    { type: "iterate" },
    { type: "ai-recipe" },
    { type: "agent" },
    { type: "preset:plain", inserts: ["node-group", "group-input", "group-output", "noise"] },
    { type: "preset:skia", inserts: ["node-group", "group-input", "group-output", "sksl-shader", "animated-value"] },
  ];
  const kept = lt
    .filterForSkiaLayer(rows, (r) => (r.type === "agent" ? [] : (r as { inserts?: string[] }).inserts ?? null))
    .map((r) => r.type);
  check(
    "add-menu filter: Skia defs, the Assistant, all-Skia presets — no zones / AI Recipe / default presets",
    JSON.stringify(kept) === JSON.stringify(["sksl-shader", "agent", "preset:skia"]),
    JSON.stringify(kept)
  );

  const index = buildCatalogDsl({ target: "skia" });
  check(
    "get_catalog target skia: index lists exactly the Skia types",
    index.startsWith("# Skia layer catalog") &&
      index.includes("sksl-shader (SkSL Shader)") &&
      index.includes("animated-value (Animated Value)") &&
      index.includes(`${GATE_TYPE} (Skia Gate Fill)`) &&
      !index.includes("noise (") &&
      !index.includes("repeat (Repeat)") &&
      !index.includes("foreach (For Each Element)"),
    index.slice(0, 600)
  );
  const full = buildCatalogDsl({ mode: "list" });
  check("the unfiltered catalog is unchanged", full.includes("noise (") && full.includes("repeat (Repeat)") && !full.startsWith("# Skia"));
  const typed = buildCatalogDsl({ target: "skia", types: ["sksl-shader", "noise"] });
  check(
    "types= under target skia: Skia types in full, others reported unknown",
    typed.includes("# unknown types: noise") && typed.includes("sksl-shader (SkSL Shader)") && typed.includes(" -> "),
    typed.slice(0, 300)
  );
  let catErr = "";
  try {
    buildCatalogDsl({ target: "skia", category: "spline" });
  } catch (e) {
    catErr = (e as Error).message;
  }
  check("a category with no Skia types says so", catErr.includes("Skia layer catalog"), catErr);
}

// ---- 3. the validator -------------------------------------------------------------
{
  const L = layerOf("Glow", "skia");
  const sk = node("sksl-shader", "sk", L.layer.id);
  const nz = node("noise", "nz", L.layer.id);
  const grp = node("node-group", "grp", L.layer.id);
  const deep = node("blur", "deep", grp.id);
  const rr = node("reroute", "rr", L.layer.id);
  const graph = [L.layer, L.groupInput, L.groupOutput, sk, nz, grp, deep, rr];
  const r = validateGraph(val(graph), []);
  const skiaIssues = r.issues.filter((i) => i.code === "SKIA_LAYER_UNSUPPORTED");
  check(
    "whole graph: non-Skia nodes inside a Skia layer are errors (nested groups too)",
    !r.ok &&
      JSON.stringify(skiaIssues.map((i) => i.nodeId).sort()) === '["deep","nz"]' &&
      skiaIssues.every((i) => i.severity === "error"),
    JSON.stringify(skiaIssues)
  );
  check(
    "the message names the node, its type and the layer",
    !!skiaIssues.find((i) => i.nodeId === "nz")?.message.includes('Node nz (noise) can\'t go inside Skia layer "Glow"'),
    skiaIssues[0]?.message
  );
  const D = layerOf("Plain", "default");
  const plain = [D.layer, D.groupInput, D.groupOutput, node("noise", "nz2", D.layer.id)];
  check("a default layer takes anything", !validateGraph(val(plain), []).issues.some((i) => i.code === "SKIA_LAYER_UNSUPPORTED"));
  check(
    "callers that pass no parent chain see no change",
    !validateGraph(
      graph.map((n) => ({ id: n.id, defType: n.data.defType, params: n.data.params })),
      []
    ).issues.some((i) => i.code === "SKIA_LAYER_UNSUPPORTED")
  );

  // insert_recipe: the fragment's chain ends at its group shell, which lands
  // in the Skia layer → `skiaLayer` applies.
  const built = buildRecipe({
    name: "mix",
    nodes: [
      { id: "s", type: "sksl-shader" },
      { id: "n", type: "noise" },
    ],
    outputs: [{ name: "image", from: "s:out", type: "image" }],
  });
  const fragIssues = (opts?: { skiaLayer: { id: string; name: string } }) =>
    validateGraph(val(built.nodes), valEdges(built.edges), opts).issues.filter((i) => i.code === "SKIA_LAYER_UNSUPPORTED");
  const intoSkia = fragIssues({ skiaLayer: { id: L.layer.id, name: "Glow" } });
  check(
    "recipe fragment into a Skia layer: only the noise is rejected (group + boundaries pass)",
    intoSkia.length === 1 && intoSkia[0].message.includes("(noise)") && intoSkia[0].message.includes('"Glow"'),
    JSON.stringify(intoSkia)
  );
  check("the same fragment elsewhere is clean", fragIssues().length === 0);

  // edit_group on the layer itself: the fragment holds the shell.
  const frag = [L.layer, L.groupInput, L.groupOutput, sk];
  const added = applyRecipeEdit(L.layer.id, frag, [], {
    ops: [
      { op: "add_node", id: "n2", type: "noise" },
      { op: "add_node", id: "a2", type: "animated-value" },
    ],
  });
  const editIssues = validateGraph(val(added.nodes), valEdges(added.edges)).issues.filter(
    (i) => i.code === "SKIA_LAYER_UNSUPPORTED"
  );
  check(
    "edit_group add_node: noise rejected, Animated Value accepted",
    editIssues.length === 1 && editIssues[0].message.includes("(noise)"),
    JSON.stringify(editIssues)
  );
}

// ---- 4. the export action ----------------------------------------------------------
const ENV = { canvas: { width: 512, height: 512 }, fps: 60, frames: 300 };
// Aurora (the M0 fixture) inside a Skia layer, as the editor holds it.
function auroraInLayer(layerName = "Aurora Layer", target: "skia" | "default" = "skia") {
  const L = layerOf(layerName, target);
  const f = fx.auroraGraph();
  const nodes: GraphNode[] = [L.layer, L.groupInput, L.groupOutput];
  for (const en of f.nodes) {
    const n = node(en.type, en.id, L.layer.id, en.params);
    n.data.params = en.params;
    n.data.animation = en.animation;
    nodes.push(n);
  }
  const edges: Edge[] = f.edges.map((e) => ({ ...e }));
  edges.push(edge("aurora", "out:primary", L.groupOutput.id, "in:image"));
  return { L, nodes, edges, fixture: f };
}
{
  check("runtime.generated.ts is the runtime on disk, verbatim", TOOLBOX_TIMELINE_SOURCE === RUNTIME);

  const { L, nodes, edges, fixture } = auroraInLayer();
  const prep = ed.prepareSkiaExport(nodes, edges, L.layer.id, ENV);
  check(
    "a Skia layer resolves to the SkSL Shader feeding its Layer Output",
    !!prep.request && prep.target?.id === "aurora" && prep.clicked?.id === L.layer.id && prep.layer?.target === "skia",
    JSON.stringify(prep.problems)
  );
  check(
    "the request is the flattened graph (boundary nodes dissolved) with the project timeline",
    !!prep.request &&
      !prep.request.nodes.some((n) => n.type === "group-input" || n.type === "group-output") &&
      prep.request.timeline.fps === 60 &&
      prep.request.timeline.ticksPerFrame === 1000 &&
      prep.request.timeline.sceneDurationTicks === 300_000 &&
      prep.request.canvas.width === 512 &&
      prep.request.name === "Aurora Layer" &&
      prep.request.runtimeSource === RUNTIME
  );
  const viaEditor = ed.exportSkiaFromEditor(nodes, edges, L.layer.id, ENV).result;
  const direct = exportSkia({
    nodes: fixture.nodes,
    edges: fixture.edges,
    targetId: fixture.targetId,
    name: "Aurora Layer",
    canvas: ENV.canvas,
    timeline: fx.AURORA_TIMELINE,
    runtimeSource: RUNTIME,
  });
  const fileNames = (f: Record<string, string> | null) => Object.keys(f ?? {}).sort().join(",");
  check(
    "export from the layer writes the same bundle as the direct exporter, byte for byte",
    !!viaEditor.files &&
      !!direct.files &&
      fileNames(viaEditor.files) === fileNames(direct.files) &&
      Object.keys(direct.files).every((k) => viaEditor.files![k] === direct.files![k]),
    `${fileNames(viaEditor.files)} vs ${fileNames(direct.files)} ${JSON.stringify(viaEditor.problems)}`
  );
  check("the bundle ships the runtime verbatim", viaEditor.files?.["toolbox-timeline.ts"] === RUNTIME);
  const viaNode = ed.exportSkiaFromEditor(nodes, edges, "aurora", ENV).result;
  check(
    "exporting the SkSL node directly gives the same timeline, under the node's own name",
    !!viaNode.files &&
      viaNode.files["timeline.ts"] === viaEditor.files?.["timeline.ts"] &&
      viaNode.files["effect.ts"].includes(`NAME = ${JSON.stringify(nodes.find((n) => n.id === "aurora")!.data.name)}`)
  );

  // Refusals, each naming what to change.
  const D = auroraInLayer("Plain Layer", "default");
  const pDefault = ed.prepareSkiaExport(D.nodes, D.edges, D.L.layer.id, ENV);
  check("a default layer is refused", !pDefault.request && !!pDefault.problems[0]?.includes("default layer"), pDefault.problems[0]);
  check(
    "…but its SkSL Shader still exports on its own",
    !!ed.exportSkiaFromEditor(D.nodes, D.edges, "aurora", ENV).result.files
  );
  const E = auroraInLayer("Empty");
  const unwired = E.edges.filter((e) => e.target !== E.L.groupOutput.id);
  const pEmpty = ed.prepareSkiaExport(E.nodes, unwired, E.L.layer.id, ENV);
  check("a Skia layer with nothing on its Layer Output is refused", !!pEmpty.problems[0]?.includes("nothing wired"), pEmpty.problems[0]);
  const W = auroraInLayer("Wrong");
  const nz = node("noise", "nz", W.L.layer.id);
  const wrongEdges = W.edges.filter((e) => e.target !== W.L.groupOutput.id);
  wrongEdges.push(edge("nz", "out:primary", W.L.groupOutput.id, "in:image"));
  const pWrong = ed.prepareSkiaExport([...W.nodes, nz], wrongEdges, W.L.layer.id, ENV);
  check(
    "a Skia layer rendering a non-target node names it",
    !!pWrong.problems[0]?.includes("(noise, nz)") && !!pWrong.problems[0]?.includes("export targets are"),
    pWrong.problems[0]
  );
  const pNoise = ed.prepareSkiaExport([...W.nodes, nz], wrongEdges, "nz", ENV);
  check("a plain node is not a target", !!pNoise.problems[0]?.includes("is a noise"), pNoise.problems[0]);
  check("a missing id is reported", !!ed.prepareSkiaExport(nodes, edges, "nope", ENV).problems[0]?.includes('"nope"'));

  // A layer slid along the comp timeline exports on its own clock — say so.
  const C = auroraInLayer("Late");
  C.L.layer.data.clips = [{ inTick: 30_000, outTick: 300_000, sourceInTick: 0, enabled: true }];
  const late = ed.exportSkiaFromEditor(C.nodes, C.edges, C.L.layer.id, ENV).result;
  check(
    "a layer that starts late exports with a clock warning",
    !!late.files && late.warnings.some((w) => w.includes("starts at frame 30")),
    JSON.stringify(late.warnings)
  );

  // The plan summary (MCP plan_skia_export).
  const plan = ed.planSkiaExportForEditor(nodes, edges, L.layer.id, ENV);
  const u = (name: string) => plan.uniforms?.find((x) => x.name === name);
  check(
    "plan: ok, target, layer and timeline length",
    plan.ok && plan.target?.id === "aurora" && plan.layer?.name === "Aurora Layer" && plan.timeline?.frames === 300 && plan.timeline?.seconds === 5,
    JSON.stringify({ ok: plan.ok, problems: plan.problems, timeline: plan.timeline })
  );
  check(
    "plan: animated uniforms say where they come from, with key ranges",
    u("drift_x")?.animated === true &&
      !!u("drift_x")?.from.includes("Animated Value drift") &&
      JSON.stringify(u("drift_x")?.frames) === "[0,300]" &&
      u("c2")?.animated === true &&
      u("c2")?.kind === "color" &&
      !!u("c2")?.from.includes("Color glow"),
    JSON.stringify(plan.uniforms)
  );
  check(
    "plan: static uniforms carry their value",
    !!plan.uniforms?.some((x) => !x.animated && x.value !== undefined && x.from.startsWith("static")),
    JSON.stringify(plan.uniforms?.filter((x) => !x.animated))
  );
  const planBad = ed.planSkiaExportForEditor(D.nodes, D.edges, D.L.layer.id, ENV);
  check("plan of a refusal is not ok and lists the problem", !planBad.ok && planBad.problems.length === 1);
  // Anything but an SkSL Shader goes through exportSkia — the scene
  // exporter's skia-canvas branch reports here once it lands.
  // The real def once lane L1 lands; a bare stand-in until then.
  const canvasNode: GraphNode = getNodeDef("skia-canvas")
    ? node("skia-canvas", "cv", W.L.layer.id)
    : (() => {
        const n = node("constant", "cv", W.L.layer.id);
        return { ...n, data: { ...n.data, defType: "skia-canvas", params: {}, name: "Skia Canvas" } };
      })();
  const cvEdges = W.edges.filter((e) => e.target !== W.L.groupOutput.id);
  cvEdges.push(edge("cv", "out:primary", W.L.groupOutput.id, "in:image"));
  const cvNodes = [...W.nodes, canvasNode];
  const cvPrep = ed.prepareSkiaExport(cvNodes, cvEdges, W.L.layer.id, ENV);
  const cvPlan = ed.planSkiaExportForEditor(cvNodes, cvEdges, W.L.layer.id, ENV);
  const cvDirect = (() => {
    if (!cvPrep.request) return null;
    try {
      return exportSkia(cvPrep.request);
    } catch (e) {
      return { files: null, problems: [`The exporter failed: ${(e as Error).message}`], warnings: [] };
    }
  })();
  check(
    "a Skia Canvas target resolves and is planned by exportSkia itself",
    cvPrep.target?.type === "skia-canvas" &&
      !!cvDirect &&
      (cvDirect.files
        ? cvPlan.ok && JSON.stringify(cvPlan.files) === JSON.stringify(Object.keys(cvDirect.files).sort())
        : !cvPlan.ok && JSON.stringify(cvPlan.problems) === JSON.stringify(cvDirect.problems)),
    JSON.stringify({ plan: cvPlan.problems, direct: cvDirect?.problems })
  );

  // Zip entries + a real zip.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 250, 251, 255]);
  const b64 = Buffer.from(png).toString("base64");
  const entries = ed.skiaZipEntries({ "index.ts": "export {};\n", "assets/logo.png.b64": b64, "notes.b64": "keep" }, "aurora-layer");
  const logo = entries.find((e) => e.path === "aurora-layer/assets/logo.png");
  check(
    "zip entries: under the bundle folder, assets/*.b64 decoded to bytes, other files text",
    entries.length === 3 &&
      !!logo?.bytes &&
      Buffer.from(logo.bytes).equals(Buffer.from(png)) &&
      entries.find((e) => e.path === "aurora-layer/index.ts")?.text === "export {};\n" &&
      entries.find((e) => e.path === "aurora-layer/notes.b64")?.text === "keep",
    JSON.stringify(entries.map((e) => e.path))
  );
  const JSZip = (await import("jszip")).default;
  const zipBytes = await ed.buildSkiaZip(ed.skiaZipEntries(viaEditor.files ?? {}, "aurora-layer"), "uint8array");
  const zip = await JSZip.loadAsync(zipBytes);
  const zipped = Object.keys(zip.files).filter((p) => !zip.files[p].dir).sort();
  const runtimeBack = await zip.file("aurora-layer/toolbox-timeline.ts")?.async("string");
  check(
    "the zip holds every bundle file under the folder, contents intact",
    zipped.length === Object.keys(viaEditor.files ?? {}).length &&
      zipped.every((p) => p.startsWith("aurora-layer/")) &&
      runtimeBack === RUNTIME,
    zipped.join(",")
  );
  const assetZip = await JSZip.loadAsync(await ed.buildSkiaZip(entries, "uint8array"));
  const logoBack = await assetZip.file("aurora-layer/assets/logo.png")?.async("uint8array");
  check("a decoded asset round-trips through the zip as binary", !!logoBack && Buffer.from(logoBack).equals(Buffer.from(png)));
  check(
    "bundle slug: lower-kebab ASCII, never empty",
    ed.skiaBundleSlug("Aurora Glow ✨ v2") === "aurora-glow-v2" && ed.skiaBundleSlug("✨") === "toolbox-effect"
  );
}

// ---- 5. the MCP handlers (the editor side of insert_recipe / edit_group /
//         get_catalog / plan_skia_export / export_skia) -------------------------------
{
  const { L, nodes, edges } = auroraInLayer("Glow");
  const status = {
    projectName: "gate",
    canvasWidth: 512,
    canvasHeight: 512,
    fps: 60,
    frame: 0,
    playing: false,
    loopFrames: 300,
    selectedNodeId: L.layer.id,
    scope: L.layer.id,
    scopeType: "layer" as const,
    parentScope: "root",
    scopeTarget: "skia" as const,
  };
  const toasts: string[] = [];
  const h = buildMcpHandlers({
    status,
    nodesRef: { current: nodes },
    edgesRef: { current: edges },
    flashToast: (m: string) => toasts.push(m),
  } as any);
  const call = async (name: string, args: Record<string, unknown>) => {
    try {
      return { ok: true as const, value: await (h as any)[name](args) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  };
  const cat = await call("get_catalog", { target: "skia" });
  check("get_catalog handler forwards target", cat.ok && String(cat.value).startsWith("# Skia layer catalog"), cat.ok ? "" : cat.error);
  const badCat = await call("get_catalog", { target: "metal" });
  check("get_catalog handler rejects an unknown target", !badCat.ok && badCat.error.includes('"metal"'));
  const recipe = {
    name: "mix",
    nodes: [{ id: "n", type: "noise" }],
    outputs: [{ name: "image", from: "n:out", type: "image" }],
  };
  const ins = await call("insert_recipe", { recipe, dry_run: true });
  check(
    "insert_recipe into the Skia layer scope is refused, naming the layer",
    !ins.ok && ins.error.includes("can't go inside Skia layer \"Glow\""),
    ins.ok ? JSON.stringify(ins.value) : ins.error
  );
  const insRoot = await call("insert_recipe", { recipe, dry_run: true, scope: "root" });
  check("the same recipe at root validates", insRoot.ok, insRoot.ok ? "" : insRoot.error);
  const okRecipe = {
    name: "skia",
    nodes: [{ id: "a", type: "animated-value" }, { id: "s", type: "sksl-shader" }],
    outputs: [{ name: "image", from: "s:out", type: "image" }],
  };
  const insSkia = await call("insert_recipe", { recipe: okRecipe, dry_run: true });
  check("a Skia-only recipe validates inside the layer", insSkia.ok, insSkia.ok ? "" : insSkia.error);
  const editBad = await call("edit_group", { groupId: L.layer.id, ops: [{ op: "add_node", id: "b", type: "blur" }], dry_run: true });
  check(
    "edit_group add_node of a non-Skia type inside the Skia layer is refused",
    !editBad.ok && editBad.error.includes("(blur) can't go inside Skia layer \"Glow\""),
    editBad.ok ? JSON.stringify(editBad.value) : editBad.error
  );
  const editOk = await call("edit_group", { groupId: L.layer.id, ops: [{ op: "add_node", id: "c", type: "constant" }], dry_run: true });
  check("edit_group add_node of a Skia type passes", editOk.ok, editOk.ok ? "" : editOk.error);

  const plan = await call("plan_skia_export", {});
  check(
    "plan_skia_export defaults to the selected node (the layer) and plans its shader",
    plan.ok && plan.value.ok === true && plan.value.target?.id === "aurora" && plan.value.uniforms?.length > 0,
    plan.ok ? JSON.stringify(plan.value).slice(0, 300) : plan.error
  );
  const exp = await call("export_skia", { target: "aurora" });
  check(
    "export_skia returns the files as text plus a folder and a note",
    exp.ok &&
      exp.value.files?.["toolbox-timeline.ts"] === RUNTIME &&
      typeof exp.value.files?.["effect.ts"] === "string" &&
      // The node's display name ("SkSL Shader"), slugged.
      exp.value.folder === "sksl-shader" &&
      String(exp.value.note).includes(".b64"),
    exp.ok ? Object.keys(exp.value).join(",") : exp.error
  );
  const expBad = await call("export_skia", { target: "nope" });
  check("export_skia on an unknown id is a tool error", !expBad.ok && expBad.error.includes('"nope"'));
  const nzNode = node("noise", "nz9", L.layer.id);
  const h2 =buildMcpHandlers({ status, nodesRef: { current: [...nodes, nzNode] }, edgesRef: { current: edges }, flashToast: () => {} } as any);
  let refused = "";
  try {
    await (h2 as any).export_skia({ target: "nz9" });
  } catch (e) {
    refused = (e as Error).message;
  }
  check("export_skia refusals list the problems", refused.includes("Nothing exported") && refused.includes("is a noise"), refused);
  check("nothing here toasted (read-only + dry runs)", toasts.length === 0, toasts.join(" | "));
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\ncheck-skia-layer: all checks passed.");
