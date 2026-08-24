// Shared clip-window drag math for the timeline editors. TrackEditor
// and LayersEditor previously carried parallel implementations of bar
// move / trim that had drifted (Layers hardcoded the in-trim slip and
// lacked the footage-end clamp). One policy now:
//
//   • Snapping is caller-supplied per gesture (`snap` = !shiftKey).
//   • Windows can't cross tick 0; a move pushed past 0 stops as a unit.
//   • Trims keep at least one frame of window.
//   • On clock-carrying clips (`slipsInTrim` — video + layer, see
//     clipSlipsOnInTrim in engine/clips.ts) an in-trim slips
//     sourceInTick by the trim delta so the content stays anchored (NLE
//     trim = reveal); the in-handle clamps at the content anchor.
//   • With a known source length (video), the out-handle clamps at the
//     end of the footage.
//   • Multi-clip trim/move applies one already-snapped delta to every
//     peer; each window still runs the clamps above independently. A
//     group move that would push any head past 0 is clamped as a unit
//     by the caller (same policy as keyframe drags).

import type { ClipBlock } from "@/engine/clips";
import { snapTickToFrame } from "@/engine/keyframes";

export interface ClipDragOptions {
  snap: boolean;
  ticksPerFrame: number;
}

// Shift a window's in/out together by a tick delta. Returns the full
// clips array with only `clipIndex` replaced, or null if the index is
// stale.
export function moveClipWindow(
  startClips: ClipBlock[],
  clipIndex: number,
  deltaTicks: number,
  { snap, ticksPerFrame }: ClipDragOptions
): ClipBlock[] | null {
  const win = startClips[clipIndex];
  if (!win) return null;
  let delta = deltaTicks;
  if (snap) {
    // Snap the window's head to a frame, not the delta itself, so the
    // bar lands frame-aligned wherever it started.
    delta = snapTickToFrame(win.inTick + delta, ticksPerFrame) - win.inTick;
  }
  let newIn = win.inTick + delta;
  let newOut = win.outTick + delta;
  if (newIn < 0) {
    newOut -= newIn;
    newIn = 0;
  }
  return startClips.map((c, i) =>
    i === clipIndex
      ? { ...c, inTick: Math.round(newIn), outTick: Math.round(newOut) }
      : c
  );
}

export interface ClipTrimOptions extends ClipDragOptions {
  slipsInTrim: boolean;
  // Source footage length in ticks (video only) — bounds the out-trim so
  // the window can't extend past the available footage. Undefined ⇒
  // unbounded.
  sourceDurationTicks?: number;
}

// Trim a window's in or out edge to the cursor's absolute tick.
export function trimClipWindow(
  startClips: ClipBlock[],
  clipIndex: number,
  side: "in" | "out",
  targetTick: number,
  { snap, ticksPerFrame, slipsInTrim, sourceDurationTicks }: ClipTrimOptions
): ClipBlock[] | null {
  const win = startClips[clipIndex];
  if (!win) return null;
  const minW = ticksPerFrame;
  const t = snap ? snapTickToFrame(targetTick, ticksPerFrame) : targetTick;
  let updated: ClipBlock;
  if (side === "in") {
    // Clock-carrying clips can't pull the head earlier than the content
    // anchor: for video that's the start of the footage (sourceIn would
    // go negative), for a layer its interior's time zero.
    const minIn = slipsInTrim ? Math.max(0, win.inTick - win.sourceInTick) : 0;
    const newIn = Math.round(Math.max(minIn, Math.min(t, win.outTick - minW)));
    const sourceIn = slipsInTrim
      ? win.sourceInTick + (newIn - win.inTick)
      : win.sourceInTick;
    updated = { ...win, inTick: newIn, sourceInTick: sourceIn };
  } else {
    let newOut = Math.round(Math.max(win.inTick + minW, t));
    if (sourceDurationTicks != null) {
      const maxOut = win.inTick + (sourceDurationTicks - win.sourceInTick);
      newOut = Math.min(newOut, Math.round(maxOut));
    }
    updated = { ...win, outTick: newOut };
  }
  return startClips.map((c, i) => (i === clipIndex ? updated : c));
}

// Trim several windows on one node's array by the same tick delta.
// `deltaTicks` is already snapped; this only applies per-window clamps.
// Rebuilds from `startClips` so two peers on the same node don't stomp
// each other. Returns null if every index was stale.
export function trimClipsByDelta(
  startClips: ClipBlock[],
  clipIndexes: number[],
  side: "in" | "out",
  deltaTicks: number,
  opts: Omit<ClipTrimOptions, "snap">
): ClipBlock[] | null {
  const trimOpts: ClipTrimOptions = { ...opts, snap: false };
  let clips = startClips;
  let any = false;
  for (const i of clipIndexes) {
    const win = startClips[i];
    if (!win) continue;
    const target = (side === "in" ? win.inTick : win.outTick) + deltaTicks;
    const next = trimClipWindow(clips, i, side, target, trimOpts);
    if (next) {
      clips = next;
      any = true;
    }
  }
  return any ? clips : null;
}

// Shift several windows on one node's array by the same tick delta.
// `deltaTicks` is already snapped (and ≥0-clamped across the group by
// the caller). Returns null if every index was stale.
export function moveClipsByDelta(
  startClips: ClipBlock[],
  clipIndexes: number[],
  deltaTicks: number,
  ticksPerFrame: number
): ClipBlock[] | null {
  const opts: ClipDragOptions = { snap: false, ticksPerFrame };
  let clips = startClips;
  let any = false;
  for (const i of clipIndexes) {
    if (!startClips[i]) continue;
    const next = moveClipWindow(clips, i, deltaTicks, opts);
    if (next) {
      clips = next;
      any = true;
    }
  }
  return any ? clips : null;
}
