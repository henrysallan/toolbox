// The editor + MCP half of the After Effects analysis (spec
// 091926_after-effects-handoff.md §6): editor nodes/edges → AePlanInput →
// planAeExport, and the readable report plan_ae_export returns. No DOM, no
// GL — the gate (scripts/ae-export/check-plan.mts) runs it on the real
// registry; mcp-handlers.ts adds the editor's status and refs.
//
// What the planner sees is what the evaluator evaluates: the composition is
// flattened (flattenGraph — groups and reroutes dissolve, a layer's interior
// wires onto its hidden `content` input, zone interiors come back from
// iterateInteriors with `parent` set), bypassed nodes pass their first input
// through, and each root layer in the Output's stack becomes one scope.
//
// Exporter wave: feed planAeExport the same AePlanInput this builds (or call
// buildAePlanInput directly) so the plan and the scene walk agree on ids.

import type { Edge } from "@xyflow/react";
import { withMaskInput } from "@/engine/conventions";
import type { GraphEdge, GraphNode as EngineNode } from "@/engine/evaluator";
import { flattenGraph } from "@/engine/flatten";
import { isZoneShell, LAYER_TYPE, LAYER_XFORM_TYPE } from "@/engine/groups";
import { DEFAULT_TICKS_PER_FRAME, type KeyframeAnimationBlock } from "@/engine/keyframes";
import { SETTABLE_PARAM_TYPES } from "@/engine/node-catalog";
import { getNodeDef } from "@/engine/registry";
import type { NodeOutput } from "@/engine/types";
import { resolveComposition, type GraphNode } from "@/state/graph-ops";
import { describeAePlan, planAeExport, type AePlanInput, type AePlanLayerInput, type AePlanTrack } from "./plan";
import type { PlanEdge, PlanNode, PlanNodeInfo } from "@/lib/glsl-translation/plan";
import {
  DEFAULT_AE_POLICY,
  type AeExportPlan,
  type AeExportPolicy,
  type AePlanWindow,
} from "./types";

export interface AeEditorEnv {
  composition: AeExportPlan["composition"];
  // Restrict to one composition's nodes (resolveComposition). Omit for a
  // single-composition project.
  compositionId?: string;
  policy?: Partial<AeExportPolicy>;
  // Playhead frame (planTranslation's static-graph frame).
  frame?: number;
  // Plan one layer (its id) instead of the whole stack.
  scope?: string;
  // Plan the branch feeding this node ("<id>" | "<id>:out" | "<id>:aux:<name>")
  // in place of its layer's output.
  target?: string;
  // The editor's last evaluation, for evaluated point counts.
  lastOutputs?: Map<string, NodeOutput> | null;
}

const VIRTUAL_TYPES: [RegExp, string][] = [
  [/^(ramp_c|gpoint_c):/, "color"],
  [/^(ramp_a|ramp_p|gpoint_x|gpoint_y|layer_opacity):/, "scalar"],
  [/^anchor_(p|in|out):/, "vec2"],
];

function toEngineGraph(nodes: GraphNode[], edges: Edge[]): { nodes: EngineNode[]; edges: GraphEdge[] } {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.defType,
      parentId: n.data.parentId,
      params: n.data.params,
      exposedParams: n.data.exposedParams,
      animation: n.data.animation,
      clips: n.data.clips,
      bypassed: !!n.data.bypassed,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? "out:primary",
      target: e.target,
      targetHandle: e.targetHandle ?? "in:image",
    })),
  };
}

const fromEndpoint = (id: string, handle: string) =>
  handle.startsWith("out:aux:") ? `${id}:aux:${handle.slice("out:aux:".length)}` : `${id}:out`;
const toEndpoint = (id: string, handle: string) =>
  handle.startsWith("in:param:") ? `${id}:param:${handle.slice("in:param:".length)}` : `${id}:${handle.startsWith("in:") ? handle : `in:${handle}`}`;

