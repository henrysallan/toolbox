"use client";

import { createContext } from "react";

// Context used to plumb junction-dot drag gestures from an individual
// JunctionEdge up to EffectsApp, where the global `edges` state actually
// lives. We can't call `setEdges` directly from the edge component because
// React Flow runs in controlled mode — edges are owned by the parent, and
// internal updates would get overwritten on the next render.
//
// The drag happens in two bursts:
//   - onDragStart(edgeId)                  — parent pushes an undo
//     snapshot so the whole drag coalesces into a single history entry.
//   - onDrag(edgeId, newFlowPos)           — fires on every mousemove;
//     parent looks up every edge whose waypoint is near the dragged one
//     and moves the whole cluster together (dots at a shared point stay
//     visually joined).

export interface WaypointActions {
  onDragStart: (edgeId: string) => void;
  onDrag: (edgeId: string, newFlowPos: [number, number]) => void;
}

export const WaypointContext = createContext<WaypointActions | null>(null);
