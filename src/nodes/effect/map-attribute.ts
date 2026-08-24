import type { NodeDefinition } from "@/engine/types";
import {
  copyPointsWith,
  EMPTY_POINTS,
  getRotation,
  getScaleX,
  getScaleY,
} from "@/engine/points";

// Map Attribute — drive the built-in point data from a named channel
// (081326_point-attributes.md M4): the bridge from "data on the wire" to
// "pixels move". Reads the channel's component 0, remaps [In Lo..In Hi] →
// [Out Lo..Out Hi] (clamped), and applies it to the chosen target:
//
//   scale      — uniform multiply of the existing per-point scale
//   rotation   — radians ADDED to the existing rotation
//   position x/y — authored-space offset added to the position
//
// The remap is the whole interface — a weight in [0,1] becomes "sizes
// between 0.2 and 1.8" by typing two numbers, no math node needed. A
// missing channel passes through unchanged (the name field's red tint
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
    "Drives built-in point data from a named channel: remap the channel's value through In/Out ranges and apply it as a scale multiplier, a rotation offset (radians), or a position offset. The bridge from authored attributes to visible motion. A missing channel passes through unchanged.",
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

    const n = src.count;
    const k = attr.arity;
    const mapped = (i: number): number => {
      const t = Math.min(
        Math.max(span === 0 ? 0 : (attr.data[i * k] - inLo) / span, 0),
        1
      );
      return outLo + t * (outHi - outLo);
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
