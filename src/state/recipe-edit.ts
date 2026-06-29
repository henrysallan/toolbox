// Edit-with-AI core (spec 062926_edit-group-with-ai.md, strategy B = patches).
//   groupToSpec()    — serialize a live group's interior to an editable spec
//                      (the LLM's context; the inverse of buildRecipe).
//   applyRecipeEdit() — apply a patch (ops) to the group's interior, preserving
//                      everything an op didn't touch. The result is validated
//                      by graph-validation and committed in place by the caller.
//
// Patch semantics preserve untouched work by construction: nodes an op doesn't
// touch are never rebuilt, so their ids, animation, and external wires survive.

import type { Edge } from "@xyflow/react";
import { getNodeDef } from "@/engine/registry";
import { SETTABLE_PARAM_TYPES } from "@/engine/node-catalog";
import {
  GROUP_TYPE,
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  readGroupInterface,
} from "@/engine/groups";
import {
  makeInstanceNode,
  newEdgeId,
  refreshNodeSockets,
  type GraphNode,
} from "@/state/graph-ops";
import {
  splitEndpoint,
  toSourceHandle,
  toTargetHandle,
  type BuildIssue,
} from "@/state/recipe-builder";

// node-group / group-input / group-output are structural plumbing — ops may
// wire to the boundary (add_edge) but may not retune or delete it.
const STRUCTURAL = new Set([GROUP_TYPE, GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE]);

// ---------------------------------------------------------------------------
// groupToSpec — the editable context the LLM sees.
// ---------------------------------------------------------------------------
export interface GroupSpecNode {
  id: string;
  type: string;
  params: Record<string, unknown>; // settable values only
  exposed: string[];
  keyframed: string[]; // params whose static value won't take effect (animated)
}
export interface GroupSpec {
  name: string;
  nodes: GroupSpecNode[];
  edges: { from: string; to: string }[];
  interface: {
    inputs: { name: string; type: string }[];
    outputs: { name: string; type: string }[];
    // Boundary node ids so an op can wire to the group's inputs/outputs.
    inputNodeId?: string;
    outputNodeId?: string;
  };
}

function sourceToEndpoint(id: string, handle: string | null | undefined): string {
  if (handle === "out:primary") return `${id}:out`;
  if (handle?.startsWith("out:aux:")) return `${id}:aux:${handle.slice("out:aux:".length)}`;
  return `${id}:out`;
}
function targetToEndpoint(id: string, handle: string | null | undefined): string {
  if (handle?.startsWith("in:param:")) return `${id}:param:${handle.slice("in:param:".length)}`;
  if (handle?.startsWith("in:")) return `${id}:in:${handle.slice("in:".length)}`;
  return `${id}:in:?`;
}

export function groupToSpec(
  groupId: string,
  nodes: GraphNode[],
  edges: Edge[]
): GroupSpec {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const shell = byId.get(groupId);
  const interior = nodes.filter(
    (n) => n.data.parentId === groupId && !STRUCTURAL.has(n.data.defType)
  );
  const inputNode = nodes.find(
    (n) => n.data.parentId === groupId && n.data.defType === GROUP_INPUT_TYPE
  );
  const outputNode = nodes.find(
    (n) => n.data.parentId === groupId && n.data.defType === GROUP_OUTPUT_TYPE
  );

  const specNodes: GroupSpecNode[] = interior.map((n) => {
    const def = getNodeDef(n.data.defType);
    const params: Record<string, unknown> = {};
    for (const p of def?.params ?? []) {
      if (SETTABLE_PARAM_TYPES.has(p.type) && n.data.params[p.name] !== undefined)
        params[p.name] = n.data.params[p.name];
    }
    const anim = (n.data.animation ?? {}) as Record<string, { animated?: boolean }>;
    const keyframed = Object.keys(anim).filter((k) => anim[k]?.animated);
    return {
      id: n.id,
      type: n.data.defType,
      params,
      exposed: n.data.exposedParams ?? [],
      keyframed,
    };
  });

  // Edges fully inside the group (interior ↔ interior, and interior ↔ boundary).
  const inGroup = (id: string) => byId.get(id)?.data.parentId === groupId;
  const groupEdges = edges
    .filter((e) => inGroup(e.source) && inGroup(e.target))
    .map((e) => ({
      from: sourceToEndpoint(e.source, e.sourceHandle),
      to: targetToEndpoint(e.target, e.targetHandle),
    }));

  const iface = shell
    ? readGroupInterface(shell.data.params as Record<string, unknown>)
    : { inputs: [], outputs: [] };

  return {
    name: shell?.data.name ?? "Group",
    nodes: specNodes,
    edges: groupEdges,
    interface: {
      inputs: iface.inputs,
      outputs: iface.outputs,
      inputNodeId: inputNode?.id,
      outputNodeId: outputNode?.id,
    },
  };
}

// ---------------------------------------------------------------------------
// applyRecipeEdit — apply a patch to a group fragment.
// ---------------------------------------------------------------------------
export type RecipeEditOp =
  | { op: "set_param"; node: string; param: string; value: unknown }
  | { op: "add_node"; id: string; type: string; params?: Record<string, unknown> }
  | { op: "remove_node"; node: string }
  | { op: "add_edge"; from: string; to: string }
  | { op: "remove_edge"; from: string; to: string }
  | { op: "rename_node"; node: string; name: string };

export interface RecipeEdit {
  summary?: string;
  ops: RecipeEditOp[];
}

export interface RecipeEditResult {
  nodes: GraphNode[];
  edges: Edge[];
  issues: BuildIssue[];
}

