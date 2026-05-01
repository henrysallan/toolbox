import type { ColliderValue, NodeDefinition } from "@/engine/types";

export const circleColliderNode: NodeDefinition = {
  type: "collider-circle",
  name: "Circle Collider",
  category: "effect",
  description:
    "Circular collider for the Particle Simulator. Outside-mode treats the disc as solid; inside-mode bounces particles off the inside (fish-tank).",
  backend: "webgl2",
  inputs: [],
  params: [
    { name: "position", label: "Center", type: "vec2", default: [0.5, 0.5] },
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 0.001,
      max: 1.5,
      step: 0.001,
      default: 0.2,
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["outside", "inside"],
      default: "outside",
    },
    {
      name: "restitution",
      label: "Bounce",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.7,
    },
  ],
  primaryOutput: "collider",
  auxOutputs: [],

  compute({ params }) {
    const pos = (params.position as number[]) ?? [0.5, 0.5];
    const radius = Math.max(0.001, (params.radius as number) ?? 0.2);
    const inside = ((params.mode as string) ?? "outside") === "inside";
    const restitution = Math.max(
      0,
      Math.min(1, (params.restitution as number) ?? 0.7)
    );
    const value: ColliderValue = {
      kind: "collider",
      descriptor: {
        kind: "circle",
        cx: pos[0],
        cy: pos[1],
        radius,
        inside,
        restitution,
      },
    };
    return { primary: value };
  },
};
