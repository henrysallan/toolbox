// Vertical (pitch) counterpart of timeline/view.ts for the piano roll:
// row height, pan offset and the pitch↔y transforms. A separate hook
// rather than a second axis on useTimelineView because the two axes obey
// different laws — time is unbounded and cursor-zoomed, pitch is a hard
// 0..127 range that clamps against the viewport.
//
// Coordinates: continuous pitch-space u, where pitch p's row spans
// [p, p+1) and HIGHER pitch is HIGHER on screen (y decreases as pitch
// increases). `viewPitchOffset` is the u sitting at the viewport's top
// edge, so y(u) = (viewPitchOffset - u) * rowPx.

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { NOTE_ROW_PX } from "../timeline/theme";

export const PITCH_MIN = 0;
export const PITCH_MAX = 127;
/** Rows on the keyboard — MIDI 0..127. */
export const PITCH_COUNT = 128;

// Keep the viewport inside the keyboard: the top edge can't rise past
// pitch 127's row and the bottom edge can't sink below pitch 0's. A
// viewport taller than the whole keyboard pins it centered instead.
export function clampPitchOffset(
  offset: number,
  viewportHeightPx: number,
  rowPx: number
): number {
  const span = viewportHeightPx / rowPx;
  if (span >= PITCH_COUNT) return PITCH_COUNT / 2 + span / 2;
  return Math.min(PITCH_COUNT, Math.max(span, offset));
}

export interface PitchView {
  rowPx: number;
  viewPitchOffset: number;
  setRowPx: Dispatch<SetStateAction<number>>;
  setViewPitchOffset: Dispatch<SetStateAction<number>>;
  /** Top edge (px) of the pitch's row. */
  pitchToY(pitch: number): number;
  /** The row under a viewport y, clamped to the MIDI range. */
  yToPitch(y: number): number;
  // Center the viewport on the row range [loPitch, hiPitch] — the
  // vertical half of "fit on mount".
  centerOn(viewportHeightPx: number, loPitch: number, hiPitch: number): void;
}

export function usePitchView(initialRowPx = NOTE_ROW_PX): PitchView {
  const [rowPx, setRowPx] = useState(initialRowPx);
  const [viewPitchOffset, setViewPitchOffset] = useState(PITCH_COUNT);

  const pitchToY = useCallback(
    (pitch: number) => (viewPitchOffset - pitch - 1) * rowPx,
    [viewPitchOffset, rowPx]
  );
  const yToPitch = useCallback(
    (y: number) =>
      Math.max(
        PITCH_MIN,
        Math.min(PITCH_MAX, Math.floor(viewPitchOffset - y / rowPx))
      ),
    [viewPitchOffset, rowPx]
  );
  const centerOn = useCallback(
    (viewportHeightPx: number, loPitch: number, hiPitch: number) => {
      const centerU = (loPitch + hiPitch + 1) / 2;
      setViewPitchOffset(
        clampPitchOffset(
          centerU + viewportHeightPx / rowPx / 2,
          viewportHeightPx,
          rowPx
        )
      );
    },
    [rowPx]
  );

  return {
    rowPx,
    viewPitchOffset,
    setRowPx,
    setViewPitchOffset,
    pitchToY,
    yToPitch,
    centerOn,
  };
}
