import type {
  InputSocketDef,
  NodeDefinition,
  OutputSocketDef,
  SocketType,
} from "@/engine/types";
import {
  REPEAT_INPUT_TYPE,
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
import type { SocketValue } from "@/engine/types";

// Repeat Output — sequential feedback zone. Same two-node shape as
// Iterate, but each pass's collect sockets become the next pass's
// matching passthroughs (by name), and the shell emits the LAST
// iteration's values at their original types (no image_group wrap).
// Nest a For Each Element inside to map over the working spline each
// generation.

const MAX_COUNT = 16;

export const repeatNode: NodeDefinition = {
  type: "repeat",
  name: "Repeat Output",
  hidden: true,
  category: "utility",
  description:
    "The collecting end of a Repeat zone. The interior runs N times; each pass's collected value is fed back into the Repeat Input's matching passthrough for the next pass (same socket name). The output is the last iteration, same type as the collect — wire a spline in, transform it, wire it out, and depth is a slider. Nest a For Each Element inside to operate per subpath each generation.",
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
      type: s.type as SocketType,
    }));
  },
  fingerprintExtras(_params, ctx, nodeId) {
    if (!nodeId) return "";
    return zoneInteriorHash(ctx, nodeId);
  },

  compute({ inputs, params, ctx, nodeId }) {
    const state = ensureZoneState(ctx, "repeat", nodeId);
    releaseZoneOwned(ctx, state);

    const minted = readBoundarySockets(params);
    if (minted.length === 0) return {};

    const stash = ctx.state[ITERATE_STASH_KEY] as IterateStash | undefined;
    const interior = stash?.get(nodeId);
    const iterInput = findZoneInput(interior, REPEAT_INPUT_TYPE, nodeId);
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
      collectMode: "last",
      tagGroupIndex: false,
      prepareValues: (i, base, last) => {
        if (i === 0 || !last) return { ...base };
        const next: Record<string, SocketValue | undefined> = { ...base };
        for (const [name, v] of Object.entries(last)) next[name] = v;
        return next;
      },
    });
  },

  dispose(ctx, nodeId) {
    disposeZoneState(ctx, "repeat", nodeId);
  },
};
