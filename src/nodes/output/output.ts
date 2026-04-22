import type { NodeDefinition } from "@/engine/types";

export const outputNode: NodeDefinition = {
  type: "output",
  name: "Output",
  category: "output",
  description:
    "Terminal node. Its input image is rendered to the visible canvas by the engine.",
  backend: "webgl2",
  terminal: true,
  inputs: [{ name: "image", type: "image", required: true }],
  params: [],
  primaryOutput: null,
  auxOutputs: [],
  compute() {
    // Engine blits our input image to the canvas after evaluation.
    return {};
  },
};
