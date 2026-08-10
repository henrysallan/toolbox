import type { AudioChainNode, AudioValue, NodeDefinition } from "@/engine/types";

// Distortion — waveshaping drive over an audio chain
// (specdocs/080826_audio-nodes.md). Emits an effect descriptor wrapping the
// upstream chain; the audio engine reconciles it into a Tone.Distortion.
// Drive and oversample set the shaper curve; the wet mix ramps click-free.
//
// Zero audio work in compute() — descriptor in, descriptor out.

export const audioDistortionNode: NodeDefinition = {
  type: "audio-distortion",
  name: "Distortion",
  category: "audio",
  subcategory: "modifier",
  description:
    "Waveshaping distortion: drive sets the amount of grit, oversample trades CPU for less aliasing, and wet blends against the dry signal. Wire an audio chain through it — keyframed drive and wet changes ramp click-free.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "audio", type: "audio", required: true, label: "Audio" }],
  params: [
    {
      name: "drive",
      label: "Drive",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.4,
    },
    {
      name: "oversample",
      label: "Oversample",
      type: "enum",
      options: ["none", "2x", "4x"],
      default: "2x",
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
        fx: "distortion",
        params: {
          drive: (params.drive as number) ?? 0.4,
          oversample: (params.oversample as string) ?? "2x",
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
