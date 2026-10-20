// After Effects export — time (spec 091926_after-effects-handoff.md §4.6).
//
// Toolbox time is integer ticks (DEFAULT_TICKS_PER_FRAME = 1000 per frame);
// AE time is seconds: t = tick / (ticksPerFrame · fps), exact up to the
// double. A root `layer` node's clip windows are its in/out bars, and the
// window also sets the interior's clock (evaluator.ts: interior local tick =
// globalTick − inTick + sourceInTick of the active window), which is AE's
// layer startTime. AE key times are COMP time on every layer, startTime
// shifted or not (M0, spec §13) — so a key on a property of the layer itself
// lands at (localTick + offset) seconds, while a key inside a precomp the
// layer sources stays at localTick seconds of the precomp.

import { DEFAULT_TICKS_PER_FRAME } from "@/engine/keyframes";
import type { ClipBlock } from "@/engine/clips";

export interface AeTimebase {
  fps: number;
  // Default DEFAULT_TICKS_PER_FRAME (1000).
  ticksPerFrame?: number;
}

export function ticksPerFrameOf(tb: AeTimebase): number {
  return tb.ticksPerFrame ?? DEFAULT_TICKS_PER_FRAME;
}

export function ticksToSeconds(tick: number, tb: AeTimebase): number {
  return tick / (ticksPerFrameOf(tb) * tb.fps);
}

export function secondsToTicks(seconds: number, tb: AeTimebase): number {
  return seconds * ticksPerFrameOf(tb) * tb.fps;
}

export function framesToSeconds(frame: number, tb: AeTimebase): number {
  return frame / tb.fps;
}

export function frameToTick(frame: number, tb: AeTimebase): number {
  return frame * ticksPerFrameOf(tb);
}

// A toolbox key's tick on a clock offset by `offsetTicks` (a layer's
// interior) → seconds of the comp that holds the layer.
export function localTickToCompSeconds(localTick: number, offsetTicks: number, tb: AeTimebase): number {
  return ticksToSeconds(localTick + offsetTicks, tb);
}

// Comp duration (§4.6): loopFrames / fps, or an explicit frame range.
export function compDurationSeconds(frames: number, tb: AeTimebase): number {
  return frames / tb.fps;
}

export interface AeLayerTiming {
  // Seconds, containing comp time (AeLayer's fields).
  inPoint: number;
  outPoint: number;
  startTime: number;
  // The interior clock offset in ticks: local tick = comp tick − offsetTicks.
  offsetTicks: number;
  // Indexes into the node's `clips` this AE layer covers (adjacent windows on
  // the same clock merge — a razor cut keeps the clock, so a split layer is
  // still one AE layer).
  windows: number[];
}

// The interior clock offset at a global tick, the evaluator's rule
// (evaluator.ts, "Per-layer time offset"): the active window, else the next
// enabled window ahead, else the last one behind; no enabled window ⇒ 0.
export function layerClockOffsetTicks(clips: readonly ClipBlock[] | undefined, tick: number): number {
  let active: ClipBlock | undefined;
  let next: ClipBlock | undefined;
  let last: ClipBlock | undefined;
  for (const c of clips ?? []) {
    if (!c.enabled) continue;
    if (!active && tick >= c.inTick && tick < c.outTick) active = c;
    if (c.inTick > tick) {
      if (!next || c.inTick < next.inTick) next = c;
    } else if (!last || c.inTick > last.inTick) {
      last = c;
    }
  }
  const ref = active ?? next ?? last;
  return ref ? ref.inTick - ref.sourceInTick : 0;
}

// A layer's clip windows → one AE layer timing per run of adjacent windows on
// the same clock. AE gives a layer one in/out pair and one startTime, so
// disjoint windows (a gap) or windows slid apart (different offsets) need one
// AE layer each — the exporter duplicates the layer per timing. No enabled
// window ⇒ the whole comp at offset 0 (an unclipped layer). `durationTicks`
// bounds that default; windows themselves are not clamped (AE allows a layer
// past the comp's end).
export function layerTimings(
  clips: readonly ClipBlock[] | undefined,
  durationTicks: number,
  tb: AeTimebase
): AeLayerTiming[] {
  const enabled = (clips ?? [])
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.enabled && c.outTick > c.inTick)
    .sort((a, b) => a.c.inTick - b.c.inTick);
  if (enabled.length === 0) {
    return [{ inPoint: 0, outPoint: ticksToSeconds(durationTicks, tb), startTime: 0, offsetTicks: 0, windows: [] }];
  }
  const runs: { inTick: number; outTick: number; offset: number; windows: number[] }[] = [];
  for (const { c, i } of enabled) {
    const offset = c.inTick - c.sourceInTick;
    const prev = runs[runs.length - 1];
    if (prev && prev.offset === offset && prev.outTick === c.inTick) {
      prev.outTick = c.outTick;
      prev.windows.push(i);
    } else {
      runs.push({ inTick: c.inTick, outTick: c.outTick, offset, windows: [i] });
    }
  }
  return runs.map((r) => ({
    inPoint: ticksToSeconds(r.inTick, tb),
    outPoint: ticksToSeconds(r.outTick, tb),
    startTime: ticksToSeconds(r.offset, tb),
    offsetTicks: r.offset,
    windows: r.windows,
  }));
}
