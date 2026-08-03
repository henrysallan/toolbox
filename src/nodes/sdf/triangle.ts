import type {
  NodeDefinition,
  PositionNode,
  PositionValue,
  SdfValue,
} from "@/engine/types";
import { SDF_PAINT_PARAMS, paintSdf } from "@/engine/sdf-material";

// SDF primitive — a general triangle through three corners. For a
// regular triangle use SDF Polygon with sides=3.

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

export const sdfTriangleNode: NodeDefinition = {
  type: "sdf-triangle",
  name: "SDF Triangle",
  category: "utility",
  description:
    "SDF primitive — a triangle through three corners (A, B, C). For a regular triangle, prefer SDF Polygon with sides=3. Wire `position` to feed a transformed coordinate space.",
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "position", type: "position", required: false, label: "Position" },
    { name: "a", type: "vec2", required: false, label: "A" },
    { name: "b", type: "vec2", required: false, label: "B" },
    { name: "c", type: "vec2", required: false, label: "C" },
  ],
  params: [
    {
      name: "ax",
      label: "Ax",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "ay",
      label: "Ay",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.25,
    },
    {
      name: "bx",
      label: "Bx",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.25,
    },
    {
      name: "by",
      label: "By",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.75,
    },
    {
      name: "cx",
      label: "Cx",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.75,
    },
    {
      name: "cy",
      label: "Cy",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.75,
    },
    ...SDF_PAINT_PARAMS,
  ],
  primaryOutput: "sdf",
  auxOutputs: [],

  compute({ inputs, params }) {
    const a = inputs.a;
    const b = inputs.b;
    const c = inputs.c;
    const ax = a?.kind === "vec2" ? a.value[0] : ((params.ax as number) ?? 0.5);
    const ay =
      a?.kind === "vec2" ? a.value[1] : ((params.ay as number) ?? 0.25);
    const bx =
      b?.kind === "vec2" ? b.value[0] : ((params.bx as number) ?? 0.25);
    const by =
      b?.kind === "vec2" ? b.value[1] : ((params.by as number) ?? 0.75);
    const cx =
      c?.kind === "vec2" ? c.value[0] : ((params.cx as number) ?? 0.75);
    const cy =
      c?.kind === "vec2" ? c.value[1] : ((params.cy as number) ?? 0.75);
    const out: SdfValue = {
      kind: "sdf",
      root: paintSdf(
        {
          kind: "triangle",
          position: rootOfPosition(inputs.position),
          ax,
          ay,
          bx,
          by,
          cx,
          cy,
        },
        params
      ),
    };
    return { primary: out };
  },
};
