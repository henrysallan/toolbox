import type { ForceValue, NodeDefinition } from "@/engine/types";

export const dragForceNode: NodeDefinition = {
  type: "force-drag",
  name: "Drag",
  category: "effect",
  description:
    "Linear-in-velocity damping. Higher coefficients slow particles faster.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "coeff",
      label: "Coefficient",
      type: "scalar",
      min: 0,
      max: 10,
      step: 0.01,
      default: 1,
    },
  ],
  primaryOutput: "force",
  auxOutputs: [],

  compute({ params }) {
    const coeff = (params.coeff as number) ?? 1;
    const out: ForceValue = {
      kind: "force",
      descriptor: { kind: "drag", coeff },
    };
    return { primary: out };
  },
};
