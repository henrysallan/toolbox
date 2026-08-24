// DOM binding for cursor-capture-core — THE pointer plumbing behind
// ctx.cursor, mounted by BOTH hosts (EffectsApp and LiveViewer). It
// replaced two near-identical inline listener blocks; extend cursor
// facts HERE (plus the core + CursorState), never by re-inlining a
// host-side listener, or the editor and exported apps drift.
// Spec: 081726_pointer-interaction.md §1.4.
//
// Listener shape (unchanged from the original blocks): move on window
// (bubble), leave on document, down/up/cancel on window in CAPTURE phase
// — so overlay handlers that stopPropagation/preventDefault their
// pointerdown can't hide the press from the pipeline. Overlays keep
// presses out of the graph the sanctioned way instead:
// lib/pointer-claim.ts.

import type { CursorState } from "@/engine/types";
import { createCursorCaptureCore } from "./cursor-capture-core";
import { wasPointerClaimedSince } from "./pointer-claim";

export interface CursorCaptureHandle {
  /**
   * Ingest pending gestures and freeze the pass's snapshot. Call exactly
   * once per render pass, right before makeContext — every eval in the
   * pass must share one snapshot (that's what makes derived pulses
   * coherent), and each commit bumps `serial`, which is what clears them
   * on the next pass.
   */
  commit(): CursorState;
  /** Last committed snapshot, without bumping. */
  peek(): CursorState;
  /** Monotonic input revision — hosts throttle paused re-evals on it. */
  revision(): number;
  dispose(): void;
}

export interface CursorCaptureOpts {
  /** The preview canvas (or its exact-fit box) — pointer UVs are measured
   *  against its live bounding rect per event. */
  getBox: () => HTMLElement | null;
  /** Gate for editor veils (landing gateway). While false, moves and new
   *  presses are ignored; an in-flight gesture still gets to end. */
  isEnabled?: () => boolean;
  /** Fires after any event that changed capture state — the editor hangs
   *  its rAF-throttled paused-re-eval bump off this. */
  onInput?: () => void;
  win?: Window;
}

export function mountCursorCapture(opts: CursorCaptureOpts): CursorCaptureHandle {
  const win = opts.win ?? window;
  const core = createCursorCaptureCore(wasPointerClaimedSince);
  let lastRev = 0;

  const afterEvent = () => {
    const rev = core.revision();
    if (rev !== lastRev) {
      lastRev = rev;
      opts.onInput?.();
    }
  };
  const rect = () => {
    const el = opts.getBox();
    return el ? el.getBoundingClientRect() : null;
  };
  const enabled = () => opts.isEnabled?.() ?? true;

  const onMove = (e: PointerEvent) => {
    // Non-primary pointers (a second finger) must not drive the cursor —
    // same rule pointer-drag.ts applies to its gestures.
    if (e.isPrimary === false) return;
    if (!enabled()) return;
    core.move(e.clientX, e.clientY, rect(), e.timeStamp);
    afterEvent();
  };
  const onLeave = () => {
    core.leave();
    afterEvent();
  };
  const onDown = (e: PointerEvent) => {
    if (e.isPrimary === false) return;
    if (e.button !== 0) return;
    if (!enabled()) return;
    core.down(e.pointerId, e.clientX, e.clientY, rect(), e.timeStamp);
    afterEvent();
  };
  // Up/cancel bypass the enabled gate: a veil raised mid-gesture must not
  // strand a held press.
  const onUp = (e: PointerEvent) => {
    core.up(e.pointerId, e.clientX, e.clientY, rect(), e.timeStamp);
    afterEvent();
  };
  const onCancel = (e: PointerEvent) => {
    core.cancel(e.pointerId, e.timeStamp);
    afterEvent();
  };

  win.addEventListener("pointermove", onMove);
  win.document.addEventListener("pointerleave", onLeave);
  win.addEventListener("pointerdown", onDown, true);
  win.addEventListener("pointerup", onUp, true);
  win.addEventListener("pointercancel", onCancel, true);

  return {
    commit: () => core.commit(),
    peek: () => core.peek(),
    revision: () => core.revision(),
    dispose() {
      win.removeEventListener("pointermove", onMove);
      win.document.removeEventListener("pointerleave", onLeave);
      win.removeEventListener("pointerdown", onDown, true);
      win.removeEventListener("pointerup", onUp, true);
      win.removeEventListener("pointercancel", onCancel, true);
    },
  };
}
