"use client";

import { useEffect, useRef, useState } from "react";
import { aspectCorrectY, aspectUncorrectY } from "@/engine/aspect";

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
  // Optional source-space bounding box. Defaults to the unit canvas
  // (0,0)-(1,1). Spline mode passes the spline's tight AABB so the
  // gizmo handles hug the actual geometry rather than the whole
  // canvas. Image / point modes leave it unset (or pass (0,0)-(1,1))
  // since the relevant "shape" is the canvas itself.
  boundsMin?: [number, number];
  boundsMax?: [number, number];
  // Restrict the translate drag surface to the gizmo's bounds polygon
  // instead of the whole canvas. Multi-select renders several gizmos at
  // once — stacked canvas-wide rects would all feed the topmost gizmo,
  // so each box only grabs drags that start inside it.
  boxTranslate?: boolean;
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

type CornerKey = "tl" | "tr" | "br" | "bl";

interface DragState {
  kind: DragKind;
  startRotate?: number;
  startAngle?: number;
  // For translate: pointer position and translate values at pointerdown so
  // deltas are relative to the starting point (not the gizmo origin).
  startPointer?: { x: number; y: number };
  startTranslate?: { x: number; y: number };
  // Scale snapshots at drag start — used by shift/alt modifier paths
  // so axis-locks freeze the unmodified axis at its starting value
  // instead of letting it drift with normal scale math.
  startScale?: { x: number; y: number };
  // Which corner's rotation grip initiated this drag (rotate kind only).
  // Kept so the grip stays rendered while the user drags the pointer
  // away from the corner.
  rotateFromCorner?: CornerKey;
}

