import type { NodeDefinition, NodeOutput, RenderContext } from "@/engine/types";
import { bandEnergy, getAudioFrame, rms } from "@/engine/audio-analysis";

// Audio Bands — split an audio signal into Low / Mid / High energy and
// emit each as a scalar, plus the overall level on the primary output.
// Wire any of them into a param (Transform scale, a Math input, opacity,
// …) to drive animation from a frequency range.
//
//   primary : level — overall RMS loudness (0 silent … ~1 saturated)
//   aux low  : mean magnitude below `crossover_lo`
//   aux mid  : mean magnitude between the two crossovers
//   aux high : mean magnitude above `crossover_hi`
//
// Analysis (one AnalyserNode per element, one FFT per frame) is shared
// via engine/audio-analysis.ts. stable:false so it re-reads the live
// signal every frame; fingerprintExtras = ctx.frame keeps independent
// subgraphs from re-evaluating off this node's churn.

const ZERO = { kind: "scalar", value: 0 } as const;

// Persistent one-pole smoothing state (previous output per band).
interface BandsState {
  low: number;
  mid: number;
  high: number;
  level: number;
}

function ensureState(ctx: RenderContext, nodeId: string): BandsState {
  const key = `audio-bands:${nodeId}`;
  const existing = ctx.state[key] as BandsState | undefined;
  if (existing) return existing;
  const s: BandsState = { low: 0, mid: 0, high: 0, level: 0 };
  ctx.state[key] = s;
  return s;
}

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

// Map a linear magnitude to 0..1: either a straight gain (linear scale)
// or a dB window remapped to [0,1] (db scale).
function shape(
  mag: number,
  scale: string,
  gain: number,
  dbFloor: number,
  dbCeil: number
): number {
  if (scale === "db") {
    const db = 20 * Math.log10(Math.max(mag, 1e-7));
    const span = Math.max(1e-3, dbCeil - dbFloor);
    return Math.max(0, Math.min(1, (db - dbFloor) / span)) * gain;
  }
  return Math.max(0, mag * gain);
}

export const audioBandsNode: NodeDefinition = {
  type: "audio-bands",
  name: "Audio Bands",
  category: "audio",
  subcategory: "utility",
  description:
    "Split audio into Low / Mid / High energy (3 scalar outputs) plus an overall level. Drive parameters from a frequency band — bass on scale, highs on a flicker, etc.",
  backend: "webgl2",
  // Reads the live signal each frame; the actual data changes out of band
  // with params (same as Audio Source / LFO).
  stable: false,
  noMaskInput: true,
  inputs: [{ name: "audio", type: "audio", required: true, label: "Audio" }],
  params: [
    {
      name: "crossover_lo",
      label: "Low / Mid (Hz)",
      type: "scalar",
      min: 20,
      max: 20000,
      softMax: 1000,
      step: 1,
      default: 250,
    },
    {
      name: "crossover_hi",
      label: "Mid / High (Hz)",
      type: "scalar",
      min: 20,
      max: 20000,
      softMax: 10000,
      step: 1,
      default: 4000,
    },
    {
      name: "gain",
      label: "Gain",
      type: "scalar",
      min: 0,
      max: 100,
      softMax: 20,
      step: 0.01,
      default: 4,
    },
    {
      name: "smoothing",
      label: "Smoothing",
      type: "scalar",
      min: 0,
      max: 0.99,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "scale",
      label: "Scale",
      type: "enum",
      options: ["linear", "db"],
      default: "linear",
    },
    {
      name: "db_floor",
      label: "dB floor",
      type: "scalar",
      min: -120,
      max: 0,
      step: 1,
      default: -60,
      visibleIf: (p) => p.scale === "db",
    },
    {
      name: "db_ceil",
      label: "dB ceil",
      type: "scalar",
      min: -60,
      max: 12,
      step: 1,
      default: 0,
      visibleIf: (p) => p.scale === "db",
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [
    { name: "low", type: "scalar" },
    { name: "mid", type: "scalar" },
    { name: "high", type: "scalar" },
  ],

  compute({ inputs, params, ctx, nodeId }): NodeOutput {
    const state = ensureState(ctx, nodeId);
    const audio = inputs.audio;
    if (audio?.kind !== "audio") {
      return {
        primary: ZERO,
        aux: { low: ZERO, mid: ZERO, high: ZERO },
      };
    }

    const frame = getAudioFrame(audio, ctx);
    if (!frame) {
      return {
        primary: { kind: "scalar", value: state.level },
        aux: {
          low: { kind: "scalar", value: state.low },
          mid: { kind: "scalar", value: state.mid },
          high: { kind: "scalar", value: state.high },
        },
      };
    }

    const loCross = num(params.crossover_lo, 250);
    const hiCross = Math.max(loCross, num(params.crossover_hi, 4000));
    const gain = num(params.gain, 4);
    const smoothing = Math.max(0, Math.min(0.99, num(params.smoothing, 0.5)));
    const scale = (params.scale as string) ?? "linear";
    const dbFloor = num(params.db_floor, -60);
    const dbCeil = num(params.db_ceil, 0);
    const nyquist = frame.sampleRate / 2;

    const tLow = shape(bandEnergy(frame, 0, loCross), scale, gain, dbFloor, dbCeil);
    const tMid = shape(bandEnergy(frame, loCross, hiCross), scale, gain, dbFloor, dbCeil);
    const tHigh = shape(bandEnergy(frame, hiCross, nyquist), scale, gain, dbFloor, dbCeil);
    const tLevel = rms(frame.timeDomain);

    // One-pole smoothing: out = prev·a + target·(1−a). a = smoothing.
    state.low = state.low * smoothing + tLow * (1 - smoothing);
    state.mid = state.mid * smoothing + tMid * (1 - smoothing);
    state.high = state.high * smoothing + tHigh * (1 - smoothing);
    state.level = state.level * smoothing + tLevel * (1 - smoothing);

    return {
      primary: { kind: "scalar", value: state.level },
      aux: {
        low: { kind: "scalar", value: state.low },
        mid: { kind: "scalar", value: state.mid },
        high: { kind: "scalar", value: state.high },
      },
    };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`audio-bands:${nodeId}`];
  },
};
