import type {
  NodeDefinition,
  PositionNode,
  PositionValue,
  ScalarFieldNode,
  ScalarFieldValue,
  SdfValue,
} from "@/engine/types";

// SDF primitive — a regular N-gon centered at (x, y) with circumradius
// r. `sides` ≥ 3; non-integer values produce smooth in-between shapes.
//
// Sides is polymorphic: wire a scalar (uniform per draw) or a
// scalar_field (per-pixel/per-tile). The latter is the headline
// per-tile-variation pattern: pair `SDF Repeat.cell_id` →
// `Noise.field_position`, set Noise's Field Lo / Hi to a side range
// (e.g. 3 / 8), and wire Noise.field → Polygon.sides_field. Toggle
// Quantize Sides on so each tile gets a clean integer side count
// rather than a smooth interpolation between counts.

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

function resolveSides(
  fieldIn: unknown,
  scalarParam: number
): number | ScalarFieldNode {
  if (
    fieldIn &&
    typeof fieldIn === "object" &&
    (fieldIn as { kind?: string }).kind === "scalar_field"
  ) {
    return (fieldIn as ScalarFieldValue).root;
  }
  return Math.max(3, scalarParam);
}

export const sdfPolygonNode: NodeDefinition = {
  type: "sdf-polygon",
  name: "SDF Polygon",
  category: "utility",
  description:
    "SDF primitive — a regular N-gon. Sides 3 = triangle, 4 = square, 5 = pentagon, 6 = hexagon… Wire a scalar field into Sides Field for per-pixel / per-tile variation in side count (set Quantize Sides on for clean integer counts; pair with SDF Repeat.cell_id → Noise for per-tile randomness).",
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "position", type: "position", required: false, label: "Position" },
    { name: "center", type: "vec2", required: false, label: "Center" },
    { name: "radius", type: "scalar", required: false, label: "Radius" },
    {
      name: "sides_field",
      type: "scalar_field",
      required: false,
      label: "Sides Field",
    },
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
    {
      name: "quantize_sides",
      label: "Quantize Sides",
      type: "boolean",
      default: true,
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
    const sides = resolveSides(
      inputs.sides_field,
      (params.sides as number) ?? 6
    );
    const out: SdfValue = {
      kind: "sdf",
      root: {
        kind: "polygon",
        position: rootOfPosition(inputs.position),
        cx,
        cy,
        r,
        sides,
        quantizeSides: (params.quantize_sides as boolean) ?? true,
      },
    };
    return { primary: out };
  },
};
