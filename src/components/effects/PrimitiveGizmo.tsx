"use client";

import { useEffect, useRef, useState } from "react";

// On-canvas transform handles for centered shape primitives (Circle,
// Rectangle, …). The gizmo works in a node-agnostic "center + half-extents"
// space — drag the box to move the center, drag the edges/corners to resize.
// Per-primitive param mapping lives in PRIMITIVE_GIZMO_ADAPTERS below so new
// primitives can opt in without touching the gizmo itself.
//
// Reuses the canvas↔node-space aspect helpers and the visual/handle
// conventions of TransformGizmo; primitives don't rotate, so there's no
// rotation/pivot machinery here.

export interface PrimitiveGizmoPatch {
  cx?: number;
  cy?: number;
  hx?: number;
  hy?: number;
}

export interface PrimitiveGizmoAdapter {
  // Read the shape's center + half-extents from the node's (effective) params.
  read: (get: (name: string, fallback: number) => number) => {
    cx: number;
    cy: number;
    hx: number;
    hy: number;
  };
  // Map a gizmo patch back to [paramName, value] pairs to apply.
  write: (patch: PrimitiveGizmoPatch) => Array<[string, number]>;
}

// defType → adapter. Add new spline primitives here.
export const PRIMITIVE_GIZMO_ADAPTERS: Record<string, PrimitiveGizmoAdapter> = {
  circle: {
    read: (g) => ({
      cx: g("centerX", 0.5),
      cy: g("centerY", 0.5),
      hx: g("radiusX", 0.25),
      hy: g("radiusY", 0.25),
    }),
    write: (p) => {
      const out: Array<[string, number]> = [];
      if (p.cx !== undefined) out.push(["centerX", p.cx]);
      if (p.cy !== undefined) out.push(["centerY", p.cy]);
      if (p.hx !== undefined) out.push(["radiusX", p.hx]);
      if (p.hy !== undefined) out.push(["radiusY", p.hy]);
      return out;
    },
  },
  rectangle: {
    read: (g) => ({
      cx: g("originX", 0.5),
      cy: g("originY", 0.5),
      hx: g("width", 0.5) / 2,
      hy: g("height", 0.5) / 2,
    }),
    write: (p) => {
      const out: Array<[string, number]> = [];
      if (p.cx !== undefined) out.push(["originX", p.cx]);
      if (p.cy !== undefined) out.push(["originY", p.cy]);
      if (p.hx !== undefined) out.push(["width", p.hx * 2]);
      if (p.hy !== undefined) out.push(["height", p.hy * 2]);
      return out;
    },
  },
};

interface Props {
  canvas: HTMLCanvasElement | null;
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  onChange: (patch: PrimitiveGizmoPatch) => void;
}

type DragKind =
  | "move"
  | "corner-tl"
  | "corner-tr"
  | "corner-br"
  | "corner-bl"
  | "edge-l"
  | "edge-r"
  | "edge-t"
  | "edge-b";

interface DragState {
  kind: DragKind;
  startPointer: { x: number; y: number };
  start: { cx: number; cy: number; hx: number; hy: number };
}

