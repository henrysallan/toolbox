import type {
  AudioChainMixInput,
  AudioChainNode,
  AudioValue,
  NodeDefinition,
} from "@/engine/types";

// Crossfade — equal-power A/B blend (specdocs/080826_audio-nodes.md), the
// audio Switch/lerp. Keyframe `fade` — or drive it from any scalar — to
// sweep between two sources without the -3dB dip a linear fade has at
// center: A rides a cosine, B a sine, so summed power stays constant.
//
// Descriptor composition, NO adapter of its own: a crossfade IS a 2-lane
// "mix" stage whose def computes the lane gains (see the header of
// engine/audio-adapters-routing.ts). A one-sided wire still plays, at that
// side's equal-power gain.
//
// Zero audio work in compute() — descriptors in, one descriptor out.

export const audioCrossfadeNode: NodeDefinition = {
  type: "audio-crossfade",
  name: "Crossfade",
  category: "audio",
  subcategory: "modifier",
  description:
    "Equal-power blend between two audio inputs. fade 0 = all A, 1 = all B; keyframe it — or drive it from Audio Bands — for smooth source transitions.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [
    { name: "a", label: "A", type: "audio", required: false },
    { name: "b", label: "B", type: "audio", required: false },
  ],
  params: [
    {
      name: "fade",
      label: "Fade (A → B)",
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
    const a = inputs.a && inputs.a.kind === "audio" ? inputs.a : null;
    const b = inputs.b && inputs.b.kind === "audio" ? inputs.b : null;

    // Upstream chain, or — for an element-only value from a producer that
    // predates chains — a leaf minted here with a this-node-derived id
    // (stable across evals, distinct from our own stage id).
    const chainOf = (
      input: AudioValue | null,
      suffix: string
    ): AudioChainNode | null => {
      if (!input) return null;
      if (input.chain) return input.chain;
      if (input.element) {
        return {
          kind: "element",
          nodeId: `${nodeId}:src${suffix}`,
          element: input.element,
          source: input.source ?? "file",
          url: null,
        };
      }
      return null;
    };

    const chainA = chainOf(a, "A");
    const chainB = chainOf(b, "B");
    if (!chainA && !chainB) return {};

    const fade = Math.max(0, Math.min(1, (params.fade as number) ?? 0.5));
    const mixInputs: AudioChainMixInput[] = [];
    if (chainA) {
      mixInputs.push({
        chain: chainA,
        gain: Math.cos((fade * Math.PI) / 2),
        pan: 0,
        mute: false,
      });
    }
    if (chainB) {
      mixInputs.push({
        chain: chainB,
        gain: Math.sin((fade * Math.PI) / 2),
        pan: 0,
        mute: false,
      });
    }

    const passthrough = chainA ? a : b;
    const value: AudioValue = {
      kind: "audio",
      chain: { kind: "mix", nodeId, params: {}, inputs: mixInputs },
      // Pass the first wired side's source element through so existing
      // element-tap consumers (audio→scalar, Audio Bands) keep reading
      // SOMETHING — that side's raw pre-fade signal. M2 replaces this with
      // true post-stage chain taps (audioEngine.getTapAnalyser).
      element: passthrough?.element,
      source: passthrough?.source,
    };
    return { primary: value };
  },
};
