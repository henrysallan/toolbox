import type { NodeDefinition } from "@/engine/types";
import {
  copyPointsWith,
  EMPTY_POINTS,
  getRotation,
  getScaleX,
  getScaleY,
} from "@/engine/points";
import {
  defaultFloatCurve,
  sampleFloatCurve,
  sanitizeFloatCurve,
} from "@/engine/float-curve";

// Map Attribute — drive the built-in point data from a named channel
// (081326_point-attributes.md M4): the bridge from "data on the wire" to
// "pixels move". Pipeline per point:
//
//   1. Read the channel's component 0, normalize [In Lo..In Hi] → [0,1]
//      (clamped).
//   2. Sample the 0..1 float curve (identity by default — a linear ramp
//      leaves this step a no-op, so old graphs keep their linear remap).
//   3. Map the curve's y through [Out Lo..Out Hi] and apply it:
//        scale      — uniform multiply of the existing per-point scale
//        rotation   — radians ADDED to the existing rotation
//        position x/y — authored-space offset added to the position
//
// A missing channel passes through unchanged (the name field's red tint
// explains why).

const TARGET_OPTIONS = [
  "scale",
  "rotation",
  "position x",
  "position y",
] as const;
type Target = (typeof TARGET_OPTIONS)[number];

export const mapAttributeNode: NodeDefinition = {
  type: "map-attribute",
  name: "Map Attribute",
  category: "point",
  subcategory: "modifier",
  description:
    "Drives built-in point data from a named channel: normalize through In Lo/Hi, shape with a 0–1 curve, then map through Out Lo/Hi and apply as a scale multiplier, a rotation offset (radians), or a position offset. The curve defaults to a linear ramp, so a straight diagonal is the old In→Out remap. A missing channel passes through unchanged.",
  backend: "webgl2",
  inputs: [{ name: "points", type: "points", required: true }],
  params: [
    {
      name: "attr_name",
      label: "Name",
      type: "string",
      default: "weight",
      placeholder: "attribute name",
      suggestAttrsFrom: "points",
      suggestAttrsRequire: true,
    },
    {
      name: "map_target",
      label: "Target",
      type: "enum",
      options: TARGET_OPTIONS as unknown as string[],
      default: "scale",
    },
    {
      // 0..1 shaper after In-range normalize, before Out-range. Identity
      // (0,0)→(1,1) is a no-op so existing linear remaps stay linear.
      name: "curve",
      label: "Curve",
      type: "float_curve",
      default: defaultFloatCurve(0, 1),
    },
    {
      name: "in_lo",
      label: "In Lo",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "in_hi",
      label: "In Hi",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "out_lo",
      label: "Out Lo",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 2,
      step: 0.001,
      default: 0,
    },
    {
      name: "out_hi",
      label: "Out Hi",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 2,
      step: 0.001,
      default: 1,
    },
  ],
  primaryOutput: "points",
  auxOutputs: [],

  compute({ inputs, params }) {
    const src = inputs.points;
    if (!src || src.kind !== "points") return { primary: EMPTY_POINTS };
    const name = ((params.attr_name as string) ?? "").trim();
    const attr = name ? src.attributes?.[name] : undefined;
    if (!attr || src.count === 0) return { primary: src };

    const target = ((params.map_target as string) ?? "scale") as Target;
    const inLo = (params.in_lo as number) ?? 0;
    const inHi = (params.in_hi as number) ?? 1;
    const outLo = (params.out_lo as number) ?? 0;
    const outHi = (params.out_hi as number) ?? 1;
    const span = inHi - inLo;
    const curve = sanitizeFloatCurve(params.curve, 0, 1);

    const n = src.count;
    const k = attr.arity;
    const mapped = (i: number): number => {
      const t = Math.min(
        Math.max(span === 0 ? 0 : (attr.data[i * k] - inLo) / span, 0),
        1
      );
      const shaped = sampleFloatCurve(curve, t);
      return outLo + shaped * (outHi - outLo);
    };

    if (target === "scale") {
      const scales = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const m = mapped(i);
        scales[i * 2] = getScaleX(src, i) * m;
        scales[i * 2 + 1] = getScaleY(src, i) * m;
      }
      return { primary: copyPointsWith(src, { scales }) };
    }
    if (target === "rotation") {
      const rotations = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        rotations[i] = getRotation(src, i) + mapped(i);
      }
      return { primary: copyPointsWith(src, { rotations }) };
    }
    // position x / y — authored-space offset on one axis.
    const axis = target === "position x" ? 0 : 1;
    const positions = new Float32Array(src.positions.subarray(0, n * 2));
    for (let i = 0; i < n; i++) positions[i * 2 + axis] += mapped(i);
    return { primary: copyPointsWith(src, { positions }) };
  },
};
