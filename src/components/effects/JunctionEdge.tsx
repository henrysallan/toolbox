"use client";

import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";

// The default edge renderer. A plain bezier that additionally honors a
// `data.spliceHighlight` flag: NodeEditor sets it while a compatible node is
// dragged over the edge, and we boost the stroke so the user sees where the
// splice will land.
//
// (Historically this also drew "junction" waypoint dots for combined
// same-source wires; that edge-metadata model was replaced by the first-class
// reroute node — see specdocs/071326_reroute-node.md. Every edge still flows
// through this type so the splice highlight works uniformly.)

type EdgeData = {
  spliceHighlight?: boolean;
};

export default function JunctionEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
    data,
  } = props;

  const splice = !!(data as EdgeData | undefined)?.spliceHighlight;
  const effectiveStyle = splice
    ? { ...style, stroke: "var(--tb-a-yellow-400)", strokeWidth: 3 }
    : style;

  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={effectiveStyle}
    />
  );
}
