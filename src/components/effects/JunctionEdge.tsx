"use client";

import { useContext } from "react";
import {
  BaseEdge,
  Position,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
} from "@xyflow/react";
import { WaypointContext } from "./waypoint-context";

// Custom edge that supports an optional waypoint stored at
// `data.waypoint = [flowX, flowY]`. When present, the edge routes through
// the waypoint as two bezier segments and draws a filled dot at the
// waypoint — the "junction" for combined same-source wires.
//
// When no waypoint is set, behavior is identical to React Flow's default
// bezier edge, so every edge in the graph can safely use this type.

type EdgeData = {
  waypoint?: [number, number] | null;
  // Set by NodeEditor while a compatible node is dragged over this
  // edge. JunctionEdge reads it and boosts the stroke so the user
  // sees where the splice will land.
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
    selected,
  } = props;

  const edgeData = data as EdgeData | undefined;
  const waypoint = edgeData?.waypoint;
  const splice = !!edgeData?.spliceHighlight;
  const waypointActions = useContext(WaypointContext);
  const { screenToFlowPosition } = useReactFlow();

  // When highlighted as a splice target, override the edge style so
  // the user sees a clear "this is where the node drops" indicator.
  // Thicker stroke + brighter color; keeps whatever fill/markerEnd
  // the caller already set.
  const effectiveStyle = splice
    ? {
        ...style,
        stroke: "#facc15",
        strokeWidth: 3,
      }
    : style;

  const onDotPointerDown = (e: React.PointerEvent<SVGCircleElement>) => {
    if (!waypointActions || !waypoint) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    waypointActions.onDragStart(id);
    const onMove = (ev: PointerEvent) => {
      const flowPos = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      waypointActions.onDrag(id, [flowPos.x, flowPos.y]);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  if (!waypoint) {
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

  const [wx, wy] = waypoint;
  // Two legs: source → waypoint (target side = Left so the curve bows in
  // from the right), waypoint → target (source side = Right, symmetric).
  // Keeps the visual flow consistent with React Flow defaults on both
  // halves. The waypoint itself doesn't have a "side," so we pick Left/
  // Right as if it were a handle mid-graph.
  const [path1] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX: wx,
    targetY: wy,
    targetPosition: Position.Left,
  });
  const [path2] = getBezierPath({
    sourceX: wx,
    sourceY: wy,
    sourcePosition: Position.Right,
    targetX,
    targetY,
    targetPosition,
  });
  const combined = `${path1} ${path2}`;

  // Dot color tracks the edge stroke when supplied, otherwise falls back
  // to a neutral gray. We read it off `style.stroke` — React Flow lets us
  // set per-edge color through the style prop that flows in from
  // NodeEditor / handle types.
  const dotColor =
    (style as { stroke?: string } | undefined)?.stroke ?? "#a1a1aa";

  return (
    <>
      <BaseEdge
        id={id}
        path={combined}
        markerEnd={markerEnd}
        style={effectiveStyle}
      />
      {/* Filled circle at the waypoint. When multiple edges share the
          same waypoint the circles stack exactly, reading as one junction
          dot to the user. The oversized transparent circle below is the
          drag hit target — keeps the grabbable area generous even though
          the visible dot is small. */}
      <circle
        cx={wx}
        cy={wy}
        r={selected ? 5 : 4}
        fill={dotColor}
        stroke="#000"
        strokeWidth={1}
        style={{ pointerEvents: "none" }}
      />
      <circle
        cx={wx}
        cy={wy}
        r={10}
        fill="transparent"
        onPointerDown={onDotPointerDown}
        style={{ cursor: "grab", pointerEvents: "auto" }}
      />
    </>
  );
}
