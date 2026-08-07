// Simulation pre-roll detection for the export drivers.
//
// Switching the engine to an export resolution recreates the backend
// (EffectsApp's [renderRes] effect), which destroys ctx.state — and
// ctx.state is where every stateful node keeps its frame-accumulated
// result: the matter/fluid/particle solvers' buffers, the Simulation
// Zone's ping-pong textures, Trails' feedback buffer, Advect Points'
// persistent positions. A still captured at frame 50 after that wipe
// shows a freshly-seeded sim (or, for the readback-deferred solvers, a
// blank frame) instead of 50 frames of accumulation.
//
// So: if any node reachable from the Output is marked `simulation` in its
// NodeDefinition, the capture has to be preceded by stepping the clock
// from frame 0 back up to the target frame at the export resolution.
// This module answers the "is that needed?" half; the stepping lives in
// EffectsApp's export drivers.
//
// Same flatten + reverse-BFS as resolveWedgeBatchInfo (lib/wedge-batch.ts)
// — flatten first so sims inside groups/layers become plain edges, then
// walk incoming edges from the Output, which is exactly the reachability
// the evaluator uses. A bypassed sim contributes nothing to the render,
// so it doesn't force a pre-roll.

import type { Node, Edge } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import { flattenGraph } from "@/engine/flatten";
import { getNodeDef } from "@/engine/registry";

// True when the subgraph feeding `outputNodeId` contains a stateful
// simulation, i.e. a still at frame > 0 can't be rendered from a cold
// backend without stepping the clock up to it first.
export function outputNeedsSimPreroll(
  allNodes: Node<NodeDataPayload>[],
  allEdges: Edge[],
  outputNodeId: string
): boolean {
  // Fast path — most graphs have no sims at all; skip the flatten.
  if (
    !allNodes.some(
      (n) => !n.data.bypassed && getNodeDef(n.data.defType)?.simulation
    )
  ) {
    return false;
  }

  const graphNodes: GraphNode[] = allNodes.map((n) => ({
    id: n.id,
    type: n.data.defType,
    parentId: n.data.parentId,
    params: n.data.params,
    exposedParams: n.data.exposedParams,
    animation: n.data.animation,
    clips: n.data.clips,
    bypassed: !!n.data.bypassed,
  }));
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

  const seen = new Set<string>([outputNodeId]);
  const stack = [outputNodeId];
  while (stack.length) {
    const id = stack.pop()!;
    const node = byId.get(id);
    if (node && !node.bypassed && getNodeDef(node.type)?.simulation) return true;
    for (const src of incoming.get(id) ?? []) {
      if (!seen.has(src)) {
        seen.add(src);
        stack.push(src);
      }
    }
  }
  return false;
}
