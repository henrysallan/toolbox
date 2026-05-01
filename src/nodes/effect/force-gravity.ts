import type { ForceValue, NodeDefinition } from "@/engine/types";

export const gravityForceNode: NodeDefinition = {
  type: "force-gravity",
  name: "Gravity",
  category: "effect",
  description:
    "Constant directional pull. Negative gy points up in canvas-UV space.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "gx",
      label: "Gx",
      type: "scalar",
      min: -5,
      max: 5,
      step: 0.01,
      default: 0,
    },
    {
      name: "gy",
      label: "Gy",
      type: "scalar",
      min: -5,
      max: 5,
      step: 0.01,
      default: 1,
    },
  ],
  primaryOutput: "force",
  auxOutputs: [],

  compute({ params }) {
    const gx = (params.gx as number) ?? 0;
    const gy = (params.gy as number) ?? 1;
    const out: ForceValue = {
      kind: "force",
      descriptor: { kind: "gravity", gx, gy },
    };
    return { primary: out };
  },
};
