import type {
  NodeDefinition,
  OutputSocketDef,
  SocketType,
} from "@/engine/types";

// Eval-only feed for a direct crossing wire into an Iterate zone
// (071926_iterate-zone-view.md, "stay as wired"). Never exists in a
// project: the shell's compute synthesizes one per exterior→member edge
// before each nested evaluation, rewiring the interior copy of that
// edge to source from here. Compute re-emits the outer-evaluated value
// from ctx.iteration.values (keyed by the mirrored shell input's name).
//
// `params.kind` records the value's runtime kind at synthesis so
// polymorphic members reading connectedTypes see a sensible type.
// ownsTextures:false is load-bearing — the value may be a borrowed
// exterior texture the private cache must never release.

export const iterateFeedNode: NodeDefinition = {
  type: "iterate-feed",
  name: "Iteration Feed",
  hidden: true,
  category: "utility",
  description:
    "Internal: carries an outside wire's value into an Iterate zone during evaluation.",
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
  // bumps) — it is constant ACROSS iterations, so no index here and the
  // private cache serves iterations 1…K−1 for free.
  fingerprintExtras(_params, ctx) {
    const it = ctx.iteration;
    return it ? `feed:${it.runId}` : "";
  },
  compute({ params, ctx }) {
    const v = ctx.iteration?.values[(params.key as string) ?? ""];
    return v ? { aux: { value: v }, ownsTextures: false } : {};
  },
};
