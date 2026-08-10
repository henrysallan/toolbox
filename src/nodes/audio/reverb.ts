import type { AudioChainNode, AudioValue, NodeDefinition } from "@/engine/types";

// Reverb — convolution room/hall ambience over an audio chain
// (specdocs/080826_audio-nodes.md). Emits an effect descriptor wrapping the
// upstream chain; the audio engine plays it through a Tone.Convolver whose
// impulse response is generated from SEEDED noise (never Tone.Reverb, whose
// IR comes from unseeded randomness) so offline exports render
// byte-identically run to run. IRs are cached per (decay, pre-delay,
// sample rate) in the adapter.
//
// Zero audio work in compute() — descriptor in, descriptor out.

export const audioReverbNode: NodeDefinition = {
  type: "audio-reverb",
  name: "Reverb",
  category: "audio",
  subcategory: "modifier",
  description:
    "Adds room or hall ambience with a deterministic convolution reverb. Decay sets how long the tail rings out; pre-delay separates the dry sound from the onset of the reverb.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "audio", type: "audio", required: true, label: "Audio" }],
  params: [
    {
      name: "decay",
      label: "Decay (s)",
      type: "scalar",
      min: 0.1,
      max: 20,
      step: 0.1,
      default: 2.5,
    },
    {
      name: "pre_delay",
      label: "Pre-delay (s)",
      type: "scalar",
      min: 0,
      max: 0.5,
      step: 0.001,
      default: 0.01,
    },
    {
      name: "wet",
      label: "Wet",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.35,
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
        fx: "reverb",
        params: {
          decay: (params.decay as number) ?? 2.5,
          pre_delay: (params.pre_delay as number) ?? 0.01,
          wet: (params.wet as number) ?? 0.35,
        },
        input: upstream,
      },
      // Pass the source element through so existing element-tap consumers
      // (audio→scalar, Audio Bands) keep reading SOMETHING — the raw
      // pre-reverb signal. M2 replaces this with true post-stage chain
      // taps (audioEngine.getTapAnalyser).
      element: input.element,
      source: input.source,
    };
    return { primary: value };
  },
};
