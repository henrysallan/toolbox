import type {
  NodeDefinition,
  PositionNode,
  PositionValue,
  SdfValue,
} from "@/engine/types";
import { SDF_PAINT_PARAMS, paintSdf } from "@/engine/sdf-material";

// SDF primitive — an N-pointed star centered at (x, y) with outer
// radius r.

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

export const sdfStarNode: NodeDefinition = {
  type: "sdf-star",
  name: "SDF Star",
  category: "utility",
  description:
    "SDF primitive — an N-pointed star. Sharpness 2 = sharpest spike, equal-to-points = regular polygon. 3 ≤ Points ≤ 24. Wire `position` to feed a transformed coordinate space.",
  facts: {
    space: {
      "in:position": "canvas01",
      "in:center": "canvas01",
      "in:radius": "canvas01",
      "param:x": "canvas01",
      "param:y": "canvas01",
      "param:radius": "canvas01",
    },
    gotchas: [
      "Builds an SDF tree only; nothing is drawn until a terminal (Rasterize / Shade / To Mask / To Distance Image) evaluates it per pixel.",
      "Unwired position = canvas UV; wire a Translate/Repeat/Mirror position chain to change the space the star is evaluated in.",
      "radius is width-relative only while the consuming terminal's aspect_correct is on; off, it becomes a per-axis UV fraction and the star squashes on non-square canvases.",
      "sharpness is clamped to [2, points] at compute time, so raising it past points has no further effect beyond a regular polygon.",
    ],
  },
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
      name: "points",
      label: "Points",
      type: "scalar",
      min: 3,
      max: 24,
      step: 1,
      default: 5,
    },
    {
      name: "sharpness",
      label: "Sharpness",
      type: "scalar",
      min: 2,
      max: 24,
      softMax: 6,
      step: 0.01,
      default: 2.5,
    },
    ...SDF_PAINT_PARAMS,
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
    const sides = Math.max(3, (params.points as number) ?? 5);
    // Clamp sharpness into [2, sides] so the formula stays well-defined.
    const sharpness = Math.max(
      2,
      Math.min(sides, (params.sharpness as number) ?? 2.5)
    );
    const out: SdfValue = {
      kind: "sdf",
      root: paintSdf(
        {
          kind: "star",
          position: rootOfPosition(inputs.position),
          cx,
          cy,
          r,
          sides,
          sharpness,
        },
        params
      ),
    };
    return { primary: out };
  },
};
