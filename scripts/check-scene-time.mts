// Guards Scene Time's stepped mode and the node's saved-param migrations:
//   - stepped is "change by step_size every step duration": the duration is
//     step_seconds or step_frames per `unit`, the output is
//     (index + eased fraction)·step_size + offset, and the global `scale` is
//     ignored (it is hidden for the mode),
//   - easing=step is a hard staircase, easing=linear a plain ramp whose
//     speed is step_size / duration,
//   - a pre-2026-09-19 save — where `step_size` was the step DURATION and
//     `scale` turned time units into output units — migrates losslessly
//     (duration = old step_size, size = old step_size·scale) for any easing,
//     in either unit, regardless of mode, and the migration is idempotent,
//   - the ping-pong `period → rate → period_frames` + `scale/offset →
//     amplitude` fold still runs after moving next to the def,
//   - the def hides `scale` for stepped and shows exactly one duration row.
//
//   npx tsx scripts/check-scene-time.mts

import { applyEasing } from "../src/engine/easing.ts";
import { sampleFloatCurve, type CurvePoint } from "../src/engine/float-curve.ts";
import {
  CUSTOM_EASING,
  STEP_FRAMES_DEFAULT,
  STEP_SECONDS_DEFAULT,
  migrateSceneTimeParams,
  sceneTimeNode,
} from "../src/nodes/source/scene-time.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail && !cond ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

