"use client";

// The frame-division grid shared by the tick-based timeline editors:
// full-height hairlines behind the lanes, and the matching short stubs
// along the bottom of the ruler.
//
// Density rides the SAME 1/2/5 ladder the ruler numbers use (ruler.ts):
// `majorFrames` is the numbered interval, `minorFrames` the finer step
// between them, so the grid re-derives on every zoom change for free and
// can never disagree with the numbers above it. Nothing else consumed
// `minorFrames` before this.
//
// Both layers are pointerEvents:none and paint behind their siblings —
// hit-testing is untouched.

import {
  COLOR_FRAME_TICK_MAJOR,
  COLOR_FRAME_TICK_MINOR,
  MIN_TICK_SPACING_PX,
  RULER_STUB_H,
} from "./theme";

export interface FrameTick {
  x: number;
  /** On a numbered (major) division rather than a minor one. */
  major: boolean;
}

export interface FrameTickOpts {
  /** Viewport width in px; divisions past it are culled. */
  width: number;
  tickToPx: (tick: number) => number;
  pxToTick: (px: number) => number;
  ticksPerFrame: number;
  majorFrames: number;
  minorFrames: number;
}

/**
 * The visible frame divisions, left to right. Steps by `minorFrames`
 * while those stay legible, falls back to majors only when they'd
 * crowd, and returns nothing when even the majors would.
 */
export function frameTicks(o: FrameTickOpts): FrameTick[] {
  const { width, tickToPx, pxToTick, ticksPerFrame, majorFrames, minorFrames } =
    o;
  if (width <= 0 || ticksPerFrame <= 0 || majorFrames <= 0) return [];
  const pxPerFrame = tickToPx(ticksPerFrame) - tickToPx(0);
  if (!(pxPerFrame > 0)) return [];
  const step =
    minorFrames > 0 && pxPerFrame * minorFrames >= MIN_TICK_SPACING_PX
      ? minorFrames
      : majorFrames;
  if (pxPerFrame * step < MIN_TICK_SPACING_PX) return [];
  const firstFrame = pxToTick(0) / ticksPerFrame;
  const startFrame = Math.floor(firstFrame / step) * step;
  const out: FrameTick[] = [];
  // The cap is a runaway guard only — the width break below is what
  // normally ends the walk.
  for (let f = startFrame; out.length < 2000; f += step) {
    const x = tickToPx(f * ticksPerFrame);
    if (x > width) break;
    if (x >= 0) {
      // Double-modulo: `f` is negative left of tick 0, where a plain
      // `%` would report the wrong majors.
      out.push({ x, major: ((f % majorFrames) + majorFrames) % majorFrames === 0 });
    }
  }
  return out;
}

/**
 * Full-height hairlines across a lanes area. Absolutely positioned to
 * fill its parent, so the host just needs `position: relative` — and it
 * must NOT live inside the vertically-scrolled content, since the grid
 * is a fixed backdrop.
 */
export function LaneFrameTicks(props: FrameTickOpts & { left?: number }) {
  const { width, left = 0 } = props;
  const ticks = frameTicks(props);
  if (ticks.length === 0) return null;
  return (
    <svg
      aria-hidden
      // Height comes from the box, and the lines below resolve their own
      // against it — so this needs no measurement of the lanes viewport
      // (whose height is a CSS `100%`, not a number).
      style={{
        position: "absolute",
        left,
        top: 0,
        bottom: 0,
        width,
        height: "100%",
        pointerEvents: "none",
      }}
    >
      {ticks.map((t) => (
        <line
          key={t.x}
          // +0.5 lands the 1px stroke on a device pixel instead of
          // straddling two, which is what makes a hairline look grey
          // and fuzzy rather than thin.
          x1={Math.round(t.x) + 0.5}
          x2={Math.round(t.x) + 0.5}
          y1={0}
          y2="100%"
          stroke={t.major ? COLOR_FRAME_TICK_MAJOR : COLOR_FRAME_TICK_MINOR}
          strokeWidth={1}
        />
      ))}
    </svg>
  );
}

/**
 * The ruler's minor stubs — short marks rising from its bottom edge.
 * Majors are skipped: the ruler already draws a full-height line and the
 * frame number at those.
 */
export function RulerFrameStubs(props: FrameTickOpts & { height: number }) {
  const { height } = props;
  // `props.width` is consumed by frameTicks for culling, not here.
  const ticks = frameTicks(props).filter((t) => !t.major);
  if (ticks.length === 0) return null;
  return (
    <>
      {ticks.map((t) => (
        <line
          key={t.x}
          x1={Math.round(t.x) + 0.5}
          x2={Math.round(t.x) + 0.5}
          y1={height - RULER_STUB_H}
          y2={height}
          stroke={COLOR_FRAME_TICK_MAJOR}
          strokeWidth={1}
        />
      ))}
    </>
  );
}
