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
  // Input socket names (without the `in:` prefix) whose being wired
  // makes the gizmo lie. The SDF primitives' `position` chain
  // transforms the SAMPLE space, so with one attached the shape no
  // longer sits at its raw x/y and the handles would float off it —
  // better no gizmo than a gizmo pointing at the wrong place.
  hideWhenWired?: string[];
  // Point-handle primitives (Line Segment's two endpoints, Triangle's
  // three corners). A centre+extent box is the wrong control for these —
  // resizing a box can't express "move one endpoint" — so when `points`
  // is present the host renders draggable dots INSTEAD of the box, and
  // `read` is not required.
  points?: {
    // Handle positions in normalized canvas space, Y-DOWN (screen
    // convention), same space the box gizmo's cx/cy live in.
    read: (
      get: (name: string, fallback: number) => number,
      env: PrimitiveGizmoEnv
    ) => Array<{ x: number; y: number; label?: string }>;
    // Map a dragged handle back to params.
    write: (
      index: number,
      x: number,
      y: number,
      env: PrimitiveGizmoEnv
    ) => Array<[string, number]>;
    // Draw connecting lines between consecutive handles; `closed` also
    // joins last→first. Purely cosmetic, but it makes a segment read as
    // a segment rather than two loose dots.
    connect?: "open" | "closed";
  };
  // Read the shape's center + half-extents from the node's (effective) params.
  // Optional only for `points` adapters, which render no box.
  read?: (
    get: (name: string, fallback: number) => number,
    env: PrimitiveGizmoEnv
  ) => {
    cx: number;
    cy: number;
    hx: number;
    hy: number;
  };
  // Map a gizmo patch back to [paramName, value] pairs to apply.
  write?: (
    patch: PrimitiveGizmoPatch,
    env: PrimitiveGizmoEnv
  ) => Array<[string, number | string]>;
  // Position params for the on-canvas motion path (animated-position
  // trajectory). Omit for primitives whose position isn't a plain X/Y pair.
  motionPath?: PrimitiveMotionPath;
}

// Smallest half-extent a gizmo will report or write.
const MIN_HALF = 0.002;

// ── SDF primitive coordinate conversion ───────────────────────────
//
// Two corrections, both load-bearing — get either wrong and the handles
// don't sit on the shape.
//
// Y FLIP. An SDF primitive's `y` param rides `v_uv` straight through
// (the compiler's main() opens with `vec2 p = v_uv`), and v = 0 is the
// framebuffer's VISUAL BOTTOM — see FULLSCREEN_VS in engine/gl.ts and
// the readPixels note beside it, corroborated by the Y-flip in
// nodes/sdf/to-spline.ts. So SDF y counts UPWARD, while this gizmo's cy
// counts DOWNWARD (`top = cy - hy`). They are opposed. Note this
// contradicts the devguide's blanket "SDF positions are Y-DOWN", which
// holds for CPU spline/point geometry but not for these params.
//
// ASPECT. With Aspect Correct on, the shader evaluates at
// p.y = (v - 0.5)/aspect + 0.5, so a shape whose SDF half-height is
// `sy` covers `sy * aspect` of the screen vertically. That factor is
// exactly what keeps an SDF circle round on a non-square canvas, so the
// gizmo box has to apply it too.
//
// Aspect Correct is a param on the TERMINAL (Rasterize / Bevel), not on
// the primitive, so we assume its default (on). On a square canvas
// aspect is 1 and the assumption costs nothing either way.
const sdfAspect = (env: PrimitiveGizmoEnv) =>
  env.canvasWidth / Math.max(1, env.canvasHeight);

const sdfYToGizmo = (y: number, a: number) => 1 - ((y - 0.5) * a + 0.5);
const gizmoYToSdf = (cy: number, a: number) => (0.5 - cy) / a + 0.5;

