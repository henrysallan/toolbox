// The exporter walk (spec 091926_after-effects-handoff.md §5.2): editor graph →
// AeScene + everything the package writer must produce next to scene.json.
//
//   1. plan      buildAePlanInput + planAeExport, exactly as plan_ae_export
//                (planAeExportForEditor) does, so ids and verdicts agree
//   2. layers    each toolbox layer of the Output's stack (parents first) →
//                its AE layer(s) in the main comp (layers.ts): the layer
//                output endpoint renders through the emitters below, which
//                recurse into their inputs
//   3. emitters  vector (shape.ts + style.ts) · source / raster (effects.ts)
//                · composite (composite.ts) · text · instances · shader ·
//                bake; masks.ts for every matte
//   4. gradients SVG seeds where the gradient owns its layer, else .ffx
//                presets (gradients.ts)
//   5. report    the plan's verdict per node, corrected by the walk
//                (report.ts); validateAeScene on the result
//
// Contract (types.ts) shared with the package lane (export_ae_package, the
// modal's runner) and the modal lane.

import type { Edge } from "@xyflow/react";
import type { GraphNode } from "@/state/graph-ops";
import { buildAePlanInput } from "../editor";
import { planAeExport } from "../plan";
import { validateAeScene } from "../runtime/validate";
import { AE_SCENE_SCHEMA_VERSION, type AeComp, type AeLayer, type AeScene } from "../types";
import { DEFAULT_TICKS_PER_FRAME } from "@/engine/keyframes";
import { emitBake } from "./bake";
import { emitComposite } from "./composite";
import { makeUid, type WalkClock, type WalkCtx } from "./context";
import { emitRaster, emitSource } from "./effects";
import { makeAeGraph } from "./graph";
import { routeGradients } from "./gradients";
import { emitInstances } from "./instances";
import { KnobRegistry } from "./knobs";
import { emitToolboxLayer, renderEndpoint, type Emitters, type LayerUnit, type Scope } from "./layers";
import { AeReport } from "./report";
import { emitShader } from "./shader";
import { emitVector } from "./shape";
import { emitText } from "./text";
import type { AeSceneBuild, AeSceneOptions } from "./types";

export type { AeAssetCopy, AeBakeRequest, AeNodeOverride, AeSceneBuild, AeSceneOptions } from "./types";
export { postScriptName } from "./text";
export { knobExpression } from "./knobs";

