import type { ForceValue, NodeDefinition } from "@/engine/types";

export const turbulenceForceNode: NodeDefinition = {
  type: "force-turbulence",
  name: "Turbulence",
  category: "effect",
  description:
    "Curl-noise turbulence field that advects through time at the given speed.",
  facts: {
    gotchas: [
      "Produces a force descriptor only; the consuming simulator advances curl noise through time (time*speed) and adds the curl to velocity each step.",
      "scale multiplies the canvas01 position before sampling curl noise, so it behaves as a spatial frequency (more cells across the canvas), not a canvas distance.",
    ],
  },
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "scale",
      label: "Scale",
      type: "scalar",
      min: 0.5,
      max: 32,
      step: 0.1,
      default: 4,
    },
    {
      name: "strength",
      label: "Strength",
      type: "scalar",
      min: 0,
      softMax: 2,
      max: 10,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "speed",
      label: "Speed",
      type: "scalar",
      min: 0,
      max: 10,
      step: 0.05,
      default: 1,
    },
  ],
  primaryOutput: "force",
  auxOutputs: [],

  compute({ params }) {
    const scale = (params.scale as number) ?? 4;
    const strength = (params.strength as number) ?? 0.5;
    const speed = (params.speed as number) ?? 1;
    const out: ForceValue = {
      kind: "force",
      descriptor: { kind: "turbulence", scale, strength, speed },
    };
    return { primary: out };
  },
};
