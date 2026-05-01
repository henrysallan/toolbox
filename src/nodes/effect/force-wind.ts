import type { ForceValue, NodeDefinition } from "@/engine/types";

export const windForceNode: NodeDefinition = {
  type: "force-wind",
  name: "Wind",
  category: "effect",
  description:
    "Constant directional push. The simulator normalizes the direction vector.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "direction",
      label: "Direction",
      type: "vec2",
      step: 0.01,
      default: [1, 0],
    },
    {
      name: "strength",
      label: "Strength",
      type: "scalar",
      min: 0,
      softMax: 2,
      max: 20,
      step: 0.01,
      default: 0.2,
    },
  ],
  primaryOutput: "force",
  auxOutputs: [],

  compute({ params }) {
    const dir = (params.direction as [number, number]) ?? [1, 0];
    const strength = (params.strength as number) ?? 0.2;
    let dx = dir[0];
    let dy = dir[1];
    if (dx === 0 && dy === 0) {
      dx = 1;
      dy = 0;
    }
    const out: ForceValue = {
      kind: "force",
      descriptor: { kind: "wind", dx, dy, strength },
    };
    return { primary: out };
  },
};
