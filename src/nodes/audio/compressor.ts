import type { AudioChainNode, AudioValue, NodeDefinition } from "@/engine/types";

// Compressor — dynamic-range control over an audio chain
// (specdocs/080826_audio-nodes.md). Emits an effect descriptor wrapping the
// upstream chain; the audio engine reconciles it into a Tone.Compressor and
// smooths threshold / ratio / envelope changes click-free, so keyframed
// dynamics moves just work.
//
// Zero audio work in compute() — descriptor in, descriptor out.

export const audioCompressorNode: NodeDefinition = {
  type: "audio-compressor",
  name: "Compressor",
  category: "audio",
  subcategory: "modifier",
  description:
    "Dynamic range compressor: signal above the threshold is reduced by the ratio, with attack/release envelope timing and a soft knee. Wire an audio chain through it to tame peaks or glue a mix — parameter changes ramp click-free and are keyframable.",
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
      default: -24,
    },
    {
      name: "ratio",
      label: "Ratio",
      type: "scalar",
      min: 1,
      max: 20,
      step: 0.1,
      default: 4,
    },
    {
      name: "attack",
      label: "Attack (s)",
      type: "scalar",
      min: 0.001,
      max: 1,
      step: 0.001,
      default: 0.003,
    },
    {
      name: "release",
      label: "Release (s)",
      type: "scalar",
      min: 0.01,
      max: 1,
      step: 0.001,
      default: 0.25,
    },
    {
      name: "knee",
      label: "Knee (dB)",
      type: "scalar",
      min: 0,
      max: 40,
      step: 0.1,
      default: 30,
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
        fx: "compressor",
        params: {
          threshold: (params.threshold as number) ?? -24,
          ratio: (params.ratio as number) ?? 4,
          attack: (params.attack as number) ?? 0.003,
          release: (params.release as number) ?? 0.25,
          knee: (params.knee as number) ?? 30,
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
