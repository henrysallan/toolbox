import type { AudioChainNode, AudioValue, NodeDefinition } from "@/engine/types";

// BitCrusher — bit-depth reduction over an audio chain
// (specdocs/080826_audio-nodes.md). Emits an effect descriptor wrapping the
// upstream chain; the audio engine reconciles it into a Tone.BitCrusher and
// ramps bits / wet changes click-free, so a keyframed crush-down just works.
//
// Zero audio work in compute() — descriptor in, descriptor out.

export const audioBitcrusherNode: NodeDefinition = {
  type: "audio-bitcrusher",
  name: "BitCrusher",
  category: "audio",
  subcategory: "modifier",
  description:
    "Lo-fi bit-depth reduction: crushes the signal down to as few as 1 bit for digital grit and crunch, with a wet/dry blend. Wire an audio chain through it — keyframed bits and wet changes ramp click-free.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "audio", type: "audio", required: true, label: "Audio" }],
  params: [
    {
      name: "bits",
      label: "Bits",
      type: "scalar",
      min: 1,
      max: 16,
      step: 1,
      default: 4,
    },
    {
      name: "wet",
      label: "Wet",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
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
        fx: "bitcrusher",
        params: {
          bits: (params.bits as number) ?? 4,
          wet: (params.wet as number) ?? 1,
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
