import type { AudioValue, NodeDefinition } from "@/engine/types";

// Noise — a seeded, deterministic noise source (specdocs/080826_audio-nodes.md).
//
// Determinism is the point: Tone.Noise fills its buffers with Math.random,
// which would make live playback and offline export disagree sample-for-
// sample. This def only names (type, seed); the adapter in
// audio-adapters-generators.ts builds the actual buffer from a seeded PRNG,
// so the same seed yields the same samples live and in exports. The seed
// param exists so two Noise nodes (or two takes) can be decorrelated on
// purpose.
//
// Like every audio chain node this def does ZERO audio work — it emits a
// generator descriptor and stays cacheable (no stable:false) so unchanged
// params hand the reconciler the identical descriptor object.

export const audioNoiseNode: NodeDefinition = {
  type: "audio-noise",
  name: "Noise",
  category: "audio",
  subcategory: "generator",
  description:
    "Seeded noise source (white / pink / brown) — the same seed produces the exact same sound live and in exports. Audible while the timeline plays and the chain reaches the Output node's audio socket, a Layer Output's audio socket, or the Active node.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [],
  params: [
    {
      name: "type",
      label: "Type",
      type: "enum",
      options: ["white", "pink", "brown"],
      default: "white",
    },
    {
      name: "level",
      label: "Level",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.3,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 9999,
      step: 1,
      default: 0,
    },
  ],
  primaryOutput: "audio",
  auxOutputs: [],

  compute({ params, nodeId }) {
    const value: AudioValue = {
      kind: "audio",
      chain: {
        kind: "generator",
        nodeId,
        gen: "noise",
        params: {
          type: (params.type as string) ?? "white",
          level: (params.level as number) ?? 0.3,
          seed: (params.seed as number) ?? 0,
        },
      },
    };
    return { primary: value };
  },
};
