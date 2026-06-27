"use client";

import { useEffect, useRef, useState } from "react";
import { rectsEqual } from "./overlay-rect";

// On-canvas handles for the Gradient node. Linear mode shows two endpoint
// handles joined by a line (start → end); radial mode shows a center handle
// plus a handle on the circle for the radius; the wave "ring" sub-mode shows
// just a center handle for the rings; multipoint shows one draggable colored
// dot per point.
//
// IMPORTANT coordinate note: the Gradient shader samples in v_uv, which is
// Y-UP (v = 0 at the bottom) — the OPPOSITE of the Y-DOWN convention the
// spline/box gizmos use. So every handle flips Y exactly once at the screen
// boundary: screenY = (1 - v) * height. Gradient param space has no aspect
// correction (uv maps linearly to the displayed canvas box), so a radial
// radius in uv reads as an ellipse on a non-square canvas — which is exactly
// what the shader produces, so we draw it that way.

export type GradientOverlayMode = "linear" | "radial" | "ring" | "multipoint";

export interface GradientOverlayPoint {
  id: string;
  x: number;
  y: number;
  color: string;
}

interface Props {
  canvas: HTMLCanvasElement | null;
  mode: GradientOverlayMode;
  // Linear endpoints (UV, Y-up).
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  // Radial center + radius (UV, Y-up; radius in UV units).
  centerX: number;
  centerY: number;
  radius: number;
  // Multipoint dots (effective positions + stored colors).
  points: GradientOverlayPoint[];
  // Param updates for the linear/radial handles (coalesced into one undo
  // entry by the caller).
  onChange: (updates: Array<[string, number]>) => void;
  // A multipoint dot moved — caller updates that point's x/y in the stored
  // points array (and autokeys when its track is animated).
  onPointChange: (id: string, x: number, y: number) => void;
}

type Drag =
  | { kind: "start" | "end" | "center" | "radius" }
  | { kind: "point"; id: string };

const HANDLE_R = 7;
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

export default function GradientOverlay({
  canvas,
  mode,
  startX,
  startY,
  endX,
  endY,
  centerX,
  centerY,
  radius,
  points,
  onChange,
  onPointChange,
}: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onPointChangeRef = useRef(onPointChange);
  onPointChangeRef.current = onPointChange;
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  // Track the rendered canvas box (resize / splitter / scroll).
  useEffect(() => {
    if (!canvas) {
      setRect(null);
      return;
    }
    // Idempotent update — avoids a ResizeObserver feedback loop (overlay-rect.ts).
    const update = () => {
      const r = canvas.getBoundingClientRect();
      setRect((prev) => (rectsEqual(prev, r) ? prev : r));
    };
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
      // Pointer → UV (Y-up). No aspect correction (gradient uv is linear in
      // the displayed box).
      const u = (e.clientX - rect.left) / rect.width;
      const v = 1 - (e.clientY - rect.top) / rect.height;
      if (drag.kind === "point") {
        onPointChangeRef.current(
          drag.id,
          clamp(u, -0.5, 1.5),
          clamp(v, -0.5, 1.5)
        );
        return;
      }
      const apply = onChangeRef.current;
      if (drag.kind === "start") {
        apply([
          ["start_x", clamp(u, -0.5, 1.5)],
          ["start_y", clamp(v, -0.5, 1.5)],
        ]);
      } else if (drag.kind === "end") {
        apply([
          ["end_x", clamp(u, -0.5, 1.5)],
          ["end_y", clamp(v, -0.5, 1.5)],
        ]);
      } else if (drag.kind === "center") {
        apply([
          ["center_x", clamp(u, 0, 1)],
          ["center_y", clamp(v, 0, 1)],
        ]);
      } else {
        // radius = UV-space distance from the center to the pointer.
        const r = Math.hypot(u - centerX, v - centerY);
        apply([["radius", clamp(r, 0.01, 2)]]);
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, rect, centerX, centerY]);

  if (!rect) return null;

  // UV (Y-up) → screen px.
  const toPx = (u: number, v: number) => ({
    x: rect.left + u * rect.width,
    y: rect.top + (1 - v) * rect.height,
  });

  const startDrag = (d: Drag) => (e: React.PointerEvent<SVGElement>) => {
    e.stopPropagation();
    e.preventDefault();
    setDrag(d);
  };

  const handle = (d: Drag, p: { x: number; y: number }, fill: string) => (
    <circle
      cx={p.x}
      cy={p.y}
      r={HANDLE_R}
      fill={fill}
      stroke="#fef2f2"
      strokeWidth="1.5"
      style={{ cursor: "grab", pointerEvents: "auto" }}
      onPointerDown={startDrag(d)}
    />
  );

  return (
    <div
      style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 2 }}
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
        {mode === "linear" && (() => {
          const a = toPx(startX, startY);
          const b = toPx(endX, endY);
          return (
            <>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#fef2f2"
                strokeWidth="1.25"
                strokeDasharray="5 3"
              />
              {handle({ kind: "start" }, a, "#111")}
              {handle({ kind: "end" }, b, "#ef4444")}
            </>
          );
        })()}

        {mode === "radial" && (() => {
          const c = toPx(centerX, centerY);
          const edge = toPx(centerX + radius, centerY);
          return (
            <>
              <ellipse
                cx={c.x}
                cy={c.y}
                rx={radius * rect.width}
                ry={radius * rect.height}
                fill="none"
                stroke="#fef2f2"
                strokeWidth="1.25"
                strokeDasharray="5 3"
              />
              {handle({ kind: "center" }, c, "#ef4444")}
              {handle({ kind: "radius" }, edge, "#111")}
            </>
          );
        })()}

        {mode === "ring" && handle({ kind: "center" }, toPx(centerX, centerY), "#ef4444")}

        {mode === "multipoint" &&
          points.map((pt) => {
            const p = toPx(pt.x, pt.y);
            return (
              <circle
                key={pt.id}
                cx={p.x}
                cy={p.y}
                r={HANDLE_R}
                fill={typeof pt.color === "string" ? pt.color : "#ffffff"}
                stroke="#fef2f2"
                strokeWidth="1.5"
                style={{ cursor: "grab", pointerEvents: "auto" }}
                onPointerDown={startDrag({ kind: "point", id: pt.id })}
              />
            );
          })}
      </svg>
    </div>
  );
}
