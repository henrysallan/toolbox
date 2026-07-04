// buildRecipe — turns an LLM-authored RecipeGraph (the minimal contract in
// specdocs/062526_ai-recipe-generation.md §5) into a real node-group fragment,
// using the same primitives presets do. The builder is the trust boundary:
// even a malformed RecipeGraph can only mint nodes via makeInstanceNode and
// edges between named handles — it can never inject behavior.

import type { Edge } from "@xyflow/react";
import type { SocketType } from "@/engine/types";
import { getNodeDef } from "@/engine/registry";
import { GROUP_TYPE } from "@/engine/groups";
import { SETTABLE_PARAM_TYPES } from "@/engine/node-catalog";
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
        if (!SETTABLE_PARAM_TYPES.has(pdef.type)) {
          issues.push({
            code: "PARAM_NOT_SETTABLE",
            message: `${rn.id}.${k}: type "${pdef.type}" is not LLM-settable — left at default.`,
          });
          continue;
        }
        next[k] = v;
      }
      n.data.params = next;
    }
    const refreshed = refreshNodeSockets(n);
    realByLid.set(rn.id, refreshed);
    interior.push(refreshed);
  }
  const real = (lid: string) => realByLid.get(lid);

  // 2. Interior edges → real handle ids; param targets get exposed.
  const edges: Edge[] = [];
  for (const re of rg.edges ?? []) {
    const s = splitEndpoint(re.from);
    const t = splitEndpoint(re.to);
    const src = s && real(s.lid);
    const tgt = t && real(t.lid);
    const sh = s && toSourceHandle(s.rest);
    const th = t && toTargetHandle(t.rest);
    if (!src || !tgt || !sh || !th) {
      issues.push({ code: "BAD_EDGE", message: `Edge ${re.from} → ${re.to}: could not resolve — dropped.` });
      continue;
    }
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
    const tgt = t && real(t.lid);
    const th = t && toTargetHandle(t.rest);
    if (!tgt || !th) {
      issues.push({ code: "BAD_INPUT", message: `Input "${io.name}" → ${io.from}: unresolved — dropped.` });
      continue;
    }
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
