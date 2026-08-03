// Shared scaffold for element-anchored drag gestures (resize grips, window
// chrome, splitters).
//
// Why this exists: the editors were originally written against `mousedown` +
// window `mousemove`/`mouseup`. iOS/iPadOS synthesizes mouse events only for a
// TAP — there is no `mousemove` stream during a touch or Apple Pencil drag —
// so every one of those gestures was dead on iPad. Pointer events cover mouse,
// touch and pen with one code path.
//
// Three things a hand-rolled pointer drag routinely gets wrong, all handled
// here:
//   1. `setPointerCapture` — without it a drag that outruns the element (or
//      crosses an iframe/canvas) stops delivering moves.
//   2. `pointercancel` — iOS fires this instead of `pointerup` whenever the
//      system claims the gesture (a scroll takes over, a palm lands, the app
//      backgrounds). No cancel handler means the listeners leak AND the
//      gesture never commits.
//   3. `touch-action` — the handle element must opt out of browser panning or
//      the browser claims the gesture before the first move. That part is CSS,
//      so it can't live here: use `TOUCH_DRAG_STYLE` (below) on the handle.
//
// The gesture ends exactly once, whichever way it ends.

import { useEffect, useState } from "react";

/**
 * Spread onto any element that starts a drag. `touchAction: "none"` tells the
 * browser this element owns its gestures, which is what stops iOS from
 * cancelling the pointer stream mid-drag to scroll an ancestor.
 */
export const TOUCH_DRAG_STYLE = { touchAction: "none" } as const;

/**
 * True when the primary input is a fingertip (iPad, phone) rather than a
 * mouse. Apple Pencil does NOT flip this back to fine — iPadOS reports the
 * device's primary pointer — which is what we want: a layout sized for a
 * fingertip is still comfortable with a stylus, and the reverse is not true.
 *
 * Reads as `false` on the server and on the first client render, then settles
 * after mount, so it never causes a hydration mismatch. Use it to widen grab
 * targets, not to change what a control does.
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const sync = () => setCoarse(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return coarse;
}

export interface PointerDragOpts {
  /** Fires for every move once the drag is live. */
  onMove: (ev: PointerEvent) => void;
  /** Normal release. Not called when the gesture is cancelled. */
  onUp?: (ev: PointerEvent) => void;
  /**
   * The system took the gesture away (iOS scroll takeover, palm rejection,
   * app backgrounded) or the element unmounted mid-drag. Undo any live
   * preview here — `onUp` will NOT also fire.
   */
  onCancel?: () => void;
  /** Held on <body> for the duration, so it survives leaving the handle. */
  cursor?: string;
  /** Suppress text selection under the cursor for the drag. Default true. */
  lockSelection?: boolean;
  /** Ignore anything but the primary button. Default true. */
  primaryOnly?: boolean;
}

/**
 * Begin a pointer drag from a React `onPointerDown`. Returns true if the drag
 * started (false when a non-primary button was filtered out), so callers can
 * bail out of their own setup.
 *
 * The handle element still needs `touchAction: "none"` — see
 * `TOUCH_DRAG_STYLE`.
 */
export function startPointerDrag(
  e: React.PointerEvent<HTMLElement>,
  opts: PointerDragOpts
): boolean {
  const {
    onMove,
    onUp,
    onCancel,
    cursor,
    lockSelection = true,
    primaryOnly = true,
  } = opts;
  if (primaryOnly && e.button !== 0) return false;

  const el = e.currentTarget;
  // Read off the synthetic event now — the handlers below outlive it.
  const pointerId = e.pointerId;
  // Capture can throw if the element is already detached — a drag we can't
  // capture is one we shouldn't start.
  try {
    el.setPointerCapture(pointerId);
  } catch {
    return false;
  }

  const prevCursor = document.body.style.cursor;
  const prevSelect = document.body.style.userSelect;
  if (cursor) document.body.style.cursor = cursor;
  if (lockSelection) document.body.style.userSelect = "none";

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    el.removeEventListener("pointermove", handleMove);
    el.removeEventListener("pointerup", handleUp);
    el.removeEventListener("pointercancel", handleCancel);
    el.removeEventListener("lostpointercapture", handleCancel);
    document.body.style.cursor = prevCursor;
    document.body.style.userSelect = prevSelect;
  };

  // Guard on pointerId so a second finger landing mid-gesture can't drive
  // the drag — on a touchscreen that's the difference between a resize and
  // a jump to wherever the other finger touched down.
  function handleMove(ev: PointerEvent) {
    if (ev.pointerId !== pointerId) return;
    onMove(ev);
  }
  function handleUp(ev: PointerEvent) {
    if (ev.pointerId !== pointerId) return;
    cleanup();
    onUp?.(ev);
  }
  // `lostpointercapture` also lands here: it fires after a normal pointerup
  // too, but `cleanup`'s `done` latch means the already-finished gesture is a
  // no-op. What it actually buys us is the unmount case, where no pointerup
  // ever arrives.
  function handleCancel() {
    if (done) return;
    cleanup();
    onCancel?.();
  }

  el.addEventListener("pointermove", handleMove);
  el.addEventListener("pointerup", handleUp);
  el.addEventListener("pointercancel", handleCancel);
  el.addEventListener("lostpointercapture", handleCancel);
  return true;
}
