import type { ForceValue, NodeDefinition } from "@/engine/types";

export const pointForceNode: NodeDefinition = {
  type: "force-point",
  name: "Point Force",
  category: "effect",
  description:
    "Radial attractor or repeller around a point in canvas-UV space.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "position",
      label: "Position",
      type: "vec2",
      step: 0.001,
      default: [0.5, 0.5],
    },
    {
      name: "strength",
      label: "Strength",
      type: "scalar",
      min: 0,
      softMax: 5,
      max: 100,
      step: 0.01,
      default: 1,
    },
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 0.001,
      max: 1.5,
      step: 0.001,
      default: 0.3,
    },
    {
      name: "falloff",
      label: "Falloff",
      type: "scalar",
      min: 0,
      max: 8,
      step: 0.1,
      default: 2,
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["attract", "repel"],
      default: "attract",
    },
  ],
  primaryOutput: "force",
  auxOutputs: [],

  compute({ params }) {
    const pos = (params.position as [number, number]) ?? [0.5, 0.5];
    const strength = (params.strength as number) ?? 1;
    const radius = (params.radius as number) ?? 0.3;
    const falloff = (params.falloff as number) ?? 2;
    const mode = ((params.mode as string) ?? "attract") as "attract" | "repel";
    const sign = mode === "repel" ? 1 : -1;
    const out: ForceValue = {
      kind: "force",
      descriptor: {
        kind: "point",
        px: pos[0],
        py: pos[1],
        strength,
        falloff,
        sign,
        radius,
      },
    };
    return { primary: out };
  },
};
