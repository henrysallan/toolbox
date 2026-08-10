import type {
  AudioFileParamValue,
  AudioValue,
  NodeDefinition,
} from "@/engine/types";

// Sampler — pitched one-shot playback of an audio file
// (specdocs/080826_audio-nodes.md).
//
// Instruments are the notes→audio "rasterizers" — the one domain-crossing
// node kind. This def emits an instrument descriptor whose params carry
// the sample's ObjectURL string plus the MIDI root pitch the recording
// sits at; the audio engine reconciles it into a Tone.Sampler that
// repitches the buffer to each incoming note. No file loaded → no
// descriptor (nothing to play).
//
// Zero audio work in compute(). The notes array is passed through BY
// REFERENCE, never copied or remapped: descriptor identity and the
// reconciler diff's notesEqual fast path both key off the upstream array
// arriving intact. Deliberately cacheable (no stable:false) — the
// descriptor is a pure function of params + inputs.

export const audioSamplerNode: NodeDefinition = {
  type: "audio-sampler",
  name: "Sampler",
  category: "audio",
  subcategory: "generator",
  description:
    "Pitched sample playback — the notes→audio rasterizer for one-shots. Load an audio file, set the MIDI root pitch it was recorded at, and every incoming note replays it repitched. Wire a notes source (Step Pattern) into it, route the audio into a Layer Output audio socket or the Output node, and press Play.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "notes", type: "notes", required: true, label: "Notes" }],
  params: [
    {
      name: "file",
      label: "Sample file",
      type: "audio_file",
      default: null,
    },
    {
      name: "root_pitch",
      label: "Root pitch (MIDI)",
      type: "scalar",
      min: 0,
      max: 127,
      step: 1,
      default: 60,
    },
    {
      name: "release",
      label: "Release (s)",
      type: "scalar",
      min: 0.001,
      max: 5,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "level",
      label: "Level",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.8,
    },
  ],
  primaryOutput: "audio",
  auxOutputs: [],

  compute({ inputs, params, nodeId }) {
    const notes = inputs.notes;
    if (!notes || notes.kind !== "notes" || notes.notes.length === 0) {
      return {};
    }

    // The descriptor carries the URL string, not the param blob — adapters
    // only ever see plain AudioStageParams, and the URL is all the offline
    // renderer needs to decode the buffer deterministically.
    const file = params.file as AudioFileParamValue | null | undefined;
    const url = file?.url;
    if (!url) return {};

    const value: AudioValue = {
      kind: "audio",
      chain: {
        kind: "instrument",
        nodeId,
        inst: "sampler",
        params: {
          url,
          root_pitch: (params.root_pitch as number) ?? 60,
          release: (params.release as number) ?? 0.5,
          level: (params.level as number) ?? 0.8,
        },
        // BY REFERENCE — see header comment.
        notes: notes.notes,
      },
    };
    return { primary: value };
  },
};