export function nodeInfoFor(type: string, params: Record<string, unknown>): PlanNodeInfo | undefined {
  const def = getNodeDef(type);
  if (!def) return undefined;
  let ins = def.inputs;
  try {
    ins = def.resolveInputs?.(params) ?? def.inputs;
  } catch {
    ins = def.inputs;
  }
  ins = withMaskInput(ins, def);
  return {
    inputs: ins.map((i) => ({ name: i.name, type: i.type })),
    primaryOutput: def.primaryOutput ?? undefined,
    auxOutputs: (def.auxOutputs ?? []).map((a) => ({ name: a.name, type: a.type })),
    readsTime: !!def.facts?.reads?.includes("time"),
    simulation: !!def.simulation,
    params: def.params
      .filter((p) => SETTABLE_PARAM_TYPES.has(p.type))
      .map((p) => ({
        name: p.name,
        type: p.type,
        ...(p.min !== undefined ? { min: p.min } : {}),
        ...(p.max !== undefined ? { max: p.max } : {}),
        ...(p.options ? { options: p.options as string[] } : {}),
        default: p.default,
      })),
  };
}

export function tracksOfNode(type: string, animation: Record<string, KeyframeAnimationBlock> | undefined): AePlanTrack[] {
  const def = getNodeDef(type);
  const out: AePlanTrack[] = [];
  for (const [param, block] of Object.entries(animation ?? {})) {
    if (!block?.animated || !Array.isArray(block.keyframes) || !block.keyframes.length) continue;
    const keys = [...block.keyframes].sort((a, b) => a.tick - b.tick);
    const type =
      def?.params.find((p) => p.name === param)?.type ?? VIRTUAL_TYPES.find(([re]) => re.test(param))?.[1];
    out.push({
      param,
      frames: keys.map((k) => k.tick / DEFAULT_TICKS_PER_FRAME),
      easings: keys.map((k) => k.easingOut),
      ...(type ? { type } : {}),
      ...(type === "color" ? { colorSpace: block.colorSpace ?? "oklab" } : {}),
    });
  }
  return out;
}

function nonDefault(type: string, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of getNodeDef(type)?.params ?? []) {
    if (!SETTABLE_PARAM_TYPES.has(p.type) || params[p.name] === undefined) continue;
    if (JSON.stringify(params[p.name]) !== JSON.stringify(p.default)) out[p.name] = params[p.name];
  }
  return out;
}

function windowsOf(n: { clips?: { inTick: number; outTick: number; sourceInTick: number; enabled: boolean }[] }): AePlanWindow[] | undefined {
  const ws = (n.clips ?? [])
    .filter((c) => c.enabled)
    .map((c) => ({
      inFrame: c.inTick / DEFAULT_TICKS_PER_FRAME,
      outFrame: c.outTick / DEFAULT_TICKS_PER_FRAME,
      sourceInFrame: (c.sourceInTick ?? 0) / DEFAULT_TICKS_PER_FRAME,
    }));
  return ws.length ? ws : undefined;
}

// The composition as the evaluator sees it (see the header): flattened, zone
// interiors included, bypassed nodes wired through. Shared by the planner
// input below and the scene walk (scene/graph.ts), so both use the same ids.
export interface AeFlatComposition {
  comp: { nodes: GraphNode[]; edges: Edge[] };
  names: Map<string, string>;
  flat: ReturnType<typeof flattenGraph>;
  allNodes: EngineNode[];
  allEdges: GraphEdge[];
  byId: Map<string, EngineNode>;
  // allEdges minus edges into bypassed nodes, sources resolved through bypasses.
  wires: GraphEdge[];
}

