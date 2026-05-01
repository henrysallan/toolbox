import type {
  NodeDefinition,
  PositionNode,
  PositionValue,
  ScalarFieldNode,
  ScalarFieldValue,
  SocketValue,
} from "@/engine/types";

// SDF position-pipeline op — spiral the sample position around the
// center by `strength` radians per unit distance.
//
// Strength is polymorphic: wire a scalar (uniform) for one twist
// per draw; wire a scalar_field for per-pixel twist amount.

function rootOfPosition(v: unknown): PositionNode {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "position") {
    return (v as PositionValue).root;
  }
  return { kind: "canvasUv" };
}

function resolveStrength(
  fieldIn: SocketValue | undefined,
  scalarIn: SocketValue | undefined,
  paramVal: number
): number | ScalarFieldNode {
  if (fieldIn && fieldIn.kind === "scalar_field") {
    return (fieldIn as ScalarFieldValue).root;
  }
  if (scalarIn && scalarIn.kind === "scalar") {
    return scalarIn.value;
  }
  return paramVal;
}

export const sdfTwistNode: NodeDefinition = {
  type: "sdf-twist",
  name: "SDF Twist",
  category: "utility",
  description:
    "SDF position-pipeline op — spiral the sample position around the center by Strength radians per unit distance. Strength accepts either a scalar (uniform per draw) or a scalar field (per-pixel; pair with SDF Repeat.cell_id → SDF Noise for per-tile variation). Large values violate the unit-gradient SDF property; a thin Rasterize contour line hides the resulting aliasing.",
  backend: "webgl2",
  stable: true,
  inputs: [
    {
      name: "position",
      type: "position",
      required: false,
      label: "Position",
    },
    { name: "center", type: "vec2", required: false, label: "Center" },
    { name: "strength", type: "scalar", required: false, label: "Strength" },
    {
      name: "strength_field",
      type: "scalar_field",
      required: false,
      label: "Strength Field",
    },
  ],
  params: [
    {
      name: "center_x",
      label: "Center X",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "center_y",
      label: "Center Y",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "strength",
      label: "Strength",
      type: "scalar",
      min: -50,
      max: 50,
      softMax: 10,
      step: 0.01,
      default: 3,
    },
  ],
  primaryOutput: "position",
  auxOutputs: [],

  compute({ inputs, params }) {
    const c = inputs.center;
    const cx =
      c?.kind === "vec2" ? c.value[0] : ((params.center_x as number) ?? 0.5);
    const cy =
      c?.kind === "vec2" ? c.value[1] : ((params.center_y as number) ?? 0.5);
    const strength = resolveStrength(
      inputs.strength_field,
      inputs.strength,
      (params.strength as number) ?? 3
    );
    const out: PositionValue = {
      kind: "position",
      root: {
        kind: "twist",
        child: rootOfPosition(inputs.position),
        cx,
        cy,
        strength,
      },
    };
    return { primary: out };
  },
};
