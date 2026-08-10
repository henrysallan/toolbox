import type { AudioChainNode, AudioValue, NodeDefinition } from "@/engine/types";

// Limiter — hard ceiling over an audio chain
// (specdocs/080826_audio-nodes.md). Emits an effect descriptor wrapping the
// upstream chain; the audio engine reconciles it into a Tone.Limiter (a
// max-ratio, fast-envelope compressor) and smooths threshold changes
// click-free.
//
// Zero audio work in compute() — descriptor in, descriptor out.

export const audioLimiterNode: NodeDefinition = {
  type: "audio-limiter",
  name: "Limiter",
  category: "audio",
  subcategory: "modifier",
  description:
    "Loudness limiter: clamps the signal to the threshold ceiling with a fast, max-ratio compressor — put it last in an audio chain to stop peaks and protect the output. Threshold changes ramp click-free and are keyframable.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "audio", type: "audio", required: true, label: "Audio" }],
  params: [
    {
      name: "threshold",
      label: "Threshold (dB)",
      type: "scalar",
      min: -60,
      max: 0,
      step: 0.1,
      default: -6,
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
        fx: "limiter",
        params: {
          threshold: (params.threshold as number) ?? -6,
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
