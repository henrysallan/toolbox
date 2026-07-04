// Client orchestrator for Edit-with-AI (spec 062926_edit-group-with-ai.md).
// Builds the group spec, POSTs to /api/edit-recipe for a patch, then applies +
// validates it client-side, with a repair loop. `post` is injectable so the
// loop is testable without a live API. The caller commits the returned
// {nodes, edges} (the edited group fragment) back into the live graph.

import type { Edge } from "@xyflow/react";
import { validateGraph, type ValNode, type ValEdge } from "@/engine/graph-validation";
import {
  applyRecipeEdit,
  groupToSpec,
  type GroupSpec,
  type RecipeEdit,
} from "@/state/recipe-edit";
import type { GraphNode } from "@/state/graph-ops";
import { buildCatalogDsl } from "@/lib/ai/generate-recipe-client";
import type { AiProgress } from "@/lib/ai/ai-progress";

export interface EditResult {
  ok: boolean;
  attempts: number;
  summary?: string;
  nodes?: GraphNode[];
  edges?: Edge[];
  errors: string[];
  warnings: string[];
}

export interface EditPostBody {
  catalog: string;
  groupSpec: GroupSpec;
  instruction: string;
  history?: { instruction: string; summary: string }[];
  repair?: { edit: RecipeEdit; errors: string[] };
}
export interface EditPostResult {
  edit: RecipeEdit;
  thinking?: string;
}
export type EditPostFn = (body: EditPostBody) => Promise<EditPostResult>;

// Apply issues that broke the patch (worth a repair turn). Soft issues (an
// ignored unknown/non-settable param) become warnings.
const HARD_OP_CODES = new Set([
  "UNKNOWN_NODE",
  "UNKNOWN_TYPE",
  "DUP_ID",
  "BAD_ENDPOINT",
  "EDGE_NODE_MISSING",
  "EDGE_NOT_FOUND",
  "PROTECTED_NODE",
  "PARAM_NOT_EXPOSABLE",
  "DUP_SOCKET",
  "NO_BOUNDARY",
  "NOT_EXPOSED",
]);

const defaultPost: EditPostFn = async (body) => {
  const res = await fetch("/api/edit-recipe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return { edit: data.edit as RecipeEdit, thinking: data.thinking as string | undefined };
};

export async function editGroupRecipe(
  groupId: string,
  nodes: GraphNode[],
  edges: Edge[],
  instruction: string,
  opts?: {
    maxRepairs?: number;
    history?: { instruction: string; summary: string }[];
    post?: EditPostFn;
    onProgress?: (e: AiProgress) => void;
  }
): Promise<EditResult> {
  const post = opts?.post ?? defaultPost;
  const maxRepairs = opts?.maxRepairs ?? 2;
  const catalog = buildCatalogDsl();
  const groupSpec = groupToSpec(groupId, nodes, edges);

  let repair: { edit: RecipeEdit; errors: string[] } | undefined;
  let attempts = 0;
  let last: EditResult = { ok: false, attempts: 0, errors: ["no attempts"], warnings: [] };

  while (attempts <= maxRepairs) {
    attempts++;
    opts?.onProgress?.({ kind: "request", attempt: attempts });
    let edit: RecipeEdit;
    try {
      const r = await post({ catalog, groupSpec, instruction, history: opts?.history, repair });
      edit = r.edit;
      if (r.thinking) opts?.onProgress?.({ kind: "thinking", attempt: attempts, text: r.thinking });
    } catch (e) {
      return { ok: false, attempts, errors: [`edit failed: ${(e as Error).message}`], warnings: [] };
    }

    // Apply each attempt to the ORIGINAL fragment — patches aren't cumulative.
    const result = applyRecipeEdit(groupId, nodes, edges, edit);
    const valNodes: ValNode[] = result.nodes.map((n) => ({
      id: n.id,
      defType: n.data.defType,
      params: n.data.params,
    }));
    const valEdges: ValEdge[] = result.edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: (e.sourceHandle ?? "") as string,
      target: e.target,
      targetHandle: (e.targetHandle ?? "") as string,
    }));
    const val = validateGraph(valNodes, valEdges);

    const hardOps = result.issues.filter((i) => HARD_OP_CODES.has(i.code));
    const softOps = result.issues.filter((i) => !HARD_OP_CODES.has(i.code));
    const valErrors = val.issues.filter((i) => i.severity === "error");
    const errors = [...hardOps.map((i) => i.message), ...valErrors.map((i) => i.message)];
    const warnings = [
      ...softOps.map((i) => i.message),
      ...val.issues.filter((i) => i.severity === "warning").map((i) => i.message),
    ];

    if (errors.length === 0) {
      opts?.onProgress?.({ kind: "applied", attempt: attempts, summary: edit.summary });
      return {
        ok: true,
        attempts,
        summary: edit.summary,
        nodes: result.nodes,
        edges: result.edges,
        errors: [],
        warnings,
      };
    }

    opts?.onProgress?.({ kind: "invalid", attempt: attempts, errors });
    last = { ok: false, attempts, summary: edit.summary, errors, warnings };
    repair = { edit, errors };
  }

  return last;
}
