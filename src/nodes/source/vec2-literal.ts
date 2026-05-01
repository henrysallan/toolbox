import type { NodeDefinition } from "@/engine/types";

// Bare vec2 literal source. Same role as Constant, but emits a vec2 so
// downstream consumers (Point's position input, Math in UV mode, etc.)
// don't need a Combine Vec2 to author a static pair.

export const vec2LiteralNode: NodeDefinition = {
  type: "vec2-literal",
  name: "Vec2",
  category: "utility",
  description:
    "Emits a single vec2 value. Use to feed exposed vec2 inputs without routing through Combine Vec2.",
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
  ],
  primaryOutput: "vec2",
  auxOutputs: [],

  compute({ params }) {
    const x = (params.x as number) ?? 0;
    const y = (params.y as number) ?? 0;
    return { primary: { kind: "vec2", value: [x, y] } };
  },
};
