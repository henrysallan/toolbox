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
