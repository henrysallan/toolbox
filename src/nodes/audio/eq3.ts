import type { AudioChainNode, AudioValue, NodeDefinition } from "@/engine/types";

// EQ — three-band tone shaping over an audio chain
// (specdocs/080826_audio-nodes.md). Emits an effect descriptor wrapping the
// upstream chain; the audio engine reconciles it into a Tone.EQ3 and ramps
// band-gain / crossover changes click-free, so keyframed or audio-reactive
// EQ moves just work.
//
// Zero audio work in compute() — descriptor in, descriptor out.

export const audioEq3Node: NodeDefinition = {
  type: "audio-eq3",
  name: "EQ",
  category: "audio",
  subcategory: "modifier",
  description:
    "Three-band equalizer: boost or cut low / mid / high in dB, with adjustable band crossover frequencies. Wire an audio chain through it and keyframe the band gains — changes ramp click-free.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "audio", type: "audio", required: true, label: "Audio" }],
  params: [
    {
      name: "low",
      label: "Low (dB)",
      type: "scalar",
      min: -24,
      max: 12,
      step: 0.1,
      default: 0,
    },
    {
      name: "mid",
      label: "Mid (dB)",
      type: "scalar",
      min: -24,
      max: 12,
      step: 0.1,
      default: 0,
    },
    {
      name: "high",
      label: "High (dB)",
      type: "scalar",
      min: -24,
      max: 12,
      step: 0.1,
      default: 0,
    },
    {
      name: "low_freq",
      label: "Low Crossover (Hz)",
      type: "scalar",
      min: 40,
      max: 1000,
      step: 1,
      default: 400,
    },
    {
      name: "high_freq",
      label: "High Crossover (Hz)",
      type: "scalar",
      min: 1000,
      max: 12000,
      step: 1,
      default: 2500,
    },
  ],
  primaryOutput: "audio",
  auxOutputs: [],

  compute({ inputs, params, nodeId }) {
    const input = inputs.audio;
    if (!input || input.kind !== "audio") return {};

    // Upstream chain, or — for an element-only value from a producer that
    // predates chains — a leaf minted here with a this-node-derived id
    // (stable across evals, distinct from our own stage id).
    let upstream: AudioChainNode | null = input.chain ?? null;
    if (!upstream && input.element) {
      upstream = {
        kind: "element",
        nodeId: `${nodeId}:src`,
        element: input.element,
        source: input.source ?? "file",
        url: null,
      };
    }
    if (!upstream) return {};

    const value: AudioValue = {
      kind: "audio",
      chain: {
        kind: "effect",
        nodeId,
        fx: "eq3",
        params: {
          low: (params.low as number) ?? 0,
          mid: (params.mid as number) ?? 0,
          high: (params.high as number) ?? 0,
          low_freq: (params.low_freq as number) ?? 400,
          high_freq: (params.high_freq as number) ?? 2500,
        },
        input: upstream,
      },
      // Pass the source element through so existing element-tap consumers
      // (audio→scalar, Audio Bands) keep reading SOMETHING — the raw
      // pre-filter signal. M2 replaces this with true post-stage chain
      // taps (audioEngine.getTapAnalyser).
      element: input.element,
      source: input.source,
    };
    return { primary: value };
  },
};
