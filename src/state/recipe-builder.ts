// buildRecipe — turns an LLM-authored RecipeGraph (the minimal contract in
// specdocs/archive/062526_ai-recipe-generation.md §5) into a real node-group fragment,
// using the same primitives presets do. The builder is the trust boundary:
// even a malformed RecipeGraph can only mint nodes via makeInstanceNode and
// edges between named handles — it can never inject behavior.

import type { Edge } from "@xyflow/react";
import type { ExprInput, NodeDefinition, SocketType } from "@/engine/types";
import { getNodeDef } from "@/engine/registry";
import { GROUP_TYPE, isZoneShell } from "@/engine/groups";
import { SETTABLE_PARAM_TYPES, vetParamValue } from "@/engine/node-catalog";
import { paramSocketType } from "@/engine/graph-helpers";
import { withMaskInput } from "@/engine/conventions";
import { tidyLayout } from "@/state/node-layout";
import { applyPositions, toLayoutGraph } from "@/state/node-layout-graph";
import {
  channelSocketType,
  EXPR_VAR_NAME_RE,
  findExprChannel,
  newExprInputId,
  syncChannelInputs,
  vetExprInputList,
} from "@/engine/expr-channels";
import {
  BLEND_MODE_ORDER,
  isDefaultMergeStack,
  newLayerId,
  type BlendMode,
  type MergeLayer,
} from "@/nodes/effect/merge";
import {
  makeForEachNodes,
  makeInstanceNode,
  makeRepeatNodes,
  mintZoneEdgeSockets,
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
  // Local id of a Repeat / For Each zone this node belongs to (the
  // compound recipe id, i.e. the Output). Body nodes and nested zones
  // use this so parentId lands on the zone shell instead of the group.
  parent?: string;
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
  // Recipe local id → node id as minted by buildRecipe (before the editor
  // clones the fragment into the live graph). Compound zones also map
  // "<id>-input". Empty when nothing resolved.
  ids: Record<string, string>;
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
// user manually hits Sync. Called from buildRecipe / applyRecipeEdit when
// `expression` is in the authored params, and from MCP set_param when that
// param is written. Add-only and id-stable (same helper as the button);
// returns `params` untouched when nothing changed.
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

// Committed expression write + channel scan in one step. MCP set_param uses
// this so a remote patch mints uniforms without swapping the node. Does not
// belong on the live param-panel path — keystrokes would mint partial names.
export function applySyncedExpression(
  def: NodeDefinition,
  params: Record<string, unknown>,
  expression: string
): { params: Record<string, unknown>; minted: string[] } {
  const next = syncExpressionChannels(def, { ...params, expression });
  const minted: string[] = [];
  for (const pdef of def.params) {
    if (pdef.type !== "expr_inputs" || !pdef.channelSync) continue;
    const before = new Set(
      ((params[pdef.name] as ExprInput[]) ?? []).map((c) => c.name)
    );
    for (const c of (next[pdef.name] as ExprInput[]) ?? []) {
      if (!before.has(c.name)) minted.push(c.name);
    }
  }
  return { params: next, minted };
}

// A channel on a channelSync expr_inputs param, looked up by the authored
// name (`ink`), not the id-based socket (`in:<id>`). Lives engine-side now;
// re-exported for recipe-edit and the MCP handlers.
export { findExprChannel };

// Resolve a channel-by-name edge target: "in:speed" → "in:in:<exprInputId>".
// Expression channel sockets are id-based (stable across renames), but the
// LLM can't know ids minted at build time — so recipes address a channel by
// its NAME as if it were a socket, and this translates to the real handle.
// Real sockets win a name collision; unknown names — and panel-only kinds
// (pick / curve have no socket) — pass through unchanged (the validator
// then reports EDGE_UNKNOWN_INPUT for the repair loop).
export function resolveChannelHandle(
  def: NodeDefinition,
  params: Record<string, unknown>,
  targetHandle: string
): string {
  if (!targetHandle.startsWith("in:") || targetHandle.startsWith("in:param:"))
    return targetHandle;
  const sock = targetHandle.slice("in:".length);
  let inputs = def.inputs;
  try {
    if (def.resolveInputs) inputs = def.resolveInputs(params);
  } catch {
    inputs = def.inputs;
  }
  if (withMaskInput(inputs, def).some((i) => i.name === sock))
    return targetHandle; // a literal socket with this name exists
  // Expression sockets are stored as `in:<ein-id>`; a recipe that targets
  // `in:ein-x0` must pick up the extra `in:` prefix or the validator looks
  // for a socket named `ein-x0` and rejects the default input.
  if (withMaskInput(inputs, def).some((i) => i.name === `in:${sock}`))
    return `in:in:${sock}`;
  // Name (`rows` / `x`), minted id (`ein-…`), or the socket name itself (`in:ein-…`).
  const hit =
    findExprChannel(def, params, sock) ??
    (sock.startsWith("in:") ? findExprChannel(def, params, sock.slice(3)) : undefined);
  return hit && channelSocketType(hit) ? `in:in:${hit.id}` : targetHandle;
}

// Grow the scalar Expression node's `inputs` list when an edge targets a
// new variable name (`<id>:in:p`). ChannelSync nodes (Point / GLSL
// Expression) are not grown — their rows come from the source. Guessed
// `ein-…` ids are left alone so a stale id stays an EDGE_UNKNOWN_INPUT
// instead of minting a variable named "ein-p".
export function growExprVarHandle(
  def: NodeDefinition,
  params: Record<string, unknown>,
  targetHandle: string
): { params: Record<string, unknown>; handle: string } {
  const pdef = def.params.find((p) => p.type === "expr_inputs" && !p.channelSync);
  if (
    !pdef ||
    !targetHandle.startsWith("in:") ||
    targetHandle.startsWith("in:param:")
  ) {
    return { params, handle: targetHandle };
  }
  const resolved = resolveChannelHandle(def, params, targetHandle);
  if (resolved !== targetHandle) return { params, handle: resolved };
  const sock = targetHandle.slice("in:".length);
  if (/^ein-[a-z0-9]+$/i.test(sock) || sock.startsWith("in:ein-")) {
    return { params, handle: targetHandle };
  }
  if (!EXPR_VAR_NAME_RE.test(sock)) return { params, handle: targetHandle };
  const list = ([...((params[pdef.name] as ExprInput[]) ?? [])]);
  const existing = list.find((e) => e.name === sock);
  if (existing) return { params, handle: `in:in:${existing.id}` };
  const row: ExprInput = { id: newExprInputId(), name: sock, default: 1 };
  return {
    params: { ...params, [pdef.name]: [...list, row] },
    handle: `in:in:${row.id}`,
  };
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
      maskInvert?: unknown;
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
    if (raw.maskInvert !== undefined && typeof raw.maskInvert !== "boolean")
      return { ok: false, reason: `entry ${i}: maskInvert must be a boolean` };
    const maskInvert =
      raw.maskInvert === undefined ? existing?.[i]?.maskInvert : raw.maskInvert;
    out.push({
      id: existing?.[i]?.id ?? newLayerId(),
      mode: mode as BlendMode,
      opacity,
      // Omit the flags at their defaults so the authored shape stays minimal.
      ...(enabled === false ? { enabled: false } : {}),
      ...(maskInvert === true ? { maskInvert: true } : {}),
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

export function isCompoundZoneType(type: string): type is "repeat" | "foreach" {
  return type === "repeat" || type === "foreach";
}

export function compoundZoneInputLid(lid: string): string {
  return `${lid}-input`;
}

const ZONE_INPUT_PLACE_TYPES = new Set([
  "repeat-input",
  "foreach-input",
  "iterate-input",
]);

function applyVettedParams(
  def: NodeDefinition,
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
  lid: string,
  issues: BuildIssue[]
): Record<string, unknown> {
  const next = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    const pdef = def.params.find((p) => p.name === k);
    if (!pdef) {
      issues.push({ code: "UNKNOWN_PARAM", message: `${lid}.${k}: no such param — ignored.` });
      continue;
    }
    if (pdef.type === "merge_layers") {
      // Fresh node still has the canned lyr-initial stack — a recipe
      // `layers` list replaces it (new ids) instead of recycling slot 0
      // and looking like N entries were appended.
      const existing = isDefaultMergeStack(next[k] as MergeLayer[] | undefined)
        ? undefined
        : (next[k] as MergeLayer[] | undefined);
      const vet = vetMergeLayers(v, existing);
      if (!vet.ok) {
        issues.push({
          code: "BAD_PARAM_VALUE",
          message: `${lid}.${k}: ${vet.reason} — left at default.`,
        });
        continue;
      }
      next[k] = vet.value;
      continue;
    }
    if (pdef.type === "expr_inputs" && !pdef.channelSync) {
      const vet = vetExprInputList(v, next[k] as ExprInput[] | undefined);
      if (!vet.ok) {
        issues.push({
          code: "BAD_PARAM_VALUE",
          message: `${lid}.${k}: ${vet.reason} — left at default.`,
        });
        continue;
      }
      next[k] = vet.value;
      continue;
    }
    if (!SETTABLE_PARAM_TYPES.has(pdef.type)) {
      issues.push({
        code: "PARAM_NOT_SETTABLE",
        message: `${lid}.${k}: type "${pdef.type}" is not LLM-settable — left at default.`,
      });
      continue;
    }
    const vet = vetParamValue(pdef, v);
    if (!vet.ok) {
      issues.push({
        code: "BAD_PARAM_VALUE",
        message: `${lid}.${k}: ${vet.reason} — left at default.`,
      });
      continue;
    }
    next[k] = vet.value;
  }
  return "expression" in overrides ? syncExpressionChannels(def, next) : next;
}

function syncLidMap(realByLid: Map<string, GraphNode>, nodes: GraphNode[]) {
  const byReal = new Map(nodes.map((n) => [n.id, n]));
  for (const [lid, n] of realByLid) {
    const updated = byReal.get(n.id);
    if (updated) realByLid.set(lid, updated);
  }
}

export function buildRecipe(rg: RecipeGraph): BuildResult {
  const issues: BuildIssue[] = [];
  const realByLid = new Map<string, GraphNode>();
  let interior: GraphNode[] = [];

  // 1. Nodes → real instances with vetted param overrides.
  let x = 0;
  for (const rn of rg.nodes ?? []) {
    if (ZONE_INPUT_PLACE_TYPES.has(rn.type)) {
      issues.push({
        code: "UNKNOWN_TYPE",
        message: `Node "${rn.id}": "${rn.type}" is minted with the compound zone — place "repeat" or "foreach" and address the Input as "${compoundZoneInputLid(rn.id)}".`,
      });
      continue;
    }
    const def = getNodeDef(rn.type);
    if (!def) {
      issues.push({ code: "UNKNOWN_TYPE", message: `Node "${rn.id}": unknown type "${rn.type}" — skipped.` });
      continue;
    }
    if (realByLid.has(rn.id)) {
      issues.push({ code: "DUP_ID", message: `Duplicate local id "${rn.id}" — later one ignored.` });
      continue;
    }

    if (rn.type === "repeat") {
      const { repeat: shell, repeatInput: input } = makeRepeatNodes({ x, y: 0 });
      x += 520;
      const inputDef = getNodeDef(input.data.defType);
      if (rn.params && inputDef) {
        input.data.params = applyVettedParams(
          inputDef,
          input.data.params,
          rn.params,
          rn.id,
          issues
        );
      }
      const shellR = refreshNodeSockets(shell);
      const inputR = refreshNodeSockets(input);
      realByLid.set(rn.id, shellR);
      realByLid.set(compoundZoneInputLid(rn.id), inputR);
      interior.push(shellR, inputR);
      continue;
    }
    if (rn.type === "foreach") {
      const { foreach: shell, foreachInput: input } = makeForEachNodes({ x, y: 0 });
      x += 520;
      const inputDef = getNodeDef(input.data.defType);
      if (rn.params && inputDef) {
        input.data.params = applyVettedParams(
          inputDef,
          input.data.params,
          rn.params,
          rn.id,
          issues
        );
      }
      const shellR = refreshNodeSockets(shell);
      const inputR = refreshNodeSockets(input);
      realByLid.set(rn.id, shellR);
      realByLid.set(compoundZoneInputLid(rn.id), inputR);
      interior.push(shellR, inputR);
      continue;
    }

    const n = makeInstanceNode(rn.type, { x, y: 0 });
    x += 260;
    if (rn.params) {
      n.data.params = applyVettedParams(def, n.data.params, rn.params, rn.id, issues);
    }
    const refreshed = refreshNodeSockets(n);
    realByLid.set(rn.id, refreshed);
    interior.push(refreshed);
  }

  // Zone membership: `parent` is the compound recipe id (the Output).
  for (const rn of rg.nodes ?? []) {
    if (!rn.parent) continue;
    const child = realByLid.get(rn.id);
    const parent = realByLid.get(rn.parent);
    if (!child || !parent) {
      issues.push({
        code: "BAD_PARENT",
        message: `Node "${rn.id}": parent "${rn.parent}" did not resolve.`,
      });
      continue;
    }
    if (!isZoneShell(parent.data.defType)) {
      issues.push({
        code: "BAD_PARENT",
        message: `Node "${rn.id}": parent "${rn.parent}" is not a Repeat or For Each zone.`,
      });
      continue;
    }
    child.data.parentId = parent.id;
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
    const live = realByLid.get(lid) ?? tgt;
    const grownVar = growExprVarHandle(tdef, live.data.params, ord.handle);
    if (grownVar.params !== live.data.params) {
      const grown = refreshNodeSockets({
        ...live,
        data: { ...live.data, params: grownVar.params },
      });
      realByLid.set(lid, grown);
      const ix = interior.findIndex((x) => x.id === tgt.id);
      if (ix >= 0) interior[ix] = grown;
    }
    return grownVar.handle;
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
    const srcNow = real(s.lid)!;
    const minted = mintZoneEdgeSockets(interior, srcNow, sh, tgt, th);
    if (minted !== interior) {
      interior = minted;
      syncLidMap(realByLid, interior);
    }
    const srcFresh = real(s.lid)!;
    tgt = real(t.lid)!;
    edges.push({
      id: newEdgeId(),
      source: srcFresh.id,
      sourceHandle: sh,
      target: tgt.id,
      targetHandle: th,
    });
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
    const label = typeof ex.name === "string" ? ex.name.trim() : "";
    const param = typeof ex.param === "string" ? ex.param.trim() : "";
    const node = real(ex.node);
    if (!node) {
      issues.push({
        code: "BAD_EXPOSED",
        message: `Exposed "${label || param || "?"}": node "${ex.node}" missing — dropped.`,
      });
      continue;
    }
    if (!param) {
      issues.push({
        code: "BAD_EXPOSED",
        message: `Exposed "${label || "(unnamed)"}": missing param name — dropped.`,
      });
      continue;
    }
    if (!label) {
      issues.push({
        code: "BAD_EXPOSED",
        message: `Exposed ${ex.node}.${param}: missing name (group knob label) — dropped.`,
      });
      continue;
    }
    const pdef = getNodeDef(node.data.defType)?.params.find((x) => x.name === param);
    if (!pdef) {
      issues.push({
        code: "BAD_EXPOSED",
        message: `Exposed "${label}": ${ex.node} has no param "${param}" — dropped.`,
      });
      continue;
    }
    const sockType = paramSocketType(pdef.type);
    if (!sockType) {
      issues.push({
        code: "BAD_EXPOSED",
        message: `Exposed "${label}": ${ex.node}.${param} (${pdef.type}) can't be a group knob — dropped.`,
      });
      continue;
    }
    promote.push({ node, param, label });
  }
  if (outputs.length === 0)
    issues.push({ code: "NO_OUTPUT", message: "Recipe produced no resolved outputs." });

  // 3b. Lay the interior out along its wires (090626_tidy-layout.md). The
  // loop above only spaced nodes along x in recipe order; the group opens
  // to a readable graph instead of a strip. Boxes are estimates here (no
  // React Flow yet) — a later Tidy in the editor refines with real sizes.
  {
    const lg = toLayoutGraph(interior, edges);
    const moves = tidyLayout(
      lg.nodes,
      lg.edges,
      interior.map((n) => n.id),
      { anchor: "origin" }
    );
    interior = applyPositions(interior, moves);
    syncLidMap(realByLid, interior);
  }
  const liveById = new Map(interior.map((n) => [n.id, n]));
  for (const p of promote) {
    const live = liveById.get(p.node.id);
    if (live) p.node = live;
  }

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
  const ids: Record<string, string> = {};
  for (const [lid, n] of realByLid) ids[lid] = n.id;
  return { nodes, edges: groupEdges, issues, ids };
}
