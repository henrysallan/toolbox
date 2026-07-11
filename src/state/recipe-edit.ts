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
import { SETTABLE_PARAM_TYPES, vetParamValue } from "@/engine/node-catalog";
import {
  GROUP_TYPE,
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  readGroupInterface,
  readBoundarySockets,
} from "@/engine/groups";
import { paramSocketType } from "@/engine/graph-helpers";
import {
  makeInstanceNode,
  newEdgeId,
  refreshNodeSockets,
  syncGroupInterface,
  type GraphNode,
} from "@/state/graph-ops";
import {
  resolveChannelHandle,
  resolveOrdinalHandle,
  splitEndpoint,
  syncExpressionChannels,
  toSourceHandle,
  toTargetHandle,
  vetMergeLayers,
  type BuildIssue,
} from "@/state/recipe-builder";
import type { MergeLayer } from "@/nodes/effect/merge";

// node-group / group-input / group-output are structural plumbing — ops may
// wire to the boundary (add_edge) but may not retune or delete it.
const STRUCTURAL = new Set([GROUP_TYPE, GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE]);

// ---------------------------------------------------------------------------
// groupToSpec — the editable context the LLM sees.
// ---------------------------------------------------------------------------
export interface GroupSpecNode {
  id: string;
  type: string;
  name?: string; // display name, when it differs from the def default
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
  return graphToSpec(nodes, edges, groupId);
}

