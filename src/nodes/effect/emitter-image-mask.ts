import type { EmitterValue, NodeDefinition } from "@/engine/types";

// Image-mask emitter — spawns particles into pixels of a mask image
// weighted by alpha. The simulator samples the mask texture at random UVs
// on its spawn pass and rejects samples whose alpha is below `threshold`.
// If the mask input is missing or the wrong kind we emit nothing — the
// simulator's switch keys on descriptor.kind, so producing no value is
// the right way to signal "no spawns from this emitter".

export const imageMaskEmitterNode: NodeDefinition = {
  type: "emitter-image-mask",
  name: "Image Mask Emitter",
  category: "effect",
  description:
    "Emit particles into the pixels of a mask image, weighted by alpha.",
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
      name: "rate",
      label: "Rate",
      type: "scalar",
      min: 0,
      max: 100000,
      step: 10,
      default: 1000,
    },
    {
      name: "velocity",
      label: "Velocity",
      type: "vec2",
      default: [0, 0],
    },
    {
      name: "vJitter",
      label: "Velocity Jitter",
      type: "scalar",
      min: 0,
      max: 5,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "lifetime",
      label: "Lifetime",
      type: "scalar",
      min: 0.05,
      max: 60,
      step: 0.05,
      default: 2,
    },
  ],
  primaryOutput: "emitter",
  auxOutputs: [],

  compute({ inputs, params }) {
    const maskInput = inputs.mask;
    if (!maskInput || maskInput.kind !== "image") {
      return {};
    }
    const vel = (params.velocity as [number, number] | undefined) ?? [0, 0];
    const out: EmitterValue = {
      kind: "emitter",
      descriptor: {
        kind: "image_mask",
        mask: maskInput,
        threshold: Math.max(0, Math.min(1, (params.threshold as number) ?? 0.5)),
        rate: Math.max(0, (params.rate as number) ?? 1000),
        vx: vel[0],
        vy: vel[1],
        vJitter: Math.max(0, (params.vJitter as number) ?? 0.5),
        lifetime: Math.max(0.05, (params.lifetime as number) ?? 2),
      },
    };
    return { primary: out };
  },
};
