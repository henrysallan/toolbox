// buildRecipe — turns an LLM-authored RecipeGraph (the minimal contract in
// specdocs/062526_ai-recipe-generation.md §5) into a real node-group fragment,
// using the same primitives presets do. The builder is the trust boundary:
// even a malformed RecipeGraph can only mint nodes via makeInstanceNode and
// edges between named handles — it can never inject behavior.

import type { Edge } from "@xyflow/react";
import type { ExprInput, NodeDefinition, SocketType } from "@/engine/types";
import { getNodeDef } from "@/engine/registry";
import { GROUP_TYPE } from "@/engine/groups";
import { SETTABLE_PARAM_TYPES, vetParamValue } from "@/engine/node-catalog";
import { withMaskInput } from "@/engine/conventions";
import { syncChannelInputs } from "@/nodes/effect/point-expression";
import {
  BLEND_MODE_ORDER,
  newLayerId,
  type BlendMode,
  type MergeLayer,
} from "@/nodes/effect/merge";
import {
  makeInstanceNode,
  newEdgeId,
  refreshNodeSockets,
  type GraphNode,
} from "@/state/graph-ops";
import {
  groupFragment,
  type GroupInputSpec,
  type GroupOutputSpec,
  type PromoteSpec,
} from "@/state/group-fragment";

// ---------------------------------------------------------------------------
// RecipeGraph: what the LLM emits. Local ids; the builder fills the mechanics.
// ---------------------------------------------------------------------------
export interface RecipeNode {
  id: string; // local id, unique within the recipe
  type: string; // built-in node type
  params?: Record<string, unknown>;
}
export interface RecipeEdge {
  from: string; // "<lid>:out" | "<lid>:aux:<name>"
  to: string; // "<lid>:in:<sock>" | "<lid>:param:<name>"
}
export interface RecipeIO {
  name: string;
  // Interior endpoint: a TARGET handle for inputs ("<lid>:in:<sock>"),
  // a SOURCE handle for outputs ("<lid>:out" | "<lid>:aux:<name>").
  from: string;
  type: SocketType;
}
export interface RecipeExposed {
  name: string; // label surfaced on the group
  node: string; // local id
  param: string;
}
export interface RecipeGraph {
  name: string;
  description?: string;
  nodes: RecipeNode[];
  edges?: RecipeEdge[];
  inputs?: RecipeIO[];
  outputs: RecipeIO[];
  exposed?: RecipeExposed[];
}

export interface BuildIssue {
  code: string;
  message: string;
}
export interface BuildResult {
  nodes: GraphNode[];
  edges: Edge[];
  issues: BuildIssue[];
}

// --- endpoint grammar (spec §5) — shared with recipe-edit.ts ---------------
export function splitEndpoint(ep: string): { lid: string; rest: string } | null {
  const i = ep.indexOf(":");
  if (i < 0) return null;
  return { lid: ep.slice(0, i), rest: ep.slice(i + 1) };
}
export function toSourceHandle(rest: string): string | null {
  if (rest === "out") return "out:primary";
  if (rest.startsWith("aux:")) return `out:${rest}`; // out:aux:NAME
  return null;
}
export function toTargetHandle(rest: string): string | null {
  if (rest.startsWith("in:")) return rest; // in:sock
  if (rest.startsWith("param:")) return `in:${rest}`; // in:param:NAME
  return null;
}

// Auto-run the panel's "Sync" for expression channels: scan the authored
// expression for ch(…)/pick(…) refs and mint the matching slider/dropdown
// inputs. The LLM can't set `expr_inputs` (not a settable type), so without
// this an AI-authored expression's tunables would only materialize after the
// user manually hits Sync inside the group. Add-only and id-stable (same
// helper as the button); returns `params` untouched when nothing changed.
export function syncExpressionChannels(
  def: NodeDefinition,
  params: Record<string, unknown>
): Record<string, unknown> {
  const source = params.expression;
  if (typeof source !== "string") return params;
  let out = params;
  for (const pdef of def.params) {
    if (pdef.type !== "expr_inputs" || !pdef.channelSync) continue;
    const existing = (out[pdef.name] as ExprInput[]) ?? [];
    const synced = syncChannelInputs(existing, source);
    if (synced !== existing) out = { ...out, [pdef.name]: synced };
  }
  return out;
}

