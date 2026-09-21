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
  LAYER_TYPE,
  VIRTUAL_SOCKET,
  isZoneShell,
  readGroupInterface,
  readBoundarySockets,
  readInputValues,
  withInputValues,
} from "@/engine/groups";
import { paramSocketType } from "@/engine/graph-helpers";
import { compactFloatCurve, floatCurvesEqual } from "@/engine/float-curve";
import {
  channelListParam,
  channelSocketType,
  describeChannels,
  setExprChannelValue,
  vetExprInputList,
} from "@/engine/expr-channels";
import type { ExprInput } from "@/engine/types";
import {
  collectDescendantIds,
  cloneSubgraph,
  connectToVirtualSocket,
  expandWithDescendants,
  listGroupShellControls,
  makeForEachNodes,
  makeInstanceNode,
  makeRepeatNodes,
  mintZoneEdgeSockets,
  newEdgeId,
  refreshNodeSockets,
  resolveGroupShellControl,
  seedMissingGroupInputValues,
  syncGroupInterface,
  type GraphNode,
} from "@/state/graph-ops";
import {
  compoundZoneInputLid,
  findExprChannel,
  growExprVarHandle,
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

// Group Input / Group Output are boundary plumbing — ops may wire to them
// but may not retune or delete them. The node-group SHELL is a real node:
// expose stays blocked (no catalog params), but set_param writes promoted
// inputValues by exposed label, and remove_node on a nested group cascades
// to its interior (same as the editor's Delete). The scope being edited
// still cannot delete itself.
const BOUNDARY_TYPES = new Set([GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE]);
const STRUCTURAL = new Set([GROUP_TYPE, GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE]);

// ---------------------------------------------------------------------------
// groupToSpec — the editable context the LLM sees.
// ---------------------------------------------------------------------------
export interface GroupSpecNode {
  id: string;
  type: string;
  name?: string; // display name, when it differs from the def default
  params?: Record<string, unknown>; // settable values (+ merge_layers, read-only-ish)
  exposed?: string[];
  keyframed?: string[]; // params whose static value won't take effect (animated)
  // Zone shell id when this node is a Repeat / For Each / Iterate member
  // (parentId points at the shell, not the enclosing group). Omitted for
  // direct children of the scope.
  parent?: string;
  // Resolved input sockets — included only for DYNAMIC defs (resolveInputs).
  // Channel sockets print the channel NAME as `name` (the wireable handle:
  // `<id>:in:<name>`) and the minted `ein-…` id as `id`. Merge layers keep
  // their real `layer:<id>` names.
  inputs?: { name: string; type: string; label?: string; id?: string }[];
  // Expression channels (Point Expression / GLSL Expression rows), id-free:
  // name, kind, current value (ramp → stops, curve → points), options for
  // pick, and the socket type for wireable kinds. Address one with
  // set_param {param: <name>} or an edge to "<id>:in:<name>".
  channels?: {
    name: string;
    kind: string;
    value: unknown;
    options?: string[];
    socket?: string;
  }[];
  // Live WebGL info log — get_graph attaches these on GLSL Expression
  // nodes that fail to compile. Absent when the shader is fine or GL
  // isn't up yet. `shaderPreludeLines` is the owned template length;
  // info-log line numbers include it (user body starts at prelude+1).
  shaderError?: string;
  shaderPreludeLines?: number;
  shaderProblems?: string[];
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
    // Group/layer shell `inputValues` — the knobs that win over interior
    // constants for exposed params. Keyed by exposed label. Omitted when
    // empty. set_param(groupId, label, value) writes these.
    values?: Record<string, unknown>;
  };
}

export type GraphSpecVerbosity = "full" | "ids";
export type GraphSpecParams = "all" | "non_default";
export type GraphSpecExpressions = "full" | "hash";
export interface GraphSpecOpts {
  // "ids" returns {id, type, name?, parent?} plus edges/interface — no
  // param dumps. Default "full".
  verbosity?: GraphSpecVerbosity;
  // "non_default" drops params that still equal the catalog default.
  // Ignored when verbosity is "ids". Default "all".
  params?: GraphSpecParams;
  // "hash" replaces long `expression` strings with {hash, chars}. Default
  // "full". MCP get_graph compact mode uses this so a custom shader doesn't
  // re-dump every call.
  expressions?: GraphSpecExpressions;
}

const EXPR_HASH_MIN = 80;

function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function compactExpressionValue(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= EXPR_HASH_MIN) return value;
  return { hash: fnv1aHex(value), chars: value.length };
}

function sourceToEndpoint(id: string, handle: string | null | undefined): string {
  if (handle === "out:primary") return `${id}:out`;
  if (handle?.startsWith("out:aux:")) return `${id}:aux:${handle.slice("out:aux:".length)}`;
  return `${id}:out`;
}
function targetToEndpoint(
  id: string,
  handle: string | null | undefined,
  tgt?: GraphNode
): string {
  if (handle?.startsWith("in:param:")) return `${id}:param:${handle.slice("in:param:".length)}`;
  // Channel wires are stored as in:in:<ein-id>; print the channel NAME so
  // the listing is the same handle add_edge accepts (`<id>:in:rows`).
  if (handle?.startsWith("in:in:") && tgt) {
    const einId = handle.slice("in:in:".length);
    const def = getNodeDef(tgt.data.defType);
    const chan = def && findExprChannel(def, tgt.data.params, einId);
    if (chan) return `${id}:in:${chan.name}`;
  }
  if (handle?.startsWith("in:")) return `${id}:in:${handle.slice("in:".length)}`;
  return `${id}:in:?`;
}

