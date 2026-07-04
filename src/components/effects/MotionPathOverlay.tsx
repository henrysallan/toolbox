"use client";

import { useEffect, useRef, useState } from "react";
import { aspectCorrectY, aspectUncorrectY } from "@/engine/aspect";
import {
  evaluateKeyframesAt,
  type KeyframeAnimationBlock,
} from "@/engine/keyframes";
import { rectsEqual } from "./overlay-rect";

// On-canvas motion path for a node's animated position. Draws a dashed line
// through the interpolated (x(t), y(t)) trajectory and a draggable diamond at
// every keyframe time. X and Y are independent keyframe tracks; we sample both
// at small tick increments so the path shows whatever curvature their separate
// easing/timing produces (there is no shared spatial bezier — by design today).
//
// A dot at tick T represents the FULL position at T (the union of the X and Y
// keyframe ticks). Dragging it writes a keyframe to both the X and Y param at
// T — collapsing the "separate tracks" model at the moments the user cares
// about. Coordinate mapping mirrors the host gizmo (aspect-corrected for the
// Transform gizmo, linear for spline primitives) so the current-frame dot sits
// exactly under the gizmo's center handle.

interface Props {
  canvas: HTMLCanvasElement | null;
  // The two position tracks (either may be undefined if that axis is constant).
  xBlock?: KeyframeAnimationBlock;
  yBlock?: KeyframeAnimationBlock;
  // Constant fallbacks for an axis with no animation / outside its range.
  xConst: number;
  yConst: number;
  // Pure mappings between param values and the normalized canvas center the
  // shape draws at. Identity for centered primitives; a +pivot offset for
  // translate-driven nodes (Transform, Text, Auto Layout).
  toCenter: (xVal: number, yVal: number) => { cx: number; cy: number };
  fromCenter: (cx: number, cy: number) => { xVal: number; yVal: number };
  // Whether the canvas aspect-corrects Y (Transform gizmo) or maps linearly
  // (spline primitives). Must match the host gizmo's `toPx`.
  aspectCorrect: boolean;
  currentTick: number;
  // Ticks per frame — used to space the equal-time speed dots (~one per frame).
  ticksPerFrame: number;
  // Commit a drag: set both axes' keyframe at `tick` to (xVal, yVal).
  onPointDrag: (tick: number, xVal: number, yVal: number) => void;
}

const DOT_R = 4.5;
// Subsamples per keyframe segment for the path polyline — enough to show
// eased curvature smoothly without exploding the point count on long scenes
// (segment count is bounded by the number of keyframes, not the duration).
const SUBSAMPLES = 18;
// Equal-time speed dots: sampled at uniform time intervals so screen-space
// spacing reflects speed (close = slow, spread = fast; an eased segment fans
// the dots out, showing acceleration). Count scales with duration, clamped.
const SPEED_DOT_R = 1.6;
const MIN_SPEED_DOTS = 8;
const MAX_SPEED_DOTS = 160;

function evalAxis(
  block: KeyframeAnimationBlock | undefined,
  konst: number,
  tick: number
): number {
  if (block && block.animated && block.keyframes.length > 0) {
    const v = evaluateKeyframesAt(block, "scalar", tick);
    if (typeof v === "number") return v;
  }
  return konst;
}

