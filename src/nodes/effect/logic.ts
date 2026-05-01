import type { InputSocketDef, NodeDefinition } from "@/engine/types";

// Boolean gate over scalar inputs. Any non-zero value reads as true;
// exactly zero reads as false. Output is 1.0 (true) or 0.0 (false).
//
// "not" is a 1-input op; the others take two. resolveInputs hides the
// second input when "not" is selected so the node visually communicates
// what it's reading.

const OPS = ["and", "or", "xor", "not"] as const;
type Op = (typeof OPS)[number];

function bool(v: number): boolean {
  return v !== 0;
}

export const logicNode: NodeDefinition = {
  type: "logic",
  name: "Logic",
  category: "utility",
  description:
    "Boolean gate over scalar inputs. Any non-zero is treated as true. Output is 1 (true) or 0 (false). Ops: and, or, xor, not (1-input).",
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "a", type: "scalar", required: false, label: "A" },
    { name: "b", type: "scalar", required: false, label: "B" },
  ],
  resolveInputs(params): InputSocketDef[] {
    const op = ((params.op as string) ?? "and") as Op;
    const sockets: InputSocketDef[] = [
      { name: "a", type: "scalar", required: false, label: "A" },
    ];
    if (op !== "not") {
      sockets.push({ name: "b", type: "scalar", required: false, label: "B" });
    }
    return sockets;
  },
  params: [
    {
      name: "op",
      label: "Op",
      type: "enum",
      options: OPS as unknown as string[],
      default: "and",
    },
    {
      name: "a",
      label: "A",
      type: "scalar",
      min: 0,
      max: 1,
      step: 1,
      default: 0,
    },
    {
      name: "b",
      label: "B",
      type: "scalar",
      min: 0,
      max: 1,
      step: 1,
      default: 0,
      visibleIf: (p) => p.op !== "not",
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
    const op = ((params.op as string) ?? "and") as Op;

    let result: boolean;
    switch (op) {
      case "and":
        result = bool(a) && bool(b);
        break;
      case "or":
        result = bool(a) || bool(b);
        break;
      case "xor":
        result = bool(a) !== bool(b);
        break;
      case "not":
        result = !bool(a);
        break;
    }
    return { primary: { kind: "scalar", value: result ? 1 : 0 } };
  },
};
