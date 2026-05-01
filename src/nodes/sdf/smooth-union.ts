import type { NodeDefinition, SdfNode, SdfValue } from "@/engine/types";

// Polynomial smin (Iñigo Quilez). Smoothness controls the blend
// width — when two SDFs come within `smoothness` of each other their
// boundaries merge into a single curved blob. Set to 0 for a sharp
// union (degenerates to plain min).

function rootOf(v: unknown): SdfNode {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "sdf") {
    return (v as SdfValue).root;
  }
  return { kind: "empty" };
}

export const sdfSmoothUnionNode: NodeDefinition = {
  type: "sdf-smooth-union",
  name: "SDF Smooth Union",
  category: "utility",
  description:
    "Smooth (blob) union of two SDFs. Smoothness sets the blend width — when boundaries come within Smoothness of each other they merge into a curved metaball-style join.",
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
        kind: "smoothUnion",
        a: rootOf(inputs.a),
        b: rootOf(inputs.b),
        k: Math.max(0, k),
      },
    };
    return { primary: out };
  },
};