export function flattenAeComposition(nodes: GraphNode[], edges: Edge[], compositionId?: string): AeFlatComposition {
  const comp = resolveComposition(nodes, edges, compositionId);
  const names = new Map(comp.nodes.map((n) => [n.id, n.data.name || getNodeDef(n.data.defType)?.name || n.data.defType]));
  const eng = toEngineGraph(comp.nodes, comp.edges);
  const flat = flattenGraph(eng.nodes, eng.edges);

  // Zone interiors come back as members of their shell's scope.
  const allNodes: EngineNode[] = [...flat.nodes];
  const allEdges: GraphEdge[] = [...flat.edges];
  for (const sub of flat.iterateInteriors?.values() ?? []) {
    allNodes.push(...sub.nodes);
    allEdges.push(...sub.edges);
  }
  const byId = new Map(allNodes.map((n) => [n.id, n]));

  // Bypassed nodes pass their first input socket through (the evaluator's rule).
  const bypassSource = new Map<string, { source: string; sourceHandle: string }>();
  for (const n of allNodes) {
    if (!n.bypassed) continue;
    const first = getNodeDef(n.type)?.inputs[0]?.name;
    const e = first ? allEdges.find((x) => x.target === n.id && x.targetHandle === `in:${first}`) : undefined;
    if (e) bypassSource.set(n.id, { source: e.source, sourceHandle: e.sourceHandle });
  }
  const resolveSource = (source: string, sourceHandle: string) => {
    for (let hops = 0; hops < 64 && byId.get(source)?.bypassed; hops++) {
      if (sourceHandle !== "out:primary") return undefined; // a bypassed node's aux outputs are empty
      const up = bypassSource.get(source);
      if (!up) return undefined;
      source = up.source;
      sourceHandle = up.sourceHandle;
    }
    return { source, sourceHandle };
  };
  const wires: GraphEdge[] = [];
  for (const e of allEdges) {
    if (byId.get(e.target)?.bypassed) continue;
    const s = resolveSource(e.source, e.sourceHandle);
    if (s) wires.push({ ...e, ...s });
  }
  return { comp, names, flat, allNodes, allEdges, byId, wires };
}

