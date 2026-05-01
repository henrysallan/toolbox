import type {
  NodeDefinition,
  PositionNode,
  PositionValue,
  SdfValue,
} from "@/engine/types";

// SDF primitive — a 2D disc of radius `r` centered at (x, y) in
// canvas-UV coords. Wire a `position` input to route the disc through
// a position-pipeline (Translate, Rotate, Repeat, Mirror, etc.) — one
// chain, evaluated once per pixel, can drive many shapes by branching
// after the chain. Default position is canvas UV.

function rootOfPosition(v: unknown): PositionNode {
  if (
    v &&
    typeof v === "object" &&
    (v as { kind?: string }).kind === "position"
  ) {
    return (v as PositionValue).root;
  }
  return { kind: "canvasUv" };
}

export const sdfCircleNode: NodeDefinition = {
  type: "sdf-circle",
  name: "SDF Circle",
  category: "utility",
  description:
    "SDF primitive — a circle of radius r at (x, y). Wire `position` to feed a transformed coordinate space (Translate / Repeat / Mirror / etc.) — unwired defaults to canvas UV.",
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "position", type: "position", required: false, label: "Position" },
    { name: "center", type: "vec2", required: false, label: "Center" },
    { name: "radius", type: "scalar", required: false, label: "Radius" },
  ],
  params: [
    {
      name: "x",
      label: "X",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "y",
      label: "Y",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 0.5,
      step: 0.001,
      default: 0.2,
    },
  ],
  primaryOutput: "sdf",
  auxOutputs: [],

  compute({ inputs, params }) {
    const center = inputs.center;
    const cx =
      center?.kind === "vec2" ? center.value[0] : ((params.x as number) ?? 0.5);
    const cy =
      center?.kind === "vec2" ? center.value[1] : ((params.y as number) ?? 0.5);
    const r =
      inputs.radius?.kind === "scalar"
        ? inputs.radius.value
        : ((params.radius as number) ?? 0.2);
    const out: SdfValue = {
      kind: "sdf",
      root: {
        kind: "circle",
        position: rootOfPosition(inputs.position),
        cx,
        cy,
        r,
      },
    };
    return { primary: out };
  },
};
