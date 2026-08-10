import type { AudioChainNode, AudioValue, NodeDefinition } from "@/engine/types";

// Channel — the utility strip (gain / pan / mute) over an audio chain
// (specdocs/080826_audio-nodes.md). Emits an effect descriptor wrapping the
// upstream chain; the audio engine reconciles it into a Tone.Channel and
// ramps gain / pan changes click-free, so keyframed level rides and pans
// just work.
//
// Zero audio work in compute() — descriptor in, descriptor out.

export const audioChannelNode: NodeDefinition = {
  type: "audio-channel",
  name: "Channel",
  category: "audio",
  subcategory: "modifier",
  description:
    "The utility strip: gain (dB), stereo pan, and a mute switch for any point in an audio chain. Wire audio through it to trim levels or place a part in the stereo field — gain and pan changes ramp click-free and are keyframable.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [
    { name: "audio", type: "audio", required: true, label: "Audio" },
    // Audio-rate modulation (080926 M-C). gain mod sums on a LINEAR unity
    // stage after the dB knob (an Audio LFO at min -0.5 / max 0.5 is a
    // tremolo); pan mod sums with the pan knob (-1..1 → autopan).
    { name: "gain_mod", type: "audio", required: false, label: "Gain mod" },
    { name: "pan_mod", type: "audio", required: false, label: "Pan mod" },
  ],
  params: [
    {
      name: "gain",
      label: "Gain (dB)",
      type: "scalar",
      min: -60,
      max: 12,
      step: 0.1,
      default: 0,
    },
    {
      name: "pan",
      label: "Pan",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "mute",
      label: "Mute",
      type: "boolean",
      default: false,
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

    const mods: { param: string; chain: AudioChainNode }[] = [];
    const gainMod = inputs.gain_mod;
    if (gainMod?.kind === "audio" && gainMod.chain) {
      mods.push({ param: "gain", chain: gainMod.chain });
    }
    const panMod = inputs.pan_mod;
    if (panMod?.kind === "audio" && panMod.chain) {
      mods.push({ param: "pan", chain: panMod.chain });
    }

    const value: AudioValue = {
      kind: "audio",
      chain: {
        kind: "effect",
        nodeId,
        fx: "channel",
        params: {
          gain: (params.gain as number) ?? 0,
          pan: (params.pan as number) ?? 0,
          mute: (params.mute as boolean) ?? false,
        },
        input: upstream,
        ...(mods.length > 0 ? { mods } : {}),
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
