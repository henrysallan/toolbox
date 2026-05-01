import type { NodeDefinition } from "@/engine/types";

// Low-frequency oscillator. Reads ctx.time (seconds) and emits a periodic
// scalar shaped by the chosen waveform. `frequency` is in Hz (cycles per
// second); `phase` is in cycles ([0, 1] = one full period of offset).
// `amplitude` and `offset` shape the output range — by default the wave
// runs in [-1, 1]; with amplitude=0.5 and offset=0.5 it rides in [0, 1].
//
// Marked stable:false so the evaluator re-fingerprints each frame —
// downstream caches invalidate but independent subgraphs don't.
//
// Waveform definitions (all on the unit-period phase p ∈ [0, 1)):
//   sine     : sin(2π p)
//   triangle : 4 |p − 0.5| − 1            (peak +1 at p=0, −1 at p=0.5)
//   sawtooth : 2 p − 1                    (rising ramp from −1 to +1)
//   square   : sign(0.5 − p)              (+1 first half, −1 second)

const SHAPES = ["sine", "triangle", "sawtooth", "square"] as const;
type Shape = (typeof SHAPES)[number];

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
    "Periodic scalar oscillator — sine, triangle, sawtooth, or square. Frequency is in Hz, phase is in cycles. Output rides in [-amplitude, +amplitude] + offset.",
  backend: "webgl2",
  stable: false,
  inputs: [
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

  compute({ inputs, params, ctx }) {
    const shape = ((params.shape as string) ?? "sine") as Shape;
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
    const raw = ctx.time * frequency + phase;
    const p = ((raw % 1) + 1) % 1;
    const v = evalShape(shape, p) * amplitude + offset;
    return { primary: { kind: "scalar", value: v } };
  },
};
