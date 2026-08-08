"use client";

import { memo } from "react";
import {
  Handle,
  Position,
  useNodeConnections,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import { colorForSocket } from "./socketColor";

type RerouteNodeType = Node<NodeDataPayload, "reroute">;

// A reroute renders as a single dot — but it's a real node (see
// specdocs/archive/071326_reroute-node.md), so selection / copy-paste / delete /
// input-swap come from React Flow's node machinery. It carries one value
// straight through; flattenGraph dissolves it before evaluation.
//
// Layout: the `in:value` target handle sits at the LEFT edge, the
// `out:primary` source handle at the RIGHT edge — a wire lands on the left and
// leaves on the right, just like the dot suggests. Crucially the handles do
// NOT cover the node's centre: React Flow handles stopPropagation on
// pointerdown, so a full-cover would make the dot unselectable by click. The
// centre strip is bare node body, so clicking the dot selects it; the dot
// itself is `pointerEvents: none` so the click falls through to that body.
// React Flow's connection radius still snaps a wire dropped near the dot onto
// the nearest edge handle.

const NODE = 22; // hit-box square (px)
const HANDLE_W = 8; // width of each edge handle (leaves a selectable centre)
const DOT = 11; // visible dot diameter (px)

const edgeHandleStyle = (side: "left" | "right"): React.CSSProperties => ({
  [side]: 0,
  top: 0,
  transform: "none",
  width: HANDLE_W,
  height: NODE,
  minWidth: 0,
  minHeight: 0,
  borderRadius: 0,
  background: "transparent",
  border: "none",
});

function RerouteNode({ data, selected }: NodeProps<RerouteNodeType>) {
  // A wired reroute takes its colour from the type flowing through it; empty,
  // it stays neutral so it doesn't masquerade as an image wire.
  const connected = useNodeConnections({ handleType: "target" }).length > 0;
  const color = connected
    ? colorForSocket(data.primaryOutput ?? "image")
    : "var(--tb-n-13)";

  return (
    <div style={{ position: "relative", width: NODE, height: NODE }}>
      <Handle
        type="target"
        id="in:value"
        position={Position.Left}
        style={edgeHandleStyle("left")}
      />
      <Handle
        type="source"
        id="out:primary"
        position={Position.Right}
        style={edgeHandleStyle("right")}
      />
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: DOT,
          height: DOT,
          borderRadius: "50%",
          background: color,
          border: "1.5px solid var(--tb-n-0)",
          boxShadow: selected
            ? "0 0 0 2px var(--tb-n-17), 0 0 0 3.5px var(--tb-n-0)"
            : "0 1px 2px rgba(0,0,0,0.5)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

export default memo(RerouteNode);