// Generalization of groupToSpec to any scope: pass a group/layer id for its
// interior, or omit `scopeId` for the ROOT composition (the layer chain +
// Output). Root has no boundary nodes, so `interface` comes back empty —
// used by the MCP bridge's get_graph.
export function graphToSpec(
  nodes: GraphNode[],
  edges: Edge[],
  scopeId?: string
): GroupSpec {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const shell = scopeId ? byId.get(scopeId) : undefined;
  // Boundary nodes are plumbing (the `interface` field describes them), but
  // group/layer SHELLS are real spec nodes — hiding them made the root scope
  // look empty and left nested groups undiscoverable (their ids are what
  // get_graph/edit ops scope into). applyRecipeEdit still refuses to retune
  // or delete them (STRUCTURAL guard).
  const BOUNDARY = new Set([GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE]);
  const interior = nodes.filter(
    (n) => n.data.parentId === scopeId && !BOUNDARY.has(n.data.defType)
  );
  const inputNode = nodes.find(
    (n) => scopeId && n.data.parentId === scopeId && n.data.defType === GROUP_INPUT_TYPE
  );
  const outputNode = nodes.find(
    (n) => scopeId && n.data.parentId === scopeId && n.data.defType === GROUP_OUTPUT_TYPE
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
      ...(n.data.name ? { name: n.data.name } : {}),
      params,
      exposed: n.data.exposedParams ?? [],
      keyframed,
    };
  });

  // Edges fully inside the scope (interior ↔ interior, and interior ↔ boundary).
  const inGroup = (id: string) => byId.get(id)?.data.parentId === scopeId;
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
    name: scopeId ? (shell?.data.name ?? "Group") : "root",
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
  | { op: "expose_param"; node: string; param: string; label?: string }
  | { op: "unexpose_param"; node: string; param: string }
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
  let needsSync = false; // an expose/unexpose changed the group interface

  const groupInput = () =>
    nodes.find((x) => x.data.parentId === groupId && x.data.defType === GROUP_INPUT_TYPE);

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
      if (pdef.type === "merge_layers") {
        // Restricted [{mode?, opacity?}, …] shape; ids preserved BY INDEX
        // from the current list so existing layer wires never dangle.
        const mvet = vetMergeLayers(v, next[k] as MergeLayer[] | undefined);
        if (!mvet.ok) {
          err("BAD_PARAM_VALUE", `${label}.${k}: ${mvet.reason}.`);
          continue;
        }
        next[k] = mvet.value;
        continue;
      }
      if (!SETTABLE_PARAM_TYPES.has(pdef.type)) {
        err("PARAM_NOT_SETTABLE", `${label}.${k}: type "${pdef.type}" is not settable.`);
        continue;
      }
      const vet = vetParamValue(pdef, v);
      if (!vet.ok) {
        err("BAD_PARAM_VALUE", `${label}.${k}: ${vet.reason}.`);
        continue;
      }
      // Spec §7: a static value on a keyframed param is a silent no-op at
      // eval (keyframes win) — surface a note instead of silently accepting.
      const anim = n.data.animation as
        | Record<string, { animated?: boolean }>
        | undefined;
      if (anim?.[k]?.animated) {
        err(
          "PARAM_KEYFRAMED",
          `${label}.${k}: param is keyframed — the static value won't take effect while the animation is active.`
        );
      }
      next[k] = vet.value;
    }
    // A patched expression mints its ch()/pick() tunables (add-only), same as
    // buildRecipe — the callers' refreshNodeSockets picks up the new sockets.
    n.data.params =
      "expression" in params ? syncExpressionChannels(def, next) : next;
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
        // The scope being edited can't delete itself — for node-groups the
        // STRUCTURAL check above covers it, but a LAYER shell isn't
        // structural (its params are editable), and removing it would
        // orphan its whole interior.
        if (op.node === groupId) { err("PROTECTED_NODE", `remove_node: "${op.node}" is the scope being edited.`); break; }
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
        let th = t && toTargetHandle(t.rest);
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
        // Expression channels are addressed by name (ids are unknowable to
        // the LLM); alias onto the id-based socket, same as buildRecipe.
        const tgtNode = byId.get(tgtId)!;
        const tdef = getNodeDef(tgtNode.data.defType);
        if (tdef) th = resolveChannelHandle(tdef, tgtNode.data.params, th);
        edges.push({ id: newEdgeId(), source: srcId, sourceHandle: sh, target: tgtId, targetHandle: th });
        // A wire into a param socket only renders when the param is in
        // exposedParams (EffectNode derives handles from it) — without this
        // mirror of buildRecipe's behavior the edge validates green, drives
        // the param at eval, and is invisible/undisconnectable in the editor.
        // (remove_edge deliberately does NOT unexpose: an exposed-but-unwired
        // param socket is a normal state the user may want kept.)
        if (th.startsWith("in:param:")) {
          const pname = th.slice("in:param:".length);
          tgtNode.data.exposedParams = [
            ...new Set([...(tgtNode.data.exposedParams ?? []), pname]),
          ];
        }
        break;
      }
      case "remove_edge": {
        const s = splitEndpoint(op.from);
        const t = splitEndpoint(op.to);
        const sh = s && toSourceHandle(s.rest);
        let th = t && toTargetHandle(t.rest);
        const srcId = s && realId(s.lid);
        const tgtId = t && realId(t.lid);
        if (!s || !t || !sh || !th || !srcId || !tgtId) {
          err("BAD_ENDPOINT", `remove_edge ${op.from} → ${op.to}: malformed endpoint.`);
          break;
        }
        const tgtNode = byId.get(tgtId);
        const tdef = tgtNode && getNodeDef(tgtNode.data.defType);
        if (tgtNode && tdef) th = resolveChannelHandle(tdef, tgtNode.data.params, th);
        const before = edges.length;
        edges = edges.filter(
          (e) => !(e.source === srcId && e.sourceHandle === sh && e.target === tgtId && e.targetHandle === th)
        );
        if (edges.length === before)
          err("EDGE_NOT_FOUND", `remove_edge ${op.from} → ${op.to}: no matching edge.`);
        break;
      }
      case "expose_param": {
        const n = byId.get(op.node);
        if (!n) { err("UNKNOWN_NODE", `expose_param: no node "${op.node}".`); break; }
        if (STRUCTURAL.has(n.data.defType)) { err("PROTECTED_NODE", `expose_param: "${op.node}" is structural.`); break; }
        const def = getNodeDef(n.data.defType);
        const pdef = def?.params.find((p) => p.name === op.param);
        if (!pdef) { err("UNKNOWN_PARAM", `expose_param: ${op.node} has no param "${op.param}".`); break; }
        const sockType = paramSocketType(pdef.type);
        if (!sockType) { err("PARAM_NOT_EXPOSABLE", `expose_param: "${op.param}" (${pdef.type}) can't be a socket.`); break; }
        const gi = groupInput();
        if (!gi) { err("NO_BOUNDARY", `expose_param: group has no input boundary.`); break; }
        const label = op.label?.trim() || op.param;
        const sockets = readBoundarySockets(gi.data.params);
        if (sockets.some((s) => s.name === label)) { err("DUP_SOCKET", `expose_param: interface socket "${label}" already exists.`); break; }
        gi.data.params = { ...gi.data.params, sockets: [...sockets, { name: label, type: sockType }] };
        n.data.exposedParams = [...new Set([...(n.data.exposedParams ?? []), op.param])];
        n.data.controlParams = [...new Set([...(n.data.controlParams ?? []), op.param])];
        edges.push({
          id: newEdgeId(),
          source: gi.id,
          sourceHandle: `out:aux:${label}`,
          target: n.id,
          targetHandle: `in:param:${op.param}`,
        });
        replaceInPlace(refreshNodeSockets(gi));
        needsSync = true;
        break;
      }
      case "unexpose_param": {
        const n = byId.get(op.node);
        if (!n) { err("UNKNOWN_NODE", `unexpose_param: no node "${op.node}".`); break; }
        const gi = groupInput();
        const promote = gi
          ? edges.find(
              (e) =>
                e.source === gi.id &&
                e.target === n.id &&
                e.targetHandle === `in:param:${op.param}`
            )
          : undefined;
        if (!gi || !promote) { err("NOT_EXPOSED", `unexpose_param: ${op.node}.${op.param} isn't exposed.`); break; }
        const label = (promote.sourceHandle ?? "").slice("out:aux:".length);
        gi.data.params = {
          ...gi.data.params,
          sockets: readBoundarySockets(gi.data.params).filter((s) => s.name !== label),
        };
        edges = edges.filter((e) => e.id !== promote.id);
        n.data.exposedParams = (n.data.exposedParams ?? []).filter((p) => p !== op.param);
        n.data.controlParams = (n.data.controlParams ?? []).filter((p) => p !== op.param);
        replaceInPlace(refreshNodeSockets(gi));
        needsSync = true;
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

  // Re-sync the shell's interface from the boundary sockets if expose/unexpose
  // touched it. syncGroupInterface returns an updated nodes array.
  const finalNodes = needsSync ? syncGroupInterface(nodes, groupId) : nodes;
  return { nodes: finalNodes, edges, issues };
}
