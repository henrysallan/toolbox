import type { AudioChainNode, AudioValue, NodeDefinition } from "@/engine/types";

// Chorus — stereo thickening/detune over an audio chain
// (specdocs/080826_audio-nodes.md). Emits an effect descriptor wrapping the
// upstream chain; the audio engine reconciles it into a Tone.Chorus (LFO
// started at creation — offline renders start it at phase 0 in the offline
// context, which is deterministic).
//
// Zero audio work in compute() — descriptor in, descriptor out.

export const audioChorusNode: NodeDefinition = {
  type: "audio-chorus",
  name: "Chorus",
  category: "audio",
  subcategory: "modifier",
  description:
    "Thickens and widens the signal by mixing in slightly delayed, LFO-detuned copies. Rate and depth set the wobble; spread pans the two LFOs apart for stereo width.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "audio", type: "audio", required: true, label: "Audio" }],
  params: [
    {
      name: "rate",
      label: "Rate (Hz)",
      type: "scalar",
      min: 0.1,
      max: 10,
      step: 0.01,
      default: 1.5,
    },
    {
      name: "depth",
      label: "Depth",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.7,
    },
    {
      name: "delay_ms",
      label: "Delay (ms)",
      type: "scalar",
      min: 2,
      max: 20,
      step: 0.1,
      default: 3.5,
    },
    {
      name: "spread",
      label: "Spread (deg)",
      type: "scalar",
      min: 0,
      max: 180,
      step: 1,
      default: 180,
    },
    {
      name: "wet",
      label: "Wet",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
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
        fx: "chorus",
        params: {
          rate: (params.rate as number) ?? 1.5,
          depth: (params.depth as number) ?? 0.7,
          delay_ms: (params.delay_ms as number) ?? 3.5,
          spread: (params.spread as number) ?? 180,
          wet: (params.wet as number) ?? 0.5,
        },
        input: upstream,
      },
      // Pass the source element through so existing element-tap consumers
      // (audio→scalar, Audio Bands) keep reading SOMETHING — the raw
      // pre-chorus signal. M2 replaces this with true post-stage chain
      // taps (audioEngine.getTapAnalyser).
      element: input.element,
      source: input.source,
    };
    return { primary: value };
  },
};
