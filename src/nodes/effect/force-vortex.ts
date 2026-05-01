import type { ForceValue, NodeDefinition } from "@/engine/types";

export const vortexForceNode: NodeDefinition = {
  type: "force-vortex",
  name: "Vortex",
  category: "effect",
  description:
    "Tangential swirl around a point. Strength sign flips rotation direction.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "position",
      label: "Position",
      type: "vec2",
      step: 0.001,
      default: [0.5, 0.5],
    },
    {
      name: "strength",
      label: "Strength",
      type: "scalar",
      min: -10,
      max: 10,
      step: 0.01,
      default: 1,
    },
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 0.001,
      max: 1.5,
      step: 0.001,
      default: 0.3,
    },
    {
      name: "falloff",
      label: "Falloff",
      type: "scalar",
      min: 0,
      max: 8,
      step: 0.1,
      default: 1.5,
    },
  ],
  primaryOutput: "force",
  auxOutputs: [],

  compute({ params }) {
    const pos = (params.position as [number, number]) ?? [0.5, 0.5];
    const strength = (params.strength as number) ?? 1;
    const radius = (params.radius as number) ?? 0.3;
    const falloff = (params.falloff as number) ?? 1.5;
    const out: ForceValue = {
      kind: "force",
      descriptor: {
        kind: "vortex",
        px: pos[0],
        py: pos[1],
        strength,
        falloff,
        radius,
      },
    };
    return { primary: out };
  },
};
