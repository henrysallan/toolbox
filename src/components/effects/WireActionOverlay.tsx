"use client";

import { useEffect, useRef, useState } from "react";
import type { Edge } from "@xyflow/react";
import { useReactFlow } from "@xyflow/react";
import {
  appendPathPoint,
  defaultBezierCps,
  handleCenter,
  polylineCrossesPolyline,
  sampleCubic,
  type Pt,
} from "@/engine/wire-geometry";
import { ownerWindow } from "./layout/panel-window";

// Captures two drag gestures over the node editor:
//
//   Shift + drag   — "combine" gesture. Every edge the drawn path crosses is
//                    grouped by source (nodeId + sourceHandle); any group
//                    with ≥2 members gets a junction waypoint set at the
//                    path's midpoint, so in the renderer those edges fan
//                    out from a shared trunk + dot.
//   Alt   + drag   — "cut" gesture. Every edge the path crosses is
//                    deleted.
//
// The overlay traces the cursor path (not a start→end rubber-band) so a
// curved drag is both visible and what gets hit-tested.
//
// We attach at the WINDOW level in the capture phase so we can preempt
// React Flow's own selection-marquee and node-drag handlers when the
// appropriate modifier is held. Clicks that land on a node, handle, or
// control are left alone — gestures only activate over empty pane.

interface Props {
  edges: Edge[];
  onCombine: (edgeIds: string[], midpointFlow: [number, number]) => void;
  onCut: (edgeIds: string[]) => void;
  // Container whose bounds define "inside the flow." Usually the React
  // Flow wrapper element. We restrict gestures to mousedowns that land
  // inside this element so clicks on menus/headers pass through.
  flowEl: HTMLElement | null;
}

type Mode = "combine" | "cut";

interface DragState {
  mode: Mode;
  start: Pt;
  current: Pt;
  path: Pt[];
}

export default function WireActionOverlay({
  edges,
  onCombine,
  onCut,
  flowEl,
}: Props) {
  const { screenToFlowPosition } = useReactFlow();
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  useEffect(() => {
    if (!flowEl) return;

    const shouldIgnoreTarget = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      if (!el) return true;
      if (!flowEl.contains(el)) return true;
      // Node bodies, handles, minimap, controls, existing edges — all
      // pass through. Only empty pane (or the background grid) activates.
      if (el.closest(".react-flow__node")) return true;
      if (el.closest(".react-flow__handle")) return true;
      if (el.closest(".react-flow__controls")) return true;
      if (el.closest(".react-flow__minimap")) return true;
      if (el.closest(".react-flow__edge")) return true;
      return false;
    };

    const win = ownerWindow(flowEl);

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (!e.shiftKey && !e.altKey) return;
      if (shouldIgnoreTarget(e.target)) return;

      const mode: Mode = e.shiftKey ? "combine" : "cut";
      // Preempt React Flow's marquee / pan handlers for this gesture.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const start: Pt = [e.clientX, e.clientY];
      const next = {
        mode,
        start,
        current: start,
        path: [start] as Pt[],
      };
      dragRef.current = next;
      setDrag(next);
    };

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault();
      const current: Pt = [e.clientX, e.clientY];
      const path = d.path.slice();
      appendPathPoint(path, current);
      const next = { mode: d.mode, start: d.start, current, path };
      dragRef.current = next;
      setDrag(next);
    };

    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      const end: Pt = [e.clientX, e.clientY];
      const path = d.path.slice();
      const last = path[path.length - 1];
      if (!last || last[0] !== end[0] || last[1] !== end[1]) path.push(end);
      dragRef.current = null;
      // Reject tiny gestures — probably a mis-click.
      const dx = end[0] - d.start[0];
      const dy = end[1] - d.start[1];
      if (Math.hypot(dx, dy) < 6) {
        setDrag(null);
        return;
      }

      const crossed = findCrossedEdges(edgesRef.current, path);
      if (d.mode === "cut") {
        if (crossed.length > 0) onCut(crossed.map((c) => c.id));
      } else if (crossed.length > 0) {
        // Combine: drop a reroute on every crossed wire. Downstream
        // (insertReroutesOnEdges) groups them by shared source and mints one
        // reroute per group, so a single crossed wire reroutes too — no ≥2
        // requirement anymore. Anchor in FLOW coords so it zooms with the
        // viewport. Place it at the path's midpoint so a curved drag
        // doesn't drop the reroute on the start→end chord.
        const midScreen = pathMidpoint(path);
        const midFlow = screenToFlowPosition({
          x: midScreen[0],
          y: midScreen[1],
        });
        onCombine(
          crossed.map((c) => c.id),
          [midFlow.x, midFlow.y]
        );
      }
      setDrag(null);
    };

    // System took the gesture — abandon without cutting/combining anything.
    const onCancel = () => {
      if (dragRef.current) {
        dragRef.current = null;
        setDrag(null);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      // Dropping the modifier mid-drag aborts the gesture — matches how
      // Photoshop tools abandon when you release the modifier key.
      if (e.key === "Shift" || e.key === "Alt") {
        if (dragRef.current) {
          dragRef.current = null;
          setDrag(null);
        }
      }
    };

    // Capture phase everywhere so React Flow's handlers see a
    // already-stopped event and don't start competing gestures. Pointer
    // rather than mouse: React Flow's own pan/marquee is pointer-driven, so
    // a mousedown intercept was racing it even with a mouse, and did nothing
    // at all under a Pencil.
    win.addEventListener("pointerdown", onDown, true);
    win.addEventListener("pointermove", onMove, true);
    win.addEventListener("pointerup", onUp, true);
    win.addEventListener("pointercancel", onCancel, true);
    win.addEventListener("keyup", onKeyUp);
    return () => {
      win.removeEventListener("pointerdown", onDown, true);
      win.removeEventListener("pointermove", onMove, true);
      win.removeEventListener("pointerup", onUp, true);
      win.removeEventListener("pointercancel", onCancel, true);
      win.removeEventListener("keyup", onKeyUp);
    };
  }, [flowEl, onCombine, onCut, screenToFlowPosition]);

  if (!drag || !flowEl) return null;
  const stroke = drag.mode === "combine" ? "var(--tb-a-cyan-400)" : "var(--tb-a-red-500)";
  const last = drag.path[drag.path.length - 1];
  const tip =
    last && last[0] === drag.current[0] && last[1] === drag.current[1]
      ? []
      : [drag.current];
  const verts = [...drag.path, ...tip];
  if (verts.length < 2) return null;
  const rect = flowEl.getBoundingClientRect();
  const points = verts
    .map((p) => `${p[0] - rect.left},${p[1] - rect.top}`)
    .join(" ");

  return (
    <svg
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 100,
        overflow: "visible",
      }}
    >
      <polyline
        points={points}
        fill="none"
        stroke="rgba(0,0,0,0.5)"
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="6 4"
      />
    </svg>
  );
}