// Circle / Polygon / Star carry ONE radius, but the gizmo hands back
// whichever axes the drag moved (edges send one, corners send both).
// Averaging the two lets a corner drag grow the shape smoothly while an
// edge drag still reads as a plain radius edit.
function sdfRadiusFrom(
  p: PrimitiveGizmoPatch,
  a: number
): number | undefined {
  const fromX = p.hx;
  const fromY = p.hy === undefined ? undefined : p.hy / a;
  if (fromX !== undefined && fromY !== undefined) return (fromX + fromY) / 2;
  return fromX ?? fromY;
}

// Shared by the three centre+radius SDF primitives.
function sdfRadialAdapter(radiusParam = "radius"): PrimitiveGizmoAdapter {
  return {
    hideWhenWired: ["position", "center"],
    read: (g, env) => {
      const a = sdfAspect(env);
      const r = Math.max(MIN_HALF, g(radiusParam, 0.2));
      return {
        cx: g("x", 0.5),
        cy: sdfYToGizmo(g("y", 0.5), a),
        hx: r,
        hy: r * a,
      };
    },
    write: (p, env) => {
      const a = sdfAspect(env);
      const out: Array<[string, number | string]> = [];
      if (p.cx !== undefined) out.push(["x", p.cx]);
      if (p.cy !== undefined) out.push(["y", gizmoYToSdf(p.cy, a)]);
      const r = sdfRadiusFrom(p, a);
      if (r !== undefined) out.push([radiusParam, Math.max(0, r)]);
      return out;
    },
  };
}

