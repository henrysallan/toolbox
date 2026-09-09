import type {
  InputSocketDef,
  NodeDefinition,
  OutputSocketDef,
  SocketType,
} from "@/engine/types";
import {
  ITERATE_INPUT_TYPE,
  readBoundarySockets,
} from "@/engine/groups";
import {
  disposeZoneState,
  ensureZoneState,
  findZoneInput,
  releaseZoneOwned,
  resolveZoneLoopParam,
  runZoneNestedLoop,
  zoneInteriorHash,
  zoneShellInputs,
} from "@/engine/zone-eval";
import { ITERATE_STASH_KEY, type IterateStash } from "@/engine/evaluator";

// Iteration Output — the computing half of an Iterate zone
// (071826_iterate-node.md; zone presentation 071926_iterate-zone-view.md
// rev 3). Nested Repeat / For Each zones are allowed: ctx.iteration is
// saved/restored around the inner loop so an outer Repeat can wrap a
// For Each (the recursive-subdivision pattern).

const MAX_COUNT = 64;

export const iterateNode: NodeDefinition = {
  type: "iterate",
  name: "Iteration Output",
  hidden: true,
  category: "utility",
  description:
    "The collecting end of an Iterate zone. Wire member results into it to define what gets collected (each wire mints its own collect socket): an image comes out as an image group (one item per iteration); a spline or points value comes out merged with each iteration's items groupIndex-tagged by iteration — ready for Copy to Points' variant picks and per-group styling. Iteration count, seed, and the random range live on the zone's Iteration Input node.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [],
  resolveInputs(params): InputSocketDef[] {
    return zoneShellInputs(params);
  },
  params: [],
  primaryOutput: null,
  auxOutputs: [],
  resolveAuxOutputs(params): OutputSocketDef[] {
    return readBoundarySockets(params).map((s) => ({
      name: s.name,
      type: (s.type === "image" ? "image_group" : s.type) as SocketType,
    }));
  },
  fingerprintExtras(_params, ctx, nodeId) {
    if (!nodeId) return "";
    return zoneInteriorHash(ctx, nodeId);
  },

  compute({ inputs, params, ctx, nodeId }) {
    const state = ensureZoneState(ctx, "iterate", nodeId);
    releaseZoneOwned(ctx, state);

    const minted = readBoundarySockets(params);
    if (minted.length === 0) return {};

    const stash = ctx.state[ITERATE_STASH_KEY] as IterateStash | undefined;
    const interior = stash?.get(nodeId);
    const iterInput = findZoneInput(interior, ITERATE_INPUT_TYPE, nodeId);
    const loopParam = (name: string, fallback: number) =>
      resolveZoneLoopParam(inputs, iterInput, ctx, name, fallback);

    const K = Math.max(
      1,
      Math.min(MAX_COUNT, Math.round(loopParam("count", 1)))
    );
    return runZoneNestedLoop({
      nodeId,
      ctx,
      inputs,
      params,
      state,
      minted,
      K,
      seed: Math.floor(loopParam("seed", 0)),
      rMin: loopParam("random_min", 0),
      rMax: loopParam("random_max", 1),
      collectMode: "group",
      tagGroupIndex: true,
      prepareValues: (_i, base) => ({ ...base }),
    });
  },

  dispose(ctx, nodeId) {
    disposeZoneState(ctx, "iterate", nodeId);
  },
};
