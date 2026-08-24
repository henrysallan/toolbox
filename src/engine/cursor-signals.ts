// Edge derivation over CursorState's monotonic facts — THE way a node
// turns press/release counters into one-frame pulses. Pure; no DOM.
// Spec: specdocs/081726_pointer-interaction.md §1.2.
//
// Why not a boolean on the context: several evals can run per visual
// frame (socket peek, spreadsheet, Iterate / Time Offset nested evals),
// so a cleared-after-read flag fires for whichever eval reads it first.
// Here a node remembers the last counter values it saw in its own
// ctx.state; when a counter advances it records the snapshot's `serial`,
// and the pulse reads true for exactly the passes that share that serial.
// Re-deriving within the same pass is idempotent; the next commit bumps
// the serial and the pulse clears.
//
// Usage inside a node's compute (state lives under the node's ctx.state
// key, one CursorSignalState per node):
//
//   const st = (state.signals ??= createCursorSignalState());
//   const sig = deriveCursorSignals(ctx.cursor, st, slopPx);
//   if (sig.press) { ... }        // rising edge, once per press
//
// A node created mid-session adopts the current counters WITHOUT firing
// pulses for historical presses.

import type { CursorState } from "./types";

// Travel value assigned to gestures that must never read as a click
// (pointercancel, late-claimed aborts). Mirrors cursor-capture-core's
// NEVER_CLICK_DIST; duplicated as a plain constant to keep this module
// engine-side and dependency-free.
const NEVER_CLICK_PX = 1e9;

export interface CursorSignalState {
  seenPress?: number;
  seenRelease?: number;
  pressSerial?: number;
  releaseSerial?: number;
  clickSerial?: number;
}

export interface CursorSignals {
  // Levels.
  held: boolean;
  // True while held AND travel has exceeded slop — "this gesture is a
  // drag, not a click in progress".
  dragActive: boolean;
  // One-frame pulses (true for every eval of the pass they occurred in).
  press: boolean;
  release: boolean;
  // Release whose whole gesture stayed within `slopPx` of the press
  // point — the click/drag discrimination. A drag's release pulses
  // `release` but not `click`.
  click: boolean;
}

export function createCursorSignalState(): CursorSignalState {
  return {};
}

export function deriveCursorSignals(
  cursor: CursorState,
  st: CursorSignalState,
  slopPx: number
): CursorSignals {
  const serial = cursor.serial ?? 0;
  const pressCount = cursor.pressCount ?? 0;
  const releaseCount = cursor.releaseCount ?? 0;
  const travel = cursor.gestureMaxDistPx ?? NEVER_CLICK_PX;

  if (st.seenPress === undefined) {
    // First derive for this node: adopt silently, no historical pulses.
    st.seenPress = pressCount;
    st.seenRelease = releaseCount;
  }
  if (pressCount !== st.seenPress) {
    st.seenPress = pressCount;
    st.pressSerial = serial;
  }
  if (releaseCount !== st.seenRelease) {
    st.seenRelease = releaseCount;
    st.releaseSerial = serial;
    // gestureMaxDistPx is frozen at release for the finished gesture, so
    // reading it on the release edge is exact even when press+release
    // landed in the same commit.
    if (travel <= slopPx) st.clickSerial = serial;
  }

  const held = !!cursor.pressed;
  return {
    held,
    dragActive: held && travel > slopPx,
    press: st.pressSerial === serial,
    release: st.releaseSerial === serial,
    click: st.clickSerial === serial,
  };
}
