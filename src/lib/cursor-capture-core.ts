// The pure gesture state machine behind ctx.cursor — DOM-free so
// scripts/check-cursor-capture.mts can drive it with synthetic events.
// lib/cursor-capture.ts is the thin DOM binding; EffectsApp and
// LiveViewer both mount that, which is what keeps the editor and
// exported apps behaviorally identical. Spec: 081726_pointer-interaction.md §1.
//
// Model: pointer events mutate PENDING state immediately (position is a
// level — it can update live), but presses/releases only become visible
// facts at commit(), which the host calls once per render pass. That
// deferral is load-bearing twice over:
//   - serial: every eval in a pass sees one frozen snapshot; the next
//     commit bumps `serial`, clearing derived pulses
//     (engine/cursor-signals.ts).
//   - claims: an overlay's bubble-phase claim lands AFTER the graph's
//     capture-phase pointerdown but BEFORE the next commit, so
//     suppression is checked exactly once, at commit, and same-turn
//     claims win retroactively (lib/pointer-claim.ts).
//
// Coordinate note: x/y are canvas UV Y-UP (DOM y flipped once, here and
// nowhere else). Travel distances are CSS px — screen-perceived slop.

import type { CursorState } from "@/engine/types";

export interface BoxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Claim-overlap query, injected so tests can fake the registry
// (production wires lib/pointer-claim.ts's wasPointerClaimedSince).
export type ClaimQuery = (pointerId: number, sinceMs: number) => boolean;

// Travel assigned to gestures that must never read as a click
// (pointercancel, late-claim aborts). Keep in sync with the constant in
// engine/cursor-signals.ts.
const NEVER_CLICK_DIST = 1e9;

// Position delta (UV) below which a move doesn't bump `revision` — the
// same guard the editor's paused-re-render path used, kept here so hosts
// don't re-render on sub-pixel jitter.
const MOVE_EPSILON = 1e-4;

interface Gesture {
  pointerId: number;
  downTimeMs: number;
  startClientX: number;
  startClientY: number;
  uvX: number;
  uvY: number;
  maxDistPx: number;
  claimResolved: boolean;
  suppressed: boolean;
  counted: boolean;
  ended: boolean;
  cancelled: boolean;
  endTimeMs: number;
  endUvX: number;
  endUvY: number;
}

export interface CursorCaptureCore {
  move(clientX: number, clientY: number, rect: BoxRect | null, timeMs: number): void;
  down(
    pointerId: number,
    clientX: number,
    clientY: number,
    rect: BoxRect | null,
    timeMs: number
  ): void;
  up(
    pointerId: number,
    clientX: number,
    clientY: number,
    rect: BoxRect | null,
    timeMs: number
  ): void;
  cancel(pointerId: number, timeMs: number): void;
  leave(): void;
  /** Ingest pending gestures, bump serial, freeze and return the snapshot. */
  commit(): CursorState;
  /** The last committed snapshot (initial default before any commit). */
  peek(): CursorState;
  /** Bumps on any state-affecting input — hosts use it to throttle re-evals. */
  revision(): number;
}

function toUv(clientX: number, clientY: number, rect: BoxRect) {
  const x = (clientX - rect.left) / rect.width;
  const yDom = (clientY - rect.top) / rect.height;
  // DOM y-down → pipeline y-up: engine textures put v_uv.y = 0 at the
  // frame's bottom. This is the ONE place the flip happens.
  return { x, y: 1 - yDom, inside: x >= 0 && x <= 1 && yDom >= 0 && yDom <= 1 };
}

