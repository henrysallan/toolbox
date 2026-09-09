import type {
  NodeDefinition,
  PositionNode,
  PositionValue,
} from "@/engine/types";

// Position-pipeline operator — fold the sample position into N
// rotational sectors around `center`. Downstream shapes are
// replicated radially. Compose with Mirror downstream for true
// kaleidoscope symmetry.

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

export const sdfPolarNode: NodeDefinition = {
  type: "sdf-polar",
  name: "SDF Polar",
  category: "utility",
  description:
    "SDF position-pipeline op — fold the sample position into N rotational sectors around the center. Compose with Mirror for kaleidoscope symmetry.",
  facts: {
    space: { "in:center": "canvas01", "param:center_x": "canvas01", "param:center_y": "canvas01" },
    gotchas: [
      "Folds the sample position into `segments` sectors of 2*pi/segments around center, so downstream shapes are replicated radially rather than duplicated as separate graph copies.",
      "rotation is in radians, not degrees, and spins where the sector boundaries fall (effectively rotating the whole kaleidoscope pattern).",
      "Output type is `position`, meant to feed a shape's Position socket or chain into another position op (e.g. Mirror) — wiring it directly as an SDF or mask does nothing.",
    ],
  },
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
      name: "segments",
      label: "Segments",
      type: "scalar",
      min: 1,
      max: 64,
      softMax: 16,
      step: 1,
      default: 6,
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
    {
      name: "rotation",
      label: "Rotation (rad)",
      type: "scalar",
      min: -Math.PI,
      max: Math.PI,
      step: 0.001,
      default: 0,
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
    const segments = Math.max(1, (params.segments as number) ?? 6);
    const rotation = (params.rotation as number) ?? 0;
    const out: PositionValue = {
      kind: "position",
      root: {
        kind: "polar",
        child: rootOfPosition(inputs.position),
        cx,
        cy,
        segments,
        rotation,
      },
    };
    return { primary: out };
  },
};