export function buildAePlanInput(nodes: GraphNode[], edges: Edge[], env: AeEditorEnv): AePlanInput {
  const { comp, names, flat, allNodes, byId, wires } = flattenAeComposition(nodes, edges, env.compositionId);
  const into = new Map<string, GraphEdge[]>();
  for (const e of wires) (into.get(e.target) ?? into.set(e.target, []).get(e.target)!).push(e);
  const sourceInto = (id: string, handle: string) => into.get(id)?.find((e) => e.targetHandle === handle);

  // The Output's stack, top → bottom through each layer's `stack` input.
  const output = allNodes.find((n) => n.type === "output" && !n.parentId);
  const chainTopDown: { layer?: EngineNode; from: GraphEdge }[] = [];
  let cur = output ? sourceInto(output.id, "in:image") : undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.source)) {
    seen.add(cur.source);
    const n = byId.get(cur.source);
    if (n?.type !== LAYER_TYPE) {
      chainTopDown.push({ from: cur }); // root-level content under (or instead of) the layers
      break;
    }
    chainTopDown.push({ layer: n, from: cur });
    cur = sourceInto(n.id, "in:stack");
  }
  const bottomUp = chainTopDown.reverse();

  const scopeOf = (out: { source: string; sourceHandle: string } | undefined, id: string, name: string, layer?: EngineNode): AePlanLayerInput => {
    const members = new Set<string>();
    const walk = (x: string) => {
      const n = byId.get(x);
      if (!n || members.has(x) || n.type === LAYER_TYPE || n.type === LAYER_XFORM_TYPE || n.type === "output") return;
      members.add(x);
      for (const e of into.get(x) ?? []) walk(e.source);
    };
    if (out) walk(out.source);
    // Zone members (and what feeds them) ride with their shell.
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of allNodes)
        if (n.parentId && members.has(n.parentId) && !members.has(n.id) && isZoneShell(byId.get(n.parentId)?.type)) {
          walk(n.id);
          grew = true;
        }
    }
    const order = allNodes.filter((n) => members.has(n.id));
    const planNodes: PlanNode[] = order.map((n) => {
      const anim = (n.animation ?? {}) as Record<string, KeyframeAnimationBlock>;
      const keyframed = Object.keys(anim).filter((k) => anim[k]?.animated);
      const zone = n.parentId && isZoneShell(byId.get(n.parentId)?.type) ? n.parentId : undefined;
      const nm = names.get(n.id);
      const defName = getNodeDef(n.type)?.name;
      return {
        id: n.id,
        type: n.type,
        ...(nm && nm !== defName ? { name: nm } : {}),
        params: nonDefault(n.type, n.params),
        keyframed,
        ...(zone ? { parent: zone } : {}),
      };
    });
    const planEdges: PlanEdge[] = wires
      .filter((e) => members.has(e.source) && members.has(e.target))
      .map((e) => ({ from: fromEndpoint(e.source, e.sourceHandle), to: toEndpoint(e.target, e.targetHandle) }));
    // Parenting from the editor wire (flatten reroutes it onto layer-xform nodes).
    const parentLayer = layer ? comp.edges.find((e) => e.target === layer.id && e.targetHandle === "in:transform")?.source : undefined;
    return {
      id,
      name,
      nodes: planNodes,
      edges: planEdges,
      ...(out ? { output: fromEndpoint(out.source, out.sourceHandle) } : {}),
      ...(layer
        ? {
            blendMode: String(layer.params.blendMode ?? "normal"),
            opacity: typeof layer.params.opacity === "number" ? layer.params.opacity : 1,
            keyframed: Object.keys(layer.animation ?? {}).filter((k) => (layer.animation as Record<string, KeyframeAnimationBlock>)[k]?.animated),
            ...(windowsOf(layer) ? { windows: windowsOf(layer) } : {}),
            ...(parentLayer && parentLayer !== layer.id && byId.get(parentLayer)?.type === LAYER_TYPE ? { parent: parentLayer } : {}),
          }
        : {}),
    };
  };

  let layers: AePlanLayerInput[] = bottomUp.map(({ layer, from }) =>
    layer
      ? scopeOf(sourceInto(layer.id, "in:content"), layer.id, names.get(layer.id) ?? "Layer", layer)
      : scopeOf(from, "root", "Composition root")
  );

  // scope / target narrow the plan to one layer (or one branch of it).
  const layerOfNode = (id: string): string => {
    if (byId.get(id)?.type === LAYER_TYPE) return id;
    return flat.layerOf.get(id) ?? layers.find((l) => l.nodes.some((n) => n.id === id))?.id ?? "root";
  };
  if (env.target) {
    const raw = env.target.trim();
    const aux = /^(.*):aux:([A-Za-z0-9_-]+)$/.exec(raw);
    const id = aux ? aux[1] : raw.endsWith(":out") ? raw.slice(0, -4) : raw;
    const n = byId.get(id);
    if (!n) throw new Error(`No node "${id}" in this composition — call get_graph for current ids.`);
    if (n.type === LAYER_TYPE) layers = layers.filter((l) => l.id === id);
    else {
      const lid = layerOfNode(id);
      const layerNode = lid === "root" ? undefined : byId.get(lid);
      const handle = aux ? `out:aux:${aux[2]}` : "out:primary";
      layers = [scopeOf({ source: id, sourceHandle: handle }, lid, names.get(lid) ?? "Composition root", layerNode)];
    }
    if (!layers.length) throw new Error(`Layer "${id}" is not in the Output's stack — nothing to plan.`);
  } else if (env.scope && env.scope !== "root") {
    const lid = layerOfNode(env.scope);
    layers = layers.filter((l) => l.id === lid);
    if (!layers.length) throw new Error(`"${env.scope}" is not a layer in the Output's stack — pass a layer id from get_graph (root scope), or omit scope for the whole composition.`);
  }

  const lastOutputs = env.lastOutputs ?? undefined;
  return {
    composition: env.composition,
    layers,
    infoOf: (id) => {
      const n = byId.get(id);
      return n ? nodeInfoFor(n.type, n.params) : undefined;
    },
    valuesOf: (id) => byId.get(id)?.params ?? {},
    tracksOf: (id) => {
      const n = byId.get(id);
      return n ? tracksOfNode(n.type, n.animation as Record<string, KeyframeAnimationBlock> | undefined) : [];
    },
    countOf: (endpoint) => {
      if (!lastOutputs) return undefined;
      const aux = /^(.*):aux:([A-Za-z0-9_-]+)$/.exec(endpoint);
      const id = aux ? aux[1] : endpoint.replace(/:out$/, "");
      const o = lastOutputs.get(id);
      const v = (aux ? o?.aux?.[aux[2]] : o?.primary) as { kind?: string; count?: number } | undefined;
      return v?.kind === "points" && typeof v.count === "number" ? v.count : undefined;
    },
    ...(env.policy ? { policy: env.policy } : {}),
    ...(env.frame !== undefined ? { frame: env.frame } : {}),
  };
}

