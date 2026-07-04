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

// Extra context handed to adapters whose param space isn't plain
// normalized UV — canvas dims for unit conversions, raw param access for
// enum branches (Auto Layout's hug/fixed axis modes), and the solved
// container size so hug axes display their actual bounds.
export interface PrimitiveGizmoEnv {
  canvasWidth: number;
  canvasHeight: number;
  getRaw: (name: string) => unknown;
  solvedSize?: { width: number; height: number } | null;
}

// Describes which two scalar params drive the primitive's on-canvas position
// and how those param values map to the shape's normalized canvas center. Lets
// MotionPathOverlay draw/edit the position trajectory without baking each
// node's coordinate convention into the overlay. `toCenter`/`fromCenter`
// default to identity (center === param values, e.g. Circle's centerX/Y).
export interface PrimitiveMotionPath {
  x: string;
  y: string;
  toCenter?: (xVal: number, yVal: number) => { cx: number; cy: number };
  fromCenter?: (cx: number, cy: number) => { xVal: number; yVal: number };
}

export interface PrimitiveGizmoAdapter {
  // Resize drags anchor the opposite edge/corner (box-style, the center
  // moves) instead of growing symmetrically around a fixed center.
  anchorResize?: boolean;
  // Read the shape's center + half-extents from the node's (effective) params.
  read: (
    get: (name: string, fallback: number) => number,
    env: PrimitiveGizmoEnv
  ) => {
    cx: number;
    cy: number;
    hx: number;
    hy: number;
  };
  // Map a gizmo patch back to [paramName, value] pairs to apply.
  write: (
    patch: PrimitiveGizmoPatch,
    env: PrimitiveGizmoEnv
  ) => Array<[string, number | string]>;
  // Position params for the on-canvas motion path (animated-position
  // trajectory). Omit for primitives whose position isn't a plain X/Y pair.
  motionPath?: PrimitiveMotionPath;
}

