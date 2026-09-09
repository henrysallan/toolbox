import type { NodeDefinition, SdfNode, SdfValue } from "@/engine/types";

// Modifier — turn an SDF into a hollow shell of the given thickness.
// Implemented as `abs(d) - thickness`. Stack multiple Onions for
// concentric rings.

function rootOf(v: unknown): SdfNode {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "sdf") {
    return (v as SdfValue).root;
  }
  return { kind: "empty" };
}

export const sdfOnionNode: NodeDefinition = {
  type: "sdf-onion",
  name: "SDF Onion",
  category: "utility",
  description:
    "Modifier — turn the SDF into a hollow shell of the given thickness. Stack multiple Onions for concentric rings.",
  facts: {
    space: { "in:thickness": "canvas01", "param:thickness": "canvas01" },
    gotchas: [
      "thickness is a canvas-UV distance, like the underlying SDF; whether it reads as width-relative pixels depends on SDF Rasterize's aspect_correct setting.",
      "A wired thickness scalar overrides the thickness param entirely, it is not combined with it.",
      "thickness is clamped to >= 0 (Math.max(0, t)); unlike SDF Round's radius, a negative value cannot be used to shrink anything here.",
    ],
  },
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "sdf", type: "sdf", required: true, label: "SDF" },
    { name: "thickness", type: "scalar", required: false, label: "Thickness" },
  ],
  params: [
    {
      name: "thickness",
      label: "Thickness",
      type: "scalar",
      min: 0,
      max: 0.5,
      softMax: 0.05,
      step: 0.001,
      default: 0.01,
    },
  ],
  primaryOutput: "sdf",
  auxOutputs: [],

  compute({ inputs, params }) {
    const t =
      inputs.thickness?.kind === "scalar"
        ? inputs.thickness.value
        : ((params.thickness as number) ?? 0.01);
    const out: SdfValue = {
      kind: "sdf",
      root: {
        kind: "onion",
        child: rootOf(inputs.sdf),
        thickness: Math.max(0, t),
      },
    };
    return { primary: out };
  },
};
