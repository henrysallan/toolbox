import type { ForceValue, NodeDefinition } from "@/engine/types";

export const dragForceNode: NodeDefinition = {
  type: "force-drag",
  name: "Drag",
  category: "effect",
  description:
    "Linear-in-velocity damping. Higher coefficients slow particles faster.",
  facts: {
    gotchas: [
      "Produces a force descriptor only; the damping (vel *= max(0, 1 - coeff*dt)) runs inside whichever simulator consumes it (sim-kernel.ts, particle shader).",
      "coeff is a per-second damping rate, not a 0..1 fraction — a large coeff*dt can zero out velocity in one step rather than merely slowing it.",
    ],
  },
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
