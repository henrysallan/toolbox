// Static validator for a graph of real built-in nodes — the correctness gate
// for AI Recipe Generation (specdocs/062526_ai-recipe-generation.md, §6 /
// milestone 2). Engine-side + pure (invariant #1): no React, no GL, no state
// imports, so it runs server-side (the generate/repair loop) and in the UI.
//
// Unlike the editor's draw-time `isValidConnection` — which validates a single
// wire against *baseline* socket types and patches polymorphism with hardcoded
// defType exceptions — this resolves the whole graph in topological order,
// calling each def's resolveInputs/resolvePrimaryOutput with a `connectedTypes`
// map built from upstream outputs (exactly what the evaluator does). That makes
// polymorphic sockets (copy-to-points `instance`, displace, math, array) and
// group boundary nodes (sockets from `params.sockets`) resolve to their REAL
// types, so the only remaining rule is the genuine coercion table.

import type { SocketType, ResolveCtx } from "./types";
import { getNodeDef } from "./registry";
import { parseTargetHandleKind, paramSocketType } from "./graph-helpers";
import { withMaskInput } from "./conventions";

// Minimal structural node shape — both the engine GraphNode ({id, type, params})
// and the editor's Node<NodeDataPayload> ({id, data:{defType, params}}) adapt to
// this trivially. Keeping it local keeps the engine subtree self-contained.
export interface ValNode {
  id: string;
  defType: string;
  params: Record<string, unknown>;
}

export interface ValEdge {
  id?: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export type Severity = "error" | "warning";

export interface ValIssue {
  severity: Severity;
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValResult {
  ok: boolean; // true ⇒ no errors (warnings are allowed)
  issues: ValIssue[];
  order?: string[]; // topological order, when acyclic
}

// ---------------------------------------------------------------------------
// Coercion table — the canonical cross-type wires (mirrors coerce.ts and the
// editor's canCoerce, minus the polymorphic defType exceptions, which proper
// connectedTypes resolution makes unnecessary).
// ---------------------------------------------------------------------------
export function coercible(src: string, tgt: string): boolean {
  if (src === tgt) return true;
  if (src === "mask" && tgt === "image") return true;
  if (src === "image" && tgt === "mask") return true;
  if (src === "scalar" && (tgt === "vec2" || tgt === "vec3" || tgt === "vec4" || tgt === "uv"))
    return true;
  if ((src === "image" || src === "mask") && tgt === "scalar") return true;
  if (src === "audio" && tgt === "scalar") return true;
  if (src === "image" && tgt === "element") return true;
  if (src === "element" && tgt === "image") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Topological sort (Kahn). Returns the eval order, or the set of node ids that
// remain in a cycle.
// ---------------------------------------------------------------------------
export function topologicalSort(
  nodes: { id: string }[],
  edges: { source: string; target: string }[]
): { order: string[] } | { cycle: string[] } {
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));

  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    if (e.source === e.target) return { cycle: [e.source] }; // self-loop
    adj.get(e.source)!.push(e.target);
    indeg.set(e.target, indeg.get(e.target)! + 1);
  }

  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const m of adj.get(id)!) {
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  if (order.length !== ids.length) {
    return { cycle: ids.filter((id) => !order.includes(id)) };
  }
  return { order };
}

// ---------------------------------------------------------------------------
// Socket resolution (calls the def's resolvers, falling back to static on any
// throw — a recipe with odd params must never crash the validator).
// ---------------------------------------------------------------------------
interface ResolvedSockets {
  inputs: { name: string; type: string; required?: boolean }[];
  primary: string | null;
  aux: { name: string; type: string }[];
}

function resolveNodeSockets(
  node: ValNode,
  connectedTypes: Record<string, SocketType | undefined>
): ResolvedSockets | null {
  const def = getNodeDef(node.defType);
  if (!def) return null;
  const ctx: ResolveCtx = { connectedTypes };
  const params = node.params ?? {};

  let inputs = def.inputs;
  try {
    if (def.resolveInputs) inputs = def.resolveInputs(params, ctx);
  } catch {
    inputs = def.inputs;
  }
  inputs = withMaskInput(inputs, def);

  let primary = def.primaryOutput;
  try {
    if (def.resolvePrimaryOutput) primary = def.resolvePrimaryOutput(params, ctx);
  } catch {
    primary = def.primaryOutput;
  }

  let aux = def.auxOutputs;
  try {
    if (def.resolveAuxOutputs) aux = def.resolveAuxOutputs(params);
  } catch {
    aux = def.auxOutputs;
  }

  return {
    inputs: inputs.map((i) => ({ name: i.name, type: i.type, required: i.required })),
    primary,
    aux: aux.map((a) => ({ name: a.name, type: a.type })),
  };
}

interface ResolvedOut {
  primary: string | null;
  aux: Map<string, string>;
}

function outputTypeOf(
  sourceId: string,
  handle: string,
  resolvedOut: Map<string, ResolvedOut>
): string | null {
  const r = resolvedOut.get(sourceId);
  if (!r) return null;
  if (handle === "out:primary") return r.primary;
  if (handle.startsWith("out:aux:")) return r.aux.get(handle.slice("out:aux:".length)) ?? null;
  return null;
}

