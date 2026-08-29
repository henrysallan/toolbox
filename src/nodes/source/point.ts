import type { NodeDefinition, PointsValue } from "@/engine/types";
import { pointsFromArray } from "@/engine/points";
import { applyTransformInputToPoints } from "@/engine/transform-value";

// Point generator. Outputs a `points` value with `count` entries, all at
// (x, y) — coincident on purpose. Each copy still gets its own index (its
// slot in the positions array), so downstream per-point nodes (Point
// Expression, Modulate Points, Filter Points) can fan the stack apart.
// Count 1 (the default) is the classic single-point identity element for
// Copy-to-Points ("place one instance at (x, y)").
//
// Rotation is stored in radians to match how Copy-to-Points applies it;
// the UI exposes degrees and we convert. Scale defaults to 1,1.

export const pointNode: NodeDefinition = {
  type: "point",
  name: "Point",
  category: "point",
  subcategory: "generator",
  description:
    "Emit Count points at (x, y). They start stacked at the same location but each has its own index, so per-point nodes (Point Expression, Modulate Points) can spread them apart. With Count 1, combine with Copy to Points to place one instance of an image or spline at a specific location. Wire a Gizmo into Transform to share placement (TRS applies on top of x/y).",
  backend: "webgl2",
  // When `position` is connected, its vec2 value overrides the x/y
  // params so you can drive Point's location from any vec2 source
  // (Sample Along Path, Cursor.velocity_vec, Combine Vec2, etc.)
  // without splitting to scalars first.
  inputs: [
    { name: "position", type: "vec2", required: false },
    { name: "transform", type: "transform", required: false, label: "Transform" },
  ],
  params: [
    {
      name: "count",
      label: "Count",
      type: "scalar",
      min: 1,
      max: 4096,
      softMax: 64,
      step: 1,
      default: 1,
    },
    {
      name: "x",
      label: "X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "y",
      label: "Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "rotation_deg",
      label: "Rotation (deg)",
      type: "scalar",
      min: -360,
      max: 360,
      step: 0.5,
      default: 0,
    },
    {
      name: "scale",
      label: "Scale",
      type: "scalar",
      min: 0,
      max: 5,
      softMax: 2,
      step: 0.01,
      default: 1,
    },
  ],
  primaryOutput: "points",
  auxOutputs: [],

  compute({ inputs, params }) {
    // `position` input wins when connected; otherwise fall back to
    // the scalar x/y params. Lets the node stay usable stand-alone
    // AND lets external vec2 drivers control it wholesale.
    const posIn = inputs.position;
    let x = (params.x as number) ?? 0.5;
    let y = (params.y as number) ?? 0.5;
    if (posIn?.kind === "vec2") {
      x = posIn.value[0];
      y = posIn.value[1];
    }
    const rotDeg = (params.rotation_deg as number) ?? 0;
    const scale = (params.scale as number) ?? 1;
    const count = Math.max(1, Math.round((params.count as number) ?? 1));
    const out: PointsValue = pointsFromArray(
      Array.from({ length: count }, () => ({
        pos: [x, y] as [number, number],
        rotation: (rotDeg * Math.PI) / 180,
        scale: [scale, scale] as [number, number],
      }))
    );
    return { primary: applyTransformInputToPoints(out, inputs.transform) };
  },
};
