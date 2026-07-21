// Shared wedge-batch resolution (spec 071026_wedge-render-batching.md):
// which Wedge nodes can affect a given Output, and how many variations the
// batch runs. Used by the export drivers in EffectsApp AND the UI readouts
// (Output panel "renders N variations", Render Queue ×N badges), so it
// lives lib-side as a pure function of the editor's node/edge arrays.
//
// Flatten first (wedges inside groups/layers and wires into exposed params
// become plain edges), then reverse-BFS from the Output — the same
// reachability walk evaluation uses, so a wedge counts exactly when it can
// affect the rendered image. Batches ZIP across wedges: count = max over
// wedges; each wedge clamps the shared index to its own count (last value
// holds). Note: a Layer Output's fixed group-output id dissolves in the
// flatten pass, so wedge batching applies to real Output nodes only.

import type { Node, Edge } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import { flattenGraph } from "@/engine/flatten";
import { WEDGE_TYPE, wedgeIterationCount } from "@/nodes/source/wedge";

export interface WedgeBatchInfo {
  // Zipped batch size; 1 = no batch.
  count: number;
  // Reachable, non-bypassed wedges in graph order. `name` is the node's
  // display name (the `{wedge:Name}` filename-token key); `params` feeds
  // wedgeTokenValue / wedgeIterationCount for per-iteration values.
  wedges: { id: string; name: string; params: Record<string, unknown> }[];
}

const NO_BATCH: WedgeBatchInfo = { count: 1, wedges: [] };

// No composition filter needed: the BFS only follows edges reachable from
// `outputNodeId`, and edges never cross compositions.
export function resolveWedgeBatchInfo(
  allNodes: Node<NodeDataPayload>[],
  allEdges: Edge[],
  outputNodeId: string
): WedgeBatchInfo {
  // Fast path — most graphs have no wedges; skip the flatten entirely.
  if (!allNodes.some((n) => n.data.defType === WEDGE_TYPE)) return NO_BATCH;

  const nameById = new Map<string, string>();
  const graphNodes: GraphNode[] = allNodes.map((n) => {
    if (n.data.name) nameById.set(n.id, n.data.name);
    return {
      id: n.id,
      type: n.data.defType,
      parentId: n.data.parentId,
      params: n.data.params,
      exposedParams: n.data.exposedParams,
      animation: n.data.animation,
      clips: n.data.clips,
      bypassed: !!n.data.bypassed,
    };
  });
  const graphEdges: GraphEdge[] = allEdges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle ?? "out:primary",
    target: e.target,
    targetHandle: e.targetHandle ?? "in:image",
  }));
  const flat = flattenGraph(graphNodes, graphEdges);
  const byId = new Map(flat.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, string[]>();
  for (const e of flat.edges) {
    const list = incoming.get(e.target);
    if (list) list.push(e.source);
    else incoming.set(e.target, [e.source]);
  }

  const wedges: WedgeBatchInfo["wedges"] = [];
  const seen = new Set<string>([outputNodeId]);
  const stack = [outputNodeId];
  while (stack.length) {
    const id = stack.pop()!;
    const node = byId.get(id);
    if (node?.type === WEDGE_TYPE && !node.bypassed) {
      wedges.push({
        id,
        name: nameById.get(id) ?? "Wedge",
        params: node.params,
      });
    }
    for (const src of incoming.get(id) ?? []) {
      if (!seen.has(src)) {
        seen.add(src);
        stack.push(src);
      }
    }
  }
  if (wedges.length === 0) return NO_BATCH;
  const count = Math.max(
    1,
    ...wedges.map((w) => wedgeIterationCount(w.params))
  );
  return { count, wedges };
}
