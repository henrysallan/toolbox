"use client";

import { useEffect, useRef, useState } from "react";

export interface TransformGizmoPatch {
  translateX?: number;
  translateY?: number;
  scaleX?: number;
  scaleY?: number;
  rotate?: number;
  pivotX?: number;
  pivotY?: number;
}

interface Props {
  canvas: HTMLCanvasElement | null;
  pivotX: number;
  pivotY: number;
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  rotate: number; // degrees
  onChange: (patch: TransformGizmoPatch) => void;
}

type DragKind =
  | "pivot"
  | "rotate"
  | "translate"
  | "corner-tl"
  | "corner-tr"
  | "corner-br"
  | "corner-bl"
  | "edge-right"
  | "edge-top";

interface DragState {
  kind: DragKind;
  startRotate?: number;
  startAngle?: number;
  // For translate: pointer position and translate values at pointerdown so
  // deltas are relative to the starting point (not the gizmo origin).
  startPointer?: { x: number; y: number };
  startTranslate?: { x: number; y: number };
}

const HANDLE = 10;
const ROTATE_R = 40;
const PIVOT_R = 4;

export default function TransformGizmo({
  canvas,
  pivotX,
  pivotY,
  translateX,
  translateY,
  scaleX,
  scaleY,
  rotate,
  onChange,
}: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [rect, setRect] = useState<DOMRect | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // Sync to the rendered canvas box — covers window resize, splitter drags
  // (ResizeObserver), and scroll.
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

  // --- forward transform (source → screen-normalized) ---
  const angleRad = (rotate * Math.PI) / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  const fwd = (sx: number, sy: number) => {
    const dx = (sx - pivotX) * scaleX;
    const dy = (sy - pivotY) * scaleY;
    const rx = cos * dx - sin * dy;
    const ry = sin * dx + cos * dy;
    return { x: translateX + pivotX + rx, y: translateY + pivotY + ry };
  };

  // Inverse-rotate a screen-space offset back into box-local axes (for
  // converting pointer positions under a rotated gizmo into scaleX / scaleY).
  const unrotate = (ux: number, uy: number) => ({
    x: cos * ux + sin * uy,
    y: -sin * ux + cos * uy,
  });

  useEffect(() => {
    if (!drag || !rect) return;
    const onMove = (e: PointerEvent) => {
      const px = (e.clientX - rect.left) / rect.width;
      const py = (e.clientY - rect.top) / rect.height;

      switch (drag.kind) {
        case "translate": {
          const sp = drag.startPointer;
          const st = drag.startTranslate;
          if (!sp || !st) break;
          onChangeRef.current({
            translateX: st.x + (px - sp.x),
            translateY: st.y + (py - sp.y),
          });
          break;
        }
        case "pivot": {
          // Pivot is stored in source coords. The pivot marker is drawn at
          // translate + pivot in screen, so dragging it just subtracts the
          // current translate to recover the pivot.
          onChangeRef.current({
            pivotX: clamp01(px - translateX),
            pivotY: clamp01(py - translateY),
          });
          break;
        }
        case "rotate": {
          const cx = (translateX + pivotX) * rect.width;
          const cy = (translateY + pivotY) * rect.height;
          const ptrAngle = Math.atan2(
            e.clientY - rect.top - cy,
            e.clientX - rect.left - cx
          );
          const startA = drag.startAngle ?? 0;
          const startR = drag.startRotate ?? 0;
          const delta = ((ptrAngle - startA) * 180) / Math.PI;
          onChangeRef.current({ rotate: startR + delta });
          break;
        }
        case "edge-right": {
          const ux = px - translateX - pivotX;
          const uy = py - translateY - pivotY;
          const local = unrotate(ux, uy);
          const ex = 1 - pivotX;
          if (Math.abs(ex) > 0.0001) {
            onChangeRef.current({ scaleX: local.x / ex });
          }
          break;
        }
        case "edge-top": {
          const ux = px - translateX - pivotX;
          const uy = py - translateY - pivotY;
          const local = unrotate(ux, uy);
          const ey = 0 - pivotY;
          if (Math.abs(ey) > 0.0001) {
            onChangeRef.current({ scaleY: local.y / ey });
          }
          break;
        }
        case "corner-tl":
        case "corner-tr":
        case "corner-br":
        case "corner-bl": {
          const cx =
            drag.kind === "corner-tr" || drag.kind === "corner-br" ? 1 : 0;
          const cy =
            drag.kind === "corner-bl" || drag.kind === "corner-br" ? 1 : 0;
          const ux = px - translateX - pivotX;
          const uy = py - translateY - pivotY;
          const local = unrotate(ux, uy);
          const ex = cx - pivotX;
          const ey = cy - pivotY;
          const patch: TransformGizmoPatch = {};
          if (Math.abs(ex) > 0.0001) patch.scaleX = local.x / ex;
          if (Math.abs(ey) > 0.0001) patch.scaleY = local.y / ey;
          if (Object.keys(patch).length) onChangeRef.current(patch);
          break;
        }
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [
    drag,
    rect,
    translateX,
    translateY,
    pivotX,
    pivotY,
    scaleX,
    scaleY,
    angleRad,
  ]);

  if (!rect) return null;

  const toPx = (n: { x: number; y: number }) => ({
    x: rect.left + n.x * rect.width,
    y: rect.top + n.y * rect.height,
  });

  const tl = toPx(fwd(0, 0));
  const tr = toPx(fwd(1, 0));
  const br = toPx(fwd(1, 1));
  const bl = toPx(fwd(0, 1));
  const rightMid = toPx(fwd(1, 0.5));
  const topMid = toPx(fwd(0.5, 0));
  const pivotPx = toPx({ x: translateX + pivotX, y: translateY + pivotY });

  const startDrag = (kind: DragKind) => (e: React.PointerEvent<SVGElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (kind === "rotate") {
      const cx = (translateX + pivotX) * rect.width;
      const cy = (translateY + pivotY) * rect.height;
      const startAngle = Math.atan2(
        e.clientY - rect.top - cy,
        e.clientX - rect.left - cx
      );
      setDrag({ kind, startRotate: rotate, startAngle });
    } else if (kind === "translate") {
      setDrag({
        kind,
        startPointer: {
          x: (e.clientX - rect.left) / rect.width,
          y: (e.clientY - rect.top) / rect.height,
        },
        startTranslate: { x: translateX, y: translateY },
      });
    } else {
      setDrag({ kind });
    }
  };

  const cornerCursor = (kind: DragKind) =>
    kind === "corner-tl" || kind === "corner-br"
      ? "nwse-resize"
      : "nesw-resize";

  const polygonPoints = `${tl.x},${tl.y} ${tr.x},${tr.y} ${br.x},${br.y} ${bl.x},${bl.y}`;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 50,
      }}
    >
      <svg
        width="100%"
        height="100%"
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
      >
        {/* Canvas-wide translate drag area. Drawn first so every handle
            (corners, edges, rotation ring, pivot dot) paints on top and
            wins pointer events — dragging empty canvas translates. */}
        <rect
          x={rect.left}
          y={rect.top}
          width={rect.width}
          height={rect.height}
          fill="transparent"
          style={{
            cursor: drag?.kind === "translate" ? "grabbing" : "grab",
            pointerEvents: "auto",
          }}
          onPointerDown={startDrag("translate")}
        />

        {/* Dotted bounding box outline */}
        <polygon
          points={polygonPoints}
          fill="none"
          stroke="#fef2f2"
          strokeWidth="1.2"
          strokeDasharray="4 3"
          style={{ pointerEvents: "none" }}
        />

        {/* Four corners — non-uniform scale when dragged */}
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
            x={p.x - HANDLE / 2}
            y={p.y - HANDLE / 2}
            width={HANDLE}
            height={HANDLE}
            fill="#111"
            stroke="#fef2f2"
            strokeWidth="1.2"
            style={{
              cursor: cornerCursor(kind),
              pointerEvents: "auto",
            }}
            onPointerDown={startDrag(kind)}
          />
        ))}

        {/* Right-edge midpoint → scale X (red, conventional X axis color) */}
        <rect
          x={rightMid.x - HANDLE / 2}
          y={rightMid.y - HANDLE / 2}
          width={HANDLE}
          height={HANDLE}
          fill="#ef4444"
          stroke="#fef2f2"
          strokeWidth="1"
          style={{ cursor: "ew-resize", pointerEvents: "auto" }}
          onPointerDown={startDrag("edge-right")}
        />

        {/* Top-edge midpoint → scale Y (green, conventional Y axis color) */}
        <rect
          x={topMid.x - HANDLE / 2}
          y={topMid.y - HANDLE / 2}
          width={HANDLE}
          height={HANDLE}
          fill="#22c55e"
          stroke="#fef2f2"
          strokeWidth="1"
          style={{ cursor: "ns-resize", pointerEvents: "auto" }}
          onPointerDown={startDrag("edge-top")}
        />

        {/* Rotation ring around the pivot. Clicks between the outer ring and
            the inner pivot dot rotate; the dot itself moves the pivot. */}
        <circle
          cx={pivotPx.x}
          cy={pivotPx.y}
          r={ROTATE_R}
          fill="none"
          stroke="#fef2f2"
          strokeWidth="1.5"
          style={{ cursor: "grab", pointerEvents: "auto" }}
          onPointerDown={startDrag("rotate")}
        />
        <circle
          cx={pivotPx.x}
          cy={pivotPx.y}
          r={PIVOT_R}
          fill="#ef4444"
          stroke="#fef2f2"
          strokeWidth="1"
          style={{ cursor: "move", pointerEvents: "auto" }}
          onPointerDown={startDrag("pivot")}
        />
      </svg>
    </div>
  );
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
