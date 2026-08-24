import type { NodeDefinition, RenderContext } from "@/engine/types";
import { aspectUncorrectY } from "@/engine/aspect";
import {
  createCursorSignalState,
  deriveCursorSignals,
  type CursorSignalState,
} from "@/engine/cursor-signals";

// Pointer — the mouse/touch interaction signal vocabulary
// (081726_pointer-interaction.md §3.1). Turns ctx.cursor's monotonic
// facts into wireable signals: position, press/release/click pulses,
// held/drag levels, per-gesture drag delta, and an accumulated drag
// offset (the "virtual scrub" — drag anywhere, let go, drag again to
// keep adjusting). Click vs drag is discriminated by `slop`: a gesture
// that travels further than slop px is a drag, and its release doesn't
// pulse `click`.
//
// Position-typed outputs are AUTHORED space (y-down [0,1]², aspect.ts) —
// wire them straight into Transform translate, force centers, point
// params. ctx.cursor is y-UP canvas UV, so the flip + uncorrect happen
// here, at the socket boundary, like Cursor Trail Points.
//
// Edge derivation rides engine/cursor-signals.ts — pulses are exact
// under re-entrant evals (peek/Iterate/Time Offset) and never double-
// fire. Presses claimed by editor overlay gestures (gizmos, spline
// tools, paint) never reach this node at all.
//
// Works identically in the editor, /live/ links, and exported apps
// (both hosts mount lib/cursor-capture). Offline export sees the inert
// cursor default — every output rests at its initial value.

interface PointerState {
  signals: CursorSignalState;
  // Accumulated drag offset from FINISHED gestures, authored units,
  // sensitivity already applied. The live gesture's contribution is
  // added on top at output time.
  baseX: number;
  baseY: number;
  clickCount: number;
  clickX: number;
  clickY: number;
  // Last finished gesture's held duration (live gesture reports live).
  lastDuration: number;
  // Serial of the pass that last advanced press/release counts — the
  // fingerprint's pulse-tail (see fingerprintExtras).
  lastCountChangeSerial: number;
  // Pulses stay true for EVERY eval of their pass (that's what makes
  // them re-eval-safe), so += side effects must run once per pass —
  // these record the serial already folded.
  releaseFoldSerial: number;
  clickFoldSerial: number;
  lastSceneTime: number;
}

