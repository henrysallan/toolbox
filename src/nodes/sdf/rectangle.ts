import type {
  NodeDefinition,
  PositionNode,
  PositionValue,
  SdfValue,
} from "@/engine/types";
import { SDF_PAINT_PARAMS, paintSdf } from "@/engine/sdf-material";

// SDF primitive — an axis-aligned rectangle (optionally rounded)
// centered at (x, y) with full width × height in canvas-UV units.
// Wire `position` to feed a transformed coordinate space.

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

export const sdfRectangleNode: NodeDefinition = {
  type: "sdf-rectangle",
  name: "SDF Rectangle",
  category: "utility",
  description:
    "SDF primitive — a rectangle (with optional rounded corners) centered at (x, y) with the given width × height. Wire `position` to feed a transformed coordinate space.",
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "position", type: "position", required: false, label: "Position" },
    { name: "center", type: "vec2", required: false, label: "Center" },
    { name: "size", type: "vec2", required: false, label: "Size" },
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
      name: "width",
      label: "Width",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 1,
      step: 0.001,
      default: 0.4,
    },
    {
      name: "height",
      label: "Height",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 1,
      step: 0.001,
      default: 0.4,
    },
    {
      name: "corner_radius",
      label: "Corner Radius",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.2,
      step: 0.001,
      default: 0,
    },
    ...SDF_PAINT_PARAMS,
  ],
  primaryOutput: "sdf",
  auxOutputs: [],
  linkedPairs: [{ a: "width", b: "height" }],

  compute({ inputs, params }) {
    const center = inputs.center;
    const cx =
      center?.kind === "vec2" ? center.value[0] : ((params.x as number) ?? 0.5);
    const cy =
      center?.kind === "vec2" ? center.value[1] : ((params.y as number) ?? 0.5);
    const sizeIn = inputs.size;
    const w =
      sizeIn?.kind === "vec2"
        ? sizeIn.value[0]
        : ((params.width as number) ?? 0.4);
    const h =
      sizeIn?.kind === "vec2"
        ? sizeIn.value[1]
        : ((params.height as number) ?? 0.4);
    const sx = Math.max(0, w / 2);
    const sy = Math.max(0, h / 2);
    const cornerRadius = Math.max(
      0,
      Math.min(Math.min(sx, sy), (params.corner_radius as number) ?? 0)
    );
    const out: SdfValue = {
      kind: "sdf",
      root: paintSdf(
        {
          kind: "rect",
          position: rootOfPosition(inputs.position),
          cx,
          cy,
          sx,
          sy,
          cornerRadius,
        },
        params
      ),
    };
    return { primary: out };
  },
};
