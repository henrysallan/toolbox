import type { NodeDefinition, SdfNode, SdfValue } from "@/engine/types";

// Morph between two SDFs by linearly interpolating their distance
// fields: mix(dA, dB, amount). At amount=0 the result is shape A, at
// amount=1 it's shape B; in between the boundary sweeps smoothly from
// one to the other and topology can change for free (a disc can split
// into two, a square can grow points into a star). Keyframe — or wire —
// Amount to animate the transition.

function rootOf(v: unknown): SdfNode {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "sdf") {
    return (v as SdfValue).root;
  }
  return { kind: "empty" };
}

export const sdfMorphNode: NodeDefinition = {
  type: "sdf-morph",
  name: "SDF Morph",
  category: "utility",
  description:
    "Morph between two SDFs by interpolating their distance fields (mix). Amount 0 = A, 1 = B; topology can change mid-morph. Keyframe or wire Amount to animate.",
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "a", type: "sdf", required: false, label: "A" },
    { name: "b", type: "sdf", required: false, label: "B" },
    { name: "amount", type: "scalar", required: false, label: "Amount" },
  ],
  params: [
    {
      name: "amount",
      label: "Amount",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
  ],
  primaryOutput: "sdf",
  auxOutputs: [],

  compute({ inputs, params }) {
    // Wired scalar wins over the (keyframable) param — same precedence
    // as SDF Smooth Union's smoothness.
    const raw =
      inputs.amount?.kind === "scalar"
        ? inputs.amount.value
        : ((params.amount as number) ?? 0.5);
    const t = Math.max(0, Math.min(1, raw));
    const out: SdfValue = {
      kind: "sdf",
      root: {
        kind: "morph",
        a: rootOf(inputs.a),
        b: rootOf(inputs.b),
        t,
      },
    };
    return { primary: out };
  },
};
