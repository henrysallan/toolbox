import type { NodeDefinition, NotesValue } from "@/engine/types";

// Transpose — ± semitones over a notes stream
// (specdocs/080826_audio-nodes.md). The first pure notes→notes transform:
// it proves the notes domain composes the way spline modifiers do —
// symbolic values in, symbolic values out, instruments rasterize at the
// end. NoteEvent.pitch is float-legal, so a keyframed fractional
// `semitones` reads as detune; the clamp keeps results inside MIDI range.
//
// At semitones === 0 the INPUT VALUE passes through untouched — identity
// preservation is cheap here and keeps downstream diffs on the fast path
// (the reconciler's notes comparison short-circuits on ===, so a no-op
// Transpose between pattern and instrument costs nothing per eval).

export const audioTransposeNode: NodeDefinition = {
  type: "audio-transpose",
  name: "Transpose",
  category: "audio",
  subcategory: "modifier",
  description:
    "Shifts every note in a notes stream by ± semitones (clamped to the MIDI 0–127 range). Keyframe it for key changes; fractional values detune.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "notes", type: "notes", required: true, label: "Notes" }],
  params: [
    {
      name: "semitones",
      label: "Semitones",
      type: "scalar",
      min: -48,
      max: 48,
      step: 1,
      default: 0,
    },
  ],
  primaryOutput: "notes",
  auxOutputs: [],

  compute({ inputs, params }) {
    const input = inputs.notes;
    if (!input || input.kind !== "notes") return {};

    const semitones = (params.semitones as number) ?? 0;
    if (semitones === 0) return { primary: input };

    const value: NotesValue = {
      kind: "notes",
      notes: input.notes.map((n) => ({
        ...n,
        pitch: Math.max(0, Math.min(127, n.pitch + semitones)),
      })),
    };
    return { primary: value };
  },
};
