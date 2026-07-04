import type { NodeDefinition } from "@/engine/types";

// Bare string literal source. Emits a single text value on a `string`
// socket — wire it into an exposed string param (Text's `text`, Output's
// filename, the Expression / ASCII / Image-Generate text fields, etc.) to
// drive that text from one place, or promote it to a group interface so a
// layer takes its copy as an input. Stable — value comes from params.

export const stringLiteralNode: NodeDefinition = {
  type: "string-literal",
  name: "String",
  category: "utility",
  description:
    "Emits a single text value. Wire it into an exposed string param (e.g. a Text node's text) to drive that text, or share one string across several nodes.",
  backend: "webgl2",
  stable: true,
  noMaskInput: true,
  inputs: [],
  params: [
    {
      name: "value",
      label: "Text",
      type: "string",
      multiline: true,
      default: "",
      placeholder: "type here…",
    },
  ],
  primaryOutput: "string",
  auxOutputs: [],

  compute({ params }) {
    const value = (params.value as string) ?? "";
    return { primary: { kind: "string", value } };
  },
};
