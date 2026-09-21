// check-lfo: the LFO's timebase contract (2026-09-20) — unwired it rides the
// scoped playhead (ctx.time, tick-derived), a wired Clock replaces it
// (seconds, or frames ÷ fps per clock_unit), the wave is a pure function of
// that clock (same clock → same value, whatever the playhead says), a
// sawtooth with amplitude 0.5 / offset 0.5 is a 0→1 ramp per period, and
// negative clocks still wrap into a valid phase. Also the def: the node is
// cacheable with the tick in its fingerprint, and every param has a default.
//
//   npx tsx scripts/check-lfo.mts

import type { NodeOutput, RenderContext, SocketValue } from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { CLOCK_UNITS, lfoNode } from "../src/nodes/source/lfo.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail && !cond ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

const TPF = 1000;
function ctxAt(seconds: number, fps = 60): RenderContext {
  return {
    time: seconds,
    frame: Math.floor(seconds * fps),
    tick: Math.round(seconds * fps * TPF),
    ticksPerFrame: TPF,
    fps,
    playing: true,
    state: {},
    width: 1920,
    height: 1080,
  } as unknown as RenderContext;
}

function fresh(over: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const d of lfoNode.params) p[d.name] = d.default;
  return { ...p, ...over };
}

function value(
  params: Record<string, unknown>,
  seconds: number,
  opts: { clock?: number; fps?: number } = {}
): number {
  const ctx = ctxAt(seconds, opts.fps ?? 60);
  const clock =
    opts.clock === undefined
      ? undefined
      : coerceValue({ kind: "scalar", value: opts.clock } satisfies SocketValue, "scalar", ctx);
  const out = lfoNode.compute({
    inputs: { clock },
    auxIn: {},
    params,
    ctx,
    nodeId: "lfo",
    consumedOutputs: new Set(["primary"]),
  } as Parameters<typeof lfoNode.compute>[0]) as NodeOutput;
  const v = out?.primary;
  if (!v || v.kind !== "scalar") throw new Error("lfo did not emit a scalar");
  return v.value;
}

// A 0→1 sawtooth at 1 Hz — the loop-driver configuration.
const RAMP = fresh({ shape: "sawtooth", frequency: 1, amplitude: 0.5, offset: 0.5 });

// --- def --------------------------------------------------------------------
{
  check("def: every param has a default", lfoNode.params.every((p) => p.default !== undefined));
  check("def: clock is an optional scalar input", lfoNode.inputs.some((i) => i.name === "clock" && i.type === "scalar" && !i.required));
  const unit = lfoNode.params.find((p) => p.name === "clock_unit");
  check(
    "def: clock_unit is an enum over seconds | frames, default seconds",
    !!unit && unit.type === "enum" && JSON.stringify(unit.options) === JSON.stringify([...CLOCK_UNITS]) && unit.default === "seconds"
  );
  check(
    "def: cacheable, with the scoped tick folded into the fingerprint",
    lfoNode.stable !== false && typeof lfoNode.fingerprintExtras === "function" && lfoNode.fingerprintExtras!({}, ctxAt(0.5), "lfo") !== lfoNode.fingerprintExtras!({}, ctxAt(0.75), "lfo")
  );
  check("def: reads time", (lfoNode.facts?.reads ?? []).includes("time"));
}

// --- unwired: the playhead ----------------------------------------------------
{
  check("sawtooth 0→1: t=0 → 0", close(value(RAMP, 0), 0));
  check("sawtooth 0→1: t=0.25 → 0.25", close(value(RAMP, 0.25), 0.25));
  check("sawtooth 0→1: t=0.999 → 0.999", close(value(RAMP, 0.999), 0.999, 1e-6));
  check("sawtooth 0→1: t=1 wraps back to 0", close(value(RAMP, 1), 0, 1e-9));
  check("sawtooth 0→1: t=2.5 → 0.5 (periodic)", close(value(RAMP, 2.5), 0.5));
  check("sine default: t=0.25 at 1 Hz → +1", close(value(fresh({}), 0.25), 1));
  check("frequency scales the period: 2 Hz sawtooth at t=0.25 → 0.5", close(value({ ...RAMP, frequency: 2 }, 0.25), 0.5));
  check("phase (cycles) shifts the ramp", close(value({ ...RAMP, phase: 0.25 }, 0), 0.25));
  check("negative playhead still wraps into [0,1)", close(value(RAMP, -0.25), 0.75));
}

// --- wired clock -------------------------------------------------------------
{
  // The playhead sits at 0.1 s; the clock says 0.5 s.
  check("wired clock (seconds) replaces the playhead", close(value(RAMP, 0.1, { clock: 0.5 }), 0.5));
  check(
    "same clock, different playhead → identical value (pure function of the clock)",
    close(value(RAMP, 0.1, { clock: 0.3 }), value(RAMP, 7.9, { clock: 0.3 }))
  );
  check(
    "clock_unit=frames divides by the composition fps",
    close(value({ ...RAMP, clock_unit: "frames" }, 0, { clock: 30, fps: 60 }), 0.5) &&
      close(value({ ...RAMP, clock_unit: "frames" }, 0, { clock: 30, fps: 30 }), 0)
  );
  check("clock_unit=seconds ignores fps", close(value(RAMP, 0, { clock: 0.5, fps: 24 }), 0.5));
  check("negative clock still wraps into [0,1)", close(value(RAMP, 0, { clock: -0.25 }), 0.75));
  check("a non-finite clock falls back to the playhead", close(value(RAMP, 0.25, { clock: Number.NaN }), 0.25));
  // Phase / frequency inputs still win over params when wired alongside.
  const ctx = ctxAt(0);
  const out = lfoNode.compute({
    inputs: {
      clock: coerceValue({ kind: "scalar", value: 0.5 }, "scalar", ctx),
      frequency: coerceValue({ kind: "scalar", value: 2 }, "scalar", ctx),
    },
    auxIn: {},
    params: RAMP,
    ctx,
    nodeId: "lfo",
    consumedOutputs: new Set(["primary"]),
  } as Parameters<typeof lfoNode.compute>[0]) as NodeOutput;
  check("wired frequency applies to the wired clock (0.5 s × 2 Hz → phase 0)", out.primary?.kind === "scalar" && close(out.primary.value, 0));
}

console.log(`\ncheck-lfo: ${failures === 0 ? "all passed" : `${failures} failure(s)`}`);
process.exit(failures ? 1 : 0);
