// xyflow graph → node-layout input (specdocs/090626_tidy-layout.md).
//
// The one place that knows how an editor node maps onto the pure layout's
// `LayoutNode`: which def types are pillars / zones / reroutes / frames,
// which handles are visible and in what row order, and where a node's box
// and handle centres come from. Measured boxes (`node.measured`) and real
// handle offsets (React Flow's internal handle bounds, passed in by the
// NodeEditor) win; anything unmeasured — a scope that isn't open, a recipe
// interior at build time — falls back to `estimateNodeGeometry`.
//
// Pure (no DOM) so recipe-builder, mcp-handlers and the editor all share it.

import type { Edge, Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import { FRAME_TYPE, REROUTE_TYPE } from "@/engine/graph-helpers";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  isZoneInput,
  isZoneShell,
} from "@/engine/groups";
import {
  estimateNodeGeometry,
  REROUTE_SIZE,
  type LayoutEdge,
  type LayoutKind,
  type LayoutNode,
  type LayoutPort,
} from "@/state/node-layout";

export type GraphLayoutNode = Node<NodeDataPayload>;

// Handle offsets the editor can supply for a node: centre y of each handle
// measured from the node's top edge, in flow px (React Flow's
// `internals.handleBounds`, which is already zoom-independent).
export interface HandleOffsets {
  inputs: LayoutPort[];
  outputs: LayoutPort[];
}

export function layoutKindFor(defType: string): LayoutKind {
  if (defType === REROUTE_TYPE) return "reroute";
  if (defType === FRAME_TYPE) return "frame";
  if (isZoneShell(defType)) return "zoneShell";
  if (isZoneInput(defType)) return "zoneInput";
  if (defType === GROUP_INPUT_TYPE) return "groupInput";
  if (defType === GROUP_OUTPUT_TYPE || defType === "output") return "groupOutput";
  return "node";
}

// Visible handle ids in row order — the same order EffectNode renders them
// (inputs, then exposed params on the left; primary, then aux on the right).
export function visibleHandles(data: NodeDataPayload): {
  inputs: string[];
  outputs: string[];
} {
  const inputs = data.inputs.filter((i) => !i.hidden).map((i) => `in:${i.name}`);
  for (const p of data.exposedParams ?? []) inputs.push(`in:param:${p}`);
  const outputs: string[] = [];
  if (data.primaryOutput) outputs.push("out:primary");
  for (const a of data.auxOutputs) if (!a.disabled) outputs.push(`out:aux:${a.name}`);
  return { inputs, outputs };
}

export function toLayoutNode(
  n: GraphLayoutNode,
  handleOffsets?: (id: string) => HandleOffsets | null
): LayoutNode {
  const kind = layoutKindFor(n.data.defType);
  if (kind === "reroute") {
    return {
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      width: n.measured?.width ?? REROUTE_SIZE,
      height: n.measured?.height ?? REROUTE_SIZE,
      kind,
      parentId: n.data.parentId,
      frameId: n.data.frameId,
      inputs: [{ id: "in:value", y: (n.measured?.height ?? REROUTE_SIZE) / 2 }],
      outputs: [{ id: "out:primary", y: (n.measured?.height ?? REROUTE_SIZE) / 2 }],
    };
  }
  const handles = visibleHandles(n.data);
  const est = estimateNodeGeometry({
    inputHandles: handles.inputs,
    outputHandles: handles.outputs,
    uiWidth: n.data.uiWidth,
    uiHeight: n.data.uiHeight,
  });
  const measured = handleOffsets?.(n.id) ?? null;
  const width = n.measured?.width ?? n.width ?? est.width;
  const height = n.measured?.height ?? n.height ?? est.height;
  return {
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    width,
    height,
    kind,
    parentId: n.data.parentId,
    frameId: n.data.frameId,
    inputs: measured && measured.inputs.length ? measured.inputs : est.inputs,
    outputs: measured && measured.outputs.length ? measured.outputs : est.outputs,
  };
}

export function toLayoutEdges(edges: Edge[]): LayoutEdge[] {
  return edges.map((e) => ({
    source: e.source,
    sourceHandle: e.sourceHandle ?? "out:primary",
    target: e.target,
    targetHandle: e.targetHandle ?? "",
  }));
}

export function toLayoutGraph(
  nodes: GraphLayoutNode[],
  edges: Edge[],
  handleOffsets?: (id: string) => HandleOffsets | null
): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  return {
    nodes: nodes.map((n) => toLayoutNode(n, handleOffsets)),
    edges: toLayoutEdges(edges),
  };
}

// Apply a layout result to xyflow nodes (new objects only for moved nodes).
export function applyPositions<T extends GraphLayoutNode>(
  nodes: T[],
  moves: Map<string, { x: number; y: number }>
): T[] {
  if (moves.size === 0) return nodes;
  return nodes.map((n) => {
    const m = moves.get(n.id);
    if (!m || (m.x === n.position.x && m.y === n.position.y)) return n;
    return { ...n, position: { x: m.x, y: m.y } };
  });
}
