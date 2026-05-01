import type { NodeDefinition } from "@/engine/types";

// Comparison operator on two scalars, output is 1.0 (true) or 0.0
// (false). The "==" / "!=" variants compare with an epsilon window
// because exact float equality is rarely useful in practice.

const OPS = [">", "<", ">=", "<=", "==", "!="] as const;
type Op = (typeof OPS)[number];

export const compareNode: NodeDefinition = {
  type: "compare",
  name: "Compare",
  category: "utility",
  description:
    "Compare two scalars with one of >, <, ≥, ≤, ==, !=. Output is 1 (true) or 0 (false). Equality variants use an epsilon window so floating-point fuzz doesn't flip results.",
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "a", type: "scalar", required: false, label: "A" },
    { name: "b", type: "scalar", required: false, label: "B" },
  ],
  params: [
    {
      name: "op",
      label: "Op",
      type: "enum",
      options: OPS as unknown as string[],
      default: ">",
    },
    {
      name: "a",
      label: "A",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.001,
      default: 0,
    },
    {
      name: "b",
      label: "B",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.001,
      default: 0,
    },
    {
      name: "epsilon",
      label: "Epsilon",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.0001,
      default: 0.0001,
      visibleIf: (p) => p.op === "==" || p.op === "!=",
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],

  compute({ inputs, params }) {
    const a =
      inputs.a?.kind === "scalar"
        ? inputs.a.value
        : ((params.a as number) ?? 0);
    const b =
      inputs.b?.kind === "scalar"
        ? inputs.b.value
        : ((params.b as number) ?? 0);
    const op = ((params.op as string) ?? ">") as Op;
    const eps = (params.epsilon as number) ?? 1e-4;

    let result: boolean;
    switch (op) {
      case ">":
        result = a > b;
        break;
      case "<":
        result = a < b;
        break;
      case ">=":
        result = a >= b;
        break;
      case "<=":
        result = a <= b;
        break;
      case "==":
        result = Math.abs(a - b) <= eps;
        break;
      case "!=":
        result = Math.abs(a - b) > eps;
        break;
    }
    return { primary: { kind: "scalar", value: result ? 1 : 0 } };
  },
};
