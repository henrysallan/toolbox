import type { NodeDefinition, NodeOutput, RenderContext } from "@/engine/types";
import {
  detectPitch,
  getAudioFrame,
  hzToMidi,
  midiToHz,
} from "@/engine/audio-analysis";

// Audio Pitch — detect the fundamental frequency of an audio signal,
// optionally quantize it to a musical scale, and emit it as a scalar so
// pitch can drive (and step) a parameter.
//
//   primary : pitch in the chosen format (midi / normalized / hz)
//   aux hz        : raw detected frequency (pre-quantize), Hz
//   aux confidence: periodicity clarity 0..1
//   aux gate      : 1 while voiced (clarity ≥ threshold), else 0
//
// Detection is McLeod's NSDF method on the time-domain buffer (see
// engine/audio-analysis.ts) — FFT bins are far too coarse for low notes.
// The detection range is bounded by Min/Max note, which doubles as the
// normalized output range. stable:false (live signal every frame).

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Scale interval sets (semitones from the root).
const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic_major: [0, 2, 4, 7, 9],
  pentatonic_minor: [0, 3, 5, 7, 10],
  whole_tone: [0, 2, 4, 6, 8, 10],
};

interface PitchState {
  // Smoothed (glided) MIDI value actually emitted.
  currentMidi: number;
  // Last MIDI value detected while voiced — held when unvoiced.
  lastMidi: number;
}

function ensureState(ctx: RenderContext, nodeId: string): PitchState {
  const key = `audio-pitch:${nodeId}`;
  const existing = ctx.state[key] as PitchState | undefined;
  if (existing) return existing;
  const s: PitchState = { currentMidi: 0, lastMidi: 0 };
  ctx.state[key] = s;
  return s;
}

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

// Snap a (fractional) MIDI value to the nearest allowed note.
function quantizeMidi(
  midi: number,
  mode: string,
  rootPc: number,
  scaleKey: string,
  divisions: number
): number {
  if (mode === "off") return midi;
  if (mode === "edo") {
    // N equal divisions of the octave; step size in semitones = 12/N.
    const step = 12 / Math.max(1, divisions);
    return rootPc + Math.round((midi - rootPc) / step) * step;
  }
  // chromatic / scale: search outward from the rounded note for the
  // nearest pitch class in the allowed set.
  const intervals =
    mode === "chromatic" ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] : SCALES[scaleKey] ?? SCALES.major;
  const allowed = new Set(intervals);
  const base = Math.round(midi);
  for (let d = 0; d < 12; d++) {
    const up = base + d;
    if (allowed.has((((up - rootPc) % 12) + 12) % 12)) return up;
    const down = base - d;
    if (allowed.has((((down - rootPc) % 12) + 12) % 12)) return down;
  }
  return base;
}