function cloneNode(n: GraphNode): GraphNode {
  return { ...n, data: { ...n.data, params: { ...n.data.params } } };
}

// `inNodes`/`inEdges` are the group fragment (shell + boundary + interior +
// their edges). Returns a new fragment with the patch applied; never mutates
// the inputs.
export function applyRecipeEdit(
  groupId: string,
  inNodes: GraphNode[],
  inEdges: Edge[],
  edit: RecipeEdit
): RecipeEditResult {
  const issues: BuildIssue[] = [];
  const err = (code: string, message: string) => issues.push({ code, message });

  const nodes = inNodes.map(cloneNode);
  let edges = [...inEdges];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const localToReal = new Map<string, string>(); // add_node local id → real id
  const realId = (lid: string) => localToReal.get(lid) ?? lid;

  const applyParams = (
    n: GraphNode,
    def: NonNullable<ReturnType<typeof getNodeDef>>,
    params: Record<string, unknown>,
    label: string
  ) => {
    const next = { ...n.data.params };
    for (const [k, v] of Object.entries(params)) {
      const pdef = def.params.find((p) => p.name === k);
      if (!pdef) {
        err("UNKNOWN_PARAM", `${label}.${k}: no such param.`);
        continue;
      }
      if (!SETTABLE_PARAM_TYPES.has(pdef.type)) {
        err("PARAM_NOT_SETTABLE", `${label}.${k}: type "${pdef.type}" is not settable.`);
        continue;
      }
      next[k] = v;
    }
    n.data.params = next;
  };

  const replaceInPlace = (updated: GraphNode) => {
    const i = nodes.findIndex((x) => x.id === updated.id);
    if (i >= 0) nodes[i] = updated;
    byId.set(updated.id, updated);
  };

  for (const op of edit.ops ?? []) {
    switch (op.op) {
      case "set_param": {
        const n = byId.get(op.node);
        if (!n) { err("UNKNOWN_NODE", `set_param: no node "${op.node}".`); break; }
        if (STRUCTURAL.has(n.data.defType)) { err("PROTECTED_NODE", `set_param: "${op.node}" is structural.`); break; }
        const def = getNodeDef(n.data.defType);
        if (!def) { err("UNKNOWN_TYPE", `set_param: node "${op.node}" has unknown type.`); break; }
        applyParams(n, def, { [op.param]: op.value }, op.node);
        // Params can retype sockets (mode toggles); refresh the cached lists.
        replaceInPlace(refreshNodeSockets(n));
        break;
      }
      case "add_node": {
        const def = getNodeDef(op.type);
        if (!def) { err("UNKNOWN_TYPE", `add_node "${op.id}": unknown type "${op.type}".`); break; }
        if (localToReal.has(op.id)) { err("DUP_ID", `add_node: duplicate local id "${op.id}".`); break; }
        let n = makeInstanceNode(op.type, { x: 0, y: 0 });
        n.data.parentId = groupId;
        if (op.params) applyParams(n, def, op.params, op.id);
        n = refreshNodeSockets(n);
        nodes.push(n);
        byId.set(n.id, n);
        localToReal.set(op.id, n.id);
        break;
      }
      case "remove_node": {
        const n = byId.get(op.node);
        if (!n) { err("UNKNOWN_NODE", `remove_node: no node "${op.node}".`); break; }
        if (STRUCTURAL.has(n.data.defType)) { err("PROTECTED_NODE", `remove_node: "${op.node}" is structural.`); break; }
        const i = nodes.findIndex((x) => x.id === op.node);
        if (i >= 0) nodes.splice(i, 1);
        byId.delete(op.node);
        edges = edges.filter((e) => e.source !== op.node && e.target !== op.node);
        break;
      }
      case "add_edge": {
        const s = splitEndpoint(op.from);
        const t = splitEndpoint(op.to);
        const sh = s && toSourceHandle(s.rest);
        const th = t && toTargetHandle(t.rest);
        const srcId = s && realId(s.lid);
        const tgtId = t && realId(t.lid);
        if (!s || !t || !sh || !th || !srcId || !tgtId) {
          err("BAD_ENDPOINT", `add_edge ${op.from} → ${op.to}: malformed endpoint.`);
          break;
        }
        if (!byId.has(srcId) || !byId.has(tgtId)) {
          err("EDGE_NODE_MISSING", `add_edge ${op.from} → ${op.to}: references an unknown node.`);
          break;
        }
        edges.push({ id: newEdgeId(), source: srcId, sourceHandle: sh, target: tgtId, targetHandle: th });
        break;
      }
      case "remove_edge": {
        const s = splitEndpoint(op.from);
        const t = splitEndpoint(op.to);
        const sh = s && toSourceHandle(s.rest);
        const th = t && toTargetHandle(t.rest);
        const srcId = s && realId(s.lid);
        const tgtId = t && realId(t.lid);
        if (!s || !t || !sh || !th || !srcId || !tgtId) {
          err("BAD_ENDPOINT", `remove_edge ${op.from} → ${op.to}: malformed endpoint.`);
          break;
        }
        const before = edges.length;
        edges = edges.filter(
          (e) => !(e.source === srcId && e.sourceHandle === sh && e.target === tgtId && e.targetHandle === th)
        );
        if (edges.length === before)
          err("EDGE_NOT_FOUND", `remove_edge ${op.from} → ${op.to}: no matching edge.`);
        break;
      }
      case "rename_node": {
        const n = byId.get(op.node);
        if (!n) { err("UNKNOWN_NODE", `rename_node: no node "${op.node}".`); break; }
        n.data.name = op.name;
        break;
      }
    }
  }

  return { nodes, edges, issues };
}
