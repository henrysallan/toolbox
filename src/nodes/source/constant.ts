import type { NodeDefinition } from "@/engine/types";

// Bare scalar literal source. Avoids routing single numbers through Math
// (Math at "Add" with B unconnected works, but a dedicated primitive
// reads cleaner in the graph and is easier to discover in the menu).
//
// The slider exposes one number; the node forwards it as a scalar.
// Stable — value comes from params, no time/external state.

export const constantNode: NodeDefinition = {
  type: "constant",
  name: "Constant",
  category: "utility",
  description:
    "Emits a single scalar value. Use to feed exposed scalar inputs without routing through a Math node.",
  backend: "webgl2",
  stable: true,
  inputs: [],
  params: [
    {
      name: "value",
      label: "Value",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.001,
      default: 1,
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],

  compute({ params }) {
    const value = (params.value as number) ?? 0;
    return { primary: { kind: "scalar", value } };
  },
};
