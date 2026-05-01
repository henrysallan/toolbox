import type {
  NodeDefinition,
  PositionNode,
  PositionValue,
} from "@/engine/types";

// Position-pipeline operator — translate the per-pixel sample
// position by (offsetX, offsetY). Wired into a shape's `position`
// input (directly or through other position ops), this moves the
// shape by (+offset).

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

export const sdfTranslateNode: NodeDefinition = {
  type: "sdf-translate",
  name: "SDF Translate",
  category: "utility",
  description:
    "SDF position-pipeline op — translate the per-pixel sample position. Feeds into a shape's `position` input. Default upstream position is canvas UV.",
  backend: "webgl2",
  stable: true,
  inputs: [
    {
      name: "position",
      type: "position",
      required: false,
      label: "Position",
    },
    { name: "offset", type: "vec2", required: false, label: "Offset" },
  ],
  params: [
    {
      name: "tx",
      label: "Offset X",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.001,
      default: 0,
    },
    {
      name: "ty",
      label: "Offset Y",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.001,
      default: 0,
    },
  ],
  primaryOutput: "position",
  auxOutputs: [],

  compute({ inputs, params }) {
    const off = inputs.offset;
    const tx = off?.kind === "vec2" ? off.value[0] : ((params.tx as number) ?? 0);
    const ty = off?.kind === "vec2" ? off.value[1] : ((params.ty as number) ?? 0);
    const out: PositionValue = {
      kind: "position",
      root: { kind: "translate", child: rootOfPosition(inputs.position), tx, ty },
    };
    return { primary: out };
  },
};