// ---------------------------------------------------------------------------
// Validate a flat graph of real nodes.
// ---------------------------------------------------------------------------
export function validateGraph(nodes: ValNode[], edges: ValEdge[]): ValResult {
  const issues: ValIssue[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const err = (code: string, message: string, extra?: Partial<ValIssue>) =>
    issues.push({ severity: "error", code, message, ...extra });
  const warn = (code: string, message: string, extra?: Partial<ValIssue>) =>
    issues.push({ severity: "warning", code, message, ...extra });

  // 1. Node types exist.
  for (const n of nodes) {
    if (!getNodeDef(n.defType))
      err("NODE_UNKNOWN_TYPE", `Unknown node type "${n.defType}".`, { nodeId: n.id });
  }

  // 2. Edges reference real nodes + well-formed handles.
  const goodEdges: ValEdge[] = [];
  for (const e of edges) {
    if (!byId.has(e.source)) {
      err("EDGE_BAD_SOURCE", `Edge source "${e.source}" is not a node.`, { edgeId: e.id });
      continue;
    }
    if (!byId.has(e.target)) {
      err("EDGE_BAD_TARGET", `Edge target "${e.target}" is not a node.`, { edgeId: e.id });
      continue;
    }
    if (!e.sourceHandle || !e.targetHandle) {
      err("EDGE_BAD_HANDLE", `Edge ${e.source}→${e.target} is missing a handle.`, { edgeId: e.id });
      continue;
    }
    goodEdges.push(e);
  }

  // 3. Acyclic. A cycle makes type resolution ill-defined, so we stop here.
  const topo = topologicalSort(nodes, goodEdges);
  if ("cycle" in topo) {
    err("GRAPH_CYCLE", `Graph has a cycle through: ${topo.cycle.join(", ")}.`);
    return { ok: false, issues };
  }
  const order = topo.order;

  // 4. Resolve sockets in topological order, threading connectedTypes.
  const edgesByTarget = new Map<string, ValEdge[]>();
  for (const e of goodEdges) {
    (edgesByTarget.get(e.target) ?? edgesByTarget.set(e.target, []).get(e.target)!).push(e);
  }
  const resolvedOut = new Map<string, ResolvedOut>();
  const resolvedIn = new Map<string, ResolvedSockets>();
  for (const id of order) {
    const node = byId.get(id)!;
    if (!getNodeDef(node.defType)) continue; // already flagged
    const connectedTypes: Record<string, SocketType | undefined> = {};
    for (const e of edgesByTarget.get(id) ?? []) {
      const parsed = parseTargetHandleKind(e.targetHandle);
      if (parsed?.kind === "input") {
        const t = outputTypeOf(e.source, e.sourceHandle, resolvedOut);
        if (t) connectedTypes[parsed.name] = t as SocketType;
      }
    }
    const r = resolveNodeSockets(node, connectedTypes);
    if (!r) continue;
    resolvedIn.set(id, r);
    resolvedOut.set(id, {
      primary: r.primary,
      aux: new Map(r.aux.map((a) => [a.name, a.type])),
    });
  }

  // 5. Per-edge handle existence + type compatibility.
  for (const e of goodEdges) {
    const srcT = outputTypeOf(e.source, e.sourceHandle, resolvedOut);
    if (srcT == null) {
      err("EDGE_UNKNOWN_OUTPUT", `Source ${e.source} has no output "${e.sourceHandle}".`, {
        edgeId: e.id,
      });
      continue;
    }
    const parsed = parseTargetHandleKind(e.targetHandle);
    if (!parsed) {
      err("EDGE_BAD_TARGET_HANDLE", `Malformed target handle "${e.targetHandle}".`, {
        edgeId: e.id,
      });
      continue;
    }
    let tgtT: string | null;
    if (parsed.kind === "input") {
      const ri = resolvedIn.get(e.target);
      tgtT = ri?.inputs.find((i) => i.name === parsed.name)?.type ?? null;
      if (tgtT == null) {
        err("EDGE_UNKNOWN_INPUT", `Node ${e.target} has no input "${parsed.name}".`, {
          edgeId: e.id,
        });
        continue;
      }
    } else {
      const def = getNodeDef(byId.get(e.target)!.defType);
      const p = def?.params.find((x) => x.name === parsed.name);
      if (!p) {
        err("EDGE_UNKNOWN_PARAM", `Node ${e.target} has no param "${parsed.name}".`, {
          edgeId: e.id,
        });
        continue;
      }
      tgtT = paramSocketType(p.type);
      if (tgtT == null) {
        err(
          "PARAM_NOT_DRIVABLE",
          `Param "${parsed.name}" (${p.type}) can't be driven by a wire.`,
          { edgeId: e.id }
        );
        continue;
      }
    }
    if (!coercible(srcT, tgtT)) {
      err(
        "EDGE_TYPE_MISMATCH",
        `Incompatible wire ${e.source}:${srcT} → ${e.target}:${tgtT} (${e.targetHandle}).`,
        { edgeId: e.id }
      );
    }
  }

  // 6. Required inputs unwired ⇒ warning (a partial recipe is still valid).
  for (const id of order) {
    const ri = resolvedIn.get(id);
    if (!ri) continue;
    const wired = new Set(
      (edgesByTarget.get(id) ?? [])
        .map((e) => parseTargetHandleKind(e.targetHandle))
        .filter((p): p is { kind: "input"; name: string } => p?.kind === "input")
        .map((p) => p.name)
    );
    for (const i of ri.inputs) {
      if (i.required && !wired.has(i.name))
        warn("REQUIRED_INPUT_UNWIRED", `Required input "${i.name}" on ${id} is unwired.`, {
          nodeId: id,
        });
    }
  }

  return { ok: !issues.some((i) => i.severity === "error"), issues, order };
}
