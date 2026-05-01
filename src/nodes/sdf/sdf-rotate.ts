import type {
  NodeDefinition,
  PositionNode,
  PositionValue,
  ScalarFieldNode,
  ScalarFieldValue,
  SocketValue,
} from "@/engine/types";

// SDF position-pipeline op — rotate the per-pixel sample position
// around a pivot. Compose downstream of SDF Repeat for tile-local
// rotation.
//
// Angle is polymorphic: wire a scalar (CPU value, uniform) for one
// rotation per draw; wire a scalar_field (Noise + position) for
// per-pixel rotation. The latter is the path to per-tile rotation
// — pair `SDF Repeat.cell_id` → `SDF Noise.position` → here.

function rootOfPosition(v: unknown): PositionNode {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "position") {
    return (v as PositionValue).root;
  }
  return { kind: "canvasUv" };
}

function resolveRotation(
  fieldIn: SocketValue | undefined,
  scalarIn: SocketValue | undefined,
  paramRad: number
): number | ScalarFieldNode {
  if (fieldIn && fieldIn.kind === "scalar_field") {
    return (fieldIn as ScalarFieldValue).root;
  }
  if (scalarIn && scalarIn.kind === "scalar") {
    return scalarIn.value;
  }
  return paramRad;
}

export const sdfRotateNode: NodeDefinition = {
  type: "sdf-rotate",
  name: "SDF Rotate",
  category: "utility",
  description:
    "SDF position-pipeline op — rotate the per-pixel sample position around a pivot. Wire a scalar field into Angle for per-pixel rotation (per-tile when paired with SDF Repeat.cell_id → SDF Noise).",
  backend: "webgl2",
  stable: true,
  inputs: [
    {
      name: "position",
      type: "position",
      required: false,
      label: "Position",
    },
    { name: "angle", type: "scalar", required: false, label: "Angle (rad)" },
    {
      name: "angle_field",
      type: "scalar_field",
      required: false,
      label: "Angle Field",
    },
    { name: "pivot", type: "vec2", required: false, label: "Pivot" },
  ],
  params: [
    {
      name: "rotation",
      label: "Angle (°)",
      type: "scalar",
      min: -360,
      max: 360,
      step: 0.5,
      default: 0,
    },
    {
      name: "cx",
      label: "Pivot X",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "cy",
      label: "Pivot Y",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
  ],
  primaryOutput: "position",
  auxOutputs: [],

  compute({ inputs, params }) {
    const paramRad = (((params.rotation as number) ?? 0) * Math.PI) / 180;
    const rotation = resolveRotation(inputs.angle_field, inputs.angle, paramRad);
    const piv = inputs.pivot;
    const cx = piv?.kind === "vec2" ? piv.value[0] : ((params.cx as number) ?? 0.5);
    const cy = piv?.kind === "vec2" ? piv.value[1] : ((params.cy as number) ?? 0.5);
    const out: PositionValue = {
      kind: "position",
      root: {
        kind: "rotate",
        child: rootOfPosition(inputs.position),
        rotation,
        cx,
        cy,
      },
    };
    return { primary: out };
  },
};
