import type { NodeDefinition, SdfNode, SdfValue } from "@/engine/types";

// Polynomial smooth subtraction. Smoothness rounds the cut so the
// subtracted shape blends into A instead of leaving a sharp crease.

function rootOf(v: unknown): SdfNode {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "sdf") {
    return (v as SdfValue).root;
  }
  return { kind: "empty" };
}

export const sdfSmoothSubtractionNode: NodeDefinition = {
  type: "sdf-smooth-subtraction",
  name: "SDF Smooth Subtraction",
  category: "utility",
  description:
    "Smooth subtraction (A − B) with a rounded cut. Smoothness blends the boundary where B carves into A — at 0 it degenerates to plain Subtraction.",
  facts: {
    space: { "in:smoothness": "canvas01", "param:smoothness": "canvas01" },
    gotchas: [
      "smoothness is a canvas-UV distance compared directly against the signed distance (same units as a shape's radius); 0 degenerates to plain Subtraction.",
      "An unwired A (base) is the empty sentinel, so the result is empty; an unwired B (cut) leaves A unchanged, since subtracting nothing does nothing.",
    ],
  },
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "a", type: "sdf", required: false, label: "A (base)" },
    { name: "b", type: "sdf", required: false, label: "B (cut)" },
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
        kind: "smoothSubtraction",
        a: rootOf(inputs.a),
        b: rootOf(inputs.b),
        k: Math.max(0, k),
      },
    };
    return { primary: out };
  },
};
