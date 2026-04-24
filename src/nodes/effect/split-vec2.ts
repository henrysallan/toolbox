import type { NodeDefinition, ScalarValue } from "@/engine/types";

// Break a vec2 into its x and y scalar components. Pairs with
// Combine Vec2 for round-tripping, and fills the gap that the
// coercion layer doesn't (we have scalar→vec broadcast but no
// vec→scalar component pick).
//
// Primary output = x to keep the common "just want the X axis"
// case a one-wire hop; Y lives on an aux so you can grab either
// or both without needing two Split nodes.

export const splitVec2Node: NodeDefinition = {
  type: "split-vec2",
  name: "Split Vec2",
  category: "utility",
  description:
    "Pull the x and y components out of a vec2 as scalars. Primary = x, aux = y.",
  backend: "webgl2",
  inputs: [{ name: "in", type: "vec2", required: true }],
  params: [],
  primaryOutput: "scalar",
  auxOutputs: [{ name: "y", type: "scalar" }],

  compute({ inputs }) {
    const v = inputs.in;
    const x = v?.kind === "vec2" ? v.value[0] : 0;
    const y = v?.kind === "vec2" ? v.value[1] : 0;
    return {
      primary: { kind: "scalar", value: x } satisfies ScalarValue,
      aux: { y: { kind: "scalar", value: y } satisfies ScalarValue },
    };
  },
};