// Same visibility as get_graph / groupToSpec: the scope's direct members,
// zone members (parentId walks through Repeat/For Each), nested group
// SHELLS, and this scope's Input/Output. Nested group interiors are hidden
// — they're a different edit_group target. Used so add_edge can't land a
// dead wire on a node that isn't actually in the edited layer/group.
export function nodeIsInEditScope(
  n: GraphNode,
  scopeId: string | undefined,
  byId: Map<string, GraphNode>
): boolean {
  if (n.id === scopeId) return false;
  let cur: string | undefined = n.data.parentId;
  for (let hops = 0; hops < byId.size + 1; hops++) {
    if (cur === scopeId) return true;
    if (cur == null) return false;
    const p = byId.get(cur);
    if (!p) return false;
    if (p.data.defType === GROUP_TYPE || p.data.defType === LAYER_TYPE) {
      return false;
    }
    cur = p.data.parentId;
  }
  return false;
}

function enclosingHiddenScope(
  n: GraphNode,
  scopeId: string,
  byId: Map<string, GraphNode>
): string | undefined {
  let cur: string | undefined = n.data.parentId;
  for (let hops = 0; hops < byId.size + 1; hops++) {
    if (!cur || cur === scopeId) return undefined;
    const p = byId.get(cur);
    if (!p) return undefined;
    if (p.data.defType === GROUP_TYPE || p.data.defType === LAYER_TYPE) return p.id;
    cur = p.data.parentId;
  }
  return undefined;
}

export function groupToSpec(
  groupId: string,
  nodes: GraphNode[],
  edges: Edge[]
): GroupSpec {
  return graphToSpec(nodes, edges, groupId);
}

// Generalization of groupToSpec to any scope: pass a group/layer/zone id
// for its interior, or omit `scopeId` for the ROOT composition (the layer
// chain + Output). Root has no boundary nodes, so `interface` comes back
// empty — used by the MCP bridge's get_graph. Zone members (parentId = the
// Repeat/For Each/Iterate shell) are included in the enclosing scope.
function paramEqualsDefault(value: unknown, fallback: unknown): boolean {
  if (Object.is(value, fallback)) return true;
  if (value == null || fallback == null) return value === fallback;
  try {
    return JSON.stringify(value) === JSON.stringify(fallback);
  } catch {
    return false;
  }
}

export function graphToSpec(
  nodes: GraphNode[],
  edges: Edge[],
  scopeId?: string,
  opts?: GraphSpecOpts
): GroupSpec {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const shell = scopeId ? byId.get(scopeId) : undefined;
  // Boundary nodes are plumbing (the `interface` field describes them), but
  // group/layer SHELLS are real spec nodes — hiding them made the root scope
  // look empty and left nested groups undiscoverable (their ids are what
  // get_graph/edit ops scope into). Nested groups can be removed (interior
  // goes with them). Exposed group knobs live on the shell as `params`
  // (from inputValues); set_param(groupId, label, value) writes them.
  const BOUNDARY = new Set([GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE]);
  const interior = nodes.filter(
    (n) => nodeIsInEditScope(n, scopeId, byId) && !BOUNDARY.has(n.data.defType)
  );
  const inputNode = nodes.find(
    (n) => scopeId && n.data.parentId === scopeId && n.data.defType === GROUP_INPUT_TYPE
  );
  const outputNode = nodes.find(
    (n) => scopeId && n.data.parentId === scopeId && n.data.defType === GROUP_OUTPUT_TYPE
  );

  const idsOnly = opts?.verbosity === "ids";
  const nonDefault = opts?.params === "non_default";

  const specNodes: GroupSpecNode[] = interior.map((n) => {
    const def = getNodeDef(n.data.defType);
    const zoneParent =
      n.data.parentId && isZoneShell(byId.get(n.data.parentId)?.data.defType)
        ? n.data.parentId
        : undefined;
    if (idsOnly) {
      return {
        id: n.id,
        type: n.data.defType,
        ...(n.data.name ? { name: n.data.name } : {}),
        ...(zoneParent ? { parent: zoneParent } : {}),
      };
    }
    const params: Record<string, unknown> = {};
    for (const p of def?.params ?? []) {
      if (SETTABLE_PARAM_TYPES.has(p.type) && n.data.params[p.name] !== undefined) {
        // A float_curve prints as [{x, y}] — the shape set_param accepts;
        // the stored point ids are editor-only noise.
        params[p.name] =
          p.type === "float_curve"
            ? compactFloatCurve(n.data.params[p.name]) ?? n.data.params[p.name]
            : n.data.params[p.name];
      }
      // merge_layers is plain JSON ({id, mode, opacity}[]) — showing it
      // gives the model the layer ids/modes it needs to patch a Merge.
      if (p.type === "merge_layers" && n.data.params[p.name] !== undefined)
        params[p.name] = n.data.params[p.name];
    }
    if (
      n.data.defType === GROUP_TYPE ||
      n.data.defType === LAYER_TYPE
    ) {
      for (const ctrl of listGroupShellControls(n, nodes, edges)) {
        if (ctrl.socketName in params) continue;
        params[ctrl.socketName] = ctrl.value;
      }
    }
    if (nonDefault) {
      for (const p of def?.params ?? []) {
        if (!(p.name in params)) continue;
        const same =
          p.type === "float_curve"
            ? floatCurvesEqual(params[p.name], p.default)
            : paramEqualsDefault(params[p.name], p.default);
        if (same) delete params[p.name];
      }
      if (n.data.defType === GROUP_TYPE || n.data.defType === LAYER_TYPE) {
        for (const ctrl of listGroupShellControls(n, nodes, edges)) {
          if (!(ctrl.socketName in params)) continue;
          if (paramEqualsDefault(params[ctrl.socketName], ctrl.controlDef.default)) {
            delete params[ctrl.socketName];
          }
        }
      }
    }
    if (opts?.expressions === "hash" && typeof params.expression === "string") {
      params.expression = compactExpressionValue(params.expression);
    }
    const anim = (n.data.animation ?? {}) as Record<string, { animated?: boolean }>;
    const keyframed = Object.keys(anim).filter((k) => anim[k]?.animated);
    const chanParam = def ? channelListParam(def) : undefined;
    const channels = chanParam
      ? describeChannels((n.data.params[chanParam.name] as ExprInput[]) ?? [])
      : [];
    // Dynamic defs mint their socket names per node — surface the resolved
    // list so the model can wire without guessing.
    let inputs: GroupSpecNode["inputs"];
    if (def?.resolveInputs) {
      let ins = def.inputs;
      try {
        ins = def.resolveInputs(n.data.params);
      } catch {
        ins = def.inputs;
      }
      inputs = ins
        .filter((i) => !i.hidden)
        .map((i) => {
          // Channel sockets are named `in:<ein-id>` with label = channel
          // name. Print the NAME as the wireable handle so get_graph
          // listings paste into add_edge (`<id>:in:<name>`).
          if (i.name.startsWith("in:")) {
            const einId = i.name.slice(3);
            const chan = findExprChannel(def, n.data.params, einId);
            if (chan && i.name === `in:${chan.id}`) {
              return { name: chan.name, type: i.type, id: chan.id };
            }
          }
          return {
            name: i.name,
            type: i.type,
            ...(i.label ? { label: i.label } : {}),
          };
        });
    }
    return {
      id: n.id,
      type: n.data.defType,
      ...(n.data.name ? { name: n.data.name } : {}),
      params,
      exposed: n.data.exposedParams ?? [],
      keyframed,
      ...(zoneParent ? { parent: zoneParent } : {}),
      ...(inputs ? { inputs } : {}),
      ...(channels.length ? { channels } : {}),
    };
  });

  // Edges fully inside the scope (interior ↔ interior, including zone
  // members, and interior ↔ this scope's group/layer boundary).
  const specIds = new Set(specNodes.map((n) => n.id));
  const inGroup = (id: string) => {
    if (specIds.has(id)) return true;
    const n = byId.get(id);
    return !!n && BOUNDARY.has(n.data.defType) && n.data.parentId === scopeId;
  };
  const groupEdges = edges
    .filter((e) => inGroup(e.source) && inGroup(e.target))
    .map((e) => ({
      from: sourceToEndpoint(e.source, e.sourceHandle),
      to: targetToEndpoint(e.target, e.targetHandle, byId.get(e.target)),
    }));

  const iface = shell
    ? readGroupInterface(shell.data.params as Record<string, unknown>)
    : { inputs: [], outputs: [] };
  const shellValues = shell ? readInputValues(shell.data.params) : {};

  return {
    name: scopeId ? (shell?.data.name ?? "Group") : "root",
    nodes: specNodes,
    edges: groupEdges,
    interface: {
      inputs: iface.inputs,
      outputs: iface.outputs,
      inputNodeId: inputNode?.id,
      outputNodeId: outputNode?.id,
      ...(Object.keys(shellValues).length ? { values: shellValues } : {}),
    },
  };
}

