import type { ColliderValue, NodeDefinition } from "@/engine/types";

// Half-plane collider. The user picks a "point on the wall" and an
// angle; we derive the unit normal + offset for the simulator.

function angleToNormal(deg: number): { nx: number; ny: number } {
  // 0° = wall pointing right (normal points up). 90° = wall pointing up
  // (normal points right). Matches an intuitive "ground" at angle 0.
  const r = (deg * Math.PI) / 180;
  return { nx: -Math.sin(r), ny: -Math.cos(r) };
}

export const lineColliderNode: NodeDefinition = {
  type: "collider-line",
  name: "Line Collider",
  category: "effect",
  description:
    "Half-plane collider — an infinite line. Particles bounce off the side opposite the normal. Use 'angle 0, point (0.5, 0.9)' for a ground.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "point",
      label: "Point on wall",
      type: "vec2",
      default: [0.5, 0.9],
    },
    {
      name: "angle",
      label: "Angle (deg)",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 0,
    },
    {
      name: "restitution",
      label: "Bounce",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.6,
    },
  ],
  primaryOutput: "collider",
  auxOutputs: [],

  compute({ params }) {
    const point = (params.point as number[]) ?? [0.5, 0.9];
    const angle = (params.angle as number) ?? 0;
    const { nx, ny } = angleToNormal(angle);
    // Half-plane: blocks points where (n · p) < d.
    const d = nx * point[0] + ny * point[1];
    const restitution = Math.max(
      0,
      Math.min(1, (params.restitution as number) ?? 0.6)
    );
    const value: ColliderValue = {
      kind: "collider",
      descriptor: { kind: "line", nx, ny, d, restitution },
    };
    return { primary: value };
  },
};
