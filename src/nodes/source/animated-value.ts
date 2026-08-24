import type { NodeDefinition } from "@/engine/types";

// Animated Value (specdocs/081426_time-offset.md, Part 2). A keyframable
// scalar whose keyframes sample at a WIRED clock instead of the playhead.
//
// Unwired `time` ⇒ behaves exactly like a keyframed Constant. Wired ⇒ the
// evaluator's clockInput affordance samples this node's keyframes at the
// incoming value (converted to ticks per the Unit param), so
// `Scene Time (frames) → Math subtract 10 → time` is a 10-frame offset, a
// Float Curve in that chain is a time-warp, and an audio level scrubs the
// curve by loudness. Out-of-range times clamp to the end keyframes
// (evaluateKeyframesAt's clamp).
//
// The node's own compute is trivial — keyframe resolution happens in the
// evaluator (wire > keyframe > constant precedence untouched: a wire into
// the `value` param still beats keyframes; clockInput only changes WHEN
// keyframes sample). The Track/Graph editors need nothing: keyframes live
// in a normal animation block and edit normally — only evaluation reads
// them at the wired clock, so the playhead diamond reflects the outer
// clock (inherent to retiming; noted in the node docs).

export const animatedValueNode: NodeDefinition = {
  type: "animated-value",
  name: "Animated Value",
  category: "utility",
  description:
    "A keyframable value with a wired clock: keyframe Value as usual, then wire a scalar into Time and the curve is sampled at that time instead of the playhead — offset it, stretch it, ping-pong it, or drive it from audio. Unwired, it behaves like a keyframed Constant. Unit sets whether Time is read as frames or seconds.",
  searchAliases: ["retime", "keyframes", "channel", "curve sample", "clock"],
  backend: "webgl2",
  inputs: [{ name: "time", type: "scalar", required: false, label: "Time" }],
  params: [
    {
      name: "value",
      label: "Value",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.001,
      default: 0,
    },
    {
      name: "unit",
      label: "Unit",
      type: "enum",
      options: ["frames", "seconds"],
      control: "segmented",
      default: "frames",
    },
  ],
  clockInput: { input: "time", unitParam: "unit" },
  primaryOutput: "scalar",
  auxOutputs: [],

  compute({ params }) {
    const v = params.value;
    return {
      primary: {
        kind: "scalar",
        value: typeof v === "number" && Number.isFinite(v) ? v : 0,
      },
    };
  },
};