export interface GraphSpecDiff {
  added: GroupSpecNode[];
  removed: string[];
  changed: GroupSpecNode[];
  edgesAdded: { from: string; to: string }[];
  edgesRemoved: { from: string; to: string }[];
  interface?: GroupSpec["interface"];
}

function edgeKey(e: { from: string; to: string }): string {
  return `${e.from}\0${e.to}`;
}

export function diffGroupSpec(prev: GroupSpec, next: GroupSpec): GraphSpecDiff {
  const prevNodes = new Map(prev.nodes.map((n) => [n.id, n]));
  const nextNodes = new Map(next.nodes.map((n) => [n.id, n]));
  const added: GroupSpecNode[] = [];
  const removed: string[] = [];
  const changed: GroupSpecNode[] = [];
  for (const n of next.nodes) {
    const p = prevNodes.get(n.id);
    if (!p) added.push(n);
    else if (JSON.stringify(p) !== JSON.stringify(n)) changed.push(n);
  }
  for (const n of prev.nodes) {
    if (!nextNodes.has(n.id)) removed.push(n.id);
  }
  const prevEdges = new Set(prev.edges.map(edgeKey));
  const nextEdges = new Set(next.edges.map(edgeKey));
  const edgesAdded = next.edges.filter((e) => !prevEdges.has(edgeKey(e)));
  const edgesRemoved = prev.edges.filter((e) => !nextEdges.has(edgeKey(e)));
  const ifaceChanged =
    JSON.stringify(prev.interface) !== JSON.stringify(next.interface);
  return {
    added,
    removed,
    changed,
    edgesAdded,
    edgesRemoved,
    ...(ifaceChanged ? { interface: next.interface } : {}),
  };
}

// ---------------------------------------------------------------------------
// applyRecipeEdit — apply a patch to a group fragment.
// ---------------------------------------------------------------------------
export type RecipeEditOp =
  | { op: "set_param"; node: string; param: string; value: unknown }
  | { op: "add_node"; id: string; type: string; params?: Record<string, unknown>; parent?: string }
  | { op: "remove_node"; node: string }
  | { op: "add_edge"; from: string; to: string }
  | { op: "remove_edge"; from: string; to: string }
  | { op: "expose_param"; node: string; param: string; label?: string }
  | { op: "unexpose_param"; node: string; param: string }
  | { op: "rename_node"; node: string; name: string }
  | {
      op: "duplicate_node";
      node: string;
      id: string;
      params?: Record<string, unknown>;
      name?: string;
      patch?: { node: string; param: string; value: unknown }[];
    };

export interface RecipeEdit {
  summary?: string;
  ops: RecipeEditOp[];
}

export const RECIPE_EDIT_OPS = [
  "set_param",
  "add_node",
  "remove_node",
  "add_edge",
  "remove_edge",
  "expose_param",
  "unexpose_param",
  "rename_node",
  "duplicate_node",
] as const;

const OP_SET = new Set<string>(RECIPE_EDIT_OPS);
const EXAMPLE_OP = '{"op": "set_param", "node": "<id>", "param": "count", "value": 12}';

// Soft issues: the op applied, but the caller should know. Everything else
// that `err()` records during an op means that op did not do what was asked.
const SOFT_OP_CODES = new Set(["PARAM_EXPOSED", "PARAM_KEYFRAMED", "CHANNEL_EXPOSE"]);

export interface RecipeEditOpEcho {
  i: number;
  op: string;
  ok: boolean;
  error?: string;
  node?: string;
  id?: string;
  param?: string;
  from?: string;
  to?: string;
  name?: string;
  ids?: Record<string, string>;
}

