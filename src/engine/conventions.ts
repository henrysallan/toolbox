import type { InputSocketDef } from "./types";

export const MASK_INPUT_NAME = "mask";

export const MASK_INPUT: InputSocketDef = {
  name: MASK_INPUT_NAME,
  label: "mask",
  type: "mask",
  required: false,
};

// Appends the universal mask input if the node's declared inputs don't already
// include one. Used by both the evaluator and the UI layer so the socket list
// stays consistent.
export function withMaskInput(inputs: InputSocketDef[]): InputSocketDef[] {
  if (inputs.some((i) => i.name === MASK_INPUT_NAME)) return inputs;
  return [...inputs, MASK_INPUT];
}