const TPF = 1000;
const FPS = 60;
// Scene Time reads only the clock fields; the rest of RenderContext is
// irrelevant to a scalar source.
function ctxAt(seconds: number) {
  return {
    time: seconds,
    frame: Math.floor(seconds * FPS),
    tick: seconds * FPS * TPF,
    ticksPerFrame: TPF,
    fps: FPS,
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
function value(params: Record<string, unknown>, seconds: number): number {
  const out = sceneTimeNode.compute({
    inputs: {},
    auxIn: {},
    params,
    ctx: ctxAt(seconds),
    nodeId: "t",
    consumedOutputs: new Set(["primary"]),
  } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
  const v = out?.primary;
  if (!v || v.kind !== "scalar") throw new Error("scene-time did not emit a scalar");
  return v.value;
}
// Fresh-node params: every def default, then overrides.
function fresh(over: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const d of sceneTimeNode.params) p[d.name] = d.default;
  return { ...p, ...over };
}

// ---------------------------------------------------------------------
// 1. Stepped compute
// ---------------------------------------------------------------------
{
  // +0.25 every 0.5 s, hard staircase, starting at 2.
  const p = fresh({
    mode: "stepped",
    unit: "seconds",
    step_size: 0.25,
    step_seconds: 0.5,
    easing: "step",
    offset: 2,
  });
  check("t=0 holds the offset", close(value(p, 0), 2));
  check("t=0.49 has not completed a step", close(value(p, 0.49), 2));
  check("t=0.5 has completed one step", close(value(p, 0.5), 2.25));
  check("t=1.2 has completed two steps", close(value(p, 1.2), 2.5));
  check("a negative step_size counts down", close(value({ ...p, step_size: -0.25 }, 1.2), 1.5));
  check(
    "scale is ignored in stepped mode",
    close(value({ ...p, scale: 5 }, 1.2), 2.5) && close(value({ ...p, scale: -3 }, 1.2), 2.5)
  );

  // Linear easing is a ramp at step_size / duration per second.
  const ramp = { ...p, easing: "linear", offset: 0 };
  check("easing=linear is a ramp: t=0.75 → 1.5 steps", close(value(ramp, 0.75), 1.5 * 0.25));
  check("ramp speed is step_size / step_seconds", close(value(ramp, 3) - value(ramp, 1), 2 * 0.5));

  // Smoothstep: holds at the boundaries, glides mid-step.
  const smooth = { ...p, easing: "smoothstep", offset: 0 };
  check("smoothstep lands exactly on the step at a boundary", close(value(smooth, 1.0), 0.5));
  check(
    "smoothstep is mid-way at mid-step",
    close(value(smooth, 1.25), (2 + applyEasing("smoothstep", 0.5)) * 0.25)
  );

  // Frames unit reads step_frames off the tick clock, not step_seconds.
  const f = fresh({
    mode: "stepped",
    unit: "frames",
    step_size: 1,
    step_frames: 12,
    step_seconds: 0.01, // must be ignored
    easing: "step",
  });
  check("unit=frames: frame 11 has not stepped", close(value(f, 11 / FPS), 0));
  check("unit=frames: frame 12 has stepped once", close(value(f, 12 / FPS), 1));
  check("unit=frames: frame 30 has stepped twice", close(value(f, 30 / FPS), 2));
  check(
    "unit=frames uses the fractional tick clock between frames",
    close(value({ ...f, easing: "linear" }, 6 / FPS), 0.5)
  );
  check(
    "unit=seconds ignores step_frames",
    close(value({ ...f, unit: "seconds", step_seconds: 0.5 }, 1.2), 2)
  );

  // Linear mode still applies scale/offset.
  check(
    "mode=linear is base·scale + offset",
    close(value(fresh({ mode: "linear", scale: 2, offset: 1 }), 1.5), 4)
  );
}

// ---------------------------------------------------------------------
// 1b. Custom easing (091926_float-curve-socket.md)
// ---------------------------------------------------------------------
{
  // A dip: identity ramp with the midpoint pulled down to 0.2.
  const dip: CurvePoint[] = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 0.5, y: 0.2 },
    { id: "c", x: 1, y: 1 },
  ];
  const p = fresh({
    mode: "stepped",
    unit: "seconds",
    step_size: 1,
    step_seconds: 1,
    easing: CUSTOM_EASING,
    easing_curve: dip,
    offset: 0,
  });
  check("custom easing samples easing_curve mid-step", close(value(p, 0.5), 0.2));
  check(
    "custom easing follows the monotone cubic between points",
    close(value(p, 0.25), sampleFloatCurve(dip, 0.25)) && close(value(p, 1.8), 1 + sampleFloatCurve(dip, 0.8))
  );
  check("custom easing lands exactly on the step at a boundary", close(value(p, 2), 2));
  check(
    "ease_intensity blends a custom curve against the raw ramp",
    close(value({ ...p, ease_intensity: 0 }, 0.5), 0.5) && close(value({ ...p, ease_intensity: 2 }, 0.5), 0.5 + 2 * (0.2 - 0.5))
  );
  check(
    "a missing or junk easing_curve reads as the identity ramp",
    close(value({ ...p, easing_curve: undefined }, 0.5), 0.5) && close(value({ ...p, easing_curve: "nope" }, 0.5), 0.5)
  );
  check(
    "the enum still picks named curves when not custom",
    close(value({ ...p, easing: "smoothstep" }, 0.5), applyEasing("smoothstep", 0.5))
  );
  // Ping-pong reads the same curve through its own enum.
  const pp = fresh({
    mode: "pingpong",
    period_frames: 120,
    min: 0,
    max: 1,
    pingpong_easing: CUSTOM_EASING,
    easing_curve: dip,
  });
  check("pingpong custom easing: quarter cycle is the ramp midpoint → 0.2", close(value(pp, 30 / FPS), 0.2));
  check("pingpong custom easing: half cycle reaches max", close(value(pp, 60 / FPS), 1));
  check("pingpong named easing unaffected", close(value({ ...pp, pingpong_easing: "linear" }, 30 / FPS), 0.5));

  // Def: the option exists on both enums, the curve row follows them, and
  // the param is a float_curve (hence exposable once paramSocketType maps it).
  const row = (name: string) => sceneTimeNode.params.find((x) => x.name === name)!;
  const vis = (name: string, params: Record<string, unknown>) => row(name).visibleIf?.(params) ?? true;
  check(
    "custom is an option on both easing enums",
    (row("easing").options ?? []).includes(CUSTOM_EASING) && (row("pingpong_easing").options ?? []).includes(CUSTOM_EASING)
  );
  check("easing_curve is a float_curve param", row("easing_curve").type === "float_curve");
  check(
    "easing_curve shows only when the live mode's enum is custom",
    vis("easing_curve", { mode: "stepped", easing: CUSTOM_EASING }) &&
      !vis("easing_curve", { mode: "stepped", easing: "smoothstep" }) &&
      vis("easing_curve", { mode: "pingpong", pingpong_easing: CUSTOM_EASING }) &&
      !vis("easing_curve", { mode: "pingpong", easing: CUSTOM_EASING }) &&
      !vis("easing_curve", { mode: "linear", easing: CUSTOM_EASING })
  );
}