function pathMidpoint(path: Pt[]): Pt {
  if (path.length === 0) return [0, 0];
  if (path.length === 1) return path[0];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  }
  if (total === 0) return path[0];
  let acc = 0;
  const half = total / 2;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    if (acc + d >= half) {
      const t = d === 0 ? 0 : (half - acc) / d;
      return [
        path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t,
        path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t,
      ];
    }
    acc += d;
  }
  return path[path.length - 1];
}

// Walk every edge, resolve its endpoints from the rendered DOM handles,
// sample a cubic bezier along its path, and check whether any segment of
// that polyline crosses the user's drawn drag path.
function findCrossedEdges(
  edges: Edge[],
  path: Pt[]
): Array<{
  id: string;
  source: string;
  sourceHandle: string | null | undefined;
}> {
  if (path.length < 2) return [];
  const hits: Array<{
    id: string;
    source: string;
    sourceHandle: string | null | undefined;
  }> = [];
  for (const e of edges) {
    if (!e.sourceHandle || !e.targetHandle) continue;
    const src = handleCenter(e.source, e.sourceHandle);
    const tgt = handleCenter(e.target, e.targetHandle);
    if (!src || !tgt) continue;

    // Waypoint-aware sampling: if the edge has a waypoint in its data,
    // we hit-test both legs. Flow-coord waypoints don't translate 1:1
    // to screen coords without access to the viewport, but they were
    // placed on top of existing edges so the per-leg bezier endpoints
    // (source→target and the implicit midpoint) already bracket them —
    // close enough to detect a crossing either way. Defer true 2-leg
    // sampling until it visibly matters in practice.
    const { c1, c2 } = defaultBezierCps(src, tgt);
    const samples = sampleCubic(src, c1, c2, tgt, 14);
    if (polylineCrossesPolyline(samples, path)) {
      hits.push({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle,
      });
    }
  }
  return hits;
}
