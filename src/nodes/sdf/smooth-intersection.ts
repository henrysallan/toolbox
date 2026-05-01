import type { NodeDefinition, SdfNode, SdfValue } from "@/engine/types";

// Polynomial smooth intersection — the dual of Smooth Union. Smoothness
// rounds the corners where the two boundaries meet. 0 degenerates to
// plain max().

function rootOf(v: unknown): SdfNode {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "sdf") {
    return (v as SdfValue).root;
  }
  return { kind: "empty" };
}

export const sdfSmoothIntersectionNode: NodeDefinition = {
  type: "sdf-smooth-intersection",
  name: "SDF Smooth Intersection",
  category: "utility",
  description:
    "Smooth intersection of two SDFs. Smoothness rounds the corners where boundaries meet — same as Smooth Union, but for intersection (max).",
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "a", type: "sdf", required: false, label: "A" },
    { name: "b", type: "sdf", required: false, label: "B" },
    {
      name: "smoothness",
      type: "scalar",
      required: false,
      label: "Smoothness",
    },
  ],
  params: [
    {
      name: "smoothness",
      label: "Smoothness",
      type: "scalar",
      min: 0,
      max: 0.5,
      softMax: 0.2,
      step: 0.001,
      default: 0.05,
    },
  ],
  primaryOutput: "sdf",
  auxOutputs: [],

  compute({ inputs, params }) {
    const k =
      inputs.smoothness?.kind === "scalar"
        ? inputs.smoothness.value
        : ((params.smoothness as number) ?? 0.05);
    const out: SdfValue = {
      kind: "sdf",
      root: {
        kind: "smoothIntersection",
        a: rootOf(inputs.a),
        b: rootOf(inputs.b),
        k: Math.max(0, k),
      },
    };
    return { primary: out };
  },
};
