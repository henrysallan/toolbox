// Pointer-gesture claims — how editor overlay gestures (gizmo drags,
// spline tools, paint strokes, 3D orbit) keep their presses out of the
// graph's cursor context. Spec: 081726_pointer-interaction.md §1.5.
//
// An overlay calls `claimPointerGesture(e.pointerId)` when it starts
// handling a gesture. The claim self-releases on that pointer's next
// pointerup/pointercancel (window capture, once) — no paired release
// call, so a forgotten release can't permanently mute the canvas.
//
// cursor-capture-core checks claims at COMMIT time (once per host render
// pass) via `wasPointerClaimedSince(pointerId, gestureStartMs)`. Two
// consequences that make the ordering work:
//   - The graph's window-level capture pointerdown fires BEFORE the
//     overlay's bubble-phase handler claims — but the press isn't counted
//     until the next commit, so a same-turn claim suppresses it
//     retroactively.
//   - A quick click-through (claim + auto-release before the commit ever
//     ran) still suppresses, because the query matches any claim interval
//     overlapping [gestureStart, now] — hence the release-time ledger,
//     not just an active set. Mouse pointerIds are reused across
//     gestures, so "was ever claimed" without a time window would be
//     wrong.
//
// Module-scope by design: every claim site is bound to the PRIMARY
// viewport, which is undetachable (see layout/panel-window.tsx invariant
// — pop-out panels never host these overlays), so the main window is the
// right listener target. Claims from gestures outside the preview box
// (panel dividers, number scrubs via startPointerDrag) are harmless
// no-ops — those presses were never counted to begin with.

// pointerId → number of live claims (two overlays may claim one gesture).
const activeClaims = new Map<number, number>();
// pointerId → performance.now() of the most recent full release.
const lastReleased = new Map<number, number>();

const RELEASE_LEDGER_MS = 10_000;

function releaseClaim(pointerId: number): void {
  const depth = activeClaims.get(pointerId) ?? 0;
  if (depth <= 1) {
    activeClaims.delete(pointerId);
    lastReleased.set(pointerId, performance.now());
    // Prune stale ledger entries so touch pointerIds (unique per
    // contact) don't accumulate forever.
    if (lastReleased.size > 32) {
      const cutoff = performance.now() - RELEASE_LEDGER_MS;
      for (const [id, t] of lastReleased) {
        if (t < cutoff) lastReleased.delete(id);
      }
    }
  } else {
    activeClaims.set(pointerId, depth - 1);
  }
}

/**
 * Mark the in-flight gesture on `pointerId` as consumed by an editor
 * overlay — the graph's cursor context will not count its press, hold, or
 * release. Call once at gesture start (pointerdown / drag begin); the
 * claim releases itself when the pointer goes up or cancels.
 */
export function claimPointerGesture(
  pointerId: number,
  win: Window = window
): void {
  activeClaims.set(pointerId, (activeClaims.get(pointerId) ?? 0) + 1);
  const onEnd = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    win.removeEventListener("pointerup", onEnd, true);
    win.removeEventListener("pointercancel", onEnd, true);
    releaseClaim(pointerId);
  };
  win.addEventListener("pointerup", onEnd, true);
  win.addEventListener("pointercancel", onEnd, true);
}

/**
 * True if `pointerId` is claimed now, or was released at/after `sinceMs`
 * — i.e. some claim interval overlapped [sinceMs, now]. `sinceMs` is the
 * gesture's pointerdown timestamp (performance.now() clock).
 */
export function wasPointerClaimedSince(
  pointerId: number,
  sinceMs: number
): boolean {
  if ((activeClaims.get(pointerId) ?? 0) > 0) return true;
  const released = lastReleased.get(pointerId);
  return released !== undefined && released >= sinceMs;
}
