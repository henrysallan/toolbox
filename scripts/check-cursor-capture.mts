// check-cursor-capture: guards the pointer-interaction fact pipeline
// (081726_pointer-interaction.md M0) — lib/cursor-capture-core.ts (the
// pure gesture state machine behind ctx.cursor), engine/cursor-signals.ts
// (per-node edge derivation), and lib/pointer-claim.ts (overlay gesture
// suppression).
//
// Why it exists: the graph is pull-based and re-entrant, so click events
// ride monotonic counters + a per-pass serial instead of cleared flags.
// The failure modes are all silent — a pulse that fires twice under
// re-eval, a claimed gizmo drag that leaks into the graph as a press, a
// Y-flip or press-inside-rect regression — and none of them are visible
// to typecheck. Every rule asserted here is stated in the spec §1.
//
//   npx tsx scripts/check-cursor-capture.mts

import { createCursorCaptureCore } from "@/lib/cursor-capture-core";
import {
  createCursorSignalState,
  deriveCursorSignals,
} from "@/engine/cursor-signals";
import {
  claimPointerGesture,
  wasPointerClaimedSince,
} from "@/lib/pointer-claim";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = Object.is(actual, expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${label}: expected ${String(expected)}, got ${String(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// A 200×100 CSS-px preview box at (100, 100).
const RECT = { left: 100, top: 100, width: 200, height: 100 };
const PID = 1;

function makeCore(claimed: (pointerId: number, sinceMs: number) => boolean) {
  return createCursorCaptureCore(claimed);
}
const never = () => false;

// --- UV math + press-inside rule ------------------------------------------
{
  const core = makeCore(never);
  core.down(PID, 200, 125, RECT, 1000);
  const snap = core.commit();
  check("press counts", snap.pressCount, 1);
  check("press x", snap.pressX, 0.5);
  // yDom = 25/100 = 0.25 → pipeline y-up = 0.75.
  check("press y is flipped", snap.pressY, 0.75);
  check("pressed level", snap.pressed, true);
  check("active", snap.active, true);
  check("serial bumped", snap.serial, 1);
}
{
  const core = makeCore(never);
  core.down(PID, 50, 50, RECT, 1000); // outside the box
  const snap = core.commit();
  check("outside press ignored", snap.pressCount, 0);
  check("outside press not held", snap.pressed, false);
}

// --- click vs drag discrimination -----------------------------------------
{
  // Click: press + 2px wiggle + release, all inside one pass.
  const core = makeCore(never);
  const st = createCursorSignalState();
  deriveCursorSignals(core.commit(), st, 4); // adopt baseline
  core.down(PID, 200, 125, RECT, 1000);
  core.move(202, 125, RECT, 1005);
  core.up(PID, 202, 125, RECT, 1010);
  const snap = core.commit();
  check("click: press+release one pass (press)", snap.pressCount, 1);
  check("click: press+release one pass (release)", snap.releaseCount, 1);
  const sig = deriveCursorSignals(snap, st, 4);
  check("click: press pulse", sig.press, true);
  check("click: release pulse", sig.release, true);
  check("click: click pulse (under slop)", sig.click, true);
  check("click: held false after release", sig.held, false);
  // Idempotent within the pass: a second derive (nested eval) agrees.
  const sig2 = deriveCursorSignals(snap, st, 4);
  check("click: re-derive idempotent", sig2.click, true);
  // Next pass clears the pulses.
  const sig3 = deriveCursorSignals(core.commit(), st, 4);
  check("click: pulse clears next pass", sig3.click || sig3.press || sig3.release, false);
}
{
  // Drag: press, 30px travel, release — release pulses, click must not.
  const core = makeCore(never);
  const st = createCursorSignalState();
  deriveCursorSignals(core.commit(), st, 4);
  core.down(PID, 200, 125, RECT, 1000);
  let sig = deriveCursorSignals(core.commit(), st, 4);
  check("drag: press pulse first", sig.press, true);
  check("drag: not dragActive yet", sig.dragActive, false);
  core.move(230, 125, RECT, 1010);
  sig = deriveCursorSignals(core.commit(), st, 4);
  check("drag: held during drag", sig.held, true);
  check("drag: dragActive past slop", sig.dragActive, true);
  check("drag: no press re-pulse", sig.press, false);
  core.up(PID, 230, 125, RECT, 1020);
  sig = deriveCursorSignals(core.commit(), st, 4);
  check("drag: release pulse", sig.release, true);
  check("drag: NOT a click", sig.click, false);
}

// --- node created mid-session adopts silently ------------------------------
{
  const core = makeCore(never);
  core.down(PID, 200, 125, RECT, 1000);
  core.up(PID, 200, 125, RECT, 1010);
  const snap = core.commit(); // history: one full click
  const st = createCursorSignalState();
  const sig = deriveCursorSignals(snap, st, 4);
  check("late node: no historical press", sig.press, false);
  check("late node: no historical click", sig.click, false);
}

// --- claim suppression ------------------------------------------------------
{
  // Same-turn claim (gizmo bubble handler after graph's capture handler):
  // resolved at commit → the press never counts.
  let claimed = false;
  const core = makeCore(() => claimed);
  core.down(PID, 200, 125, RECT, 1000);
  claimed = true; // overlay claims before the next commit
  const snap = core.commit();
  check("claim: press suppressed", snap.pressCount, 0);
  check("claim: not held", snap.pressed, false);
  // The suppressed gesture's release must not fire either.
  claimed = false;
  core.up(PID, 200, 125, RECT, 1010);
  const snap2 = core.commit();
  check("claim: release suppressed too", snap2.releaseCount, 0);
}
{
  // Late claim (overlay arms after a movement threshold, press already
  // counted): graph sees a synthetic release, poisoned so it never reads
  // as a click.
  let claimed = false;
  const core = makeCore(() => claimed);
  const st = createCursorSignalState();
  deriveCursorSignals(core.commit(), st, 4);
  core.down(PID, 200, 125, RECT, 1000);
  let sig = deriveCursorSignals(core.commit(), st, 4);
  check("late claim: press counted first", sig.press, true);
  claimed = true;
  sig = deriveCursorSignals(core.commit(), st, 4);
  check("late claim: synthetic release", sig.release, true);
  check("late claim: not a click", sig.click, false);
  check("late claim: held dropped", sig.held, false);
}

// --- pointercancel ----------------------------------------------------------
{
  const core = makeCore(never);
  const st = createCursorSignalState();
  deriveCursorSignals(core.commit(), st, 4);
  core.down(PID, 200, 125, RECT, 1000);
  deriveCursorSignals(core.commit(), st, 4);
  core.cancel(PID, 1010);
  const sig = deriveCursorSignals(core.commit(), st, 4);
  check("cancel: release pulse", sig.release, true);
  check("cancel: never a click", sig.click, false);
}

// --- fast double click in one pass ------------------------------------------
{
  const core = makeCore(never);
  core.down(PID, 200, 125, RECT, 1000);
  core.up(PID, 200, 125, RECT, 1005);
  core.down(PID, 200, 125, RECT, 1010);
  core.up(PID, 200, 125, RECT, 1015);
  const snap = core.commit();
  check("double: both presses count", snap.pressCount, 2);
  check("double: both releases count", snap.releaseCount, 2);
}

// --- revision throttling -----------------------------------------------------
{
  const core = makeCore(never);
  const r0 = core.revision();
  core.move(150, 150, RECT, 1000); // inside → bump
  const r1 = core.revision();
  check("revision: inside move bumps", r1 > r0, true);
  core.move(150.001, 150, RECT, 1001); // sub-epsilon
  check("revision: sub-epsilon move doesn't bump", core.revision(), r1);
  core.move(50, 50, RECT, 1002); // leaves the box → active flip bumps
  const r2 = core.revision();
  check("revision: leaving bumps", r2 > r1, true);
  core.move(40, 40, RECT, 1003); // outside, was outside → no bump
  check("revision: outside move doesn't bump", core.revision(), r2);
}

// --- pointer-claim registry --------------------------------------------------
{
  // Fake window capturing the auto-release listeners.
  type Listener = (ev: { pointerId: number }) => void;
  const ups: Listener[] = [];
  const fakeWin = {
    addEventListener: (type: string, fn: Listener) => {
      if (type === "pointerup") ups.push(fn);
    },
    removeEventListener: () => {},
  } as unknown as Window;

  const t0 = performance.now();
  claimPointerGesture(7, fakeWin);
  check("registry: active claim matches", wasPointerClaimedSince(7, t0), true);
  check("registry: other pointer clean", wasPointerClaimedSince(8, t0), false);
  // Auto-release on pointerup; the release-time ledger keeps the overlap
  // query true for gestures that started before the release (the
  // quick-click-through case).
  for (const fn of ups) fn({ pointerId: 7 });
  check("registry: overlap after release", wasPointerClaimedSince(7, t0), true);
  check(
    "registry: clean for gestures after release",
    wasPointerClaimedSince(7, performance.now() + 1),
    false
  );
}

// --- Pointer node end-to-end (capture core → signals → compute) -------------
// Drives the real capture core and feeds its snapshots into the Pointer
// node's compute with a stubbed context. 200×100 canvas → aspect 2, so
// authored-space conversion is observable: canvas-UV y-up 0.75 →
// authored y 0.375. Scalar reset is passed directly (same-kind wire —
// no coercion applies).
{
  const { pointerNode } = await import("@/nodes/source/pointer");
  type V2 = { kind: "vec2"; value: [number, number] };
  type Sc = { kind: "scalar"; value: number };

  const sharedState: Record<string, unknown> = {};
  const makeCtx = (cursor: unknown, time = 0) =>
    ({
      cursor,
      state: sharedState,
      time,
      width: 200,
      height: 100,
    }) as never;
  const run = (cursor: unknown, extra?: Record<string, unknown>) =>
    pointerNode.compute({
      inputs: (extra ?? {}) as never,
      auxIn: {} as never,
      params: { slop: 4, axis: "both", sensitivity: 1, clear_on_loop: false },
      ctx: makeCtx(cursor),
      nodeId: "p1",
    }) as { primary: V2; aux: Record<string, V2 | Sc> };

  const core = makeCore(never);
  run(core.commit()); // adopt baseline

  // Click at box center: press+release, zero travel, in one pass (a
  // gesture WITH travel would also fold into drag_offset's base and
  // muddy the drag assertions below — clicks accumulate too, by design).
  core.down(PID, 200, 125, RECT, 1000);
  core.up(PID, 200, 125, RECT, 1010);
  let out = run(core.commit());
  check("node: click pulse", (out.aux.click as Sc).value, 1);
  check("node: click_count", (out.aux.click_count as Sc).value, 1);
  const cp = (out.aux.click_position as V2).value;
  check("node: click_position x", Math.abs(cp[0] - 0.5) < 1e-6, true);
  check("node: click_position y authored", Math.abs(cp[1] - 0.375) < 1e-6, true);
  out = run(core.commit());
  check("node: pulse clears", (out.aux.click as Sc).value, 0);

  // Drag 40 CSS px right (canvas UV Δx = 0.2): no click, offset lands.
  core.down(PID, 200, 125, RECT, 2000);
  core.move(240, 125, RECT, 2005);
  out = run(core.commit());
  check("node: held during drag", (out.aux.held as Sc).value, 1);
  check("node: drag_active", (out.aux.drag_active as Sc).value, 1);
  const dd = (out.aux.drag_delta as V2).value;
  check("node: drag_delta x", Math.abs(dd[0] - 0.2) < 1e-6, true);
  check("node: drag_delta y", Math.abs(dd[1]) < 1e-6, true);
  core.up(PID, 240, 125, RECT, 2010);
  out = run(core.commit());
  check("node: drag release not a click", (out.aux.click as Sc).value, 0);
  check("node: click_count unchanged", (out.aux.click_count as Sc).value, 1);
  const off = (out.aux.drag_offset as V2).value;
  check("node: drag_offset accumulated", Math.abs(off[0] - 0.2) < 1e-6, true);
  out = run(core.commit());
  check(
    "node: drag_offset persists after gesture",
    Math.abs((out.aux.drag_offset as V2).value[0] - 0.2) < 1e-6,
    true
  );

  // Reset input zeros the accumulated state and holds it.
  out = run(core.commit(), { reset: { kind: "scalar", value: 1 } });
  check("node: reset zeros offset", (out.aux.drag_offset as V2).value[0], 0);
  check("node: reset zeros count", (out.aux.click_count as Sc).value, 0);

  // Fingerprint pulse-tail: the pass after a count change must differ
  // (pulse-era downstream caches bust), then go stable.
  const fpState: Record<string, unknown> = {};
  const fpCore = makeCore(never);
  const fpCtxOf = (cursor: unknown) =>
    ({ cursor, state: fpState, time: 0, width: 200, height: 100 }) as never;
  const pass = (cursor: unknown) => {
    const fp = pointerNode.fingerprintExtras!({}, fpCtxOf(cursor), "p1");
    pointerNode.compute({
      inputs: {} as never,
      auxIn: {} as never,
      params: { slop: 4, axis: "both", sensitivity: 1, clear_on_loop: false },
      ctx: fpCtxOf(cursor),
      nodeId: "p1",
    });
    return fp;
  };
  pass(fpCore.commit());
  fpCore.down(PID, 200, 125, RECT, 3000);
  fpCore.up(PID, 200, 125, RECT, 3005);
  const fpPulse = pass(fpCore.commit());
  const fpAfter = pass(fpCore.commit());
  const fpQuiet1 = pass(fpCore.commit());
  const fpQuiet2 = pass(fpCore.commit());
  check("node: fp busts on pulse decay", fpPulse === fpAfter, false);
  check("node: fp settles when quiet", fpQuiet1 === fpQuiet2, true);
}

// --- Trigger Envelope (timeline clock → deterministic) ----------------------
{
  const { triggerEnvelopeNode } = await import(
    "@/nodes/effect/trigger-envelope"
  );
  const state: Record<string, unknown> = {};
  const P = {
    attack: 1,
    hold: 1,
    release: 2,
    attack_curve: "linear",
    release_curve: "linear",
    retrigger: "restart",
    clock: "timeline",
  };
  const run = (time: number, trigger: number, params = P) =>
    (
      triggerEnvelopeNode.compute({
        inputs: { trigger: { kind: "scalar", value: trigger } } as never,
        auxIn: {} as never,
        params: params as never,
        ctx: { state, time } as never,
        nodeId: "e1",
      }) as { primary: { value: number } }
    ).primary.value;

  check("env: idle before trigger", run(0, 0), 0);
  check("env: attack starts at 0", run(1, 1), 0);
  check("env: mid-attack (linear)", run(1.5, 1), 0.5);
  check("env: hold plateau", run(2.5, 1), 1);
  check("env: mid-release", run(4, 1), 0.5);
  check("env: finished", run(6, 1), 0);
  // Held-high trigger is a LEVEL — only the rising edge fires, so the
  // envelope above ran through while trigger stayed 1. Now drop + rise
  // mid-envelope under both retrigger modes.
  check("env: falling edge no-op", run(6.5, 0), 0);
  check("env: retrigger restarts", run(7, 1), 0);
  check("env: restart mid-attack", run(7.5, 1), 0.5);
  run(7.6, 0); // drop while active
  const ignoreP = { ...P, retrigger: "ignore" };
  check(
    "env: ignore mode holds phase",
    run(8, 1, ignoreP),
    1 // elapsed 1 since t0=7 → hold plateau, edge ignored
  );
}

// --- Sample & Hold ----------------------------------------------------------
{
  const { sampleHoldNode } = await import("@/nodes/effect/sample-hold");
  const state: Record<string, unknown> = {};
  const run = (
    value: unknown,
    trigger: number,
    params: Record<string, unknown> = { type: "vec2", initial: "follow" }
  ) =>
    (
      sampleHoldNode.compute({
        inputs: {
          value,
          trigger: { kind: "scalar", value: trigger },
        } as never,
        auxIn: {} as never,
        params: params as never,
        ctx: { state, time: 0 } as never,
        nodeId: "s1",
      }) as { primary: { kind: string; value: number | number[] } }
    ).primary;

  const v = (x: number, y: number) => ({ kind: "vec2", value: [x, y] });
  let out = run(v(0.3, 0.7), 0);
  check(
    "s&h: follows before first trigger",
    (out.value as number[])[1],
    0.7
  );
  out = run(v(0.3, 0.7), 1); // rising edge → latch
  check("s&h: latches on edge", (out.value as number[])[0], 0.3);
  out = run(v(0.9, 0.9), 1); // still high — no new edge
  check("s&h: held while input moves", (out.value as number[])[0], 0.3);
  out = run(v(0.9, 0.9), 0);
  check("s&h: held after trigger drops", (out.value as number[])[0], 0.3);
  out = run(v(0.9, 0.1), 1); // new edge → re-latch
  check("s&h: re-latches", (out.value as number[])[1], 0.1);
  // Scalar wired into a vec2-typed socket broadcasts (matches the
  // evaluator's scalar→vec coercion the live wire would apply).
  const state2: Record<string, unknown> = {};
  const runZero = () =>
    sampleHoldNode.compute({
      inputs: {} as never,
      auxIn: {} as never,
      params: { type: "scalar", initial: "zero" } as never,
      ctx: { state: state2, time: 0 } as never,
      nodeId: "s2",
    }) as { primary: { value: number } };
  check("s&h: zero mode rests at 0", runZero().primary.value, 0);
}

// --- Hit Region grab semantics ----------------------------------------------
// Synthetic field: 1 inside a disk of UV-radius 0.2 around the box
// center (0.5, 0.5), 0 outside. Cursor snapshots come from the real
// capture core, so press/hover positions arrive through the same facts
// the live node reads.
{
  const { deriveHitRegion, createHitRegionState } = await import(
    "@/nodes/effect/hit-region"
  );
  const disk = (x: number, y: number) =>
    Math.hypot(x - 0.5, y - 0.5) <= 0.2 ? 1 : 0;

  const core = makeCore(never);
  const st = createHitRegionState();
  const derive = (cursor: unknown) =>
    deriveHitRegion(cursor as never, st, 4, 0.5, disk);

  // Hover: inside → true; outside → false.
  core.move(200, 150, RECT, 100); // center → uv (0.5, 0.5)
  check("hit: hover inside", derive(core.commit()).hover, true);
  core.move(280, 150, RECT, 110); // uv (0.9, 0.5) — outside
  check("hit: hover outside", derive(core.commit()).hover, false);

  // Press OUTSIDE the region: the gesture is never owned, even when the
  // cursor wanders in mid-drag.
  core.down(PID, 280, 150, RECT, 200);
  let sig = derive(core.commit());
  check("hit: outside press not owned", sig.press, false);
  core.move(200, 150, RECT, 210); // drag INTO the disk
  sig = derive(core.commit());
  check("hit: unowned drag not held", sig.held, false);
  check("hit: but hover still live", sig.hover, true);
  core.up(PID, 200, 150, RECT, 220);
  sig = derive(core.commit());
  check("hit: unowned release silent", sig.release, false);

  // Press INSIDE: owned; leaving mid-drag keeps the grab (real-button
  // rule); release far outside still fires release (but not click —
  // travel blew past slop).
  core.down(PID, 200, 150, RECT, 300);
  sig = derive(core.commit());
  check("hit: inside press owned", sig.press, true);
  check("hit: held on press", sig.held, true);
  core.move(280, 150, RECT, 310); // drag OUT of the disk
  sig = derive(core.commit());
  check("hit: grab survives exit", sig.held, true);
  check("hit: hover follows cursor out", sig.hover, false);
  core.up(PID, 280, 150, RECT, 320);
  const snap = core.commit();
  sig = derive(snap);
  check("hit: owned release fires", sig.release, true);
  check("hit: dragged release is not a click", sig.click, false);
  // Re-derive on the same snapshot (nested eval) must agree even though
  // the release edge cleared `owned`.
  check("hit: release re-derive idempotent", derive(snap).release, true);

  // Clean in-place click inside the region.
  core.down(PID, 200, 150, RECT, 400);
  core.up(PID, 201, 150, RECT, 410);
  sig = derive(core.commit());
  check("hit: click inside", sig.click, true);
}

// --- Pointer re-entrancy regression -----------------------------------------
// Pulses stay true for every eval of their pass, so a second compute on
// the SAME snapshot (peek / spreadsheet forced branch) must not
// double-fold drag_offset or double-count clicks.
{
  const { pointerNode } = await import("@/nodes/source/pointer");
  type Sc = { kind: "scalar"; value: number };
  type V2 = { kind: "vec2"; value: [number, number] };
  const state: Record<string, unknown> = {};
  const run = (cursor: unknown) =>
    pointerNode.compute({
      inputs: {} as never,
      auxIn: {} as never,
      params: { slop: 4, axis: "both", sensitivity: 1, clear_on_loop: false },
      ctx: { cursor, state, time: 0, width: 200, height: 100 } as never,
      nodeId: "pr1",
    }) as { aux: Record<string, Sc | V2> };
  const core = makeCore(never);
  run(core.commit());
  core.down(PID, 200, 125, RECT, 1000);
  core.move(240, 125, RECT, 1005);
  core.up(PID, 240, 125, RECT, 1010);
  const snap = core.commit();
  run(snap);
  const second = run(snap); // same pass, second eval
  check(
    "reentry: drag_offset not double-folded",
    Math.abs((second.aux.drag_offset as V2).value[0] - 0.2) < 1e-6,
    true
  );
  core.down(PID, 200, 125, RECT, 2000);
  core.up(PID, 200, 125, RECT, 2005);
  const snap2 = core.commit();
  run(snap2);
  check(
    "reentry: click_count not double-counted",
    ((run(snap2).aux.click_count as Sc).value),
    1
  );
}

// --- Drag Points ------------------------------------------------------------
{
  const { dragPointsNode } = await import("@/nodes/effect/drag-points");
  const { makePoints } = await import("@/engine/points");
  type Sc = { kind: "scalar"; value: number };
  type Pts = { positions: Float32Array; count: number };

  // Two points, authored space: one at the canvas center (0.5, 0.5),
  // one far right. Canvas 200×100 (aspect 2).
  const src = makePoints(2);
  src.positions.set([0.5, 0.5, 0.9, 0.5]);

  const state: Record<string, unknown> = {};
  const run = (cursor: unknown, reset = 0) =>
    dragPointsNode.compute({
      inputs: {
        points: src,
        reset: { kind: "scalar", value: reset },
      } as never,
      auxIn: {} as never,
      params: { grab_radius: 16, clear_on_loop: false } as never,
      ctx: { cursor, state, time: 0, width: 200, height: 100 } as never,
      nodeId: "d1",
    }) as { primary: Pts; aux: Record<string, Sc> };

  const core = makeCore(never);
  run(core.commit());

  // Press at the center point (authored (0.5, 0.5) → canvas center →
  // client (200, 150)); drag right 40 CSS px (authored Δx 0.2).
  core.down(PID, 200, 150, RECT, 1000);
  let out = run(core.commit());
  check("dragp: grabs nearest", (out.aux.active_index as Sc).value, 0);
  core.move(240, 150, RECT, 1010);
  out = run(core.commit());
  check(
    "dragp: live offset",
    Math.abs(out.primary.positions[0] - 0.7) < 1e-6,
    true
  );
  check(
    "dragp: other point untouched",
    Math.abs(out.primary.positions[2] - 0.9) < 1e-6,
    true
  );
  core.up(PID, 240, 150, RECT, 1020);
  const relSnap = core.commit();
  out = run(relSnap);
  check("dragp: released", (out.aux.active_index as Sc).value, -1);
  check(
    "dragp: offset persists",
    Math.abs(out.primary.positions[0] - 0.7) < 1e-6,
    true
  );
  out = run(relSnap); // re-entrant release pass
  check(
    "dragp: release re-eval stable",
    Math.abs(out.primary.positions[0] - 0.7) < 1e-6,
    true
  );

  // Press far from any point: nothing grabbed, nothing moves.
  core.down(PID, 150, 130, RECT, 2000);
  out = run(core.commit());
  check("dragp: empty press grabs nothing", (out.aux.active_index as Sc).value, -1);
  core.up(PID, 150, 130, RECT, 2010);
  run(core.commit());

  // Reset zeroes the moved point back to its source position.
  out = run(core.commit(), 1);
  check(
    "dragp: reset restores",
    Math.abs(out.primary.positions[0] - 0.5) < 1e-6,
    true
  );
}

// --- Draggable (offset-compensated grab) ------------------------------------
{
  const { deriveDraggable, createDraggableState } = await import(
    "@/nodes/effect/draggable"
  );
  // Un-translated handle: disk of UV-radius 0.15 at canvas center.
  const disk = (x: number, y: number) =>
    Math.hypot(x - 0.5, y - 0.5) <= 0.15 ? 1 : 0;
  const OPTS = {
    slopPx: 4,
    threshold: 0.5,
    sensitivity: 1,
    axisX: 1,
    axisY: 1,
    aspect: 2,
  };
  const core = makeCore(never);
  const st = createDraggableState();
  const derive = (cursor: unknown) =>
    deriveDraggable(cursor as never, st, OPTS, disk);
  derive(core.commit());

  // Grab at center, drag right 40 px (authored Δx 0.2), release.
  core.down(PID, 200, 150, RECT, 1000);
  let r = derive(core.commit());
  check("drgbl: grabbed at rest position", r.sig.held, true);
  core.move(240, 150, RECT, 1010);
  r = derive(core.commit());
  check("drgbl: live offset", Math.abs(r.offX - 0.2) < 1e-6, true);
  core.up(PID, 240, 150, RECT, 1020);
  r = derive(core.commit());
  check("drgbl: offset settles", Math.abs(r.offX - 0.2) < 1e-6, true);
  check("drgbl: released", r.sig.held, false);

  // The shape now sits at +0.2: pressing its OLD position misses, its
  // NEW position (client 240) grabs — the offset-compensated hit test.
  core.down(PID, 200, 150, RECT, 2000);
  r = derive(core.commit());
  check("drgbl: old position no longer grabs", r.sig.held, false);
  core.up(PID, 200, 150, RECT, 2010);
  derive(core.commit());
  core.down(PID, 240, 150, RECT, 3000);
  r = derive(core.commit());
  check("drgbl: moved shape grabs at new position", r.sig.held, true);
  core.up(PID, 240, 150, RECT, 3010);
  r = derive(core.commit());
  check("drgbl: second drag keeps base", Math.abs(r.offX - 0.2) < 1e-6, true);
}

console.log(
  failures === 0
    ? "\ncheck-cursor-capture: all passed"
    : `\ncheck-cursor-capture: ${failures} FAILURES`
);
if (failures > 0) process.exit(1);
