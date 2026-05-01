import type { NodeDefinition, SdfNode, SdfValue } from "@/engine/types";

// Inflate (or deflate, with negative radius) the boundary of an SDF
// outward by `radius`. Sharp corners become rounded; the entire shape
// grows by `radius` in every direction.

function rootOf(v: unknown): SdfNode {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "sdf") {
    return (v as SdfValue).root;
  }
  return { kind: "empty" };
}

export const sdfRoundNode: NodeDefinition = {
  type: "sdf-round",
  name: "SDF Round",
  category: "utility",
  description:
    "Inflate the boundary of an SDF by `radius`. Sharp corners become rounded; the entire shape grows by radius. Negative radius shrinks it.",
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "sdf", type: "sdf", required: true, label: "SDF" },
    { name: "radius", type: "scalar", required: false, label: "Radius" },
  ],
  params: [
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: -1,
      max: 1,
      softMax: 0.1,
      step: 0.001,
      default: 0.02,
    },
  ],
  primaryOutput: "sdf",
  auxOutputs: [],

  compute({ inputs, params }) {
    const r =
      inputs.radius?.kind === "scalar"
        ? inputs.radius.value
        : ((params.radius as number) ?? 0.02);
    const out: SdfValue = {
      kind: "sdf",
      root: { kind: "round", child: rootOf(inputs.sdf), r },
    };
    return { primary: out };
  },
};
