import type { NodeDefinition, SdfNode, SdfValue } from "@/engine/types";

// Boolean union of two SDFs — the result is "inside if either A or B
// is inside". Implemented as min(a, b). Sharp boundary; for a blended
// boundary use SDF Smooth Union.

function rootOf(v: unknown): SdfNode {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "sdf") {
    return (v as SdfValue).root;
  }
  return { kind: "empty" };
}

export const sdfUnionNode: NodeDefinition = {
  type: "sdf-union",
  name: "SDF Union",
  category: "utility",
  description:
    "Boolean union of two SDFs (min). Result is inside if either A or B is inside. For a blended boundary use SDF Smooth Union.",
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
      root: { kind: "union", a: rootOf(inputs.a), b: rootOf(inputs.b) },
    };
    return { primary: out };
  },
};