// ---------------------------------------------------------------------
// 2. Stepped migration
// ---------------------------------------------------------------------
// The pre-split formula, for reference: step_size was the duration and the
// per-step rise, scale converted to output units.
function legacyStepped(
  base: number,
  step: number,
  scale: number,
  offset: number,
  easing: string,
  intensity: number
): number {
  const idx = Math.floor(base / step);
  const alpha = base / step - idx;
  return (idx + applyEasing(easing, alpha, intensity)) * step * scale + offset;
}
{
  // "+1 every 12 frames" as an old save had to express it.
  const old = {
    unit: "frames",
    mode: "stepped",
    step_size: 12,
    scale: 1 / 12,
    offset: 0.5,
    easing: "smoothstep",
    ease_intensity: 1.3,
    period_frames: 120,
  };
  const p: Record<string, unknown> = { ...old };
  migrateSceneTimeParams(p, FPS);
  check("frames save: step_frames takes the old duration", p.step_frames === 12);
  check("frames save: step_seconds gets the fresh default", p.step_seconds === STEP_SECONDS_DEFAULT);
  check("frames save: step_size becomes old step·scale", close(p.step_size as number, 1));
  check("frames save: scale is left alone", close(p.scale as number, 1 / 12));
  let same = true;
  for (const frame of [0, 3, 6, 11, 12, 13, 30, 47.5, 100.25]) {
    const want = legacyStepped(frame, 12, 1 / 12, 0.5, "smoothstep", 1.3);
    if (!close(value(p, frame / FPS), want, 1e-9)) same = false;
  }
  check("frames save renders identically at every sampled frame", same);

  const before = JSON.stringify(p);
  migrateSceneTimeParams(p, FPS);
  check("migration is idempotent", JSON.stringify(p) === before);
}
{
  // Seconds unit, hard staircase, negative scale.
  const p: Record<string, unknown> = {
    unit: "seconds",
    mode: "stepped",
    step_size: 0.5,
    scale: -0.5,
    offset: 3,
    easing: "step",
    ease_intensity: 1,
    period_frames: 120,
  };
  migrateSceneTimeParams(p, FPS);
  check("seconds save: step_seconds takes the old duration", p.step_seconds === 0.5);
  check("seconds save: step_frames gets the fresh default", p.step_frames === STEP_FRAMES_DEFAULT);
  check("seconds save: step_size becomes old step·scale", close(p.step_size as number, -0.25));
  let same = true;
  for (const t of [0, 0.25, 0.5, 0.99, 1, 2.2, 7.75]) {
    if (!close(value(p, t), legacyStepped(t, 0.5, -0.5, 3, "step", 1))) same = false;
  }
  check("seconds save renders identically at every sampled time", same);
}
{
  // A linear-mode save keeps its scale and, switched to stepped later, moves
  // as it would have (size = default step 1 · scale).
  const p: Record<string, unknown> = {
    unit: "seconds",
    mode: "linear",
    step_size: 1,
    scale: 2,
    offset: 0,
    period_frames: 120,
  };
  migrateSceneTimeParams(p, FPS);
  check("linear save: scale untouched", p.scale === 2);
  check("linear save: output unchanged", close(value(p, 1.5), 3));
  check("linear save: step_size pre-folded for a later switch to stepped", p.step_size === 2);
  check(
    "linear save switched to stepped matches the old stepped formula",
    close(value({ ...p, mode: "stepped", easing: "step" }, 2.5), legacyStepped(2.5, 1, 2, 0, "step", 1))
  );
}
{
  // A save with no stepped params at all (untouched defaults were still
  // serialized, but be safe): defaults in, nothing NaN.
  const p: Record<string, unknown> = { mode: "stepped", period_frames: 120 };
  migrateSceneTimeParams(p, FPS);
  check(
    "bare save gets the defaults",
    p.step_seconds === 1 && p.step_frames === STEP_FRAMES_DEFAULT && p.step_size === 1
  );
  check("bare save renders a finite value", Number.isFinite(value(p, 1.5)));
}
{
  // A new-format save is not touched.
  const p: Record<string, unknown> = fresh({
    mode: "stepped",
    step_size: 3,
    step_seconds: 0.25,
    step_frames: 7,
    scale: 4,
  });
  const before = JSON.stringify(p);
  migrateSceneTimeParams(p, FPS);
  check("new-format save is untouched", JSON.stringify(p) === before);
}