export function createCursorCaptureCore(
  wasClaimedSince: ClaimQuery
): CursorCaptureCore {
  // Live position (updates immediately; a level, not an edge).
  let curX = 0.5;
  let curY = 0.5;
  let curActive = false;

  // FIFO so two full click cycles inside one render pass both count —
  // at most one entry is un-ended at any time.
  const gestures: Gesture[] = [];

  let serial = 0;
  let rev = 0;
  let pressCount = 0;
  let releaseCount = 0;
  let pressX: number | undefined;
  let pressY: number | undefined;
  let pressTimeMs: number | undefined;
  let releaseX: number | undefined;
  let releaseY: number | undefined;
  let releaseTimeMs: number | undefined;
  // Frozen travel of the last finished counted gesture; live travel of
  // the in-flight one wins while it exists.
  let frozenMaxDistPx = 0;

  let snapshot: CursorState = {
    x: curX,
    y: curY,
    active: false,
    pressed: false,
    serial: 0,
    pressCount: 0,
    releaseCount: 0,
    gestureMaxDistPx: 0,
  };

  const liveGesture = (): Gesture | null => {
    const last = gestures[gestures.length - 1];
    return last && !last.ended ? last : null;
  };

  function trackTravel(clientX: number, clientY: number): void {
    const g = liveGesture();
    if (!g) return;
    const d = Math.hypot(clientX - g.startClientX, clientY - g.startClientY);
    if (d > g.maxDistPx) g.maxDistPx = d;
  }

  return {
    move(clientX, clientY, rect, _timeMs) {
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const { x, y, inside } = toUv(clientX, clientY, rect);
      const prevActive = curActive;
      const changed =
        Math.abs(x - curX) >= MOVE_EPSILON ||
        Math.abs(y - curY) >= MOVE_EPSILON ||
        inside !== prevActive;
      curX = x;
      curY = y;
      curActive = inside;
      trackTravel(clientX, clientY);
      // Movement outside the box only matters when it changes `active`
      // (leaving) or feeds an in-flight gesture — matches the editor's
      // old "inside || prev.active" re-render guard.
      if (changed && (inside || prevActive || liveGesture())) rev++;
    },

    down(pointerId, clientX, clientY, rect, timeMs) {
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const { x, y, inside } = toUv(clientX, clientY, rect);
      // Presses only count when they START inside the preview box —
      // existing `pressed` rule, unchanged.
      if (!inside) return;
      // Single primary gesture at a time (the binding already filters
      // non-primary pointers; this guards re-entrant downs).
      if (liveGesture()) return;
      curX = x;
      curY = y;
      curActive = true;
      gestures.push({
        pointerId,
        downTimeMs: timeMs,
        startClientX: clientX,
        startClientY: clientY,
        uvX: x,
        uvY: y,
        maxDistPx: 0,
        claimResolved: false,
        suppressed: false,
        counted: false,
        ended: false,
        cancelled: false,
        endTimeMs: timeMs,
        endUvX: x,
        endUvY: y,
      });
      rev++;
    },

    up(pointerId, clientX, clientY, rect, timeMs) {
      const g = liveGesture();
      if (!g || g.pointerId !== pointerId) return;
      trackTravel(clientX, clientY);
      g.ended = true;
      g.endTimeMs = timeMs;
      if (rect && rect.width > 0 && rect.height > 0) {
        const { x, y } = toUv(clientX, clientY, rect);
        g.endUvX = x;
        g.endUvY = y;
      } else {
        g.endUvX = curX;
        g.endUvY = curY;
      }
      rev++;
    },

    cancel(pointerId, timeMs) {
      const g = liveGesture();
      if (!g || g.pointerId !== pointerId) return;
      g.ended = true;
      g.cancelled = true;
      g.endTimeMs = timeMs;
      g.endUvX = curX;
      g.endUvY = curY;
      rev++;
    },

    leave() {
      if (!curActive) return;
      curActive = false;
      rev++;
    },

    commit() {
      serial++;
      for (const g of gestures) {
        if (!g.claimResolved) {
          g.claimResolved = true;
          g.suppressed = wasClaimedSince(g.pointerId, g.downTimeMs);
        } else if (
          g.counted &&
          !g.ended &&
          !g.suppressed &&
          wasClaimedSince(g.pointerId, g.downTimeMs)
        ) {
          // Late claim (an overlay that arms after a movement threshold):
          // the press already counted, so abort gracefully — synthetic
          // release at the current position, travel poisoned so it can
          // never read as a click.
          g.suppressed = true;
          releaseCount++;
          releaseX = curX;
          releaseY = curY;
          releaseTimeMs = g.endTimeMs;
          frozenMaxDistPx = NEVER_CLICK_DIST;
        }
        if (!g.suppressed && !g.counted) {
          g.counted = true;
          pressCount++;
          pressX = g.uvX;
          pressY = g.uvY;
          pressTimeMs = g.downTimeMs;
        }
        if (g.ended && g.counted && !g.suppressed) {
          releaseCount++;
          releaseX = g.endUvX;
          releaseY = g.endUvY;
          releaseTimeMs = g.endTimeMs;
          frozenMaxDistPx = g.cancelled ? NEVER_CLICK_DIST : g.maxDistPx;
        }
      }
      // Drop everything fully processed; keep at most the in-flight one.
      for (let i = gestures.length - 1; i >= 0; i--) {
        if (gestures[i].ended || gestures[i].suppressed) gestures.splice(i, 1);
      }
      const live = liveGesture();
      const owned = live !== null && live.counted;
      snapshot = {
        x: curX,
        y: curY,
        active: curActive,
        pressed: owned,
        serial,
        pressCount,
        releaseCount,
        pressX,
        pressY,
        releaseX,
        releaseY,
        pressTimeMs,
        releaseTimeMs,
        gestureMaxDistPx: owned ? live.maxDistPx : frozenMaxDistPx,
      };
      return snapshot;
    },

    peek() {
      return snapshot;
    },

    revision() {
      return rev;
    },
  };
}
