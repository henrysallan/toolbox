import type { NodeDefinition, PointsValue } from "@/engine/types";

// Single-point generator. Outputs a `points` value with exactly one entry.
// Useful as the identity element for Copy-to-Points ("place one instance
// at (x, y)") and as a seed for operations that transform points.
//
// Rotation is stored in radians to match how Copy-to-Points applies it;
// the UI exposes degrees and we convert. Scale defaults to 1,1.

export const pointNode: NodeDefinition = {
  type: "point",
  name: "Point",
  category: "source",
  description:
    "Emit a single point at (x, y). Combine with Copy to Points to place one instance of an image or spline at a specific location.",
  backend: "webgl2",
  // When `position` is connected, its vec2 value overrides the x/y
  // params so you can drive Point's location from any vec2 source
  // (Sample Along Path, Cursor.velocity_vec, Combine Vec2, etc.)
  // without splitting to scalars first.
  inputs: [{ name: "position", type: "vec2", required: false }],
  params: [
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
    const out: PointsValue = {
      kind: "points",
      points: [
        {
          pos: [x, y],
          rotation: (rotDeg * Math.PI) / 180,
          scale: [scale, scale],
        },
      ],
    };
    return { primary: out };
  },
};
