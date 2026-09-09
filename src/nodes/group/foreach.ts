import type {
  InputSocketDef,
  NodeDefinition,
  OutputSocketDef,
  PointsValue,
  SocketType,
  SocketValue,
  SplineValue,
} from "@/engine/types";
import {
  FOREACH_INPUT_TYPE,
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
import { EMPTY_POINTS, gatherPoints } from "@/engine/points";

// For Each Output — map a subgraph over each subpath (or point) of a
// wired geometry input on this shell. Output is grouped like Iterate.
// Nest inside a Repeat zone to recurse: Repeat feeds the working spline
// into this node's geometry input each generation.

const MAX_ELEMENTS = 1024;

function sliceElement(
  geo: SocketValue | undefined,
  i: number
): SocketValue | undefined {
  if (geo?.kind === "spline") {
    const sub = geo.subpaths[i];
    return {
      kind: "spline",
      subpaths: sub ? [{ ...sub }] : [],
    } satisfies SplineValue;
  }
  if (geo?.kind === "points") {
    if (i < 0 || i >= geo.count) return EMPTY_POINTS;
    return gatherPoints(geo as PointsValue, [i], 1);
  }
  return undefined;
}

export const foreachNode: NodeDefinition = {
  type: "foreach",
  name: "For Each Output",
  hidden: true,
  category: "utility",
  description:
    "The collecting end of a For Each Element zone. Wire a spline or points value into Geometry — the interior runs once per subpath (or per point), with that element on the For Each Input. Collected results merge like Iterate (groupIndex = element index). Put this zone inside a Repeat to process every current segment each generation.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [],
  resolveInputs(params, ctx): InputSocketDef[] {
    const connected = ctx?.connectedTypes?.geometry;
    const geoType: SocketType =
      connected === "points" ? "points" : "spline";
    return zoneShellInputs(params, [
      { name: "geometry", type: geoType, required: true, label: "Geometry" },
    ]);
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
    const state = ensureZoneState(ctx, "foreach", nodeId);
    releaseZoneOwned(ctx, state);

    const minted = readBoundarySockets(params);
    if (minted.length === 0) return {};

    const stash = ctx.state[ITERATE_STASH_KEY] as IterateStash | undefined;
    const interior = stash?.get(nodeId);
    const iterInput = findZoneInput(interior, FOREACH_INPUT_TYPE, nodeId);
    const loopParam = (name: string, fallback: number) =>
      resolveZoneLoopParam(inputs, iterInput, ctx, name, fallback);

    const geo = inputs.geometry;
    const cap = Math.max(
      1,
      Math.min(MAX_ELEMENTS, Math.round(loopParam("max_elements", 256)))
    );
    let n = 0;
    if (geo?.kind === "points") n = geo.count;
    else if (geo?.kind === "spline") n = geo.subpaths.length;
    const K = Math.min(n, cap);

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
      prepareValues: (i, base) => {
        const element = sliceElement(geo, i);
        return element ? { ...base, element } : { ...base };
      },
    });
  },

  dispose(ctx, nodeId) {
    disposeZoneState(ctx, "foreach", nodeId);
  },
};
