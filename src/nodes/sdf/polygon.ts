import type {
  NodeDefinition,
  PositionNode,
  PositionValue,
  SdfValue,
} from "@/engine/types";

// SDF primitive — a regular N-gon centered at (x, y) with circumradius
// r. `sides` ≥ 3; non-integer values produce smooth in-between shapes.

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

export const sdfPolygonNode: NodeDefinition = {
  type: "sdf-polygon",
  name: "SDF Polygon",
  category: "utility",
  description:
    "SDF primitive — a regular N-gon. Sides 3 = triangle, 4 = square, 5 = pentagon, 6 = hexagon… Non-integer sides interpolate smoothly between counts. Wire `position` to feed a transformed coordinate space.",
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
      default: 0.25,
    },
    {
      name: "sides",
      label: "Sides",
      type: "scalar",
      min: 3,
      max: 24,
      step: 1,
      default: 6,
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
        : ((params.radius as number) ?? 0.25);
    const sides = Math.max(3, (params.sides as number) ?? 6);
    const out: SdfValue = {
      kind: "sdf",
      root: {
        kind: "polygon",
        position: rootOfPosition(inputs.position),
        cx,
        cy,
        r,
        sides,
      },
    };
    return { primary: out };
  },
};
