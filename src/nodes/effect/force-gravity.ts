import type { ForceValue, NodeDefinition } from "@/engine/types";

export const gravityForceNode: NodeDefinition = {
  type: "force-gravity",
  name: "Gravity",
  category: "effect",
  description:
    "Constant directional pull. Negative gy points up in canvas-UV space.",
  facts: {
    gotchas: [
      "Produces a force descriptor only; gx/gy are added straight to velocity each step (vel += g*dt) by whichever simulator consumes it.",
      "gx/gy are accelerations in the authored canvas01 frame (Y-down, width-isotropic): positive gy pulls toward the bottom of the canvas.",
    ],
  },
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
