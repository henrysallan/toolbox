import type {
  NodeDefinition,
  OutputSocketDef,
  SocketType,
} from "@/engine/types";

// Eval-only feed for a boundary crossing edge into a Time Offset closure
// (specdocs/081426_time-offset.md). Never exists in a project: the shell's
// compute synthesizes one per boundary edge before its nested evaluation,
// rewiring the closure's copy of that edge to source from here. Compute
// re-emits the outer-evaluated value from ctx.timeOffsetFeed.values
// (keyed by the mirrored shell input's name) — the iterate-feed pattern
// exactly, on the shell's own ctx channel.
//
// `params.kind` records the value's runtime kind at synthesis so
// polymorphic members reading connectedTypes see a sensible type.
// ownsTextures:false is load-bearing — the value may be a borrowed outer
// texture the private cache must never release.

export const timeOffsetFeedNode: NodeDefinition = {
  type: "time-offset-feed",
  name: "Time Offset Feed",
  hidden: true,
  category: "utility",
  description:
    "Internal: carries an outside wire's un-shifted value into a Time Offset node's re-evaluated branch.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [],
  params: [],
  primaryOutput: null,
  auxOutputs: [],
  resolveAuxOutputs(params): OutputSocketDef[] {
    return [
      {
        name: "value",
        type: ((params.kind as string) ?? "image") as SocketType,
      },
    ];
  },
  // The outer value can only change when the shell recomputes (runId
  // bumps), so the private cache serves repeated nested passes for free
  // while the fed value holds still.
  fingerprintExtras(_params, ctx) {
    const feed = ctx.timeOffsetFeed;
    return feed ? `tofeed:${feed.runId}` : "";
  },
  compute({ params, ctx }) {
    const v = ctx.timeOffsetFeed?.values[(params.key as string) ?? ""];
    return v ? { aux: { value: v }, ownsTextures: false } : {};
  },
};