export interface RecipeEditResult {
  nodes: GraphNode[];
  edges: Edge[];
  issues: BuildIssue[];
  applied: number;
  ops: RecipeEditOpEcho[];
  // add_node / duplicate_node local id → minted live id, including
  // "<zone>-input" for compound zones. Same shape as insert_recipe `ids`.
  ids: Record<string, string>;
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseRecipeEditOp(
  raw: unknown,
  index: number
): { ok: true; op: RecipeEditOp } | { ok: false; opName: string; issue: BuildIssue } {
  const loc = `ops[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      opName: "?",
      issue: {
        code: "MALFORMED_OP",
        message: `${loc} is not an object. Example: ${EXAMPLE_OP}`,
      },
    };
  }
  const o = raw as Record<string, unknown>;
  const nested = Object.keys(o).filter((k) => OP_SET.has(k));
  if (typeof o.op !== "string") {
    if (nested.length) {
      return {
        ok: false,
        opName: nested[0],
        issue: {
          code: "MALFORMED_OP",
          message:
            `${loc}: nested {${nested[0]}: {...}} is not valid — use {"op": "${nested[0]}", ...}. ` +
            `Example: ${EXAMPLE_OP}`,
        },
      };
    }
    return {
      ok: false,
      opName: "?",
      issue: {
        code: "MALFORMED_OP",
        message: `${loc}: missing "op". Example: ${EXAMPLE_OP}`,
      },
    };
  }
  if (!OP_SET.has(o.op)) {
    return {
      ok: false,
      opName: o.op,
      issue: {
        code: "UNKNOWN_OP",
        message:
          `${loc}: unknown op ${JSON.stringify(o.op)}. Valid: ${RECIPE_EDIT_OPS.join(", ")}. ` +
          `Example: ${EXAMPLE_OP}`,
      },
    };
  }
  const malformed = (need: string) =>
    ({
      ok: false as const,
      opName: o.op as string,
      issue: {
        code: "MALFORMED_OP",
        message: `${loc}: ${o.op} needs ${need}. Example: ${EXAMPLE_OP}`,
      },
    });
  switch (o.op) {
    case "set_param": {
      const node = asNonEmptyString(o.node);
      const param = asNonEmptyString(o.param);
      if (!node || !param || !("value" in o)) return malformed("node, param, value");
      return { ok: true, op: { op: "set_param", node, param, value: o.value } };
    }
    case "add_node": {
      const id = asNonEmptyString(o.id);
      const type = asNonEmptyString(o.type);
      if (!id || !type) return malformed("id, type");
      const params =
        o.params && typeof o.params === "object" && !Array.isArray(o.params)
          ? (o.params as Record<string, unknown>)
          : undefined;
      const parent = asNonEmptyString(o.parent);
      return {
        ok: true,
        op: { op: "add_node", id, type, ...(params ? { params } : {}), ...(parent ? { parent } : {}) },
      };
    }
    case "remove_node": {
      const node = asNonEmptyString(o.node);
      if (!node) return malformed("node");
      return { ok: true, op: { op: "remove_node", node } };
    }
    case "add_edge": {
      const from = asNonEmptyString(o.from);
      const to = asNonEmptyString(o.to);
      if (!from || !to) return malformed("from, to");
      return { ok: true, op: { op: "add_edge", from, to } };
    }
    case "remove_edge": {
      const from = asNonEmptyString(o.from);
      const to = asNonEmptyString(o.to);
      if (!from || !to) return malformed("from, to");
      return { ok: true, op: { op: "remove_edge", from, to } };
    }
    case "expose_param": {
      const node = asNonEmptyString(o.node);
      const param = asNonEmptyString(o.param);
      if (!node || !param) return malformed("node, param");
      const label = asNonEmptyString(o.label);
      return { ok: true, op: { op: "expose_param", node, param, ...(label ? { label } : {}) } };
    }
    case "unexpose_param": {
      const node = asNonEmptyString(o.node);
      const param = asNonEmptyString(o.param);
      if (!node || !param) return malformed("node, param");
      return { ok: true, op: { op: "unexpose_param", node, param } };
    }
    case "rename_node": {
      const node = asNonEmptyString(o.node);
      const name = asNonEmptyString(o.name);
      if (!node || !name) return malformed("node, name");
      return { ok: true, op: { op: "rename_node", node, name } };
    }
    case "duplicate_node": {
      const node = asNonEmptyString(o.node);
      const id = asNonEmptyString(o.id);
      if (!node || !id) return malformed("node, id");
      const params =
        o.params && typeof o.params === "object" && !Array.isArray(o.params)
          ? (o.params as Record<string, unknown>)
          : undefined;
      const name = asNonEmptyString(o.name);
      let patch: { node: string; param: string; value: unknown }[] | undefined;
      if (Array.isArray(o.patch)) {
        patch = [];
        for (const raw of o.patch) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const p = raw as Record<string, unknown>;
          const pn = asNonEmptyString(p.node);
          const pp = asNonEmptyString(p.param);
          if (!pn || !pp || !("value" in p)) continue;
          patch.push({ node: pn, param: pp, value: p.value });
        }
        if (patch.length === 0) patch = undefined;
      }
      return {
        ok: true,
        op: {
          op: "duplicate_node",
          node,
          id,
          ...(params ? { params } : {}),
          ...(name ? { name } : {}),
          ...(patch ? { patch } : {}),
        },
      };
    }
    default:
      return malformed("a valid op");
  }
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

  let nodes = inNodes.map(cloneNode);
  let edges = [...inEdges];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const localToReal = new Map<string, string>(); // add_node local id → real id
  const dupIds = new Map<string, Record<string, string>>(); // local id → original→clone
  const realId = (lid: string) => localToReal.get(lid) ?? lid;
  const rewriteEp = (ep: string) => {
    const s = splitEndpoint(ep);
    return s ? `${realId(s.lid)}:${s.rest}` : ep;
  };
  let needsSync = false; // an expose/unexpose changed the group interface

  const echoes: RecipeEditOpEcho[] = [];
  const parsed: RecipeEditOp[] = [];
  let parseFailed = false;
  for (let i = 0; i < (edit.ops ?? []).length; i++) {
    const r = parseRecipeEditOp((edit.ops as unknown[])[i], i);
    if (!r.ok) {
      parseFailed = true;
      err(r.issue.code, r.issue.message);
      echoes.push({ i, op: r.opName, ok: false, error: r.issue.message });
    } else {
      parsed.push(r.op);
    }
  }
  if (parseFailed) {
    return { nodes, edges, issues, applied: 0, ops: echoes, ids: {} };
  }

  const echoOp = (i: number, op: RecipeEditOp, ok: boolean, error?: string) => {
    const base: RecipeEditOpEcho = { i, op: op.op, ok, ...(error && !ok ? { error } : {}) };
    switch (op.op) {
      case "set_param":
        echoes.push({ ...base, node: realId(op.node), param: op.param });
        break;
      case "add_node":
        echoes.push({ ...base, id: op.id, node: localToReal.get(op.id) });
        break;
      case "remove_node":
        echoes.push({ ...base, node: realId(op.node) });
        break;
      case "add_edge":
      case "remove_edge":
        echoes.push({ ...base, from: rewriteEp(op.from), to: rewriteEp(op.to) });
        break;
      case "expose_param":
      case "unexpose_param":
        echoes.push({ ...base, node: realId(op.node), param: op.param });
        break;
      case "rename_node":
        echoes.push({ ...base, node: realId(op.node), name: op.name });
        break;
      case "duplicate_node":
        echoes.push({
          ...base,
          id: op.id,
          node: localToReal.get(op.id),
          ...(dupIds.get(op.id) ? { ids: dupIds.get(op.id) } : {}),
        });
        break;
    }
  };

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
        // A channel NAME (ch/toggle/pick/color/ramp/curve row) — set the
        // row's value in place. Sync is add-only, so this is the only way
        // a recipe edit tunes a channel that already exists.
        const chan = findExprChannel(def, next, k);
        if (chan) {
          const r = setExprChannelValue(def, next, k, v);
          if (!r.ok) {
            err("BAD_PARAM_VALUE", `${label}.${k} (channel): ${r.reason}.`);
            continue;
          }
          next[r.listParam] = r.params[r.listParam];
          continue;
        }
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
      if (pdef.type === "expr_inputs" && !pdef.channelSync) {
        const evet = vetExprInputList(v, next[k] as ExprInput[] | undefined);
        if (!evet.ok) {
          err("BAD_PARAM_VALUE", `${label}.${k}: ${evet.reason}.`);
          continue;
        }
        next[k] = evet.value;
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
      if ((n.data.exposedParams ?? []).includes(k)) {
        err(
          "PARAM_EXPOSED",
          `${label}.${k}: param is exposed; group value wins — set_param the group shell with the exposed label.`
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

  for (let i = 0; i < parsed.length; i++) {
    const op = parsed[i];
    const issuesBefore = issues.length;
    switch (op.op) {
      case "set_param": {
        const n = byId.get(realId(op.node));
        if (!n) { err("UNKNOWN_NODE", `set_param: no node "${op.node}".`); break; }
        if (n.data.defType === GROUP_INPUT_TYPE || n.data.defType === GROUP_OUTPUT_TYPE) {
          err("PROTECTED_NODE", `set_param: "${op.node}" is structural.`);
          break;
        }
        if (n.data.defType === GROUP_TYPE || n.data.defType === LAYER_TYPE) {
          const def = getNodeDef(n.data.defType);
          const pdef = def?.params.find((p) => p.name === op.param);
          if (pdef && def) {
            applyParams(n, def, { [op.param]: op.value }, op.node);
            replaceInPlace(refreshNodeSockets(n));
            break;
          }
          const ctrl = resolveGroupShellControl(n, op.param, nodes, edges);
          if (!ctrl) {
            const names = listGroupShellControls(n, nodes, edges)
              .map((c) => c.socketName)
              .join(", ");
            const catalog = (def?.params ?? []).map((p) => p.name).join(", ");
            err(
              "UNKNOWN_PARAM",
              `set_param: "${op.node}" (${n.data.defType}) has no exposed param "${op.param}". Exposed: ${names || "none"}.${catalog ? ` Params: ${catalog}.` : ""}`
            );
            break;
          }
          const vet = vetParamValue(ctrl.controlDef, op.value);
          if (!vet.ok) {
            err("BAD_PARAM_VALUE", `set_param: ${op.node}.${op.param}: ${vet.reason}.`);
            break;
          }
          const iv = readInputValues(n.data.params);
          n.data.params = withInputValues(n.data.params, {
            ...iv,
            [ctrl.socketName]: vet.value,
          });
          replaceInPlace(refreshNodeSockets(n));
          break;
        }
        const def = getNodeDef(n.data.defType);
        if (!def) { err("UNKNOWN_TYPE", `set_param: node "${op.node}" has unknown type.`); break; }
        applyParams(n, def, { [op.param]: op.value }, op.node);
        // Params can retype sockets (mode toggles); refresh the cached lists.
        replaceInPlace(refreshNodeSockets(n));
        break;
      }
      case "add_node": {
        if (
          op.type === "repeat-input" ||
          op.type === "foreach-input" ||
          op.type === "iterate-input"
        ) {
          err(
            "UNKNOWN_TYPE",
            `add_node "${op.id}": "${op.type}" is minted with the compound zone — place "repeat" or "foreach" and address the Input as "${compoundZoneInputLid(op.id)}".`
          );
          break;
        }
        const def = getNodeDef(op.type);
        if (!def) { err("UNKNOWN_TYPE", `add_node "${op.id}": unknown type "${op.type}".`); break; }
        if (localToReal.has(op.id)) { err("DUP_ID", `add_node: duplicate local id "${op.id}".`); break; }
        let parentId = groupId;
        if (op.parent) {
          const pid = realId(op.parent);
          const pnode = byId.get(pid);
          if (!pnode || !isZoneShell(pnode.data.defType)) {
            err("BAD_PARENT", `add_node "${op.id}": parent "${op.parent}" is not a Repeat or For Each zone.`);
            break;
          }
          parentId = pnode.id;
        }
        if (op.type === "repeat") {
          const { repeat: shell, repeatInput: input } = makeRepeatNodes({ x: 0, y: 0 });
          shell.data.parentId = parentId;
          const inputDef = getNodeDef(input.data.defType);
          if (op.params && inputDef) applyParams(input, inputDef, op.params, op.id);
          const shellR = refreshNodeSockets(shell);
          const inputR = refreshNodeSockets(input);
          nodes.push(shellR, inputR);
          byId.set(shellR.id, shellR);
          byId.set(inputR.id, inputR);
          localToReal.set(op.id, shellR.id);
          localToReal.set(compoundZoneInputLid(op.id), inputR.id);
          break;
        }
        if (op.type === "foreach") {
          const { foreach: shell, foreachInput: input } = makeForEachNodes({ x: 0, y: 0 });
          shell.data.parentId = parentId;
          const inputDef = getNodeDef(input.data.defType);
          if (op.params && inputDef) applyParams(input, inputDef, op.params, op.id);
          const shellR = refreshNodeSockets(shell);
          const inputR = refreshNodeSockets(input);
          nodes.push(shellR, inputR);
          byId.set(shellR.id, shellR);
          byId.set(inputR.id, inputR);
          localToReal.set(op.id, shellR.id);
          localToReal.set(compoundZoneInputLid(op.id), inputR.id);
          break;
        }
        let n = makeInstanceNode(op.type, { x: 0, y: 0 });
        n.data.parentId = parentId;
        if (op.params) applyParams(n, def, op.params, op.id);
        n = refreshNodeSockets(n);
        nodes.push(n);
        byId.set(n.id, n);
        localToReal.set(op.id, n.id);
        break;
      }
      case "remove_node": {
        const nid = realId(op.node);
        const n = byId.get(nid);
        if (!n) { err("UNKNOWN_NODE", `remove_node: no node "${op.node}".`); break; }
        if (BOUNDARY_TYPES.has(n.data.defType)) {
          err("PROTECTED_NODE", `remove_node: "${op.node}" is a group boundary.`);
          break;
        }
        // Can't delete the scope being edited — that would orphan (or, for a
        // layer, dissolve) the whole interior. Nested groups ARE removable;
        // their interior is collected below so nothing is left dangling.
        if (nid === groupId) {
          err("PROTECTED_NODE", `remove_node: "${op.node}" is the scope being edited.`);
          break;
        }
        const dead = new Set([nid, ...collectDescendantIds(nodes, [nid])]);
        nodes = nodes.filter((x) => !dead.has(x.id));
        for (const id of dead) byId.delete(id);
        edges = edges.filter((e) => !dead.has(e.source) && !dead.has(e.target));
        // Promote edges to the deleted node die with it; drop the Group
        // Input sockets that now have no interior consumer (the dead
        // "index" knob after removing an exposed constant).
        const gi = groupInput();
        if (gi) {
          const stillUsed = new Set<string>();
          for (const e of edges) {
            if (e.source !== gi.id) continue;
            const name = (e.sourceHandle ?? "").startsWith("out:aux:")
              ? e.sourceHandle!.slice("out:aux:".length)
              : "";
            if (name) stillUsed.add(name);
          }
          const sockets = readBoundarySockets(gi.data.params);
          const kept = sockets.filter((s) => stillUsed.has(s.name));
          if (kept.length !== sockets.length) {
            gi.data.params = { ...gi.data.params, sockets: kept };
            replaceInPlace(refreshNodeSockets(gi));
            needsSync = true;
          }
        }
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
          const missing = !byId.has(srcId) ? srcId : tgtId;
          err(
            "EDGE_NODE_MISSING",
            `add_edge ${op.from} → ${op.to}: "${missing}" is not in this scope (editing ${groupId}).`
          );
          break;
        }
        {
          const srcN = byId.get(srcId)!;
          const tgtN = byId.get(tgtId)!;
          const out =
            !nodeIsInEditScope(srcN, groupId, byId)
              ? srcN
              : !nodeIsInEditScope(tgtN, groupId, byId)
                ? tgtN
                : undefined;
          if (out) {
            const inside = enclosingHiddenScope(out, groupId, byId);
            err(
              "EDGE_OUT_OF_SCOPE",
              `add_edge ${op.from} → ${op.to}: "${out.id}" is not in this scope` +
                (inside
                  ? ` — it's inside ${inside}. edit_group that id to wire its interior, or wire to the group shell.`
                  : ".")
            );
            break;
          }
        }
        // Merge ordinals ("in:layer2" — grows the layer list + refreshes
        // sockets when needed) and expression channels by name alias onto
        // the real id-based sockets, same as buildRecipe.
        let tgtNode = byId.get(tgtId)!;
        const tdef = getNodeDef(tgtNode.data.defType);
        if (tdef) {
          const ord = resolveOrdinalHandle(tdef, tgtNode.data.params, th);
          if (ord.params !== tgtNode.data.params) {
            tgtNode.data.params = ord.params;
            replaceInPlace(refreshNodeSockets(tgtNode));
          }
          th = resolveChannelHandle(tdef, ord.params, ord.handle);
          const grownVar = growExprVarHandle(tdef, byId.get(tgtId)!.data.params, th);
          if (grownVar.params !== byId.get(tgtId)!.data.params) {
            tgtNode.data.params = grownVar.params;
            replaceInPlace(refreshNodeSockets(tgtNode));
          }
          th = grownVar.handle;
        }
        const srcNode = byId.get(srcId)!;
        tgtNode = byId.get(tgtId)!;
        const srcVirtual = sh === `out:aux:${VIRTUAL_SOCKET}`;
        const tgtVirtual = th === `in:${VIRTUAL_SOCKET}`;
        // The virtual port is a mint gesture, not a real socket — the
        // editor swaps onto a named socket before any edge references
        // `__virtual__`. Storing the edge on that name looks like success
        // (the output exists on the def) but never appears on the group.
        if (srcVirtual || tgtVirtual) {
          if (srcVirtual && tgtVirtual) {
            err(
              "BAD_ENDPOINT",
              `add_edge ${op.from} → ${op.to}: virtual-to-virtual has no type to infer.`
            );
            break;
          }
          const minted = connectToVirtualSocket(nodes, edges, {
            source: srcId,
            sourceHandle: sh,
            target: tgtId,
            targetHandle: th,
          });
          if (!minted) {
            err(
              "BAD_ENDPOINT",
              `add_edge ${op.from} → ${op.to}: couldn't mint a boundary socket from the virtual port (target must already exist).`
            );
            break;
          }
          nodes = minted.nodes;
          edges = minted.edges;
          byId.clear();
          for (const n of nodes) byId.set(n.id, n);
          tgtNode = byId.get(tgtId)!;
          if (th.startsWith("in:param:")) {
            const pname = th.slice("in:param:".length);
            tgtNode.data.exposedParams = [
              ...new Set([...(tgtNode.data.exposedParams ?? []), pname]),
            ];
          }
          needsSync = true;
          break;
        }
        const minted = mintZoneEdgeSockets(nodes, srcNode, sh, tgtNode, th);
        if (minted !== nodes) {
          nodes = minted;
          byId.clear();
          for (const n of nodes) byId.set(n.id, n);
          tgtNode = byId.get(tgtId)!;
        }
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
        if (tgtNode && tdef) {
          // Ordinal aliasing WITHOUT growth — removing "in:layer5" on a
          // 2-layer merge shouldn't mint three layers as a side effect.
          const ord = resolveOrdinalHandle(tdef, tgtNode.data.params, th, { grow: false });
          th = resolveChannelHandle(tdef, tgtNode.data.params, ord.handle);
        }
        const before = edges.length;
        edges = edges.filter(
          (e) => !(e.source === srcId && e.sourceHandle === sh && e.target === tgtId && e.targetHandle === th)
        );
        if (edges.length === before)
          err("EDGE_NOT_FOUND", `remove_edge ${op.from} → ${op.to}: no matching edge.`);
        break;
      }
      case "expose_param": {
        const n = byId.get(realId(op.node));
        if (!n) { err("UNKNOWN_NODE", `expose_param: no node "${op.node}".`); break; }
        if (STRUCTURAL.has(n.data.defType)) { err("PROTECTED_NODE", `expose_param: "${op.node}" is structural.`); break; }
        const def = getNodeDef(n.data.defType);
        const pdef = def?.params.find((p) => p.name === op.param);
        const channel = !pdef && def ? findExprChannel(def, n.data.params, op.param) : undefined;
        if (!pdef && !channel) { err("UNKNOWN_PARAM", `expose_param: ${op.node} has no param "${op.param}".`); break; }
        if (channel && !channelSocketType(channel)) {
          err("PARAM_NOT_EXPOSABLE", `expose_param: "${op.param}" is a ${channel.kind ?? "pick"} channel (no socket — only scalar, toggle, color and ramp channels expose).`);
          break;
        }
        // A channel's boundary socket takes the channel's socket type
        // (scalar / vec4 / color_ramp), a param's its paramSocketType.
        const sockType = pdef
          ? paramSocketType(pdef.type)
          : channelSocketType(channel!);
        if (!sockType) { err("PARAM_NOT_EXPOSABLE", `expose_param: "${op.param}" (${pdef!.type}) can't be a socket.`); break; }
        const gi = groupInput();
        if (!gi) { err("NO_BOUNDARY", `expose_param: group has no input boundary.`); break; }
        const label = op.label?.trim() || op.param;
        const sockets = readBoundarySockets(gi.data.params);
        if (sockets.some((s) => s.name === label)) { err("DUP_SOCKET", `expose_param: interface socket "${label}" already exists.`); break; }
        gi.data.params = { ...gi.data.params, sockets: [...sockets, { name: label, type: sockType }] };
        const targetHandle = channel
          ? `in:in:${channel.id}`
          : `in:param:${op.param}`;
        if (!channel) {
          n.data.exposedParams = [...new Set([...(n.data.exposedParams ?? []), op.param])];
          n.data.controlParams = [...new Set([...(n.data.controlParams ?? []), op.param])];
          const shell = byId.get(groupId);
          const seed = n.data.params[op.param];
          if (shell && seed !== undefined) {
            const iv = readInputValues(shell.data.params);
            if (!(label in iv)) {
              shell.data.params = withInputValues(shell.data.params, {
                ...iv,
                [label]: seed,
              });
              replaceInPlace(shell);
            }
          }
        } else {
          err(
            "CHANNEL_EXPOSE",
            `expose_param: "${op.param}" promoted as socket only; no shell value (channel is not a param).`
          );
        }
        edges.push({
          id: newEdgeId(),
          source: gi.id,
          sourceHandle: `out:aux:${label}`,
          target: n.id,
          targetHandle,
        });
        replaceInPlace(refreshNodeSockets(gi));
        needsSync = true;
        break;
      }
      case "unexpose_param": {
        const n = byId.get(realId(op.node));
        if (!n) { err("UNKNOWN_NODE", `unexpose_param: no node "${op.node}".`); break; }
        const gi = groupInput();
        const def = getNodeDef(n.data.defType);
        const channel = def ? findExprChannel(def, n.data.params, op.param) : undefined;
        const promote = gi
          ? edges.find(
              (e) =>
                e.source === gi.id &&
                e.target === n.id &&
                (e.targetHandle === `in:param:${op.param}` ||
                  (!!channel && e.targetHandle === `in:in:${channel.id}`))
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
        const shell = byId.get(groupId);
        if (shell && label) {
          const iv = readInputValues(shell.data.params);
          if (label in iv) {
            // Copy the group value onto the interior param so unexpose
            // doesn't snap back to the authored default — that's what
            // turned a later re-expose into the N→14 (by-position) bug.
            if (!channel) {
              n.data.params = { ...n.data.params, [op.param]: iv[label] };
              replaceInPlace(n);
            }
            const next = { ...iv };
            delete next[label];
            shell.data.params = withInputValues(shell.data.params, next);
            replaceInPlace(shell);
          }
        }
        replaceInPlace(refreshNodeSockets(gi));
        needsSync = true;
        break;
      }
      case "rename_node": {
        const n = byId.get(realId(op.node));
        if (!n) { err("UNKNOWN_NODE", `rename_node: no node "${op.node}".`); break; }
        n.data.name = op.name;
        break;
      }
      case "duplicate_node": {
        const srcId = realId(op.node);
        const src = byId.get(srcId);
        if (!src) { err("UNKNOWN_NODE", `duplicate_node: no node "${op.node}".`); break; }
        if (BOUNDARY_TYPES.has(src.data.defType)) {
          err("PROTECTED_NODE", `duplicate_node: "${op.node}" is a group boundary.`);
          break;
        }
        if (srcId === groupId) {
          err("PROTECTED_NODE", `duplicate_node: "${op.node}" is the scope being edited.`);
          break;
        }
        if (localToReal.has(op.id)) {
          err("DUP_ID", `duplicate_node: duplicate local id "${op.id}".`);
          break;
        }
        const selIds = expandWithDescendants(nodes, [srcId]);
        const selection = nodes.filter((n) => selIds.has(n.id));
        const dupIndex = echoes.filter((e) => e.op === "duplicate_node" && e.ok).length;
        const { nodes: clones, edges: clonedEdges, idMap } = cloneSubgraph(
          selection,
          edges,
          { x: 80 * (dupIndex + 1), y: 40 * (dupIndex + 1) }
        );
        const cloneRoot = clones.find((n) => n.id === idMap.get(srcId));
        if (!cloneRoot) {
          err("UNKNOWN_NODE", `duplicate_node: clone of "${op.node}" failed.`);
          break;
        }
        cloneRoot.selected = false;
        if (op.name) cloneRoot.data.name = op.name;
        for (const c of clones) {
          nodes.push(c);
          byId.set(c.id, c);
        }
        edges.push(...clonedEdges);
        localToReal.set(op.id, cloneRoot.id);
        const ids: Record<string, string> = {};
        for (const [from, to] of idMap) ids[from] = to;
        dupIds.set(op.id, ids);
        if (op.params) {
          const cdef = getNodeDef(cloneRoot.data.defType);
          if (cdef) {
            if (cloneRoot.data.defType === GROUP_TYPE || cloneRoot.data.defType === LAYER_TYPE) {
              for (const [k, v] of Object.entries(op.params)) {
                const pdef = cdef.params.find((p) => p.name === k);
                if (pdef) {
                  applyParams(cloneRoot, cdef, { [k]: v }, op.id);
                  continue;
                }
                const ctrl = resolveGroupShellControl(cloneRoot, k, nodes, edges);
                if (!ctrl) {
                  err(
                    "UNKNOWN_PARAM",
                    `duplicate_node "${op.id}": no exposed param "${k}".`
                  );
                  continue;
                }
                const vet = vetParamValue(ctrl.controlDef, v);
                if (!vet.ok) {
                  err("BAD_PARAM_VALUE", `duplicate_node "${op.id}".${k}: ${vet.reason}.`);
                  continue;
                }
                const iv = readInputValues(cloneRoot.data.params);
                cloneRoot.data.params = withInputValues(cloneRoot.data.params, {
                  ...iv,
                  [ctrl.socketName]: vet.value,
                });
              }
              replaceInPlace(refreshNodeSockets(cloneRoot));
            } else {
              applyParams(cloneRoot, cdef, op.params, op.id);
              replaceInPlace(refreshNodeSockets(cloneRoot));
            }
          }
        }
        for (const p of op.patch ?? []) {
          const nid = idMap.get(p.node) ?? p.node;
          const n = byId.get(nid);
          if (!n) {
            err("UNKNOWN_NODE", `duplicate_node "${op.id}" patch: no node "${p.node}".`);
            continue;
          }
          const def = getNodeDef(n.data.defType);
          if (!def) {
            err("UNKNOWN_TYPE", `duplicate_node "${op.id}" patch: unknown type on "${p.node}".`);
            continue;
          }
          applyParams(n, def, { [p.param]: p.value }, p.node);
          replaceInPlace(refreshNodeSockets(n));
          if ((n.data.exposedParams ?? []).includes(p.param)) {
            const promote = edges.find(
              (e) =>
                e.target === n.id && e.targetHandle === `in:param:${p.param}`
            );
            const label = (promote?.sourceHandle ?? "").startsWith("out:aux:")
              ? promote!.sourceHandle!.slice("out:aux:".length)
              : "";
            const gi = label ? byId.get(promote!.source) : undefined;
            const shell = gi?.data.parentId ? byId.get(gi.data.parentId) : undefined;
            if (shell && label) {
              const iv = readInputValues(shell.data.params);
              shell.data.params = withInputValues(shell.data.params, {
                ...iv,
                [label]: n.data.params[p.param],
              });
              replaceInPlace(shell);
            }
          }
        }
        break;
      }
    }
    const newIssues = issues.slice(issuesBefore);
    const blocked = newIssues.some((x) => !SOFT_OP_CODES.has(x.code));
    echoOp(i, op, !blocked, newIssues[0]?.message);
  }

  // Re-sync the shell's interface from the boundary sockets if expose/unexpose
  // touched it. syncGroupInterface returns an updated nodes array.
  const synced = needsSync ? syncGroupInterface(nodes, groupId) : nodes;
  const finalNodes = seedMissingGroupInputValues(synced, edges, groupId);
  return {
    nodes: finalNodes,
    edges,
    issues,
    applied: echoes.filter((e) => e.ok).length,
    ops: echoes,
    ids: Object.fromEntries(localToReal),
  };
}