// ---------------------------------------------------------------------
// 3. Ping-pong migration still runs from the new home
// ---------------------------------------------------------------------
{
  const p: Record<string, unknown> = {
    unit: "seconds",
    mode: "pingpong",
    period: 1, // half-cycle seconds → rate 0.5 → 120 frames at 60 fps
    min: 0,
    max: 1,
    scale: 2,
    offset: 1,
    step_size: 1,
  };
  migrateSceneTimeParams(p, FPS);
  check("period → period_frames at the composition fps", p.period_frames === 120);
  check("rate/period removed", p.rate === undefined && p.period === undefined);
  check("scale/offset folded into min/max", p.min === 1 && p.max === 3 && p.amplitude === 1);
  check("scale/offset neutralized", p.scale === 1 && p.offset === 0);
  check("stepped split ran too", p.step_seconds === 1 && p.step_size === 1);
  check("ping-pong output spans the folded range", close(value(p, 0), 1) && close(value(p, 1), 3));

  const f: Record<string, unknown> = { unit: "frames", mode: "pingpong", rate: 0.05 };
  migrateSceneTimeParams(f, FPS);
  check("frames-unit rate → 1/rate frames", f.period_frames === 20);
}

// ---------------------------------------------------------------------
// 3b. Sawtooth (2026-09-20): a min→max ramp over period_frames that resets
// hard — the plain 0→1 loop driver. Shares ping-pong's controls.
// ---------------------------------------------------------------------
{
  const saw = fresh({ mode: "sawtooth", period_frames: 120, min: 0, max: 1 });
  check("sawtooth: frame 0 → min", close(value(saw, 0), 0));
  check("sawtooth: quarter period → 0.25", close(value(saw, 30 / FPS), 0.25));
  check("sawtooth: half period → 0.5 (ping-pong would be at max)", close(value(saw, 60 / FPS), 0.5));
  check("sawtooth: just before the period → ~1", close(value(saw, 119 / FPS), 119 / 120));
  check("sawtooth: the period resets to min", close(value(saw, 120 / FPS), 0));
  check("sawtooth: periodic (2.5 periods → 0.5)", close(value(saw, 300 / FPS), 0.5));
  check("sawtooth: negative time wraps into the range", close(value(saw, -30 / FPS), 0.75));
  check(
    "sawtooth: min / max set the range, amplitude scales the swing around the centre",
    close(value({ ...saw, min: 2, max: 4 }, 30 / FPS), 2.5) && close(value({ ...saw, amplitude: 2 }, 30 / FPS), 0)
  );
  check(
    "sawtooth ignores unit / scale / offset",
    close(value({ ...saw, unit: "frames", scale: 5, offset: 7 }, 30 / FPS), 0.25)
  );
  check(
    "sawtooth eases the ramp through pingpong_easing",
    close(value({ ...saw, pingpong_easing: "smoothstep" }, 30 / FPS), applyEasing("smoothstep", 0.25))
  );
  const dip: CurvePoint[] = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 0.5, y: 0.2 },
    { id: "c", x: 1, y: 1 },
  ];
  check(
    "sawtooth custom easing samples easing_curve",
    close(value({ ...saw, pingpong_easing: CUSTOM_EASING, easing_curve: dip }, 60 / FPS), 0.2)
  );
  check("sawtooth is tick-derived, not integer-frame", close(value(saw, 30.5 / FPS), 30.5 / 120));

  const row = (name: string) => sceneTimeNode.params.find((x) => x.name === name)!;
  const vis = (name: string, params: Record<string, unknown>) => row(name).visibleIf?.(params) ?? true;
  check("sawtooth is a mode option", (row("mode").options ?? []).includes("sawtooth"));
  check(
    "sawtooth shows the ping-pong control set",
    ["period_frames", "min", "max", "amplitude", "pingpong_easing", "ease_intensity"].every((n) => vis(n, { mode: "sawtooth" }))
  );
  check(
    "sawtooth hides unit / scale / offset and the stepped rows",
    !vis("unit", { mode: "sawtooth" }) && !vis("scale", { mode: "sawtooth" }) && !vis("offset", { mode: "sawtooth" }) && !vis("step_size", { mode: "sawtooth" })
  );
  check(
    "sawtooth shows easing_curve only when its enum is custom",
    vis("easing_curve", { mode: "sawtooth", pingpong_easing: CUSTOM_EASING }) && !vis("easing_curve", { mode: "sawtooth", pingpong_easing: "linear" })
  );
}

