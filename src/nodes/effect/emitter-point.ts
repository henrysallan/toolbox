import type { EmitterValue, NodeDefinition } from "@/engine/types";

// Point emitter — spawns particles around a single (px, py) location each
// frame. Position/velocity live in normalized [0,1]² Y-DOWN canvas-UV space
// to match every other engine value; the Particle Simulator reads this
// descriptor as uniforms on its spawn pass.

export const pointEmitterNode: NodeDefinition = {
  type: "emitter-point",
  name: "Point Emitter",
  category: "effect",
  description:
    "Emit particles from a single point with positional and velocity jitter.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "position",
      label: "Position",
      type: "vec2",
      default: [0.5, 0.5],
    },
    {
      name: "spread",
      label: "Spread",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.02,
    },
    {
      name: "rate",
      label: "Rate",
      type: "scalar",
      min: 0,
      max: 100000,
      step: 1,
      default: 200,
    },
    {
      name: "velocity",
      label: "Velocity",
      type: "vec2",
      default: [0, -0.5],
    },
    {
      name: "vJitter",
      label: "Velocity Jitter",
      type: "scalar",
      min: 0,
      max: 5,
      step: 0.01,
      default: 0.2,
    },
    {
      name: "lifetime",
      label: "Lifetime",
      type: "scalar",
      min: 0.05,
      max: 60,
      step: 0.05,
      default: 2,
    },
  ],
  primaryOutput: "emitter",
  auxOutputs: [],

  compute({ params }) {
    const pos = (params.position as [number, number] | undefined) ?? [0.5, 0.5];
    const vel = (params.velocity as [number, number] | undefined) ?? [0, -0.5];
    const out: EmitterValue = {
      kind: "emitter",
      descriptor: {
        kind: "point",
        px: pos[0],
        py: pos[1],
        spread: Math.max(0, (params.spread as number) ?? 0.02),
        rate: Math.max(0, (params.rate as number) ?? 200),
        vx: vel[0],
        vy: vel[1],
        vJitter: Math.max(0, (params.vJitter as number) ?? 0.2),
        lifetime: Math.max(0.05, (params.lifetime as number) ?? 2),
      },
    };
    return { primary: out };
  },
};