// Resolve a channel-by-name edge target: "in:speed" → "in:in:<exprInputId>".
// Expression channel sockets are id-based (stable across renames), but the
// LLM can't know ids minted at build time — so recipes address a channel by
// its NAME as if it were a socket, and this translates to the real handle.
// Real sockets win a name collision; unknown names pass through unchanged
// (the validator then reports EDGE_UNKNOWN_INPUT for the repair loop).
export function resolveChannelHandle(
  def: NodeDefinition,
  params: Record<string, unknown>,
  targetHandle: string
): string {
  if (!targetHandle.startsWith("in:") || targetHandle.startsWith("in:param:"))
    return targetHandle;
  const chanParam = def.params.find(
    (p) => p.type === "expr_inputs" && p.channelSync
  );
  if (!chanParam) return targetHandle;
  const sock = targetHandle.slice("in:".length);
  let inputs = def.inputs;
  try {
    if (def.resolveInputs) inputs = def.resolveInputs(params);
  } catch {
    inputs = def.inputs;
  }
  if (withMaskInput(inputs, def).some((i) => i.name === sock))
    return targetHandle; // a literal socket with this name exists
  const entries = (params[chanParam.name] as ExprInput[]) ?? [];
  const hit = entries.find((e) => e.name === sock && !e.options);
  return hit ? `in:in:${hit.id}` : targetHandle;
}

// ---------------------------------------------------------------------------
// Merge-style dynamic inputs (`merge_layers` params). Socket ids are minted
// at author time (`layer:<id>`), so — like expression channels — the LLM
// can't know them. Two affordances close the gap:
//   1. `params.layers` accepts a RESTRICTED authoring shape,
//      [{mode?, opacity?}, …] — ids are minted here, or preserved BY INDEX
//      when the node already has layers so existing wires never dangle.
//   2. Edge targets may address layers ordinally — "in:layer2"/"in:mask2" —
//      and resolve to the real id-based socket, growing the list if needed.
// ---------------------------------------------------------------------------

const BLEND_MODE_SET = new Set<string>(BLEND_MODE_ORDER);
const MAX_MERGE_LAYERS = 16;
const ORDINAL_RE = /^in:(layer|mask)([1-9]\d*)$/;

export function vetMergeLayers(
  value: unknown,
  existing: MergeLayer[] | undefined
): { ok: true; value: MergeLayer[] } | { ok: false; reason: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MERGE_LAYERS)
    return {
      ok: false,
      reason: `expected an array of 1–${MAX_MERGE_LAYERS} {mode?, opacity?} entries`,
    };
  const out: MergeLayer[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i] as {
      mode?: unknown;
      opacity?: unknown;
      enabled?: unknown;
    } | null;
    if (raw === null || typeof raw !== "object")
      return { ok: false, reason: `entry ${i} must be an object` };
    const mode = raw.mode === undefined ? (existing?.[i]?.mode ?? "normal") : raw.mode;
    if (typeof mode !== "string" || !BLEND_MODE_SET.has(mode))
      return {
        ok: false,
        reason: `entry ${i}: unknown blend mode "${String(raw.mode)}" — one of ${BLEND_MODE_ORDER.join(", ")}`,
      };
    const opacity =
      raw.opacity === undefined ? (existing?.[i]?.opacity ?? 1) : raw.opacity;
    if (typeof opacity !== "number" || !(opacity >= 0 && opacity <= 1))
      return { ok: false, reason: `entry ${i}: opacity must be a number in 0–1` };
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
      return { ok: false, reason: `entry ${i}: enabled must be a boolean` };
    const enabled =
      raw.enabled === undefined ? existing?.[i]?.enabled : raw.enabled;
    out.push({
      id: existing?.[i]?.id ?? newLayerId(),
      mode: mode as BlendMode,
      opacity,
      // Omit when enabled (the default) so the authored shape stays minimal.
      ...(enabled === false ? { enabled: false } : {}),
    });
  }
  return { ok: true, value: out };
}

