import type { AudioChainNode, AudioValue, NodeDefinition } from "@/engine/types";

// Phaser — sweeping notch/phase-shift effect over an audio chain
// (specdocs/080826_audio-nodes.md). Emits an effect descriptor wrapping the
// upstream chain; the audio engine reconciles it into a Tone.Phaser (LFO
// starts at phase 0 in the offline context, which is deterministic).
//
// Zero audio work in compute() — descriptor in, descriptor out.

export const audioPhaserNode: NodeDefinition = {
  type: "audio-phaser",
  name: "Phaser",
  category: "audio",
  subcategory: "modifier",
  description:
    "Classic swirling phaser: an LFO sweeps a bank of all-pass filters through the spectrum. Rate sets the sweep speed, octaves its range above the base frequency.",
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
      default: 0.5,
    },
    {
      name: "octaves",
      label: "Octaves",
      type: "scalar",
      min: 0,
      max: 8,
      step: 0.1,
      default: 3,
    },
    {
      name: "base_freq",
      label: "Base Freq (Hz)",
      type: "scalar",
      min: 20,
      max: 2000,
      step: 1,
      default: 350,
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
        fx: "phaser",
        params: {
          rate: (params.rate as number) ?? 0.5,
          octaves: (params.octaves as number) ?? 3,
          base_freq: (params.base_freq as number) ?? 350,
          wet: (params.wet as number) ?? 0.5,
        },
        input: upstream,
      },
      // Pass the source element through so existing element-tap consumers
      // (audio→scalar, Audio Bands) keep reading SOMETHING — the raw
      // pre-phaser signal. M2 replaces this with true post-stage chain
      // taps (audioEngine.getTapAnalyser).
      element: input.element,
      source: input.source,
    };
    return { primary: value };
  },
};
