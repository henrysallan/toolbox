import type { AudioChainNode, AudioValue, NodeDefinition } from "@/engine/types";

// Delay — echo / feedback delay over an audio chain
// (specdocs/080826_audio-nodes.md). Emits an effect descriptor wrapping the
// upstream chain; the audio engine reconciles it into a Tone.FeedbackDelay
// (or Tone.PingPongDelay) and ramps time/feedback/wet click-free.
//
// The mode enum swaps Tone CLASSES, and a class swap must be a SHAPE change
// for the reconciler (dispose + recreate, not an in-place retune) — so the
// def folds the mode into the fx key ("delay" vs "delay-pingpong") instead
// of passing it as a param. stageShapeKey() then differs and the diff does
// the right thing for free.
//
// Zero audio work in compute() — descriptor in, descriptor out.

export const audioDelayNode: NodeDefinition = {
  type: "audio-delay",
  name: "Delay",
  category: "audio",
  subcategory: "modifier",
  description:
    "Echo effect: repeats the signal after a set time, with feedback controlling how many repeats trail off. Ping-pong mode bounces the echoes between left and right channels.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "audio", type: "audio", required: true, label: "Audio" }],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["normal", "ping-pong"],
      default: "normal",
    },
    {
      name: "time",
      label: "Time (s)",
      type: "scalar",
      min: 0.001,
      max: 2,
      step: 0.001,
      default: 0.25,
    },
    {
      name: "feedback",
      label: "Feedback",
      type: "scalar",
      min: 0,
      max: 0.95,
      step: 0.01,
      default: 0.35,
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

    const mode = (params.mode as string) ?? "normal";
    const value: AudioValue = {
      kind: "audio",
      chain: {
        kind: "effect",
        nodeId,
        // Mode is a class swap in Tone, so it lives in the fx key (shape),
        // never in params (retune).
        fx: mode === "ping-pong" ? "delay-pingpong" : "delay",
        params: {
          time: (params.time as number) ?? 0.25,
          feedback: (params.feedback as number) ?? 0.35,
          wet: (params.wet as number) ?? 0.5,
        },
        input: upstream,
      },
      // Pass the source element through so existing element-tap consumers
      // (audio→scalar, Audio Bands) keep reading SOMETHING — the raw
      // pre-delay signal. M2 replaces this with true post-stage chain
      // taps (audioEngine.getTapAnalyser).
      element: input.element,
      source: input.source,
    };
    return { primary: value };
  },
};
