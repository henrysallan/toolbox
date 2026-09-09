import type { NodeDefinition, SdfNode, SdfValue } from "@/engine/types";

// Boolean subtraction — A minus B. Result is inside A but outside B.
// Implemented as max(a, -b).

function rootOf(v: unknown): SdfNode {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "sdf") {
    return (v as SdfValue).root;
  }
  return { kind: "empty" };
}

export const sdfSubtractionNode: NodeDefinition = {
  type: "sdf-subtraction",
  name: "SDF Subtraction",
  category: "utility",
  description:
    "Boolean subtraction (A − B). Result is inside A but outside B — useful for cutting holes.",
  facts: {
    gotchas: [
      "Computed as max(a, -b): an unwired A (base) is the empty sentinel, so the result is empty; an unwired B (cut) leaves A unchanged.",
      "When shapes carry SDF Material colours, B (the cutter) never contributes colour or bleed weight; only A's colour and wash survive the cut.",
    ],
  },
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "a", type: "sdf", required: false, label: "A (base)" },
    { name: "b", type: "sdf", required: false, label: "B (cut)" },
  ],
  params: [],
  primaryOutput: "sdf",
  auxOutputs: [],

  compute({ inputs }) {
    const out: SdfValue = {
      kind: "sdf",
      root: {
        kind: "subtraction",
        a: rootOf(inputs.a),
        b: rootOf(inputs.b),
      },
    };
    return { primary: out };
  },
};
