import type { NodeDefinition } from "@/engine/types";

// Low-frequency oscillator. Emits a periodic scalar shaped by the chosen
// waveform. `frequency` is in Hz (cycles per second); `phase` is in cycles
// ([0, 1] = one full period of offset). `amplitude` and `offset` shape the
// output range — by default the wave runs in [-1, 1]; with amplitude=0.5
// and offset=0.5 it rides in [0, 1].
//
// Clock: unwired, the oscillator runs on the scoped playhead — ctx.time,
// which the evaluator derives from the project tick (never wall-clock), so
// scrubbing and export are exact and a Layer / Time Offset retimes it. A
// wired `clock` (2026-09-20, the same contract as Stagger's) replaces that
// timebase: feed Scene Time, an Expression, or any scalar and the wave is
// a pure function of that value — `clock_unit` says whether it arrives in
// seconds or frames (frames divide by the composition fps to keep
// `frequency` in Hz).
//
// Cacheable (stable) with the scoped tick folded into the fingerprint via
// fingerprintExtras — Stagger's pattern. Recompute happens once per tick
// as before; identical ticks (a paused param edit elsewhere) now hit the
// cache instead of re-evaluating, and the catalog no longer flags the
// node as unstable.
//
// Waveform definitions (all on the unit-period phase p ∈ [0, 1)):
//   sine     : sin(2π p)
//   triangle : 4 |p − 0.5| − 1            (peak +1 at p=0, −1 at p=0.5)
//   sawtooth : 2 p − 1                    (rising ramp from −1 to +1)
//   square   : sign(0.5 − p)              (+1 first half, −1 second)

const SHAPES = ["sine", "triangle", "sawtooth", "square"] as const;
type Shape = (typeof SHAPES)[number];

export const CLOCK_UNITS = ["seconds", "frames"] as const;

function evalShape(shape: Shape, p: number): number {
  // p is the unit-period phase, already wrapped into [0, 1).
  switch (shape) {
    case "sine":
      return Math.sin(2 * Math.PI * p);
    case "triangle":
      return 4 * Math.abs(p - 0.5) - 1;
    case "sawtooth":
      return 2 * p - 1;
    case "square":
      return p < 0.5 ? 1 : -1;
  }
}

export const lfoNode: NodeDefinition = {
  type: "lfo",
  name: "LFO",
  category: "utility",
  description:
    "Periodic scalar oscillator — sine, triangle, sawtooth, or square. Frequency is in Hz, phase is in cycles. Output rides in [-amplitude, +amplitude] + offset. Runs on the playhead (tick-derived, scrub-exact) unless a Clock is wired, in which case the wave is a pure function of that scalar (seconds or frames per Clock unit).",
  facts: {
    reads: ["time"],
    gotchas: [
      "frequency, phase, amplitude, and offset each take the wired scalar input over their same-named param when connected.",
      "Unwired, the timebase is the scoped playhead in seconds (tick-derived, not wall-clock); a wired clock replaces it, and clock_unit=frames divides by the composition fps so frequency stays in Hz.",
      "phase wraps via ((t*frequency+phase)%1+1)%1, so negative frequency, clock or phase still produce a valid, non-jumping phase.",
      "square is a hard step: +1 for phase<0.5, -1 otherwise, with no smoothing at the transition.",
      "sawtooth with amplitude 0.5 and offset 0.5 is a plain 0→1 ramp per period (1/frequency seconds) — the loopable driver for cyclic per-point effects.",
    ],
  },
  backend: "webgl2",
  // Pure function of (inputs, params, scoped tick): cacheable, with the tick
  // in the fingerprint so the unwired playhead still advances the wave.
  // `tickDriven` tells the Iterate / Time Offset interior hash the same.
  stable: true,
  tickDriven: true,
  inputs: [
    { name: "clock", type: "scalar", required: false, label: "Clock" },
    { name: "frequency", type: "scalar", required: false, label: "Frequency (Hz)" },
    { name: "phase", type: "scalar", required: false, label: "Phase (cycles)" },
    { name: "amplitude", type: "scalar", required: false, label: "Amplitude" },
    { name: "offset", type: "scalar", required: false, label: "Offset" },
  ],
  params: [
    {
      name: "shape",
      label: "Shape",
      type: "enum",
      options: SHAPES as unknown as string[],
      default: "sine",
    },
    {
      name: "clock_unit",
      label: "Clock unit",
      type: "enum",
      options: CLOCK_UNITS as unknown as string[],
      control: "segmented",
      default: "seconds",
    },
    {
      name: "frequency",
      label: "Frequency (Hz)",
      type: "scalar",
      min: 0,
      max: 100,
      softMax: 5,
      step: 0.001,
      default: 1,
    },
    {
      name: "phase",
      label: "Phase (cycles)",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "amplitude",
      label: "Amplitude",
      type: "scalar",
      min: 0,
      max: 100,
      softMax: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "offset",
      label: "Offset",
      type: "scalar",
      min: -100,
      max: 100,
      softMax: 1,
      step: 0.001,
      default: 0,
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],

  // Unwired, the wave rides the scoped playhead, so the output changes
  // every tick. (A WIRED clock is already in the inputs fingerprint; the
  // tick stamp then costs one trivial recompute per frame — the hook
  // can't see wiring. Same trade Stagger makes.)
  fingerprintExtras(_params, ctx) {
    return `t:${ctx.tick}`;
  },

  compute({ inputs, params, ctx }) {
    const shape = ((params.shape as string) ?? "sine") as Shape;
    const clockIn = inputs.clock;
    let t: number;
    if (clockIn?.kind === "scalar" && Number.isFinite(clockIn.value)) {
      const fps = ctx.fps > 0 ? ctx.fps : 60;
      t = params.clock_unit === "frames" ? clockIn.value / fps : clockIn.value;
    } else {
      t = ctx.time;
    }
    const frequency =
      inputs.frequency?.kind === "scalar"
        ? inputs.frequency.value
        : ((params.frequency as number) ?? 1);
    const phase =
      inputs.phase?.kind === "scalar"
        ? inputs.phase.value
        : ((params.phase as number) ?? 0);
    const amplitude =
      inputs.amplitude?.kind === "scalar"
        ? inputs.amplitude.value
        : ((params.amplitude as number) ?? 1);
    const offset =
      inputs.offset?.kind === "scalar"
        ? inputs.offset.value
        : ((params.offset as number) ?? 0);

    // Wrap into [0, 1) using the mod-mod trick so negative frequency or
    // phase still produce a non-negative phase value.
    const raw = t * frequency + phase;
    const p = ((raw % 1) + 1) % 1;
    const v = evalShape(shape, p) * amplitude + offset;
    return { primary: { kind: "scalar", value: v } };
  },
};
