import type {
  ImageValue,
  NodeDefinition,
  SdfNode,
  SdfValue,
} from "@/engine/types";

// Modifier — perturb the distance field by sampling an image's red
// channel at the position. The sampled value (in [0..1]) is remapped
// to [-amount..+amount] and added to the SDF's distance, so a Perlin
// noise input becomes wobbly edges; a black-and-white mask becomes a
// hard cutout. The image gets bound as a sampler into the compiled
// SDF Rasterize shader, so the displacement is sampled at every pixel
// in lockstep with the SDF evaluation.

function rootOf(v: unknown): SdfNode {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "sdf") {
    return (v as SdfValue).root;
  }
  return { kind: "empty" };
}

export const sdfDisplaceNode: NodeDefinition = {
  type: "sdf-displace",
  name: "SDF Displace",
  category: "utility",
  description:
    "Modifier — perturb the distance field by sampling an image's red channel. Sampled value [0..1] remaps to [-Amount..+Amount] and adds to the distance. Wire a Noise output for wobbly edges; wire a mask for a hard cutout.",
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "sdf", type: "sdf", required: true, label: "SDF" },
    { name: "field", type: "image", required: true, label: "Field" },
    { name: "amount", type: "scalar", required: false, label: "Amount" },
  ],
  params: [
    {
      name: "amount",
      label: "Amount",
      type: "scalar",
      min: -0.5,
      max: 0.5,
      softMax: 0.1,
      step: 0.001,
      default: 0.02,
    },
  ],
  primaryOutput: "sdf",
  auxOutputs: [],

  compute({ inputs, params }) {
    const fieldIn = inputs.field;
    if (!fieldIn || fieldIn.kind !== "image") {
      // No field wired — pass the input SDF straight through. Keeps
      // the graph usable while the user is still wiring.
      const child = rootOf(inputs.sdf);
      const out: SdfValue = { kind: "sdf", root: child };
      return { primary: out };
    }
    const amount =
      inputs.amount?.kind === "scalar"
        ? inputs.amount.value
        : ((params.amount as number) ?? 0.02);
    const out: SdfValue = {
      kind: "sdf",
      root: {
        kind: "displace",
        child: rootOf(inputs.sdf),
        amount,
        image: fieldIn as ImageValue,
      },
    };
    return { primary: out };
  },
};