export function planAeExportForEditor(nodes: GraphNode[], edges: Edge[], env: AeEditorEnv): AeExportPlan {
  return planAeExport(buildAePlanInput(nodes, edges, env));
}

// plan_ae_export's result: the five-line relay first, the JSON plan after.
export function aePlanReport(plan: AeExportPlan): string {
  return `${describeAePlan(plan)}\n\nJSON plan:\n${JSON.stringify(plan)}\n`;
}

// The policy argument of plan_ae_export, checked key by key — an unknown key
// or a wrong type is an error, never silently the default.
export function vetAePolicy(raw: unknown): Partial<AeExportPolicy> | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("policy must be an object, e.g. { shaderHost: false }.");
  const out: Partial<AeExportPolicy> = {};
  const errors: string[] = [];
  const oneOf = <T extends string | number>(k: string, v: unknown, opts: readonly T[]): T | undefined => {
    if (opts.includes(v as T)) return v as T;
    errors.push(`${k} must be one of ${opts.map((o) => JSON.stringify(o)).join(", ")} — got ${JSON.stringify(v)}`);
    return undefined;
  };
  const positive = (k: string, v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    errors.push(`${k} must be a non-negative number — got ${JSON.stringify(v)}`);
    return undefined;
  };
  const bool = (k: string, v: unknown) => {
    if (typeof v === "boolean") return v;
    errors.push(`${k} must be true or false — got ${JSON.stringify(v)}`);
    return undefined;
  };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    switch (k) {
      case "fidelity": { const x = oneOf(k, v, ["editable", "exact"] as const); if (x) out.fidelity = x; break; }
      case "color": { const x = oneOf(k, v, ["auto", "expression", "dense", "rgb"] as const); if (x) out.color = x; break; }
      case "bakeCodec": { const x = oneOf(k, v, ["prores4444", "qtrle"] as const); if (x) out.bakeCodec = x; break; }
      case "bitsPerChannel": { const x = oneOf(k, v, [8, 16, 32] as const); if (x) out.bitsPerChannel = x; break; }
      case "colorTolerance": { const x = positive(k, v); if (x !== undefined) out.colorTolerance = x; break; }
      case "layerBudget": { const x = positive(k, v); if (x !== undefined) out.layerBudget = Math.round(x); break; }
      case "bakeWarnMB": { const x = positive(k, v); if (x !== undefined) out.bakeWarnMB = x; break; }
      case "acceptApprox": { const x = bool(k, v); if (x !== undefined) out.acceptApprox = x; break; }
      case "shaderHost": { const x = bool(k, v); if (x !== undefined) out.shaderHost = x; break; }
      default:
        errors.push(`unknown policy key "${k}" (known: ${Object.keys(DEFAULT_AE_POLICY).join(", ")})`);
    }
  }
  if (errors.length) throw new Error(`Invalid policy:\n- ${errors.join("\n- ")}`);
  return out;
}
