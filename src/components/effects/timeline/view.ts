// Shared tick↔pixel view state for the timeline editors: zoom
// (pixelsPerTick), pan (viewTickOffset, the leftmost visible tick) and
// the derived transforms. Each editor owns its own event wiring (wheel,
// middle-drag, space-pan differ per surface) and calls into this hook
// for the math, so the transforms and clamps can't drift between tabs.

import { useCallback, useState } from "react";
import {
  FIT_PAD,
  MAX_PIXELS_PER_TICK,
  MIN_PIXELS_PER_TICK,
} from "./theme";

export function clampPixelsPerTick(v: number): number {
  return Math.max(MIN_PIXELS_PER_TICK, Math.min(MAX_PIXELS_PER_TICK, v));
}

export interface TimelineView {
  pixelsPerTick: number;
  viewTickOffset: number;
  setPixelsPerTick: React.Dispatch<React.SetStateAction<number>>;
  setViewTickOffset: React.Dispatch<React.SetStateAction<number>>;
  tickToPx(tick: number): number;
  pxToTick(px: number): number;
  // Set the scale to `nextRaw` (clamped) while keeping `anchorTick`
  // fixed at `anchorPx` — the cursor-anchored zoom every editor uses.
  zoomTo(anchorPx: number, anchorTick: number, nextRaw: number): void;
  // Fit `durationTicks` into a viewport. `leftGutterPx` reserves space
  // for a floating label column that overlays the timeline's left edge
  // (TrackEditor): tick 0 lands just right of the gutter instead of
  // underneath it, so early keyframes stay clickable.
  fit(viewportWidthPx: number, durationTicks: number, leftGutterPx?: number): void;
}

export function useTimelineView(initialPixelsPerTick = 0.01): TimelineView {
  const [pixelsPerTick, setPixelsPerTick] = useState(initialPixelsPerTick);
  const [viewTickOffset, setViewTickOffset] = useState(0);

  const tickToPx = useCallback(
    (tick: number) => (tick - viewTickOffset) * pixelsPerTick,
    [viewTickOffset, pixelsPerTick]
  );
  const pxToTick = useCallback(
    (px: number) => viewTickOffset + px / pixelsPerTick,
    [viewTickOffset, pixelsPerTick]
  );

  const zoomTo = useCallback(
    (anchorPx: number, anchorTick: number, nextRaw: number) => {
      const next = clampPixelsPerTick(nextRaw);
      setViewTickOffset(anchorTick - anchorPx / next);
      setPixelsPerTick(next);
    },
    []
  );

  const fit = useCallback(
    (viewportWidthPx: number, durationTicks: number, leftGutterPx = 0) => {
      const usable = Math.max(50, viewportWidthPx - leftGutterPx);
      const pps = clampPixelsPerTick(
        durationTicks > 0 ? (usable * FIT_PAD) / durationTicks : 0.01
      );
      setPixelsPerTick(pps);
      setViewTickOffset(-leftGutterPx / pps);
    },
    []
  );

  return {
    pixelsPerTick,
    viewTickOffset,
    setPixelsPerTick,
    setViewTickOffset,
    tickToPx,
    pxToTick,
    zoomTo,
    fit,
  };
}