const HANDLE = 10;
const CENTER_R = 4;
const MIN_HALF = 0.002;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export default function PrimitiveGizmo({
  canvas,
  cx,
  cy,
  hx,
  hy,
  onChange,
}: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // Track the rendered canvas box (resize / splitter / scroll).
  useEffect(() => {
    if (!canvas) {
      setRect(null);
      return;
    }
    const update = () => setRect(canvas.getBoundingClientRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [canvas]);

  useEffect(() => {
    if (!drag || !rect) return;
    const onMove = (e: PointerEvent) => {
      // Spline primitives rasterize [0,1]² straight to canvas pixels (no
      // aspect correction), and the canvas displays at that same aspect —
      // so node UV maps linearly to the displayed box.
      const ux = (e.clientX - rect.left) / rect.width;
      const uy = (e.clientY - rect.top) / rect.height;
      const s = drag.start;
      const shift = e.shiftKey;

      if (drag.kind === "move") {
        const dx = ux - drag.startPointer.x;
        const dy = uy - drag.startPointer.y;
        onChangeRef.current({
          cx: clamp01(s.cx + dx),
          cy: clamp01(s.cy + dy),
        });
        return;
      }

      // Resize: half-extent = distance from the (fixed) center along each axis.
      const movesX =
        drag.kind === "edge-l" ||
        drag.kind === "edge-r" ||
        drag.kind.startsWith("corner");
      const movesY =
        drag.kind === "edge-t" ||
        drag.kind === "edge-b" ||
        drag.kind.startsWith("corner");
      const patch: PrimitiveGizmoPatch = {};
      let nhx = movesX ? Math.max(MIN_HALF, Math.abs(ux - s.cx)) : s.hx;
      let nhy = movesY ? Math.max(MIN_HALF, Math.abs(uy - s.cy)) : s.hy;
      if (shift && drag.kind.startsWith("corner")) {
        // Uniform — both halves share the larger magnitude.
        const m = Math.max(nhx, nhy);
        nhx = m;
        nhy = m;
      }
      if (movesX) patch.hx = nhx;
      if (movesY) patch.hy = nhy;
      onChangeRef.current(patch);
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, rect]);

  if (!rect) return null;

  const toPx = (ux: number, uy: number) => ({
    x: rect.left + ux * rect.width,
    y: rect.top + uy * rect.height,
  });

  const left = cx - hx;
  const right = cx + hx;
  const top = cy - hy;
  const bottom = cy + hy;
  const tl = toPx(left, top);
  const tr = toPx(right, top);
  const br = toPx(right, bottom);
  const bl = toPx(left, bottom);
  const center = toPx(cx, cy);
  const rightMid = toPx(right, cy);
  const leftMid = toPx(left, cy);
  const topMid = toPx(cx, top);
  const botMid = toPx(cx, bottom);

  const startDrag =
    (kind: DragKind) => (e: React.PointerEvent<SVGElement>) => {
      e.stopPropagation();
      e.preventDefault();
      setDrag({
        kind,
        startPointer: {
          x: (e.clientX - rect.left) / rect.width,
          y: (e.clientY - rect.top) / rect.height,
        },
        start: { cx, cy, hx, hy },
      });
    };

  const polygon = `${tl.x},${tl.y} ${tr.x},${tr.y} ${br.x},${br.y} ${bl.x},${bl.y}`;
  const handleProps = (kind: DragKind, p: { x: number; y: number }) => ({
    x: p.x - HANDLE / 2,
    y: p.y - HANDLE / 2,
    width: HANDLE,
    height: HANDLE,
    rx: 2,
    ry: 2,
    onPointerDown: startDrag(kind),
  });

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 2,
      }}
    >
      <svg
        width="100%"
        height="100%"
        style={{
          position: "absolute",
          inset: 0,
          overflow: "visible",
          pointerEvents: "none",
        }}
      >
        {/* Box interior → move the shape's center. */}
        <polygon
          points={polygon}
          fill="transparent"
          style={{
            cursor: drag?.kind === "move" ? "grabbing" : "grab",
            pointerEvents: "auto",
          }}
          onPointerDown={startDrag("move")}
        />
        {/* Outline */}
        <polygon
          points={polygon}
          fill="none"
          stroke="#fef2f2"
          strokeWidth="0.75"
          strokeDasharray="4 3"
          style={{ pointerEvents: "none" }}
        />

        {/* Corners — resize both axes */}
        {(
          [
            ["corner-tl", tl],
            ["corner-tr", tr],
            ["corner-br", br],
            ["corner-bl", bl],
          ] as Array<[DragKind, { x: number; y: number }]>
        ).map(([kind, p]) => (
          <rect
            key={kind}
            {...handleProps(kind, p)}
            fill="#111"
            stroke="#fef2f2"
            strokeWidth="0.75"
            style={{
              cursor:
                kind === "corner-tl" || kind === "corner-br"
                  ? "nwse-resize"
                  : "nesw-resize",
              pointerEvents: "auto",
            }}
          />
        ))}

        {/* Left / right edges → X half-extent (red = X axis) */}
        {(
          [
            ["edge-l", leftMid],
            ["edge-r", rightMid],
          ] as Array<[DragKind, { x: number; y: number }]>
        ).map(([kind, p]) => (
          <rect
            key={kind}
            {...handleProps(kind, p)}
            fill="#ef4444"
            stroke="#fef2f2"
            strokeWidth="0.75"
            style={{ cursor: "ew-resize", pointerEvents: "auto" }}
          />
        ))}

        {/* Top / bottom edges → Y half-extent (green = Y axis) */}
        {(
          [
            ["edge-t", topMid],
            ["edge-b", botMid],
          ] as Array<[DragKind, { x: number; y: number }]>
        ).map(([kind, p]) => (
          <rect
            key={kind}
            {...handleProps(kind, p)}
            fill="#22c55e"
            stroke="#fef2f2"
            strokeWidth="0.75"
            style={{ cursor: "ns-resize", pointerEvents: "auto" }}
          />
        ))}

        {/* Center dot — also moves the shape. */}
        <circle
          cx={center.x}
          cy={center.y}
          r={CENTER_R}
          fill="#ef4444"
          stroke="#fef2f2"
          strokeWidth="0.75"
          style={{ cursor: "move", pointerEvents: "auto" }}
          onPointerDown={startDrag("move")}
        />
      </svg>
    </div>
  );
}
