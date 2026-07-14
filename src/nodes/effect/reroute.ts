import type { NodeDefinition, SocketType } from "@/engine/types";

// Reroute — a wire-organizing passthrough, rendered as a dot in the editor
// (RerouteNode.tsx) but a first-class node in the model so it inherits
// selection, copy/paste, delete-removes-all-wires, and single-input swap for
// free. See specdocs/071326_reroute-node.md.
//
// It carries exactly one polymorphic value from its `value` input straight to
// its output, adopting whatever type is wired in (connectedTypes retyping, so
// it belongs in EffectsApp's CONNECTED_TYPE_RETYPE_NODES). The engine never
// actually evaluates one: flattenGraph dissolves reroutes before toposort,
// splicing `source → reroute → {targets}` down to direct `source → {targets}`
// edges — so a reroute costs nothing at render time and coercion/caching are
// identical to a plain wire. The `compute` below is a defensive passthrough in
// case a reroute ever survives flatten; the normal path never calls it.
//
// `hidden: true` — reroutes are born from the Shift-drag / double-click-a-wire
// gestures, not the add-node catalog. `noMaskInput` — a passthrough must not
// grow the universal `mask` socket.

const REROUTE_INPUT = "value";

function wiredType(ctx?: {
  connectedTypes: Record<string, SocketType | undefined>;
}): SocketType {
  return ctx?.connectedTypes[REROUTE_INPUT] ?? "image";
}

export const rerouteNode: NodeDefinition = {
  type: "reroute",
  name: "Reroute",
  hidden: true,
  category: "utility",
  backend: "webgl2",
  noMaskInput: true,
  description:
    "A wire waypoint. Passes its input straight through, adopting whatever type is wired in. Delete it to remove its wires; drop a new wire on the left to swap its input.",
  inputs: [{ name: REROUTE_INPUT, type: "image", required: false }],
  resolveInputs: (_params, ctx) => [
    { name: REROUTE_INPUT, type: wiredType(ctx), required: false },
  ],
  params: [],
  primaryOutput: "image",
  resolvePrimaryOutput: (_params, ctx) => wiredType(ctx),
  auxOutputs: [],
  compute: ({ inputs }) => {
    const v = inputs[REROUTE_INPUT];
    if (v === undefined) return {};
    // Pass the received value through untouched — we don't own its textures.
    return { primary: v, ownsTextures: false };
  },
};
