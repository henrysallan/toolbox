"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
} from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import type { Pt } from "@/engine/wire-geometry";
import { useWireLabelApi } from "./wire-label-context";

// The default edge renderer. A plain bezier that additionally honors a
// `data.spliceHighlight` flag: NodeEditor sets it while a compatible node is
// dragged over the edge, and we boost the stroke so the user sees where the
// splice will land.
//
// Wire labels (091526): when `data.label` is set the edge also renders a
// text bubble parked at `data.labelT` (0..1) of the wire's length, through
// React Flow's EdgeLabelRenderer (a div layer in flow coordinates, so the
// bubble zooms with the graph like node chrome). Click the bubble to edit
// the text, drag it to slide it along the wire, right-click for the wire
// menu. Commits go through WireLabelContext (NodeEditor → EffectsApp owns
// undo).
//
// (Historically this also drew "junction" waypoint dots for combined
// same-source wires; that edge-metadata model was replaced by the first-class
// reroute node — see specdocs/archive/071326_reroute-node.md. Every edge still flows
// through this type so the splice highlight works uniformly.)

type EdgeData = {
  spliceHighlight?: boolean;
  label?: string;
  labelT?: number;
};

// --- Bezier geometry ------------------------------------------------------
// Mirrors @xyflow/system's getBezierPath control points (curvature 0.25) so
// the bubble sits ON the drawn wire — the wire-geometry.ts helper used for
// gesture hit-testing approximates a different curve and is tolerant of it;
// a label parked visibly off the wire is not.

const CURVATURE = 0.25;

function controlOffset(distance: number): number {
  return distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance);
}

function controlPoint(
  pos: Position,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): Pt {
  switch (pos) {
    case Position.Left:
      return [x1 - controlOffset(x1 - x2), y1];
    case Position.Right:
      return [x1 + controlOffset(x2 - x1), y1];
    case Position.Top:
      return [x1, y1 - controlOffset(y1 - y2)];
    case Position.Bottom:
      return [x1, y1 + controlOffset(y2 - y1)];
  }
}

export interface WireCubic {
  p0: Pt;
  c1: Pt;
  c2: Pt;
  p3: Pt;
}

export function wireCubic(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  sourcePosition: Position = Position.Right,
  targetPosition: Position = Position.Left
): WireCubic {
  return {
    p0: [sourceX, sourceY],
    c1: controlPoint(sourcePosition, sourceX, sourceY, targetX, targetY),
    c2: controlPoint(targetPosition, targetX, targetY, sourceX, sourceY),
    p3: [targetX, targetY],
  };
}

export function pointOnWire(w: WireCubic, t: number): Pt {
  const mt = 1 - t;
  const b0 = mt * mt * mt;
  const b1 = 3 * mt * mt * t;
  const b2 = 3 * mt * t * t;
  const b3 = t * t * t;
  return [
    b0 * w.p0[0] + b1 * w.c1[0] + b2 * w.c2[0] + b3 * w.p3[0],
    b0 * w.p0[1] + b1 * w.c1[1] + b2 * w.c2[1] + b3 * w.p3[1],
  ];
}

// Parameter of the wire point nearest `pt`: coarse sample, then narrow the
// bracket around the best sample three times. Plenty for a drag handle.
export function nearestWireT(w: WireCubic, pt: Pt): number {
  let bestT = 0.5;
  let bestD = Infinity;
  const consider = (t: number) => {
    const p = pointOnWire(w, t);
    const dx = p[0] - pt[0];
    const dy = p[1] - pt[1];
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  };
  const N = 64;
  for (let i = 0; i <= N; i++) consider(i / N);
  let span = 1 / N;
  for (let round = 0; round < 3; round++) {
    const lo = Math.max(0, bestT - span);
    const hi = Math.min(1, bestT + span);
    const center = bestT;
    for (let i = 0; i <= 8; i++) {
      const t = lo + ((hi - lo) * i) / 8;
      if (t !== center) consider(t);
    }
    span /= 4;
  }
  return bestT;
}

export function clampLabelT(t: unknown): number {
  return typeof t === "number" && Number.isFinite(t)
    ? Math.min(1, Math.max(0, t))
    : 0.5;
}