// defType → adapter. Add new spline primitives here.
export const PRIMITIVE_GIZMO_ADAPTERS: Record<string, PrimitiveGizmoAdapter> = {
  circle: {
    motionPath: { x: "centerX", y: "centerY" },
    read: (g) => ({
      cx: g("centerX", 0.5),
      cy: g("centerY", 0.5),
      hx: g("radiusX", 0.25),
      hy: g("radiusY", 0.25),
    }),
    write: (p) => {
      const out: Array<[string, number | string]> = [];
      if (p.cx !== undefined) out.push(["centerX", p.cx]);
      if (p.cy !== undefined) out.push(["centerY", p.cy]);
      if (p.hx !== undefined) out.push(["radiusX", p.hx]);
      if (p.hy !== undefined) out.push(["radiusY", p.hy]);
      return out;
    },
  },
  rectangle: {
    motionPath: { x: "originX", y: "originY" },
    read: (g) => ({
      cx: g("originX", 0.5),
      cy: g("originY", 0.5),
      hx: g("width", 0.5) / 2,
      hy: g("height", 0.5) / 2,
    }),
    write: (p) => {
      const out: Array<[string, number | string]> = [];
      if (p.cx !== undefined) out.push(["originX", p.cx]);
      if (p.cy !== undefined) out.push(["originY", p.cy]);
      if (p.hx !== undefined) out.push(["width", p.hx * 2]);
      if (p.hy !== undefined) out.push(["height", p.hy * 2]);
      return out;
    },
  },
  // Liquid Glass panel (Shape A): center is posX/posY (normalized, Y-down),
  // size is width/height fractions. Box-style resize like Text/Auto Layout.
  // Shape B (the liquid-merge partner) stays panel-driven for now.
  "liquid-glass": {
    anchorResize: true,
    motionPath: { x: "posX", y: "posY" },
    read: (g) => ({
      cx: g("posX", 0.5),
      cy: g("posY", 0.5),
      hx: Math.max(0.005, g("width", 0.4) / 2),
      hy: Math.max(0.005, g("height", 0.26) / 2),
    }),
    write: (p) => {
      const out: Array<[string, number | string]> = [];
      if (p.cx !== undefined) out.push(["posX", p.cx]);
      if (p.cy !== undefined) out.push(["posY", p.cy]);
      if (p.hx !== undefined) out.push(["width", p.hx * 2]);
      if (p.hy !== undefined) out.push(["height", p.hy * 2]);
      return out;
    },
  },
  // Text box: position rides translateX/Y (the raster centers the box on
  // the canvas and the node's transform post-pass places it), size is the
  // box fraction params. Scale/rotate/pivot stay panel-driven — when they
  // are non-default the gizmo box shows the unscaled layout rect.
  text: {
    anchorResize: true,
    motionPath: {
      x: "translateX",
      y: "translateY",
      toCenter: (x, y) => ({ cx: 0.5 + x, cy: 0.5 + y }),
      fromCenter: (cx, cy) => ({ xVal: cx - 0.5, yVal: cy - 0.5 }),
    },
    read: (g) => ({
      cx: 0.5 + g("translateX", 0),
      cy: 0.5 + g("translateY", 0),
      hx: Math.max(0.005, g("boxWidth", 1) / 2),
      hy: Math.max(0.005, g("boxHeight", 1) / 2),
    }),
    write: (p) => {
      const out: Array<[string, number | string]> = [];
      if (p.cx !== undefined) out.push(["translateX", p.cx - 0.5]);
      if (p.cy !== undefined) out.push(["translateY", p.cy - 0.5]);
      if (p.hx !== undefined) out.push(["boxWidth", p.hx * 2]);
      if (p.hy !== undefined) out.push(["boxHeight", p.hy * 2]);
      return out;
    },
  },
  // Auto Layout container bounds: dragging moves translateX/Y; resizing
  // an edge writes that axis's fixed size in layout units AND flips the
  // axis to "fixed" (a hug axis under direct manipulation becomes
  // explicit, Figma-style). Hug axes display the solved container size.
  autolayout: {
    anchorResize: true,
    motionPath: {
      x: "translateX",
      y: "translateY",
      toCenter: (x, y) => ({ cx: 0.5 + x, cy: 0.5 + y }),
      fromCenter: (cx, cy) => ({ xVal: cx - 0.5, yVal: cy - 0.5 }),
    },
    read: (g, env) => {
      const { canvasWidth: W, canvasHeight: H, getRaw, solvedSize } = env;
      const unitPx = Math.min(W, H) / 1000;
      const hx =
        getRaw("widthMode") !== "fixed" && solvedSize
          ? solvedSize.width / W / 2
          : (g("width", 600) * unitPx) / W / 2;
      const hy =
        getRaw("heightMode") !== "fixed" && solvedSize
          ? solvedSize.height / H / 2
          : (g("height", 600) * unitPx) / H / 2;
      return {
        cx: 0.5 + g("translateX", 0),
        cy: 0.5 + g("translateY", 0),
        hx: Math.max(0.002, hx),
        hy: Math.max(0.002, hy),
      };
    },
    write: (p, env) => {
      const { canvasWidth: W, canvasHeight: H } = env;
      const pxToUnits = (px: number) => (px * 1000) / Math.min(W, H);
      const out: Array<[string, number | string]> = [];
      if (p.cx !== undefined) out.push(["translateX", p.cx - 0.5]);
      if (p.cy !== undefined) out.push(["translateY", p.cy - 0.5]);
      if (p.hx !== undefined) {
        out.push(["width", Math.max(1, Math.round(pxToUnits(p.hx * 2 * W)))]);
        out.push(["widthMode", "fixed"]);
      }
      if (p.hy !== undefined) {
        out.push(["height", Math.max(1, Math.round(pxToUnits(p.hy * 2 * H)))]);
        out.push(["heightMode", "fixed"]);
      }
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
  // Box-style resize: the dragged edge/corner follows the pointer and the
  // opposite side stays anchored (center moves). Default is the legacy
  // symmetric resize around a fixed center.
  anchorResize?: boolean;
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
  anchorResize = false,
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

      if (anchorResize) {
        // Box-style resize: the dragged edge/corner tracks the pointer,
        // the opposite side stays anchored, so both center and extents
        // move. Shift on a corner squares the box off the anchor.
        const minSize = MIN_HALF * 2;
        let left = s.cx - s.hx;
        let right = s.cx + s.hx;
        let top = s.cy - s.hy;
        let bottom = s.cy + s.hy;
        const isCorner = drag.kind.startsWith("corner");
        const movesL =
          drag.kind === "edge-l" ||
          drag.kind === "corner-tl" ||
          drag.kind === "corner-bl";
        const movesR =
          drag.kind === "edge-r" ||
          drag.kind === "corner-tr" ||
          drag.kind === "corner-br";
        const movesT =
          drag.kind === "edge-t" ||
          drag.kind === "corner-tl" ||
          drag.kind === "corner-tr";
        const movesB =
          drag.kind === "edge-b" ||
          drag.kind === "corner-bl" ||
          drag.kind === "corner-br";
        if (movesL) left = Math.min(right - minSize, ux);
        if (movesR) right = Math.max(left + minSize, ux);
        if (movesT) top = Math.min(bottom - minSize, uy);
        if (movesB) bottom = Math.max(top + minSize, uy);
        if (shift && isCorner) {
          const m = Math.max(right - left, bottom - top);
          if (movesL) left = right - m;
          else if (movesR) right = left + m;
          if (movesT) top = bottom - m;
          else if (movesB) bottom = top + m;
        }
        const patch: PrimitiveGizmoPatch = {};
        if (movesL || movesR) {
          patch.cx = (left + right) / 2;
          patch.hx = (right - left) / 2;
        }
        if (movesT || movesB) {
          patch.cy = (top + bottom) / 2;
          patch.hy = (bottom - top) / 2;
        }
        onChangeRef.current(patch);
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
  }, [drag, rect, anchorResize]);

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
