import type { AudioValue, NodeDefinition } from "@/engine/types";

// Oscillator — a free-running audio-rate tone (specdocs/080826_audio-nodes.md).
//
// The "hello world" of the audio chain system: emits a generator descriptor
// that the audio engine reconciles into a live Tone.Oscillator. No note
// input by design — instruments are the notes→audio crossing; an oscillator
// is a drone you shape with Filter and friends.
//
// Like every audio chain node this def does ZERO audio work: it returns a
// small descriptor and the engine does the rest. It is deliberately
// cacheable (no stable:false) — unchanged params hand back the identical
// descriptor object, which is what lets the reconciler skip the stage on an
// identity check.
//
// Audible only while the scene is playing AND the chain reaches the Output
// node's audio socket (timeline-slaved transport; routing = audibility).

export const audioOscillatorNode: NodeDefinition = {
  type: "audio-oscillator",
  name: "Oscillator",
  category: "audio",
  subcategory: "generator",
  description:
    "Free-running audio tone (sine / square / sawtooth / triangle). Wire it through audio effects into the Output node's audio socket — it sounds while the timeline plays. Keyframe or wire the frequency for sweeps.",
  backend: "webgl2",
  noMaskInput: true,
  // Audio-rate modulation (080926 M-C): wired signals SUM with the
  // matching knob inside the audio clock domain. freq mod at audible
  // rates is FM; level mod is tremolo/AM.
  inputs: [
    { name: "freq_mod", type: "audio", required: false, label: "Freq mod" },
    { name: "level_mod", type: "audio", required: false, label: "Level mod" },
  ],
  params: [
    {
      name: "wave",
      label: "Waveform",
      type: "enum",
      options: ["sine", "square", "sawtooth", "triangle"],
      default: "sine",
    },
    {
      name: "freq",
      label: "Frequency (Hz)",
      type: "scalar",
      min: 1,
      max: 20000,
      softMax: 2000,
      step: 0.1,
      default: 220,
    },
    {
      name: "detune",
      label: "Detune (cents)",
      type: "scalar",
      min: -1200,
      max: 1200,
      step: 1,
      default: 0,
    },
    {
      name: "level",
      label: "Level",
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
    const mods: { param: string; chain: NonNullable<AudioValue["chain"]> }[] = [];
    const freqMod = inputs.freq_mod;
    if (freqMod?.kind === "audio" && freqMod.chain) {
      mods.push({ param: "freq", chain: freqMod.chain });
    }
    const levelMod = inputs.level_mod;
    if (levelMod?.kind === "audio" && levelMod.chain) {
      mods.push({ param: "level", chain: levelMod.chain });
    }
    const value: AudioValue = {
      kind: "audio",
      chain: {
        kind: "generator",
        nodeId,
        gen: "osc",
        params: {
          wave: (params.wave as string) ?? "sine",
          freq: (params.freq as number) ?? 220,
          detune: (params.detune as number) ?? 0,
          level: (params.level as number) ?? 0.5,
        },
        ...(mods.length > 0 ? { mods } : {}),
      },
    };
    return { primary: value };
  },
};