// ---------------------------------------------------------------------
// 4. Def declares the rows
// ---------------------------------------------------------------------
{
  const row = (name: string) => {
    const d = sceneTimeNode.params.find((x) => x.name === name);
    if (!d) throw new Error(`no param ${name}`);
    return d;
  };
  const vis = (name: string, params: Record<string, unknown>) => row(name).visibleIf?.(params) ?? true;
  check("scale hidden for stepped", !vis("scale", { mode: "stepped" }));
  check("scale hidden for pingpong", !vis("scale", { mode: "pingpong" }));
  check("scale shown for linear (and an unset mode)", vis("scale", { mode: "linear" }) && vis("scale", {}));
  check("offset shown for stepped", vis("offset", { mode: "stepped" }));
  check(
    "seconds: only step_seconds shows",
    vis("step_seconds", { mode: "stepped", unit: "seconds" }) &&
      !vis("step_frames", { mode: "stepped", unit: "seconds" })
  );
  check(
    "frames: only step_frames shows",
    !vis("step_seconds", { mode: "stepped", unit: "frames" }) &&
      vis("step_frames", { mode: "stepped", unit: "frames" })
  );
  check(
    "duration rows hidden outside stepped",
    !vis("step_seconds", { mode: "linear" }) && !vis("step_frames", { mode: "pingpong", unit: "frames" })
  );
  check("step_size labeled as a size", row("step_size").label === "Step size");
  check(
    "duration rows carry their unit in the label",
    row("step_seconds").label === "Step duration (s)" && row("step_frames").label === "Step duration (frames)"
  );
  check("step_frames steps by whole frames", row("step_frames").step === 1 && row("step_frames").min === 1);
  check("step_size allows negatives", (row("step_size").min ?? 0) < 0);
  check(
    "defaults match the exported constants",
    row("step_seconds").default === STEP_SECONDS_DEFAULT && row("step_frames").default === STEP_FRAMES_DEFAULT
  );
}

if (failures > 0) {
  console.error(`\n${failures} scene-time check(s) failed`);
  process.exit(1);
}
console.log("\nscene-time checks passed");