// "in:layer2" → "in:layer:<id>" against the def's merge_layers param. When
// `grow` (the default) and the ordinal is past the end, the list extends
// with normal/1.0 layers and the RETURNED params carry the growth — callers
// write them back and refresh sockets. Non-matching handles pass through.
export function resolveOrdinalHandle(
  def: NodeDefinition,
  params: Record<string, unknown>,
  targetHandle: string,
  opts?: { grow?: boolean }
): { handle: string; params: Record<string, unknown> } {
  const m = ORDINAL_RE.exec(targetHandle);
  const pdef = m ? def.params.find((p) => p.type === "merge_layers") : undefined;
  if (!m || !pdef) return { handle: targetHandle, params };
  const kind = m[1];
  const n = Number(m[2]);
  if (n > MAX_MERGE_LAYERS) return { handle: targetHandle, params };
  let layers = (params[pdef.name] as MergeLayer[] | undefined) ?? [];
  if (layers.length < n) {
    if (opts?.grow === false) return { handle: targetHandle, params };
    layers = [...layers];
    while (layers.length < n)
      layers.push({ id: newLayerId(), mode: "normal", opacity: 1 });
    params = { ...params, [pdef.name]: layers };
  }
  return { handle: `in:${kind}:${layers[n - 1].id}`, params };
}

