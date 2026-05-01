import type { NodeDefinition } from "@/engine/types";

// Bare vec3 literal source. Mirrors Vec2 but for 3-component values.

export const vec3LiteralNode: NodeDefinition = {
  type: "vec3-literal",
  name: "Vec3",
  category: "utility",
  description: "Emits a single vec3 value.",
  backend: "webgl2",
  stable: true,
  inputs: [],
  params: [
    {
      name: "x",
      label: "X",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "y",
      label: "Y",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "z",
      label: "Z",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 1,
      step: 0.001,
      default: 0,
    },
  ],
  primaryOutput: "vec3",
  auxOutputs: [],

  compute({ params }) {
    const x = (params.x as number) ?? 0;
    const y = (params.y as number) ?? 0;
    const z = (params.z as number) ?? 0;
    return { primary: { kind: "vec3", value: [x, y, z] } };
  },
};
