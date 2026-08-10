import type { AudioValue, NodeDefinition } from "@/engine/types";

// Synth — polyphonic subtractive voice (specdocs/080826_audio-nodes.md).
//
// Instruments are the notes→audio "rasterizers" — the one domain-crossing
// node kind. This def emits an instrument descriptor; the audio engine
// reconciles it into a Tone.PolySynth(Tone.Synth) and schedules the note
// list onto the timeline-slaved transport.
//
// Zero audio work in compute(). The notes array is passed through BY
// REFERENCE, never copied or remapped: descriptor identity and the
// reconciler diff's notesEqual fast path both key off the upstream array
// arriving intact. Deliberately cacheable (no stable:false) — the
// descriptor is a pure function of params + inputs.

export const audioSynthNode: NodeDefinition = {
  type: "audio-synth",
  name: "Synth",
  category: "audio",
  subcategory: "generator",
  description:
    "Polyphonic synth voice — the notes→audio rasterizer. Wire a notes source (Step Pattern) into it, route the audio into a Layer Output audio socket or the Output node, and press Play. Waveform picks the tone; the ADSR envelope shapes each note.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "notes", type: "notes", required: true, label: "Notes" }],
  params: [
    {
      name: "wave",
      label: "Waveform",
      type: "enum",
      options: ["sine", "square", "sawtooth", "triangle"],
      default: "sawtooth",
    },
    {
      name: "attack",
      label: "Attack (s)",
      type: "scalar",
      min: 0.001,
      max: 2,
      step: 0.001,
      default: 0.01,
    },
    {
      name: "decay",
      label: "Decay (s)",
      type: "scalar",
      min: 0.001,
      max: 2,
      step: 0.001,
      default: 0.15,
    },
    {
      name: "sustain",
      label: "Sustain",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "release",
      label: "Release (s)",
      type: "scalar",
      min: 0.001,
      max: 5,
      step: 0.001,
      default: 0.3,
    },
    {
      name: "level",
      label: "Level",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.7,
    },
  ],
  primaryOutput: "audio",
  auxOutputs: [],

  compute({ inputs, params, nodeId }) {
    const notes = inputs.notes;
    if (!notes || notes.kind !== "notes" || notes.notes.length === 0) {
      return {};
    }

    const value: AudioValue = {
      kind: "audio",
      chain: {
        kind: "instrument",
        nodeId,
        inst: "synth",
        params: {
          wave: (params.wave as string) ?? "sawtooth",
          attack: (params.attack as number) ?? 0.01,
          decay: (params.decay as number) ?? 0.15,
          sustain: (params.sustain as number) ?? 0.5,
          release: (params.release as number) ?? 0.3,
          level: (params.level as number) ?? 0.7,
        },
        // BY REFERENCE — see header comment.
        notes: notes.notes,
      },
    };
    return { primary: value };
  },
};
