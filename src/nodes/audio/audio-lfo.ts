import type { AudioValue, NodeDefinition } from "@/engine/types";

// Audio LFO — an audio-rate modulator (specdocs/080926_audio-v2-integration.md
// M-C). Emits a generator descriptor whose live form is a Tone.LFO; wire it
// into a `mod` input (Filter's cutoff mod, Oscillator's freq/level mod,
// Channel's gain/pan mod) and its signal SUMS with that knob's value inside
// the audio clock domain — no zipper, no frame-rate stairstepping.
//
// Attenuation is SOURCE-SIDE by design: `min`/`max` express the output
// range in the DESTINATION param's units (±500 on a cutoff mod = ±500 Hz
// around the knob), so mod inputs need no depth knob of their own.
//
// This is modulation, not audio: wiring an LFO into a regular audio input
// technically works (it's a signal) but you'll hear its raw ramp as DC-ish
// rumble — the mod inputs are the intended sockets.

export const audioLfoNode: NodeDefinition = {
  type: "audio-lfo",
  name: "Audio LFO",
  category: "audio",
  subcategory: "generator",
  description:
    "Audio-rate modulator. Wire into a mod input (Filter cutoff, Oscillator freq/level, Channel gain/pan) — the wave sweeps that knob between min and max, in the knob's own units, smoothly at audio rate. For frame-rate modulation of any other param, use the regular LFO node instead.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [],
  params: [
    {
      name: "shape",
      label: "Shape",
      type: "enum",
      options: ["sine", "square", "sawtooth", "triangle"],
      default: "sine",
    },
    {
      name: "rate",
      label: "Rate (Hz)",
      type: "scalar",
      min: 0.01,
      max: 40,
      softMax: 20,
      step: 0.01,
      default: 2,
    },
    {
      name: "min",
      label: "Min (dest units)",
      type: "scalar",
      min: -20000,
      max: 20000,
      softMax: 2000,
      step: 1,
      default: -500,
    },
    {
      name: "max",
      label: "Max (dest units)",
      type: "scalar",
      min: -20000,
      max: 20000,
      softMax: 2000,
      step: 1,
      default: 500,
    },
    {
      name: "phase",
      label: "Phase (°)",
      type: "scalar",
      min: 0,
      max: 360,
      step: 1,
      default: 0,
    },
  ],
  primaryOutput: "audio",
  auxOutputs: [],

  compute({ params, nodeId }) {
    const value: AudioValue = {
      kind: "audio",
      chain: {
        kind: "generator",
        nodeId,
        gen: "lfo",
        params: {
          shape: (params.shape as string) ?? "sine",
          rate: (params.rate as number) ?? 2,
          min: (params.min as number) ?? -500,
          max: (params.max as number) ?? 500,
          phase: (params.phase as number) ?? 0,
        },
      },
    };
    return { primary: value };
  },
};