export function buildAeSceneForEditor(nodes: GraphNode[], edges: Edge[], opts: AeSceneOptions): AeSceneBuild {
  const env = opts.env;
  const input = buildAePlanInput(nodes, edges, env);
  const plan = planAeExport(input);
  const c = env.composition;
  const canvas = { width: c.width, height: c.height };
  // Exposed knobs (knobs.ts) see the raw graph; the walk sees it with
  // Constant-knob wires read as the constant's value.
  const knobs = new KnobRegistry(makeAeGraph(nodes, edges, env.compositionId, canvas, c.fps));
  const graph = knobs.graph;
  const ctx: WalkCtx = {
    canvas,
    fps: c.fps,
    tpf: DEFAULT_TICKS_PER_FRAME,
    durationFrames: Math.max(1, Math.round(c.durationFrames)),
    policy: plan.policy,
    graph,
    plan,
    overrides: opts.overrides ?? {},
    fused: opts.fused ?? {},
    name: opts.name,
    report: new AeReport(plan),
    out: { comps: [], footage: [], presets: [], files: [], assets: [], bakes: [], bundles: [], warnings: [], problems: [] },
    projectNeeds: {},
    knobs,
    free: new WeakSet(),
    uid: makeUid(),
  };
  for (const a of plan.approximations) ctx.report.seedApprox(a.id, a.note);
  for (const b of plan.blocked) ctx.out.problems.push(`${b.type} (${b.id}) is a live input: ${b.reason}`);

  const em: Emitters = {
    vector: (s, ep, pn) => emitVector(s, ep, pn),
    source: (s, ep, pn) => emitSource(s, ep, pn, em),
    raster: (s, ep, pn) => emitRaster(s, ep, pn, em),
    composite: (s, ep, pn) => emitComposite(s, ep, pn, em),
    text: (s, ep, pn) => emitText(s, ep, pn),
    instances: (s, ep, pn) => emitInstances(s, ep, pn),
    shader: (s, ep, pn) => emitShader(s, ep, pn),
    bake: (s, ep, reason, members) => emitBake(s, ep, reason, members),
  };

  // Parents before children (a child's AE parent must exist); the main comp
  // keeps the stack order.
  const units = new Map<string, LayerUnit>();
  const order: number[] = [];
  const visiting = new Set<string>();
  const visit = (i: number) => {
    const L = input.layers[i];
    if (order.includes(i) || visiting.has(L.id)) return;
    visiting.add(L.id);
    const pi = L.parent ? input.layers.findIndex((x) => x.id === L.parent) : -1;
    if (pi >= 0) visit(pi);
    order.push(i);
  };
  input.layers.forEach((_, i) => visit(i));

  for (const i of order) {
    const L = plan.layers[i];
    const Li = input.layers[i];
    const nodesById = new Map(L.nodes.map((n) => [n.id, n]));
    const makeScope = (clock: WalkClock): Scope => {
      const scope: Scope = {
        ctx,
        layer: L,
        input: Li,
        clock,
        nodes: nodesById,
        render: (ep) => knobs.render(scope, ep, () => renderEndpoint(scope, ep, em)),
        at: (cl) => makeScope(cl),
      };
      return scope;
    };
    const parent = Li.parent ? units.get(Li.parent) : undefined;
    // A layer blend AE lacks: the plan bakes this layer's composite.
    const layerBake = plan.bakes.find((b) => b.output === `${L.id}:out`);
    const layerShader = plan.shaderRegions.find((r) => r.target === `${L.id}:out`);
    if (layerBake || layerShader) {
      const scope = makeScope({ offsetTicks: 0, inFrame: 0, outFrame: ctx.durationFrames });
      const reason = layerBake?.reason ?? `${layerShader!.summary ?? "layer blend"} — bakes (a blend-mode Toolbox Shader is not emitted yet)`;
      ctx.report.ensure(L.id, "layer", "bake", L.name);
      const r = emitBake(scope, `${L.id}:out`, reason, [L.id]);
      units.set(L.id, { layers: r.layers, xform: undefined });
      continue;
    }
    units.set(L.id, emitToolboxLayer(ctx, L, Li, makeScope, parent));
  }

  const mainLayers: AeLayer[] = [];
  for (let i = plan.layers.length - 1; i >= 0; i--) mainLayers.push(...(units.get(plan.layers[i].id)?.layers ?? []));
  const main: AeComp = {
    id: ctx.uid("comp:main"),
    name: opts.name,
    width: c.width,
    height: c.height,
    fps: c.fps,
    duration: ctx.durationFrames / c.fps,
    bgColor: [0, 0, 0],
    layers: mainLayers,
  };
  if (!mainLayers.length) ctx.out.warnings.push(`Composition "${c.name}" exports no layers.`);

  const scene: AeScene = {
    schemaVersion: AE_SCENE_SCHEMA_VERSION,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    toolboxVersion: opts.toolboxVersion,
    project: {
      bitsPerChannel: plan.policy.bitsPerChannel,
      workingSpace: "sRGB IEC61966-2.1",
      linearBlending: false,
      // Off: toolbox composites display-referred sRGB, and the calibrated
      // effect maps were measured that way (Gaussian Blur 2 linearizes on its
      // own; in a linearized space it would twice). build.jsx sets it.
      linearizeWorkingSpace: ctx.projectNeeds.linearizeWorkingSpace ?? false,
      expressionEngine: "javascript-1.0",
    },
    footage: ctx.out.footage,
    presets: [],
    comps: [...ctx.out.comps, main],
    main: main.id,
    report: { route: plan.route, native: [], approx: [], shader: [], baked: [], blocked: [], warnings: [], requires: { fonts: [] } },
  };
  routeGradients(ctx, scene, opts.gradientRoute ?? "svg");
  // Distinct comp names, and distinct layer names per comp: AE allows
  // duplicates, but expressions and people address both by name.
  const compNames = new Map<string, number>();
  for (const comp of scene.comps) {
    const n = (compNames.get(comp.name) ?? 0) + 1;
    compNames.set(comp.name, n);
    if (n > 1) comp.name = `${comp.name} ${n}`;
  }
  for (const comp of scene.comps) {
    const seen = new Map<string, number>();
    for (const L of [...comp.layers].reverse()) {
      const n = (seen.get(L.name) ?? 0) + 1;
      seen.set(L.name, n);
      if (n > 1) L.name = `${L.name} ${n}`;
    }
  }

  const route: AeScene["report"]["route"] = plan.blocked.length ? "blocked" : ctx.out.bundles.length ? "direct+shader" : ctx.out.bakes.length ? "direct+bake" : "direct";
  scene.report = ctx.report.build(plan, route);
  // Knob placeholders → each comp's Controls null (names are final now).
  const controls = knobs.finish(ctx, scene);
  if (controls.length) scene.report.controls = controls;
  const invalid = validateAeScene(scene);
  for (const p of invalid) ctx.out.problems.push(`scene.json: ${p}`);

  return {
    plan,
    scene,
    bakes: ctx.out.bakes,
    bundles: ctx.out.bundles,
    presets: ctx.out.presets,
    files: ctx.out.files,
    assets: ctx.out.assets,
    problems: ctx.out.problems,
    warnings: [...new Set([...plan.warnings, ...ctx.out.warnings, ...ctx.report.warnings])],
  };
}