const HANDLE = 10;
const PIVOT_R = 4;
// Pixel radius around a corner handle within which the rotation grip
// becomes visible. Generous enough that hovering the corner-resize
// area itself reliably triggers the grip without making the grip pop
// in too far away.
const ROTATE_HOVER_RADIUS = 32;
// Pixel offset of the rotation grip outward from the corner along
// the box's screen diagonal. Far enough that the grip doesn't
// overlap the corner-resize handle visually.
const ROTATE_GRIP_OFFSET = 18;

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
  boundsMin,
  boundsMax,
  boxTranslate = false,
}: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [rect, setRect] = useState<DOMRect | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Modifier-driven axis lock for the active drag. Lives in a ref
  // (not state) because the move handler reads it every pointermove
  // and we don't want a re-render per frame. Sticky once decided —
  // releasing the modifier resets it; re-pressing re-decides.
  const lockedAxisRef = useRef<"x" | "y" | null>(null);
  // Which corner (if any) the pointer is currently near. Drives the
  // rotation grip's visibility — only the hovered corner shows its
  // grip. While actively rotating, the grip on the originating
  // corner stays rendered via drag.rotateFromCorner regardless of
  // current pointer position.
  const [hoveredCorner, setHoveredCorner] = useState<CornerKey | null>(null);
  // Active snap state for the current translate drag. Each axis can
  // independently snap to the canvas's left edge (0), center (0.5),
  // or right edge (1) — likewise top / center / bottom on Y.
  // `lineUv` is the canvas-UV coordinate where the red snap line
  // should be drawn for that axis. Cleared on pointerup.
  const [snap, setSnap] = useState<{
    x: { kind: "left" | "center" | "right"; lineUv: number } | null;
    y: { kind: "top" | "center" | "bottom"; lineUv: number } | null;
  }>({ x: null, y: null });

  // Default bounds = full canvas. Spline mode overrides via props.
  const bMinX = boundsMin?.[0] ?? 0;
  const bMinY = boundsMin?.[1] ?? 0;
  const bMaxX = boundsMax?.[0] ?? 1;
  const bMaxY = boundsMax?.[1] ?? 1;

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
    const aspect = rect.width / rect.height;
    const onMove = (e: PointerEvent) => {
      // Node space is normalized [0,1]²; the canvas aspect-corrects y, so undo
      // that here to recover true node-space y from the screen position.
      const px = (e.clientX - rect.left) / rect.width;
      const py = aspectUncorrectY((e.clientY - rect.top) / rect.height, aspect);
      const shift = e.shiftKey;
      const alt = e.altKey;
      // Reset axis lock when neither modifier is held — re-pressing
      // restarts the decision based on current pointer delta.
      if (!shift && !alt) lockedAxisRef.current = null;

      switch (drag.kind) {
        case "translate": {
          const sp = drag.startPointer;
          const st = drag.startTranslate;
          if (!sp || !st) break;
          let dx = px - sp.x;
          let dy = py - sp.y;
          if (shift) {
            // Axis-lock to the dominant direction since drag start.
            // Decision sticks once committed (until the user releases
            // shift) so the locked axis doesn't flicker if the pointer
            // overshoots the perpendicular by a hair.
            if (!lockedAxisRef.current) {
              if (Math.abs(dx) > Math.abs(dy)) lockedAxisRef.current = "x";
              else if (Math.abs(dy) > 1e-4) lockedAxisRef.current = "y";
            }
            if (lockedAxisRef.current === "x") dy = 0;
            else if (lockedAxisRef.current === "y") dx = 0;
          }
          let nextTx = st.x + dx;
          let nextTy = st.y + dy;

          // Snap targets per axis: canvas left/center/right edges
          // (X = 0 / 0.5 / 1) and top/center/bottom (Y same). Each
          // axis picks the closest target within SNAP_THRESHOLD;
          // farther = no snap. Rendered as a red snap line at the
          // target UV. Cmd / ctrl disables snapping for the drag.
          let nextSnapX:
            | { kind: "left" | "center" | "right"; lineUv: number }
            | null = null;
          let nextSnapY:
            | { kind: "top" | "center" | "bottom"; lineUv: number }
            | null = null;
          if (!e.metaKey && !e.ctrlKey) {
            const SNAP_THRESHOLD = 0.015;

            // AABB of the four box corners in canvas-UV after the
            // proposed translate. `cos` / `sin` / `scaleX` / `scaleY`
            // / `pivotX` / `pivotY` are captured from the closure.
            const cornerCanvasUv = (tx: number, ty: number) => {
              const corners: Array<[number, number]> = [
                [bMinX, bMinY],
                [bMaxX, bMinY],
                [bMaxX, bMaxY],
                [bMinX, bMaxY],
              ];
              let mnX = Infinity;
              let mxX = -Infinity;
              let mnY = Infinity;
              let mxY = -Infinity;
              for (const [sx, sy] of corners) {
                const ox = (sx - pivotX) * scaleX;
                const oy = (sy - pivotY) * scaleY;
                const rx2 = cos * ox - sin * oy;
                const ry2 = sin * ox + cos * oy;
                const x = tx + pivotX + rx2;
                const y = ty + pivotY + ry2;
                if (x < mnX) mnX = x;
                if (x > mxX) mxX = x;
                if (y < mnY) mnY = y;
                if (y > mxY) mxY = y;
              }
              return { mnX, mxX, mnY, mxY };
            };

            const b = cornerCanvasUv(nextTx, nextTy);
            const midX = (b.mnX + b.mxX) / 2;
            const midY = (b.mnY + b.mxY) / 2;

            // Pick the smallest-delta snap candidate per axis so a
            // mid-sized gizmo near (0.5, 0.5) doesn't try to snap
            // its center AND its right edge at once.
            type CandX = {
              kind: "left" | "center" | "right";
              delta: number;
              lineUv: number;
            };
            type CandY = {
              kind: "top" | "center" | "bottom";
              delta: number;
              lineUv: number;
            };
            const candidatesX: CandX[] = [
              { kind: "left", delta: 0 - b.mnX, lineUv: 0 },
              { kind: "center", delta: 0.5 - midX, lineUv: 0.5 },
              { kind: "right", delta: 1 - b.mxX, lineUv: 1 },
            ];
            const candidatesY: CandY[] = [
              { kind: "top", delta: 0 - b.mnY, lineUv: 0 },
              { kind: "center", delta: 0.5 - midY, lineUv: 0.5 },
              { kind: "bottom", delta: 1 - b.mxY, lineUv: 1 },
            ];
            let bestX: CandX | null = null;
            for (const c of candidatesX) {
              if (
                Math.abs(c.delta) < SNAP_THRESHOLD &&
                (!bestX || Math.abs(c.delta) < Math.abs(bestX.delta))
              ) {
                bestX = c;
              }
            }
            let bestY: CandY | null = null;
            for (const c of candidatesY) {
              if (
                Math.abs(c.delta) < SNAP_THRESHOLD &&
                (!bestY || Math.abs(c.delta) < Math.abs(bestY.delta))
              ) {
                bestY = c;
              }
            }
            if (bestX) {
              nextTx += bestX.delta;
              nextSnapX = { kind: bestX.kind, lineUv: bestX.lineUv };
            }
            if (bestY) {
              nextTy += bestY.delta;
              nextSnapY = { kind: bestY.kind, lineUv: bestY.lineUv };
            }
          }
          setSnap((prev) => {
            const xSame =
              (prev.x === null && nextSnapX === null) ||
              (prev.x !== null &&
                nextSnapX !== null &&
                prev.x.kind === nextSnapX.kind &&
                prev.x.lineUv === nextSnapX.lineUv);
            const ySame =
              (prev.y === null && nextSnapY === null) ||
              (prev.y !== null &&
                nextSnapY !== null &&
                prev.y.kind === nextSnapY.kind &&
                prev.y.lineUv === nextSnapY.lineUv);
            if (xSame && ySame) return prev;
            return { x: nextSnapX, y: nextSnapY };
          });

          onChangeRef.current({
            translateX: nextTx,
            translateY: nextTy,
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
          // Measure the angle in node space (the space the transform rotates
          // in), so it stays consistent with the rendered result.
          const ptrAngle = Math.atan2(
            py - (translateY + pivotY),
            px - (translateX + pivotX)
          );
          const startA = drag.startAngle ?? 0;
          const startR = drag.startRotate ?? 0;
          let delta = ((ptrAngle - startA) * 180) / Math.PI;
          if (shift) {
            // Snap to 15° increments — standard convention.
            delta = Math.round(delta / 15) * 15;
          }
          onChangeRef.current({ rotate: startR + delta });
          break;
        }
        case "edge-right": {
          const ux = px - translateX - pivotX;
          const uy = py - translateY - pivotY;
          const local = unrotate(ux, uy);
          // Edge handle at the right edge of the bounds. ex = its
          // source-space distance from the pivot along the X axis.
          const ex = bMaxX - pivotX;
          if (Math.abs(ex) > 0.0001) {
            const proposedX = local.x / ex;
            const patch: TransformGizmoPatch = { scaleX: proposedX };
            if (shift) {
              // Uniform: lock Y to match X so the box scales as a
              // single unit even when only the X-edge is dragged.
              patch.scaleY = proposedX;
            }
            onChangeRef.current(patch);
          }
          break;
        }
        case "edge-top": {
          const ux = px - translateX - pivotX;
          const uy = py - translateY - pivotY;
          const local = unrotate(ux, uy);
          const ey = bMinY - pivotY;
          if (Math.abs(ey) > 0.0001) {
            const proposedY = local.y / ey;
            const patch: TransformGizmoPatch = { scaleY: proposedY };
            if (shift) patch.scaleX = proposedY;
            onChangeRef.current(patch);
          }
          break;
        }
        case "corner-tl":
        case "corner-tr":
        case "corner-br":
        case "corner-bl": {
          const cornerX =
            drag.kind === "corner-tr" || drag.kind === "corner-br"
              ? bMaxX
              : bMinX;
          const cornerY =
            drag.kind === "corner-bl" || drag.kind === "corner-br"
              ? bMaxY
              : bMinY;
          const ux = px - translateX - pivotX;
          const uy = py - translateY - pivotY;
          const local = unrotate(ux, uy);
          const ex = cornerX - pivotX;
          const ey = cornerY - pivotY;
          const proposedX =
            Math.abs(ex) > 0.0001 ? local.x / ex : drag.startScale?.x ?? scaleX;
          const proposedY =
            Math.abs(ey) > 0.0001 ? local.y / ey : drag.startScale?.y ?? scaleY;
          const patch: TransformGizmoPatch = {};
          if (shift) {
            // Uniform proportional scale: both axes share magnitude
            // (the larger of the two proposed). Sign comes from each
            // proposed axis individually so flipping past the pivot
            // still works the same way.
            const m = Math.max(Math.abs(proposedX), Math.abs(proposedY));
            patch.scaleX = m * Math.sign(proposedX || 1);
            patch.scaleY = m * Math.sign(proposedY || 1);
          } else if (alt) {
            // Single-axis constraint. Decide which axis on the first
            // significant move (whichever proposed scale has drifted
            // furthest from its starting value); lock for the rest of
            // the drag.
            if (!lockedAxisRef.current) {
              const startX = drag.startScale?.x ?? 1;
              const startY = drag.startScale?.y ?? 1;
              const dxFromStart = Math.abs(proposedX - startX);
              const dyFromStart = Math.abs(proposedY - startY);
              if (dxFromStart > dyFromStart && dxFromStart > 1e-4) {
                lockedAxisRef.current = "x";
              } else if (dyFromStart > 1e-4) {
                lockedAxisRef.current = "y";
              }
            }
            if (lockedAxisRef.current === "x") {
              patch.scaleX = proposedX;
            } else if (lockedAxisRef.current === "y") {
              patch.scaleY = proposedY;
            } else {
              // Pre-decision: still write both for visual continuity.
              patch.scaleX = proposedX;
              patch.scaleY = proposedY;
            }
          } else {
            patch.scaleX = proposedX;
            patch.scaleY = proposedY;
          }
          if (Object.keys(patch).length) onChangeRef.current(patch);
          break;
        }
      }
    };
    const onUp = () => {
      setDrag(null);
      lockedAxisRef.current = null;
      setSnap((prev) => (prev.x || prev.y ? { x: null, y: null } : prev));
    };
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
    bMinX,
    bMinY,
    bMaxX,
    bMaxY,
  ]);

  // Hover proximity to corners — drives rotation-grip visibility.
  // Window-level so the grip appears even when the user approaches
  // from outside the gizmo's interactive surfaces (the corner
  // handles themselves are tiny — most of the "near corner" hover
  // zone is empty space the SVG doesn't otherwise own).
  //
  // Suppressed during a non-rotate drag so the user isn't distracted
  // by grips appearing while they're scaling. During a rotate drag
  // the active grip stays rendered via drag.rotateFromCorner — the
  // hovered-state lookup is skipped.
  useEffect(() => {
    if (!rect) return;
    if (drag && drag.kind !== "rotate") {
      // Active non-rotate drag — hide all grips for the duration.
      if (hoveredCorner !== null) setHoveredCorner(null);
      return;
    }
    const onMove = (e: PointerEvent) => {
      // Recompute corner screen positions inline using the current
      // closure's transform values.
      const fwdLocal = (sx: number, sy: number) => {
        const dx = (sx - pivotX) * scaleX;
        const dy = (sy - pivotY) * scaleY;
        const c = Math.cos(angleRad);
        const s = Math.sin(angleRad);
        return {
          x: translateX + pivotX + (c * dx - s * dy),
          y: translateY + pivotY + (s * dx + c * dy),
        };
      };
      const toScreen = (n: { x: number; y: number }) => ({
        x: rect.left + n.x * rect.width,
        y: rect.top + aspectCorrectY(n.y, rect.width / rect.height) * rect.height,
      });
      const corners: Record<CornerKey, { x: number; y: number }> = {
        tl: toScreen(fwdLocal(bMinX, bMinY)),
        tr: toScreen(fwdLocal(bMaxX, bMinY)),
        br: toScreen(fwdLocal(bMaxX, bMaxY)),
        bl: toScreen(fwdLocal(bMinX, bMaxY)),
      };
      let nearest: CornerKey | null = null;
      let nearestDist = ROTATE_HOVER_RADIUS;
      for (const key of Object.keys(corners) as CornerKey[]) {
        const c = corners[key];
        const d = Math.hypot(e.clientX - c.x, e.clientY - c.y);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = key;
        }
      }
      // setState only on actual change — avoids re-render storms when
      // pointer drifts far from any corner (nearest stays null).
      setHoveredCorner((prev) => (prev === nearest ? prev : nearest));
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [
    rect,
    drag,
    hoveredCorner,
    translateX,
    translateY,
    pivotX,
    pivotY,
    scaleX,
    scaleY,
    angleRad,
    bMinX,
    bMinY,
    bMaxX,
    bMaxY,
  ]);

  if (!rect) return null;

  const toPx = (n: { x: number; y: number }) => ({
    x: rect.left + n.x * rect.width,
    y: rect.top + aspectCorrectY(n.y, rect.width / rect.height) * rect.height,
  });

  const tl = toPx(fwd(bMinX, bMinY));
  const tr = toPx(fwd(bMaxX, bMinY));
  const br = toPx(fwd(bMaxX, bMaxY));
  const bl = toPx(fwd(bMinX, bMaxY));
  const rightMid = toPx(fwd(bMaxX, (bMinY + bMaxY) / 2));
  const topMid = toPx(fwd((bMinX + bMaxX) / 2, bMinY));
  const pivotPx = toPx({ x: translateX + pivotX, y: translateY + pivotY });

  const startDrag =
    (kind: DragKind, fromCorner?: CornerKey) =>
    (e: React.PointerEvent<SVGElement>) => {
      e.stopPropagation();
      e.preventDefault();
      // Reset modifier-driven axis lock at every drag start so the
      // previous drag's decision doesn't persist into a new gesture.
      lockedAxisRef.current = null;
      const startScale = { x: scaleX, y: scaleY };
      const aspect = rect.width / rect.height;
      if (kind === "rotate") {
        // Node-space angle (matches the rotate handler in onMove).
        const startPx = (e.clientX - rect.left) / rect.width;
        const startPy = aspectUncorrectY(
          (e.clientY - rect.top) / rect.height,
          aspect
        );
        const startAngle = Math.atan2(
          startPy - (translateY + pivotY),
          startPx - (translateX + pivotX)
        );
        setDrag({
          kind,
          startRotate: rotate,
          startAngle,
          startScale,
          rotateFromCorner: fromCorner,
        });
      } else if (kind === "translate") {
        setDrag({
          kind,
          startPointer: {
            x: (e.clientX - rect.left) / rect.width,
            y: aspectUncorrectY((e.clientY - rect.top) / rect.height, aspect),
          },
          startTranslate: { x: translateX, y: translateY },
          startScale,
        });
      } else {
        setDrag({ kind, startScale });
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
        // Sits above the canvas (zIndex: 1) but below the Track Editor
        // dock (zIndex: 5), banners, modals, and other UI chrome.
        zIndex: 2,
      }}
    >
      <svg
        width="100%"
        height="100%"
        // Force the SVG root transparent to events. Individual handles and
        // the translate rect re-enable pointer-events explicitly. Without
        // this the SVG's default `visiblePainted` behavior can swallow
        // clicks anywhere one of its children is painted — including over
        // the node editor when the gizmo's handles land near that edge.
        style={{
          position: "absolute",
          inset: 0,
          overflow: "visible",
          pointerEvents: "none",
        }}
      >
        {/* Translate drag area — canvas-wide for a lone gizmo (dragging
            empty canvas translates), the bounds polygon in multi-select
            (boxTranslate). Drawn first so every handle (corners, edges,
            rotation grips, pivot dot) paints on top and wins pointer
            events. */}
        {boxTranslate ? (
          <polygon
            points={polygonPoints}
            fill="transparent"
            style={{
              cursor: drag?.kind === "translate" ? "grabbing" : "grab",
              pointerEvents: "auto",
            }}
            onPointerDown={startDrag("translate")}
          />
        ) : (
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
        )}

        {/* Dotted bounding box outline */}
        <polygon
          points={polygonPoints}
          fill="none"
          stroke="#fef2f2"
          strokeWidth="0.75"
          strokeDasharray="4 3"
          style={{ pointerEvents: "none" }}
        />

        {/* Snap guides. Each axis can be snapped to one of three
            canvas-UV targets (left/center/right or top/center/
            bottom); the line is drawn at the active target's UV.
            Painted before the handles so they don't sit on top of
            the pivot dot or corner squares. */}
        {snap.x && (
          <line
            x1={rect.left + snap.x.lineUv * rect.width}
            y1={rect.top}
            x2={rect.left + snap.x.lineUv * rect.width}
            y2={rect.top + rect.height}
            stroke="#ef4444"
            strokeWidth={0.75}
            style={{ pointerEvents: "none" }}
          />
        )}
        {snap.y && (
          <line
            x1={rect.left}
            y1={rect.top + aspectCorrectY(snap.y.lineUv, rect.width / rect.height) * rect.height}
            x2={rect.left + rect.width}
            y2={rect.top + aspectCorrectY(snap.y.lineUv, rect.width / rect.height) * rect.height}
            stroke="#ef4444"
            strokeWidth={0.75}
            style={{ pointerEvents: "none" }}
          />
        )}

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
            rx={2}
            ry={2}
            fill="#111"
            stroke="#fef2f2"
            strokeWidth="0.75"
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
          rx={2}
          ry={2}
          fill="#ef4444"
          stroke="#fef2f2"
          strokeWidth="0.75"
          style={{ cursor: "ew-resize", pointerEvents: "auto" }}
          onPointerDown={startDrag("edge-right")}
        />

        {/* Top-edge midpoint → scale Y (green, conventional Y axis color) */}
        <rect
          x={topMid.x - HANDLE / 2}
          y={topMid.y - HANDLE / 2}
          width={HANDLE}
          height={HANDLE}
          rx={2}
          ry={2}
          fill="#22c55e"
          stroke="#fef2f2"
          strokeWidth="0.75"
          style={{ cursor: "ns-resize", pointerEvents: "auto" }}
          onPointerDown={startDrag("edge-top")}
        />

        {/* Pivot dot — sets the rotation/scale center. Smaller now
            that the ring is gone, since it doesn't need to look like
            the bullseye of a rotation control. */}
        <circle
          cx={pivotPx.x}
          cy={pivotPx.y}
          r={PIVOT_R}
          fill="#ef4444"
          stroke="#fef2f2"
          strokeWidth="0.75"
          style={{ cursor: "move", pointerEvents: "auto" }}
          onPointerDown={startDrag("pivot")}
        />

        {/* Per-corner rotation grips. Each renders as a small curved
            arrow placed outward from its corner along the screen
            diagonal from the box center. Visible only when the
            pointer is hovering near the corresponding corner — or,
            during an active rotation, on the corner that initiated
            the drag. */}
        {(
          [
            ["tl", tl],
            ["tr", tr],
            ["br", br],
            ["bl", bl],
          ] as Array<[CornerKey, { x: number; y: number }]>
        ).map(([key, cornerPx]) => {
          const visible =
            (drag?.kind === "rotate" && drag.rotateFromCorner === key) ||
            (!drag && hoveredCorner === key);
          if (!visible) return null;
          // Box center in screen coords. "Outward" = direction from
          // center to this corner. Falls back to a unit diagonal
          // when the box has zero area (degenerate case).
          const cx = (tl.x + br.x) / 2;
          const cy = (tl.y + br.y) / 2;
          let dx = cornerPx.x - cx;
          let dy = cornerPx.y - cy;
          const dist = Math.hypot(dx, dy);
          if (dist > 1e-3) {
            dx /= dist;
            dy /= dist;
          } else {
            dx = key === "tr" || key === "br" ? 1 : -1;
            dy = key === "bl" || key === "br" ? 1 : -1;
            const m = Math.SQRT1_2;
            dx *= m;
            dy *= m;
          }
          const gripX = cornerPx.x + dx * ROTATE_GRIP_OFFSET;
          const gripY = cornerPx.y + dy * ROTATE_GRIP_OFFSET;
          return (
            <RotationGrip
              key={key}
              x={gripX}
              y={gripY}
              corner={key}
              boxRotateDeg={rotate}
              active={drag?.kind === "rotate"}
              onPointerDown={startDrag("rotate", key)}
            />
          );
        })}
      </svg>
    </div>
  );
}

