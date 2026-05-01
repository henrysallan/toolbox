import type { ColliderValue, NodeDefinition } from "@/engine/types";

export const imageMaskColliderNode: NodeDefinition = {
  type: "collider-image-mask",
  name: "Image Mask Collider",
  category: "effect",
  description:
    "Image-based collider — pixels with alpha above the threshold act as solid geometry. Particles bounce off (gradient as surface normal) or die on contact.",
  backend: "webgl2",
  inputs: [{ name: "mask", type: "image", required: true }],
  params: [
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "kill",
      label: "Kill on contact",
      type: "boolean",
      default: false,
    },
    {
      name: "restitution",
      label: "Bounce",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => !p.kill,
    },
  ],
  primaryOutput: "collider",
  auxOutputs: [],

  compute({ inputs, params }) {
    const mask = inputs.mask;
    if (!mask || mask.kind !== "image") return {};
    const value: ColliderValue = {
      kind: "collider",
      descriptor: {
        kind: "image_mask",
        mask,
        threshold: Math.max(
          0,
          Math.min(1, (params.threshold as number) ?? 0.5)
        ),
        restitution: Math.max(
          0,
          Math.min(1, (params.restitution as number) ?? 0.5)
        ),
        kill: !!params.kill,
      },
    };
    return { primary: value };
  },
};
