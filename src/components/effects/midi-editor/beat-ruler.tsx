"use client";

// Bars/beats/divisions ladder + ruler strip for the piano roll — the
// musical sibling of timeline/ruler.ts. The frame ruler walks the decimal
// 1/2/5 ladder; here intervals DOUBLE (1, 2, 4, 8 bars up; 1/2, 1/4 beat
// down) because halving a bar is musically meaningful where a fifth of
// one is not. 4/4 is fixed for v1 (spec owner decision), and bar numbers
// are 1-indexed, Logic style.
//
// The minor/major line drawing reuses FrameTicks wholesale: frameTicks is
// unit-agnostic (it walks "frames" of `ticksPerFrame` ticks), so feeding
// it ticksPerBeat + beat intervals yields the beat grid — one ladder, one
// culling rule, no second implementation to drift.

import { RulerFrameStubs } from "../timeline/FrameTicks";
import { COLOR_RULER_TEXT, COLOR_RULER_TICK } from "../timeline/theme";

/** 4/4 fixed for v1. */
export const BEATS_PER_BAR = 4;

// Sub-beat gridlines fade in as you zoom once the halved interval would
// still get this much screen room (frameTicks' MIN_TICK_SPACING_PX is the
// legibility floor; this is the comfort threshold for ADDING density).
const MINOR_TARGET_PX = 12;

export interface BeatSpacing {
  /** Labeled bar-line interval, in beats — always whole bars. */
  majorBeats: number;
  /** Gridline interval between labels, in beats — can be sub-beat. */
  minorBeats: number;
}

export function beatSpacing(
  pixelsPerTick: number,
  ticksPerBeat: number,
  targetPx = 80
): BeatSpacing {
  const pxPerBeat = pixelsPerTick * ticksPerBeat;
  if (pxPerBeat <= 0) return { majorBeats: BEATS_PER_BAR, minorBeats: 1 };
  // Fewest whole bars whose label spacing reaches targetPx.
  let bars = 1;
  while (pxPerBeat * bars * BEATS_PER_BAR < targetPx && bars < 1 << 14) {
    bars *= 2;
  }
  const majorBeats = bars * BEATS_PER_BAR;
  // Minors: quarter the label interval (beats within one bar, bars within
  // a multi-bar label), then halve toward divisions while legible. Floor
  // at 1/8 beat = a 1/32 note.
  let minorBeats = majorBeats / BEATS_PER_BAR;
  while (minorBeats > 1 / 8 && pxPerBeat * (minorBeats / 2) >= MINOR_TARGET_PX) {
    minorBeats /= 2;
  }
  return { majorBeats, minorBeats };
}

export interface BeatRulerProps {
  width: number;
  height: number;
  tickToPx: (tick: number) => number;
  pxToTick: (px: number) => number;
  ticksPerBeat: number;
  majorBeats: number;
  minorBeats: number;
}

// The ruler strip's contents: a full-height line + bar number per major,
// beat/division stubs off the bottom edge between them. Same visual
// grammar as the Tracks/Layers frame ruler so the surfaces read as one
// family. pointerEvents none — the host div owns the seek gesture.
export function BeatRuler(props: BeatRulerProps) {
  const {
    width,
    height,
    tickToPx,
    pxToTick,
    ticksPerBeat,
    majorBeats,
    minorBeats,
  } = props;
  const startBeat = pxToTick(0) / ticksPerBeat;
  const endBeat = pxToTick(width) / ticksPerBeat;
  const cells: { x: number; bar: number }[] = [];
  const firstMajor = Math.ceil(startBeat / majorBeats) * majorBeats;
  for (let b = firstMajor; b <= endBeat; b += majorBeats) {
    const x = tickToPx(b * ticksPerBeat);
    if (x < -40 || x > width + 40) continue;
    cells.push({ x, bar: b / BEATS_PER_BAR + 1 });
  }
  return (
    <svg
      width={width}
      height={height}
      style={{ display: "block", pointerEvents: "none" }}
    >
      <RulerFrameStubs
        width={width}
        height={height}
        tickToPx={tickToPx}
        pxToTick={pxToTick}
        ticksPerFrame={ticksPerBeat}
        majorFrames={majorBeats}
        minorFrames={minorBeats}
      />
      {cells.map((c) => (
        <g key={c.bar}>
          <line
            x1={c.x}
            x2={c.x}
            y1={0}
            y2={height}
            stroke={COLOR_RULER_TICK}
            strokeWidth={1}
          />
          <text
            x={c.x + 4}
            y={height / 2 + 3}
            fontSize={9}
            // style, not the presentation attribute — var() only resolves
            // through the CSS cascade.
            style={{ fontFamily: "var(--ui-font)" }}
            fill={COLOR_RULER_TEXT}
          >
            {c.bar}
          </text>
        </g>
      ))}
    </svg>
  );
}