export function buildRecipe(rg: RecipeGraph): BuildResult {
  const issues: BuildIssue[] = [];
  const realByLid = new Map<string, GraphNode>();
  const interior: GraphNode[] = [];

  // 1. Nodes → real instances with vetted param overrides.
  let x = 0;
  for (const rn of rg.nodes ?? []) {
    const def = getNodeDef(rn.type);
    if (!def) {
      issues.push({ code: "UNKNOWN_TYPE", message: `Node "${rn.id}": unknown type "${rn.type}" — skipped.` });
      continue;
    }
    if (realByLid.has(rn.id)) {
      issues.push({ code: "DUP_ID", message: `Duplicate local id "${rn.id}" — later one ignored.` });
      continue;
    }
    const n = makeInstanceNode(rn.type, { x, y: 0 });
    x += 260;
    if (rn.params) {
      const next = { ...n.data.params };
      for (const [k, v] of Object.entries(rn.params)) {
        const pdef = def.params.find((p) => p.name === k);
        if (!pdef) {
          issues.push({ code: "UNKNOWN_PARAM", message: `${rn.id}.${k}: no such param — ignored.` });
          continue;
        }
        if (pdef.type === "merge_layers") {
          // Restricted authoring shape — see vetMergeLayers.
          const vet = vetMergeLayers(v, next[k] as MergeLayer[] | undefined);
          if (!vet.ok) {
            issues.push({
              code: "BAD_PARAM_VALUE",
              message: `${rn.id}.${k}: ${vet.reason} — left at default.`,
            });
            continue;
          }
          next[k] = vet.value;
          continue;
        }
        if (!SETTABLE_PARAM_TYPES.has(pdef.type)) {
          issues.push({
            code: "PARAM_NOT_SETTABLE",
            message: `${rn.id}.${k}: type "${pdef.type}" is not LLM-settable — left at default.`,
          });
          continue;
        }
        const vet = vetParamValue(pdef, v);
        if (!vet.ok) {
          issues.push({
            code: "BAD_PARAM_VALUE",
            message: `${rn.id}.${k}: ${vet.reason} — left at default.`,
          });
          continue;
        }
        next[k] = vet.value;
      }
      // Gated on the recipe actually authoring an expression, so a node
      // placed with the default placeholder doesn't mint junk channels
      // from the placeholder's ch("name", default) comment.
      n.data.params =
        "expression" in rn.params ? syncExpressionChannels(def, next) : next;
    }
    const refreshed = refreshNodeSockets(n);
    realByLid.set(rn.id, refreshed);
    interior.push(refreshed);
  }
  const real = (lid: string) => realByLid.get(lid);

  // Resolve the two authoring aliases against a target node: merge ordinals
  // ("in:layer2" — growing the layer list + refreshing sockets when the
  // ordinal points past the end) and expression channels by name.
  const resolveTargetHandle = (lid: string, tgt: GraphNode, th: string): string => {
    const tdef = getNodeDef(tgt.data.defType);
    if (!tdef) return th;
    const ord = resolveOrdinalHandle(tdef, tgt.data.params, th);
    if (ord.params !== tgt.data.params) {
      const grown = refreshNodeSockets({
        ...tgt,
        data: { ...tgt.data, params: ord.params },
      });
      realByLid.set(lid, grown);
      const ix = interior.findIndex((x) => x.id === tgt.id);
      if (ix >= 0) interior[ix] = grown;
    }
    return resolveChannelHandle(tdef, ord.params, ord.handle);
  };

  // 2. Interior edges → real handle ids; param targets get exposed.
  const edges: Edge[] = [];
  for (const re of rg.edges ?? []) {
    const s = splitEndpoint(re.from);
    const t = splitEndpoint(re.to);
    const src = s && real(s.lid);
    let tgt = t && real(t.lid);
    const sh = s && toSourceHandle(s.rest);
    let th = t && toTargetHandle(t.rest);
    if (!t || !src || !tgt || !sh || !th) {
      issues.push({ code: "BAD_EDGE", message: `Edge ${re.from} → ${re.to}: could not resolve — dropped.` });
      continue;
    }
    th = resolveTargetHandle(t.lid, tgt, th);
    tgt = real(t.lid)!; // growth may have replaced the node object
    edges.push({ id: newEdgeId(), source: src.id, sourceHandle: sh, target: tgt.id, targetHandle: th });
    if (th.startsWith("in:param:")) {
      const pname = th.slice("in:param:".length);
      tgt.data.exposedParams = [...new Set([...(tgt.data.exposedParams ?? []), pname])];
    }
  }

  // 3. Interface specs (inputs / outputs / exposed).
  const inputs: GroupInputSpec[] = [];
  for (const io of rg.inputs ?? []) {
    const t = splitEndpoint(io.from);
    let tgt = t && real(t.lid);
    let th = t && toTargetHandle(t.rest);
    if (!t || !tgt || !th) {
      issues.push({ code: "BAD_INPUT", message: `Input "${io.name}" → ${io.from}: unresolved — dropped.` });
      continue;
    }
    th = resolveTargetHandle(t.lid, tgt, th);
    tgt = real(t.lid)!;
    inputs.push({ name: io.name, type: io.type, to: { nodeId: tgt.id, handle: th } });
  }
  const outputs: GroupOutputSpec[] = [];
  for (const io of rg.outputs ?? []) {
    const s = splitEndpoint(io.from);
    const src = s && real(s.lid);
    const sh = s && toSourceHandle(s.rest);
    if (!src || !sh) {
      issues.push({ code: "BAD_OUTPUT", message: `Output "${io.name}" ← ${io.from}: unresolved — dropped.` });
      continue;
    }
    outputs.push({ name: io.name, type: io.type, from: { nodeId: src.id, handle: sh } });
  }
  const promote: PromoteSpec[] = [];
  for (const ex of rg.exposed ?? []) {
    const node = real(ex.node);
    if (!node) {
      issues.push({ code: "BAD_EXPOSED", message: `Exposed "${ex.name}": node "${ex.node}" missing — dropped.` });
      continue;
    }
    promote.push({ node, param: ex.param, label: ex.name });
  }
  if (outputs.length === 0)
    issues.push({ code: "NO_OUTPUT", message: "Recipe produced no resolved outputs." });

  // 4. Wrap in a node-group fragment (same path as presets).
  const { nodes, edges: groupEdges } = groupFragment({
    name: rg.name,
    interior,
    edges,
    inputs,
    outputs,
    promote,
  });
  // Mark the group shell as AI-authored so it gets the "Edit with AI" button.
  for (const n of nodes) {
    if (n.data.defType === GROUP_TYPE) n.data.aiAuthored = true;
  }
  return { nodes, edges: groupEdges, issues };
}