export default function MotionPathOverlay({
  canvas,
  xBlock,
  yBlock,
  xConst,
  yConst,
  toCenter,
  fromCenter,
  aspectCorrect,
  currentTick,
  ticksPerFrame,
  onPointDrag,
}: Props) {
  // The drag handler reads these off-render; ref them so the rapid
  // pointermove subscription doesn't re-bind on every render. (Everything
  // else is read directly during render.)
  const fromCenterRef = useRef(fromCenter);
  fromCenterRef.current = fromCenter;
  const onPointDragRef = useRef(onPointDrag);
  onPointDragRef.current = onPointDrag;

  const [rect, setRect] = useState<DOMRect | null>(null);
  const [drag, setDrag] = useState<{
    tick: number;
    startPointer: { x: number; y: number };
    startCenter: { cx: number; cy: number };
  } | null>(null);

  // Track the rendered canvas box (resize / splitter / scroll).
  useEffect(() => {
    if (!canvas) {
      setRect(null);
      return;
    }
    const update = () =>
      setRect((prev) => {
        const next = canvas.getBoundingClientRect();
        return rectsEqual(prev, next) ? prev : next;
      });
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
    const aspect = rect.width / rect.height;
    const onMove = (e: PointerEvent) => {
      const px = (e.clientX - rect.left) / rect.width;
      const pyRaw = (e.clientY - rect.top) / rect.height;
      const py = aspectCorrect ? aspectUncorrectY(pyRaw, aspect) : pyRaw;
      // Delta from drag start in normalized center space, so grabbing the
      // dot off-center doesn't snap it to the pointer.
      const cx = drag.startCenter.cx + (px - drag.startPointer.x);
      const cy = drag.startCenter.cy + (py - drag.startPointer.y);
      const { xVal, yVal } = fromCenterRef.current(cx, cy);
      onPointDragRef.current(drag.tick, xVal, yVal);
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, rect, aspectCorrect]);

  if (!rect) return null;

  // Require BOTH axes animated. With only one axis keyframed, dragging a dot
  // along the constant axis would insert that axis's only keyframe — making it
  // a single constant value across the whole timeline (a surprising global
  // shift). Both-animated matches the "keyframe X/Y at A then B" use case and
  // keeps every drag an edit among existing keyframes. (Relaxable later.)
  const xAnimated = !!xBlock?.animated && xBlock.keyframes.length > 0;
  const yAnimated = !!yBlock?.animated && yBlock.keyframes.length > 0;
  if (!xAnimated || !yAnimated) return null;

  // Union of the two tracks' keyframe ticks — the moments where the position
  // changes. Need at least two distinct ticks to draw a path.
  const tickSet = new Set<number>();
  for (const k of xBlock?.keyframes ?? []) tickSet.add(k.tick);
  for (const k of yBlock?.keyframes ?? []) tickSet.add(k.tick);
  const ticks = [...tickSet].sort((a, b) => a - b);
  if (ticks.length < 2) return null;

  const toPx = (cx: number, cy: number) => ({
    x: rect.left + cx * rect.width,
    y:
      rect.top +
      (aspectCorrect ? aspectCorrectY(cy, rect.width / rect.height) : cy) *
        rect.height,
  });

  const centerAt = (tick: number) => {
    const xv = evalAxis(xBlock, xConst, tick);
    const yv = evalAxis(yBlock, yConst, tick);
    return toCenter(xv, yv);
  };

  const minTick = ticks[0];
  const maxTick = ticks[ticks.length - 1];

  // Faint trajectory line: subsample each segment so eased curves render
  // smoothly (purely the shape of the path; speed is shown by the dots).
  const pathPts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < ticks.length - 1; i++) {
    const t0 = ticks[i];
    const t1 = ticks[i + 1];
    for (let s = 0; s < SUBSAMPLES; s++) {
      const t = t0 + ((t1 - t0) * s) / SUBSAMPLES;
      const c = centerAt(t);
      pathPts.push(toPx(c.cx, c.cy));
    }
  }
  {
    const last = centerAt(maxTick);
    pathPts.push(toPx(last.cx, last.cy));
  }
  const polyline = pathPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  // Equal-time speed dots: uniform time steps → spacing reflects speed. Count
  // tracks duration (~one per frame) but is clamped so a long scene stays
  // light and a short one still reads as a path.
  const frames = (maxTick - minTick) / Math.max(1, ticksPerFrame);
  const dotCount = Math.max(
    MIN_SPEED_DOTS,
    Math.min(MAX_SPEED_DOTS, Math.round(frames))
  );
  const speedDots: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= dotCount; i++) {
    const t = minTick + ((maxTick - minTick) * i) / dotCount;
    const c = centerAt(t);
    speedDots.push(toPx(c.cx, c.cy));
  }

  const startDrag = (tick: number) => (e: React.PointerEvent<SVGElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const aspect = rect.width / rect.height;
    const c = centerAt(tick);
    const pyRaw = (e.clientY - rect.top) / rect.height;
    setDrag({
      tick,
      startPointer: {
        x: (e.clientX - rect.left) / rect.width,
        y: aspectCorrect ? aspectUncorrectY(pyRaw, aspect) : pyRaw,
      },
      startCenter: { cx: c.cx, cy: c.cy },
    });
  };

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
        {/* Faint trajectory line — the shape of the path. */}
        <polyline
          points={polyline}
          fill="none"
          stroke="#fef2f2"
          strokeOpacity={0.28}
          strokeWidth={1}
          style={{ pointerEvents: "none" }}
        />
        {/* Equal-time dots — spacing reflects speed (close = slow, far = fast;
            an eased segment fans them out, showing acceleration). */}
        {speedDots.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={SPEED_DOT_R}
            fill="#fef2f2"
            fillOpacity={0.85}
            style={{ pointerEvents: "none" }}
          />
        ))}
        {/* Keyframe diamonds — drag to reposition (writes both X and Y at
            that tick). The diamond at the playhead is highlighted. */}
        {ticks.map((tick) => {
          const c = centerAt(tick);
          const p = toPx(c.cx, c.cy);
          const isCurrent = tick === currentTick;
          return (
            <rect
              key={tick}
              x={p.x - DOT_R}
              y={p.y - DOT_R}
              width={DOT_R * 2}
              height={DOT_R * 2}
              transform={`rotate(45 ${p.x.toFixed(2)} ${p.y.toFixed(2)})`}
              fill={isCurrent ? "#ef4444" : "#111"}
              stroke="#fef2f2"
              strokeWidth={1}
              style={{
                cursor: drag?.tick === tick ? "grabbing" : "move",
                pointerEvents: "auto",
              }}
              onPointerDown={startDrag(tick)}
            />
          );
        })}
      </svg>
    </div>
  );
}
