// Client-side orchestrator for AI Recipe Generation (spec §3, milestone 4).
// Runs in the browser, where the engine + registry already live: it builds the
// node catalog, POSTs the request to /api/generate-recipe (the thin Claude
// proxy), then BUILDS and VALIDATES the returned RecipeGraph locally. On
// validation errors it re-POSTs with the errors for a repair turn, up to a cap.
// The `post` fn is injectable so the loop is testable without a live API.

import type { Edge } from "@xyflow/react";
import { allNodeDefs } from "@/engine/registry";
import { buildNodeCatalog, formatCatalogDsl } from "@/engine/node-catalog";
import { validateGraph, type ValNode, type ValEdge } from "@/engine/graph-validation";
import { buildRecipe, type RecipeGraph } from "@/state/recipe-builder";
import type { GraphNode } from "@/state/graph-ops";
import type { AiProgress } from "@/lib/ai/ai-progress";

export interface GenerateResult {
  ok: boolean;
  attempts: number;
  recipe?: RecipeGraph;
  nodes?: GraphNode[];
  edges?: Edge[];
  errors: string[]; // blocking problems (empty when ok)
  warnings: string[]; // soft issues (e.g. a non-settable param was dropped)
}

export interface PostBody {
  catalog: string;
  request: string;
  repair?: { recipe: RecipeGraph; errors: string[] };
}
export interface PostResult {
  recipe: RecipeGraph;
  thinking?: string;
}
export type PostFn = (body: PostBody) => Promise<PostResult>;

// Build issues that are worth a repair turn (structurally broke the recipe).
// Soft issues (a non-settable/unknown param the builder just dropped) are
// surfaced as warnings, not retried — the node still works at its default.
export const HARD_BUILD_CODES = new Set([
  "UNKNOWN_TYPE",
  "DUP_ID",
  "BAD_EDGE",
  "BAD_INPUT",
  "BAD_OUTPUT",
  "BAD_EXPOSED",
  "NO_OUTPUT",
  // A rejected param VALUE (wrong type / non-option enum / non-finite
  // number) means the recipe doesn't do what the model intended — worth a
  // repair turn, unlike the dropped-param soft issues.
  "BAD_PARAM_VALUE",
]);

const defaultPost: PostFn = async (body) => {
  const res = await fetch("/api/generate-recipe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return { recipe: data.recipe as RecipeGraph, thinking: data.thinking as string | undefined };
};

export function buildCatalogDsl(): string {
  return formatCatalogDsl(buildNodeCatalog(allNodeDefs()));
}

export async function generateRecipe(
  request: string,
  opts?: { maxRepairs?: number; post?: PostFn; onProgress?: (e: AiProgress) => void }
): Promise<GenerateResult> {
  const post = opts?.post ?? defaultPost;
  const maxRepairs = opts?.maxRepairs ?? 2;
  const catalog = buildCatalogDsl();

  let repair: { recipe: RecipeGraph; errors: string[] } | undefined;
  let attempts = 0;
  let last: GenerateResult = { ok: false, attempts: 0, errors: ["no attempts"], warnings: [] };

  while (attempts <= maxRepairs) {
    attempts++;
    opts?.onProgress?.({ kind: "request", attempt: attempts });
    let recipe: RecipeGraph;
    try {
      const r = await post({ catalog, request, repair });
      recipe = r.recipe;
      if (r.thinking) opts?.onProgress?.({ kind: "thinking", attempt: attempts, text: r.thinking });
    } catch (e) {
      return { ok: false, attempts, errors: [`generation failed: ${(e as Error).message}`], warnings: [] };
    }

    const built = buildRecipe(recipe);
    const valNodes: ValNode[] = built.nodes.map((n) => ({
      id: n.id,
      defType: n.data.defType,
      params: n.data.params,
    }));
    const valEdges: ValEdge[] = built.edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: (e.sourceHandle ?? "") as string,
      target: e.target,
      targetHandle: (e.targetHandle ?? "") as string,
    }));
    const val = validateGraph(valNodes, valEdges);

    const hardBuild = built.issues.filter((i) => HARD_BUILD_CODES.has(i.code));
    const softBuild = built.issues.filter((i) => !HARD_BUILD_CODES.has(i.code));
    const valErrors = val.issues.filter((i) => i.severity === "error");
    const errors = [...hardBuild.map((i) => i.message), ...valErrors.map((i) => i.message)];
    const warnings = [
      ...softBuild.map((i) => i.message),
      ...val.issues.filter((i) => i.severity === "warning").map((i) => i.message),
    ];

    if (errors.length === 0) {
      opts?.onProgress?.({ kind: "applied", attempt: attempts, summary: recipe.name });
      return { ok: true, attempts, recipe, nodes: built.nodes, edges: built.edges, errors: [], warnings };
    }

    opts?.onProgress?.({ kind: "invalid", attempt: attempts, errors });
    last = { ok: false, attempts, recipe, errors, warnings };
    repair = { recipe, errors };
  }

  return last;
}