function stateKey(nodeId: string): string {
  return `pointer:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): PointerState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as PointerState | undefined;
  if (existing) return existing;
  const s: PointerState = {
    signals: createCursorSignalState(),
    baseX: 0,
    baseY: 0,
    clickCount: 0,
    clickX: 0.5,
    clickY: 0.5,
    lastDuration: 0,
    lastCountChangeSerial: -10,
    releaseFoldSerial: -10,
    clickFoldSerial: -10,
    lastSceneTime: ctx.time,
  };
  ctx.state[key] = s;
  return s;
}

// ctx.cursor (y-up canvas UV) → authored (y-down, aspect-uncorrected).
function toAuthored(
  x: number,
  yUp: number,
  ctx: RenderContext
): [number, number] {
  const aspect = ctx.height > 0 ? ctx.width / ctx.height : 1;
  return [x, aspectUncorrectY(1 - yUp, aspect)];
}

function resetInteraction(s: PointerState): void {
  s.baseX = 0;
  s.baseY = 0;
  s.clickCount = 0;
  s.clickX = 0.5;
  s.clickY = 0.5;
  s.lastDuration = 0;
}

function axisMask(axis: unknown): [number, number] {
  if (axis === "x") return [1, 0];
  if (axis === "y") return [0, 1];
  return [1, 1];
}

export const pointerNode: NodeDefinition = {
  type: "pointer",
  name: "Pointer",
  category: "utility",
  subcategory: "generator",
  description:
    "Mouse / touch interaction signals: cursor position (authored space), press / release / click pulses, held and drag-active levels, per-gesture drag delta, and an accumulated drag offset with axis lock and sensitivity — the virtual-scrub control. Click vs drag is split by the slop threshold. Wire click into Trigger Envelope for motion, drag_offset into a Transform translate, press into an Accumulator for click counting.",
  backend: "webgl2",
  // External pointer + wall-clock state — recompute every eval.
  stable: false,
  // Live input has no past/future to sample — Time Offset boundary-feeds
  // current values through un-shifted.
  retimeable: false,
  inputs: [
    // >0.5 zeros drag_offset / click_count / click_position and holds
    // them there while high (Accumulator's reset grammar).
    { name: "reset", type: "scalar", required: false },
  ],
  params: [
    {
      name: "slop",
      label: "Click slop (px)",
      type: "scalar",
      min: 0,
      max: 40,
      step: 1,
      default: 4,
    },
    {
      name: "axis",
      label: "Drag axis",
      type: "enum",
      options: ["both", "x", "y"],
      default: "both",
    },
    {
      name: "sensitivity",
      label: "Drag sensitivity",
      type: "scalar",
      min: 0,
      max: 10,
      softMax: 2,
      step: 0.01,
      default: 1,
    },
    {
      name: "clear_on_loop",
      label: "Clear on loop",
      type: "boolean",
      default: false,
    },
  ],
  primaryOutput: "vec2",
  auxOutputs: [
    { name: "held", type: "scalar" },
    { name: "press", type: "scalar" },
    { name: "release", type: "scalar" },
    { name: "click", type: "scalar" },
    { name: "click_position", type: "vec2" },
    { name: "drag_active", type: "scalar" },
    { name: "drag_delta", type: "vec2" },
    { name: "drag_offset", type: "vec2" },
    { name: "duration", type: "scalar" },
    { name: "click_count", type: "scalar" },
  ],

  // stable:false recomputes THIS node every eval; the extras token is for
  // DOWNSTREAM caches. It must change exactly when outputs can change:
  // quantized position/active (position + live drag), the counters (every
  // edge-derived output), a pulse tail (the pass AFTER a count change,
  // when pulses fall back to 0 — without it downstream would cache-hit on
  // the pulse-era value forever), a coarse time bucket while held
  // (duration ticks), accumulated state (drag base / clicks — covers
  // reset + loop-clear), and the loop-wrap flag itself so the clearing
  // pass busts immediately.
  fingerprintExtras(_params, ctx, nodeId) {
    const c = ctx.cursor;
    const s = nodeId
      ? (ctx.state[stateKey(nodeId)] as PointerState | undefined)
      : undefined;
    const serial = c.serial ?? 0;
    const pulseTail =
      s && serial - s.lastCountChangeSerial <= 1 ? serial : 0;
    const heldBucket = c.pressed
      ? Math.floor((performance.now() - (c.pressTimeMs ?? 0)) / 40)
      : -1;
    const wrap =
      s && ctx.time < s.lastSceneTime - 1e-6 ? 1 : 0;
    const acc = s
      ? `${s.baseX.toFixed(4)},${s.baseY.toFixed(4)},${s.clickCount},${s.clickX.toFixed(4)},${s.clickY.toFixed(4)}`
      : "0";
    return `ptr:${c.x.toFixed(5)},${c.y.toFixed(5)},${c.active ? 1 : 0},${c.pressCount ?? 0},${c.releaseCount ?? 0},${c.pressed ? 1 : 0},${pulseTail},${heldBucket},${wrap},${acc}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const s = ensureState(ctx, nodeId);
    const c = ctx.cursor;

    if (
      params.clear_on_loop === true &&
      ctx.time < s.lastSceneTime - 1e-6
    ) {
      resetInteraction(s);
    }
    s.lastSceneTime = ctx.time;

    const resetSignal =
      inputs.reset?.kind === "scalar" ? inputs.reset.value : 0;
    const resetHeld = resetSignal > 0.5;
    if (resetHeld) resetInteraction(s);

    const slopPx = Math.max(0, (params.slop as number) ?? 4);
    const sensitivity = (params.sensitivity as number) ?? 1;
    const [mx, my] = axisMask(params.axis);

    const sig = deriveCursorSignals(c, s.signals, slopPx);
    const serial = c.serial ?? 0;
    if (sig.press || sig.release) s.lastCountChangeSerial = serial;

    // Release edge: fold the finished gesture into the accumulated base
    // using the frozen press/release FACTS — exact even if no eval ran
    // mid-gesture. (If several full gestures landed between evals, only
    // the last one's endpoints are known; earlier ones are dropped. Both
    // hosts re-eval on every press/release, so that needs a stalled
    // pipeline AND rapid clicking.)
    if (sig.release && !resetHeld && s.releaseFoldSerial !== serial) {
      s.releaseFoldSerial = serial;
      const [px, py] = toAuthored(c.pressX ?? c.x, c.pressY ?? c.y, ctx);
      const [rx, ry] = toAuthored(c.releaseX ?? c.x, c.releaseY ?? c.y, ctx);
      s.baseX += (rx - px) * sensitivity * mx;
      s.baseY += (ry - py) * sensitivity * my;
      s.lastDuration = Math.max(
        0,
        ((c.releaseTimeMs ?? 0) - (c.pressTimeMs ?? 0)) / 1000
      );
    }
    if (sig.click && !resetHeld && s.clickFoldSerial !== serial) {
      s.clickFoldSerial = serial;
      s.clickCount += 1;
      const [ax, ay] = toAuthored(c.releaseX ?? c.x, c.releaseY ?? c.y, ctx);
      s.clickX = ax;
      s.clickY = ay;
    }

    const [posX, posY] = toAuthored(c.x, c.y, ctx);

    // Live gesture contribution (authored units, axis-locked).
    let deltaX = 0;
    let deltaY = 0;
    if (sig.held) {
      const [px, py] = toAuthored(c.pressX ?? c.x, c.pressY ?? c.y, ctx);
      deltaX = (posX - px) * mx;
      deltaY = (posY - py) * my;
    }
    const offX = s.baseX + deltaX * sensitivity;
    const offY = s.baseY + deltaY * sensitivity;

    const duration = sig.held
      ? Math.max(0, (performance.now() - (c.pressTimeMs ?? 0)) / 1000)
      : s.lastDuration;

    // While a gesture is held, duration and the drag outputs change with
    // wall-clock even when the pointer sits still — keep the paused
    // editor re-evaluating (Cursor Trail Points' pattern; the live
    // viewer runs every frame anyway, offline sees no gestures).
    if (sig.held && typeof window !== "undefined") {
      window.dispatchEvent(new Event("pipeline-bump"));
    }

    const bool = (v: boolean) =>
      ({ kind: "scalar", value: v ? 1 : 0 }) as const;
    return {
      primary: { kind: "vec2", value: [posX, posY] },
      aux: {
        held: bool(sig.held),
        press: bool(sig.press),
        release: bool(sig.release),
        click: bool(sig.click),
        click_position: { kind: "vec2", value: [s.clickX, s.clickY] },
        drag_active: bool(sig.dragActive),
        drag_delta: { kind: "vec2", value: [deltaX, deltaY] },
        drag_offset: { kind: "vec2", value: [offX, offY] },
        duration: { kind: "scalar", value: duration },
        click_count: { kind: "scalar", value: s.clickCount },
      },
    };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    delete ctx.state[stateKey(nodeId)];
  },
};