// Single-corner glyph — two perpendicular line segments meeting at
// a rounded right-angle, drawn so the corner-vertex sits at the
// OUTERMOST point of the grip (farthest from the box center) and
// the two segments wrap inward toward the box. Mirrors the box
// corner geometry.
//
// The default path is the top-left orientation (corner-vertex at
// glyph's top-left). Other corners apply per-corner mirror scales
// to flip without re-drawing the path; the box's current rotation
// is layered on top so the glyph stays aligned with the box edges
// as the user rotates.
function RotationGrip({
  x,
  y,
  corner,
  boxRotateDeg,
  active,
  onPointerDown,
}: {
  x: number;
  y: number;
  corner: CornerKey;
  boxRotateDeg: number;
  active: boolean;
  onPointerDown: (e: React.PointerEvent<SVGElement>) => void;
}) {
  const HIT_R = 14;
  // Per-corner mirror. Default path's corner-vertex is at top-left;
  // mirroring puts it at the matching corner of the grip area.
  //   tl: identity
  //   tr: flip X  → vertex at top-right
  //   br: flip both → vertex at bottom-right
  //   bl: flip Y  → vertex at bottom-left
  const sx = corner === "tr" || corner === "br" ? -1 : 1;
  const sy = corner === "bl" || corner === "br" ? -1 : 1;
  return (
    <g
      style={{
        cursor: active ? "grabbing" : "grab",
        pointerEvents: "auto",
      }}
      onPointerDown={onPointerDown}
    >
      {/* Hit target — invisible disk covers the visual glyph plus
          some padding so the user doesn't have to land precisely
          on the stroke. */}
      <circle cx={x} cy={y} r={HIT_R} fill="transparent" />
      {/* Compose: position at grip center → rotate by box rotation →
          mirror for this corner → draw the default-orientation L.
          SVG composes transforms right-to-left, so this string runs
          translate-then-rotate-then-scale-then-path. */}
      {/* Path is an explicit arc segment between the two stubs
          rather than a sharp join with strokeLinejoin="round" —
          stroke-linejoin only rounds at the stroke level (a few
          px), but the user wants a generously rounded corner.
          Arc radius 6 over 14-unit legs gives ~85% of each leg
          dedicated to the curve while leaving short straight
          stubs at the ends. */}
      <path
        d="M 7 -7 L -1 -7 A 6 6 0 0 0 -7 -1 L -7 7"
        transform={`translate(${x}, ${y}) rotate(${boxRotateDeg}) scale(${sx}, ${sy})`}
        fill="none"
        stroke="#fef2f2"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ pointerEvents: "none" }}
      />
    </g>
  );
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