// --- Edge -------------------------------------------------------------------

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

  const d = data as EdgeData | undefined;
  const splice = !!d?.spliceHighlight;
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
  const label = typeof d?.label === "string" ? d.label : undefined;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={effectiveStyle}
      />
      {label !== undefined && (
        <EdgeLabelRenderer>
          <WireLabel
            edgeId={id}
            label={label}
            t={clampLabelT(d?.labelT)}
            selected={!!selected}
            wire={wireCubic(
              sourceX,
              sourceY,
              targetX,
              targetY,
              sourcePosition,
              targetPosition
            )}
          />
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// --- Label bubble -----------------------------------------------------------

const DRAG_THRESHOLD_PX = 3;

function WireLabel({
  edgeId,
  label,
  t,
  selected,
  wire,
}: {
  edgeId: string;
  label: string;
  t: number;
  selected: boolean;
  wire: WireCubic;
}) {
  const api = useWireLabelApi();
  const { screenToFlowPosition } = useReactFlow();
  const inputRef = useRef<HTMLInputElement>(null);
  // Live drag position — overrides the committed `t` until pointer-up.
  const [dragT, setDragT] = useState<number | null>(null);
  // Text edit: `draft` is only meaningful while editing; the committed
  // label renders otherwise, so an undo underneath never fights local state.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const cancelRef = useRef(false);
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    t: number;
  } | null>(null);

  // "Label Wire" / "Edit Label" from the context menu — take focus once.
  // Focusing the (read-only) input runs onFocus, which flips into editing.
  const focusRequested = api?.focusEdgeId === edgeId;
  useEffect(() => {
    if (!focusRequested || !api) return;
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
    api.consumeFocus(edgeId);
  }, [focusRequested, api, edgeId]);

  const beginEdit = () => {
    if (!editing) {
      setDraft(label);
      setEditing(true);
    }
  };

  const commit = () => {
    const cancelled = cancelRef.current;
    cancelRef.current = false;
    if (!editing) return;
    setEditing(false);
    if (cancelled || !api) return;
    const next = draft.trim();
    if (next === "") api.setLabel(edgeId, { label: null });
    else if (next !== label) api.setLabel(edgeId, { label: next });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || editing) return;
    // Own the gesture: no text selection / focus yet, and React Flow's
    // pane must not see this as a pan or marquee start.
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    gestureRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      t,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    if (!g.moved) {
      if (
        Math.hypot(e.clientX - g.startX, e.clientY - g.startY) <
        DRAG_THRESHOLD_PX
      )
        return;
      g.moved = true;
    }
    e.preventDefault();
    e.stopPropagation();
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    g.t = nearestWireT(wire, [pos.x, pos.y]);
    setDragT(g.t);
  };

  const endGesture = (e: React.PointerEvent<HTMLDivElement>, commitDrag: boolean) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gestureRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    e.stopPropagation();
    setDragT(null);
    if (g.moved) {
      if (commitDrag && api && g.t !== t) api.setLabel(edgeId, { labelT: g.t });
      return;
    }
    if (!commitDrag) return;
    // A plain click: edit the text.
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  };

  const shownT = dragT ?? t;
  const [x, y] = pointOnWire(wire, shownT);
  const text = editing ? draft : label;
  const dragging = dragT !== null;

  return (
    <div
      className="nodrag nopan nowheel"
      data-wire-label={edgeId}
      title={editing ? undefined : "Click to edit · drag to slide along the wire"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endGesture(e, true)}
      onPointerCancel={(e) => endGesture(e, false)}
      onContextMenu={(e) => {
        if (!api) return;
        e.preventDefault();
        e.stopPropagation();
        api.openMenu(edgeId, e.clientX, e.clientY);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
        pointerEvents: "all",
        // The auto-growing-input trick: a hidden mirror span and the input
        // share one grid cell, so the cell (and the bubble) is as wide as
        // the text while the input just fills it — no measuring.
        display: "inline-grid",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 999,
        background: "var(--tb-n-3)",
        border: `1px solid ${
          selected || editing ? "var(--tb-a-blue-400)" : "var(--tb-n-8)"
        }`,
        boxShadow: dragging
          ? "0 4px 14px rgba(0,0,0,0.45)"
          : "0 1px 4px rgba(0,0,0,0.35)",
        color: "var(--tb-n-16)",
        fontFamily: "var(--ui-font)",
        fontSize: 11,
        lineHeight: "14px",
        whiteSpace: "pre",
        cursor: dragging ? "grabbing" : editing ? "text" : "grab",
        userSelect: editing ? "text" : "none",
      }}
    >
      <span
        aria-hidden
        style={{
          gridArea: "1 / 1",
          visibility: "hidden",
          minWidth: 8,
          whiteSpace: "pre",
        }}
      >
        {text || " "}
      </span>
      <input
        ref={inputRef}
        className="nodrag nopan"
        value={text}
        readOnly={!editing}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={beginEdit}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            inputRef.current?.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelRef.current = true;
            inputRef.current?.blur();
          }
        }}
        style={{
          gridArea: "1 / 1",
          width: "100%",
          minWidth: 8,
          padding: 0,
          margin: 0,
          border: "none",
          outline: "none",
          background: "transparent",
          color: "inherit",
          font: "inherit",
          lineHeight: "inherit",
          textAlign: "center",
          cursor: "inherit",
          // Read-only until clicked: pointer events go to the bubble so
          // a press starts the drag gesture instead of a text selection.
          pointerEvents: editing ? "auto" : "none",
        }}
      />
    </div>
  );
}
