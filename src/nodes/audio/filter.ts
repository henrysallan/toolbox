import type { AudioChainNode, AudioValue, NodeDefinition } from "@/engine/types";

// Filter — subtractive tone shaping over an audio chain
// (specdocs/080826_audio-nodes.md). Emits an effect descriptor wrapping the
// upstream chain; the audio engine reconciles it into a Tone.Filter and
// ramps cutoff/Q changes click-free, so a keyframed or audio-reactive
// cutoff sweep just works.
//
// Zero audio work in compute() — descriptor in, descriptor out.

export const audioFilterNode: NodeDefinition = {
  type: "audio-filter",
  name: "Filter",
  category: "audio",
  subcategory: "modifier",
  description:
    "Filter an audio signal (low-pass / high-pass / band-pass / notch) with cutoff and resonance. Keyframe the cutoff — or drive it from Audio Bands — for sweeps.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [
    { name: "audio", type: "audio", required: true, label: "Audio" },
    // Audio-rate cutoff modulation (080926 M-C): the wired signal SUMS
    // with the cutoff knob inside the audio clock domain. Wire an Audio
    // LFO (its min/max are in Hz here) for wobble/sweeps.
    { name: "cutoff_mod", type: "audio", required: false, label: "Cutoff mod" },
  ],
  params: [
    {
      name: "type",
      label: "Type",
      type: "enum",
      options: ["lowpass", "highpass", "bandpass", "notch"],
      default: "lowpass",
    },
    {
      name: "cutoff",
      label: "Cutoff (Hz)",
      type: "scalar",
      min: 20,
      max: 20000,
      softMax: 8000,
      step: 1,
      default: 800,
    },
    {
      name: "q",
      label: "Resonance (Q)",
      type: "scalar",
      min: 0.05,
      max: 20,
      softMax: 10,
      step: 0.01,
      default: 1,
    },
    {
      name: "rolloff",
      label: "Rolloff (dB/oct)",
      type: "enum",
      options: ["-12", "-24", "-48"],
      default: "-12",
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

    // Mod edges attach only when wired — an absent `mods` keeps the
    // descriptor shape identical to pre-mod saves.
    const modIn = inputs.cutoff_mod;
    const mods =
      modIn?.kind === "audio" && modIn.chain
        ? [{ param: "cutoff", chain: modIn.chain }]
        : undefined;

    const value: AudioValue = {
      kind: "audio",
      chain: {
        kind: "effect",
        nodeId,
        fx: "filter",
        params: {
          type: (params.type as string) ?? "lowpass",
          cutoff: (params.cutoff as number) ?? 800,
          q: (params.q as number) ?? 1,
          rolloff: Number((params.rolloff as string) ?? "-12"),
        },
        input: upstream,
        ...(mods ? { mods } : {}),
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
