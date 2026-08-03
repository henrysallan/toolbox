import type {
  NodeDefinition,
  PositionNode,
  PositionValue,
  SdfValue,
} from "@/engine/types";
import { SDF_PAINT_PARAMS, paintSdf } from "@/engine/sdf-material";

// SDF primitive — a capsule between two points (a, b) with thickness r.
// Same formula covers Quílez's "line segment" and "capsule" — the only
// difference is naming.

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

export const sdfLineSegmentNode: NodeDefinition = {
  type: "sdf-line-segment",
  name: "SDF Line Segment",
  category: "utility",
  description:
    "SDF primitive — a thick line (capsule) between (Ax, Ay) and (Bx, By) with the given thickness. Endpoints are rounded. Wire `position` to feed a transformed coordinate space.",
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "position", type: "position", required: false, label: "Position" },
    { name: "a", type: "vec2", required: false, label: "A" },
    { name: "b", type: "vec2", required: false, label: "B" },
    { name: "thickness", type: "scalar", required: false, label: "Thickness" },
  ],
  params: [
    {
      name: "ax",
      label: "Ax",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.25,
    },
    {
      name: "ay",
      label: "Ay",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "bx",
      label: "Bx",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.75,
    },
    {
      name: "by",
      label: "By",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "thickness",
      label: "Thickness",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.2,
      step: 0.001,
      default: 0.04,
    },
    ...SDF_PAINT_PARAMS,
  ],
  primaryOutput: "sdf",
  auxOutputs: [],

  compute({ inputs, params }) {
    const a = inputs.a;
    const b = inputs.b;
    const ax =
      a?.kind === "vec2" ? a.value[0] : ((params.ax as number) ?? 0.25);
    const ay = a?.kind === "vec2" ? a.value[1] : ((params.ay as number) ?? 0.5);
    const bx =
      b?.kind === "vec2" ? b.value[0] : ((params.bx as number) ?? 0.75);
    const by = b?.kind === "vec2" ? b.value[1] : ((params.by as number) ?? 0.5);
    const r =
      inputs.thickness?.kind === "scalar"
        ? inputs.thickness.value
        : ((params.thickness as number) ?? 0.04);
    const out: SdfValue = {
      kind: "sdf",
      root: paintSdf(
        {
          kind: "lineSegment",
          position: rootOfPosition(inputs.position),
          ax,
          ay,
          bx,
          by,
          r: Math.max(0, r),
        },
        params
      ),
    };
    return { primary: out };
  },
};
