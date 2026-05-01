import type {
  NodeDefinition,
  PositionNode,
  PositionValue,
} from "@/engine/types";

// Position-pipeline operator — mirror the sample position about the
// X, Y, or both axes through the center. Compose with Polar inside
// for kaleidoscope effects.

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

const AXIS_OPTIONS = ["x", "y", "both"] as const;
type Axis = (typeof AXIS_OPTIONS)[number];

function axisToBitmask(a: Axis): 1 | 2 | 3 {
  if (a === "x") return 1;
  if (a === "y") return 2;
  return 3;
}

export const sdfMirrorNode: NodeDefinition = {
  type: "sdf-mirror",
  name: "SDF Mirror",
  category: "utility",
  description:
    "SDF position-pipeline op — reflect the sample position about X, Y, or both axes through the center.",
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
  ],
  params: [
    {
      name: "axis",
      label: "Axis",
      type: "enum",
      options: AXIS_OPTIONS as unknown as string[],
      default: "x",
    },
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
  ],
  primaryOutput: "position",
  auxOutputs: [],

  compute({ inputs, params }) {
    const c = inputs.center;
    const cx =
      c?.kind === "vec2" ? c.value[0] : ((params.center_x as number) ?? 0.5);
    const cy =
      c?.kind === "vec2" ? c.value[1] : ((params.center_y as number) ?? 0.5);
    const axis = ((params.axis as string) ?? "x") as Axis;
    const out: PositionValue = {
      kind: "position",
      root: {
        kind: "mirror",
        child: rootOfPosition(inputs.position),
        axis: axisToBitmask(axis),
        cx,
        cy,
      },
    };
    return { primary: out };
  },
};
