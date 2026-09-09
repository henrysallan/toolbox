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
  facts: {
    space: { "in:radius": "canvas01", "param:radius": "canvas01" },
    gotchas: [
      "radius is a canvas-UV distance, like the underlying SDF; whether it reads as width-relative pixels depends on SDF Rasterize's aspect_correct setting.",
      "A wired radius scalar overrides the radius param entirely, it is not combined with it.",
      "radius is unclamped (can go negative to shrink); unlike SDF Onion's thickness, there is no floor at zero.",
    ],
  },
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
