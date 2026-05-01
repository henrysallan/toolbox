import type { NodeDefinition, SdfNode, SdfValue } from "@/engine/types";

// Boolean intersection of two SDFs — the result is "inside only where
// both A and B are inside". Implemented as max(a, b).

function rootOf(v: unknown): SdfNode {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "sdf") {
    return (v as SdfValue).root;
  }
  return { kind: "empty" };
}

export const sdfIntersectionNode: NodeDefinition = {
  type: "sdf-intersection",
  name: "SDF Intersection",
  category: "utility",
  description:
    "Boolean intersection of two SDFs (max). Result is inside only where both A and B are inside.",
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "a", type: "sdf", required: false, label: "A" },
    { name: "b", type: "sdf", required: false, label: "B" },
  ],
  params: [],
  primaryOutput: "sdf",
  auxOutputs: [],

  compute({ inputs }) {
    const out: SdfValue = {
      kind: "sdf",
      root: {
        kind: "intersection",
        a: rootOf(inputs.a),
        b: rootOf(inputs.b),
      },
    };
    return { primary: out };
  },
};
