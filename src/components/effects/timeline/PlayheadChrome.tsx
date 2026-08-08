"use client";

// Playhead chrome shared by the tick-based timeline editors: the 1px
// playhead line, the ruler triangle handle, and the faded hover-preview
// line. The line and handle subscribe to the clock THEMSELVES (the
// leaf-subscription pass from specdocs/archive/071026_clock-store.md): the
// editor shells no longer read the tick at their top level, so playback
// re-renders these leaves only — not the whole editor.
//
// The hover line is imperative (a ref handle, no state): mousemove
// updates its transform directly so cursor tracking doesn't re-render
// the shell either.

import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useClock } from "@/state/playback-clock";
import { useCoarsePointer } from "@/lib/pointer-drag";
import {
  COLOR_PLAYHEAD,
  COLOR_PLAYHEAD_HOVER,
  RULER_HEIGHT,
} from "./theme";

export interface PlayheadLineProps {
  tickToPx: (tick: number) => number;
  // Added to the computed x (LayersEditor offsets by its label column).
  leftOffset?: number;
  // Hide when the computed x (pre-offset) is outside [0, visibleWidth].
  // Omit to always show.
  visibleWidth?: number;
}

// The vertical playhead line across the lanes.
export function PlayheadLine({
  tickToPx,
  leftOffset = 0,
  visibleWidth,
}: PlayheadLineProps) {
  const tick = useClock((s) => s.tick);
  const x = tickToPx(tick);
  const hidden =
    visibleWidth != null ? x < 0 || x > visibleWidth : x < -1;
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: leftOffset + x,
        width: 1,
        background: COLOR_PLAYHEAD,
        opacity: 0.7,
        pointerEvents: "none",
        display: hidden ? "none" : "block",
      }}
    />
  );
}

export interface PlayheadHandleProps {
  tickToPx: (tick: number) => number;
  visibleWidth?: number;
  // Begin a scrub drag (the editor owns the drag state machine).
  onStartScrub(): void;
}

// The draggable handle in the ruler row.
export function PlayheadHandle({
  tickToPx,
  visibleWidth,
  onStartScrub,
}: PlayheadHandleProps) {
  const tick = useClock((s) => s.tick);
  const [hover, setHover] = useState(false);
  const coarse = useCoarsePointer();
  const x = tickToPx(tick);
  if (visibleWidth != null && (x < 0 || x > visibleWidth)) return null;
  // Grab box only — the visible slug below keeps its own width. 12px is a
  // mouse target; a fingertip needs roughly double.
  const hit = coarse ? 24 : 12;
  return (
    <div
      style={{
        position: "absolute",
        left: x - hit / 2,
        top: 2,
        width: hit,
        height: RULER_HEIGHT - 4,
        cursor: "ew-resize",
        touchAction: "none",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // Pointer, not mouse: under finger or Pencil there is no mousedown
      // until the touch ENDS, so a mouse-rooted scrub never starts.
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        onStartScrub();
      }}
    >
      {/* A rounded slug rather than the old downward triangle — it reads
          as a grabbable handle and its full width stays legible at any
          zoom, where a triangle's tip visually collapsed onto the line.
          Nearly fills the ruler's height so it's an easy target. */}
      <div
        style={{
          width: 10,
          // Leaves room inside the ruler for the hover ring, which the
          // ruler row clips (overflow: hidden).
          height: RULER_HEIGHT - 6,
          margin: "0 auto",
          borderRadius: 3,
          background: hover ? COLOR_PLAYHEAD_HOVER : COLOR_PLAYHEAD,
          boxShadow: hover ? "0 0 0 2px rgba(34,197,94,0.25)" : "none",
          transition: "background 90ms, box-shadow 90ms",
        }}
      />
    </div>
  );
}

export interface HoverLineHandle {
  // x in the host's coordinate space, or null to hide.
  set(x: number | null): void;
}

// Faded playhead-preview line that tracks the cursor. Positioned
// imperatively via the handle so mousemove never re-renders the host.
export const HoverLine = forwardRef<HoverLineHandle>(function HoverLine(
  _props,
  ref
) {
  const divRef = useRef<HTMLDivElement | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      set(x: number | null) {
        const el = divRef.current;
        if (!el) return;
        if (x == null) {
          el.style.display = "none";
        } else {
          el.style.display = "block";
          el.style.left = `${x}px`;
        }
      },
    }),
    []
  );
  return (
    <div
      ref={divRef}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: 0,
        width: 1,
        background: COLOR_PLAYHEAD,
        opacity: 0.3,
        pointerEvents: "none",
        display: "none",
      }}
    />
  );
});
