import type {
  NodeDefinition,
  PositionNode,
  PositionValue,
} from "@/engine/types";

// Position-pipeline operator — scale the per-pixel sample position
// around a pivot. Scaling the sample-position by S makes downstream
// shapes appear (1/S)× — the math is inverted because we transform
// the sample, not the shape; the node API exposes the *visible*
// scale, so the values feel natural.

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

export const sdfScaleNode: NodeDefinition = {
  type: "sdf-scale",
  name: "SDF Scale",
  category: "utility",
  description:
    "SDF position-pipeline op — scale the per-pixel sample position around a pivot. The exposed scale matches the visible effect on downstream shapes.",
  facts: {
    space: { "in:position": "canvas01", "param:cx": "canvas01", "param:cy": "canvas01" },
    gotchas: [
      "sx/sy is the visible scale of downstream shapes (2 makes them appear twice as big); internally the sample position is divided by scale, so the exposed value is already the intuitive direction.",
      "Pivot (cx/cy) is param-only on this node, unlike SDF Rotate which also accepts a wired pivot vec2.",
      "Emits a position value only; nothing visibly changes until a downstream shape or field consumes this position.",
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
    { name: "scale", type: "vec2", required: false, label: "Scale" },
  ],
  params: [
    {
      name: "sx",
      label: "Scale X",
      type: "scalar",
      min: 0.01,
      max: 10,
      softMax: 4,
      step: 0.001,
      default: 1,
    },
    {
      name: "sy",
      label: "Scale Y",
      type: "scalar",
      min: 0.01,
      max: 10,
      softMax: 4,
      step: 0.001,
      default: 1,
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
  linkedPairs: [{ a: "sx", b: "sy" }],

  compute({ inputs, params }) {
    const s = inputs.scale;
    const sx = s?.kind === "vec2" ? s.value[0] : ((params.sx as number) ?? 1);
    const sy = s?.kind === "vec2" ? s.value[1] : ((params.sy as number) ?? 1);
    const cx = (params.cx as number) ?? 0.5;
    const cy = (params.cy as number) ?? 0.5;
    const out: PositionValue = {
      kind: "position",
      root: {
        kind: "scale",
        child: rootOfPosition(inputs.position),
        sx,
        sy,
        cx,
        cy,
      },
    };
    return { primary: out };
  },
};