export const audioPitchNode: NodeDefinition = {
  type: "audio-pitch",
  name: "Audio Pitch",
  category: "audio",
  subcategory: "utility",
  description:
    "Detect the pitch of an audio signal and quantize it to a musical scale. Drive a parameter with melody — note as MIDI, normalized 0..1, or raw Hz, with hold + glide for smooth stepping.",
  backend: "webgl2",
  stable: false,
  // Reads the LIVE AnalyserNode tap — external audio state. Time Offset
  // boundary-feeds the current pitch through un-shifted.
  retimeable: false,
  noMaskInput: true,
  inputs: [{ name: "audio", type: "audio", required: true, label: "Audio" }],
  params: [
    {
      name: "min_note",
      label: "Min note (MIDI)",
      type: "scalar",
      min: 0,
      max: 127,
      step: 1,
      default: 36,
    },
    {
      name: "max_note",
      label: "Max note (MIDI)",
      type: "scalar",
      min: 0,
      max: 127,
      step: 1,
      default: 84,
    },
    {
      name: "as",
      label: "Output",
      type: "enum",
      options: ["normalized", "midi", "hz"],
      default: "normalized",
    },
    {
      name: "quantize",
      label: "Quantize",
      type: "enum",
      options: ["off", "chromatic", "scale", "edo"],
      default: "chromatic",
    },
    {
      name: "root",
      label: "Root",
      type: "enum",
      options: NOTE_NAMES,
      default: "C",
      visibleIf: (p) => p.quantize === "scale" || p.quantize === "edo",
    },
    {
      name: "scale",
      label: "Scale",
      type: "enum",
      options: Object.keys(SCALES),
      default: "major",
      visibleIf: (p) => p.quantize === "scale",
    },
    {
      name: "divisions",
      label: "Divisions / octave",
      type: "scalar",
      min: 1,
      max: 48,
      step: 1,
      default: 12,
      visibleIf: (p) => p.quantize === "edo",
    },
    {
      name: "threshold",
      label: "Confidence gate",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.6,
    },
    {
      name: "hold",
      label: "Hold last pitch",
      type: "boolean",
      default: true,
    },
    {
      name: "glide",
      label: "Glide",
      type: "scalar",
      min: 0,
      max: 0.99,
      step: 0.01,
      default: 0,
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [
    { name: "hz", type: "scalar" },
    { name: "confidence", type: "scalar" },
    { name: "gate", type: "scalar" },
  ],

  compute({ inputs, params, ctx, nodeId }): NodeOutput {
    const state = ensureState(ctx, nodeId);
    const minNote = num(params.min_note, 36);
    const maxNote = Math.max(minNote + 1, num(params.max_note, 84));
    const as = (params.as as string) ?? "normalized";

    const format = (midi: number): number => {
      if (as === "hz") return midiToHz(midi);
      if (as === "midi") return midi;
      return Math.max(0, Math.min(1, (midi - minNote) / (maxNote - minNote)));
    };
    const unvoiced = (): NodeOutput => ({
      primary: { kind: "scalar", value: format(state.currentMidi) },
      aux: {
        hz: { kind: "scalar", value: 0 },
        confidence: { kind: "scalar", value: 0 },
        gate: { kind: "scalar", value: 0 },
      },
    });

    const audio = inputs.audio;
    if (audio?.kind !== "audio") return unvoiced();
    const frame = getAudioFrame(audio, ctx);
    if (!frame) return unvoiced();

    const minHz = midiToHz(minNote);
    const maxHz = midiToHz(maxNote);
    const { hz, clarity } = detectPitch(frame.timeDomain, frame.sampleRate, minHz, maxHz);

    const threshold = num(params.threshold, 0.6);
    const voiced = hz > 0 && clarity >= threshold;
    const hold = (params.hold as boolean) ?? true;

    if (!voiced) {
      if (hold) {
        // Keep gliding toward the held note; report unvoiced gate.
        const glide = Math.max(0, Math.min(0.99, num(params.glide, 0)));
        state.currentMidi = state.currentMidi * glide + state.lastMidi * (1 - glide);
      }
      return unvoiced();
    }

    const rootPc = Math.max(0, NOTE_NAMES.indexOf((params.root as string) ?? "C"));
    const targetMidi = quantizeMidi(
      hzToMidi(hz),
      (params.quantize as string) ?? "chromatic",
      rootPc,
      (params.scale as string) ?? "major",
      num(params.divisions, 12)
    );
    state.lastMidi = targetMidi;

    // Glide (portamento) toward the target in semitone space.
    const glide = Math.max(0, Math.min(0.99, num(params.glide, 0)));
    state.currentMidi = state.currentMidi * glide + targetMidi * (1 - glide);

    return {
      primary: { kind: "scalar", value: format(state.currentMidi) },
      aux: {
        hz: { kind: "scalar", value: hz },
        confidence: { kind: "scalar", value: clarity },
        gate: { kind: "scalar", value: 1 },
      },
    };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`audio-pitch:${nodeId}`];
  },
};