// defType → adapter. Add new spline primitives here.
export const PRIMITIVE_GIZMO_ADAPTERS: Record<string, PrimitiveGizmoAdapter> = {
  // SDF primitives. The four with a genuine centre+extent param shape
  // get the box; Line Segment and Triangle get point handles instead
  // (see `points` on the adapter). SDF Spline and SDF from Image stay
  // out — they carry no position params at all.
  //
  // `motionPath` is deliberately omitted: its toCenter/fromCenter hooks
  // take no env, so they cannot apply the aspect factor, and a
  // trajectory that drifts on non-square canvases is worse than none.
  "sdf-circle": sdfRadialAdapter(),
  "sdf-polygon": sdfRadialAdapter(),
  "sdf-star": sdfRadialAdapter(),
  // Endpoint handles, not a box: a segment is defined by where its two
  // ends are, and no box resize can move one end independently.
  "sdf-line-segment": {
    hideWhenWired: ["position"],
    points: {
      connect: "open",
      read: (g, env) => {
        const a = sdfAspect(env);
        return [
          { x: g("ax", 0.25), y: sdfYToGizmo(g("ay", 0.5), a), label: "A" },
          { x: g("bx", 0.75), y: sdfYToGizmo(g("by", 0.5), a), label: "B" },
        ];
      },
      write: (i, x, y, env) => {
        const a = sdfAspect(env);
        const yv = gizmoYToSdf(y, a);
        return i === 0
          ? [["ax", x], ["ay", yv]]
          : [["bx", x], ["by", yv]];
      },
    },
  },
  // Same story with three corners.
  "sdf-triangle": {
    hideWhenWired: ["position"],
    points: {
      connect: "closed",
      read: (g, env) => {
        const a = sdfAspect(env);
        return [
          { x: g("ax", 0.5), y: sdfYToGizmo(g("ay", 0.25), a), label: "A" },
          { x: g("bx", 0.25), y: sdfYToGizmo(g("by", 0.75), a), label: "B" },
          { x: g("cx", 0.75), y: sdfYToGizmo(g("cy", 0.75), a), label: "C" },
        ];
      },
      write: (i, x, y, env) => {
        const a = sdfAspect(env);
        const yv = gizmoYToSdf(y, a);
        const nx = ["ax", "bx", "cx"][i];
        const ny = ["ay", "by", "cy"][i];
        return [
          [nx, x],
          [ny, yv],
        ];
      },
    },
  },
  "sdf-rectangle": {
    // width/height are FULL extents here (the node halves them into the
    // AST's sx/sy), unlike the radial trio.
    hideWhenWired: ["position", "center", "size"],
    read: (g, env) => {
      const a = sdfAspect(env);
      return {
        cx: g("x", 0.5),
        cy: sdfYToGizmo(g("y", 0.5), a),
        hx: Math.max(MIN_HALF, g("width", 0.4) / 2),
        hy: Math.max(MIN_HALF, (g("height", 0.4) / 2) * a),
      };
    },
    write: (p, env) => {
      const a = sdfAspect(env);
      const out: Array<[string, number | string]> = [];
      if (p.cx !== undefined) out.push(["x", p.cx]);
      if (p.cy !== undefined) out.push(["y", gizmoYToSdf(p.cy, a)]);
      if (p.hx !== undefined) out.push(["width", Math.max(0, p.hx * 2)]);
      if (p.hy !== undefined)
        out.push(["height", Math.max(0, (p.hy / a) * 2)]);
      return out;
    },
  },

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

// Draggable point handles for primitives defined by explicit points
// rather than a box — SDF Line Segment's two endpoints, SDF Triangle's
// three corners. Same fixed-overlay + canvas-rect mapping as
// PrimitiveGizmo; the adapter owns all coordinate conversion, so this
// component never learns anything about SDF space.
export function PrimitivePointHandles({
  canvas,
  points,
  connect,
  onChange,
}: {
  canvas: HTMLCanvasElement | null;
  points: Array<{ x: number; y: number; label?: string }>;
  connect?: "open" | "closed";
  onChange: (index: number, x: number, y: number) => void;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Latest-callback ref, assigned in an effect rather than during render
  // so the drag listeners can stay subscribed across re-renders without
  // reading a ref mid-render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    // No `setRect(null)` on an absent canvas — that would be a
    // synchronous setState in an effect body. The render guard below
    // covers it, and a stale rect is unreachable while canvas is null.
    if (!canvas) return;
    const update = () => setRect(canvas.getBoundingClientRect());
    // No synchronous seeding call either — observing fires the callback
    // once immediately, which supplies the initial rect.
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
    if (dragIndex === null || !rect) return;
    const onMove = (e: PointerEvent) => {
      // Unclamped on purpose: these points legitimately live outside
      // [0,1] (a segment can run off-canvas), unlike a box centre.
      onChangeRef.current(
        dragIndex,
        (e.clientX - rect.left) / rect.width,
        (e.clientY - rect.top) / rect.height
      );
    };
    const onUp = () => setDragIndex(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragIndex, rect]);

  if (!canvas || !rect || points.length === 0) return null;

  const px = points.map((p) => ({
    x: rect.left + p.x * rect.width,
    y: rect.top + p.y * rect.height,
    label: p.label,
  }));

  const segments: Array<[typeof px[0], typeof px[0]]> = [];
  if (connect) {
    for (let i = 0; i + 1 < px.length; i++) segments.push([px[i], px[i + 1]]);
    if (connect === "closed" && px.length > 2) {
      segments.push([px[px.length - 1], px[0]]);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 2 }}>
      <svg
        width="100%"
        height="100%"
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
      >
        {segments.map(([a, b], i) => (
          <line
            key={`seg-${i}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="#22c55e"
            strokeWidth="1"
            strokeDasharray="4 3"
            opacity={0.9}
          />
        ))}
        {px.map((p, i) => (
          <g key={`pt-${i}`}>
            <circle
              cx={p.x}
              cy={p.y}
              r={CENTER_R + 1}
              fill={dragIndex === i ? "#ef4444" : "#22c55e"}
              stroke="#fef2f2"
              strokeWidth="0.75"
              style={{ cursor: "move", pointerEvents: "auto" }}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setDragIndex(i);
              }}
            />
            {p.label && (
              <text
                x={p.x + CENTER_R + 4}
                y={p.y - CENTER_R - 2}
                fill="#fef2f2"
                fontSize="10"
                fontFamily="var(--ui-font)"
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                {p.label}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
