import type { NodeDefinition, Vec2Value } from "@/engine/types";

// Assemble a vec2 from two scalars. Mirror of Split Vec2. When an
// input is unconnected it falls back to the corresponding scalar
// param so the node is useful stand-alone for emitting a literal
// vec2 constant.

export const combineVec2Node: NodeDefinition = {
  type: "combine-vec2",
  name: "Combine Vec2",
  category: "effect",
  description:
    "Build a vec2 from two scalars. Inputs default to the x/y params when unconnected, so the node also doubles as a vec2 constant.",
  backend: "webgl2",
  inputs: [
    { name: "x", type: "scalar", required: false },
    { name: "y", type: "scalar", required: false },
  ],
  params: [
    {
      name: "x",
      label: "X",
      type: "scalar",
      min: -10,
      max: 10,
      softMax: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "y",
      label: "Y",
      type: "scalar",
      min: -10,
      max: 10,
      softMax: 1,
      step: 0.001,
      default: 0,
    },
  ],
  primaryOutput: "vec2",
  auxOutputs: [],

  compute({ inputs, params }) {
    const xIn = inputs.x;
    const yIn = inputs.y;
    const x = xIn?.kind === "scalar" ? xIn.value : (params.x as number) ?? 0;
    const y = yIn?.kind === "scalar" ? yIn.value : (params.y as number) ?? 0;
    return {
      primary: { kind: "vec2", value: [x, y] } satisfies Vec2Value,
    };
  },
};
