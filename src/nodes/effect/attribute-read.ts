import type {
  NodeDefinition,
  ScalarValue,
  SocketType,
  Vec2Value,
} from "@/engine/types";
import {
  pointAttrExists,
  readPointAttr,
  readPointAttrVec2,
} from "@/engine/points";

// Attribute Read — sample one point's column as a concrete scalar or
// vec2 (the pull-a-value-off-the-wire counterpart to Set Named Attribute).
// Blender's Named Attribute is a per-element field; ours carry concrete
// values, so this node samples at an index instead of emitting a field.
// Per-point reads stay on Point Expression's attr("name").
//
// Name accepts a named channel, a dotted component (`color.y`), or a
// built-in column (index, x, y, position, scale, rotation, group, …).
// Missing channels and empty points read as 0. Index clamps to the
// live point count.

const SHAPES = ["scalar", "vec2"] as const;
type Shape = (typeof SHAPES)[number];

function zeroOf(shape: Shape): ScalarValue | Vec2Value {
  return shape === "vec2"
    ? { kind: "vec2", value: [0, 0] }
    : { kind: "scalar", value: 0 };
}

export const attributeReadNode: NodeDefinition = {
  type: "attribute-read",
  name: "Attribute Read",
  category: "point",
  subcategory: "modifier",
  searchAliases: [
    "get attribute",
    "named attribute",
    "sample index",
    "read attribute",
  ],
  description:
    "Reads one point's column — a named channel, a dotted component (color.y), or a built-in like index, x, y, position, scale, rotation, or group — and outputs it as a scalar or vec2. Index picks the point (clamped); a missing channel reads as 0. For per-point reads that stay on the points wire, use Point Expression's attr(\"name\") or Map Attribute.",
  facts: {
    space: { out: "unitless" },
    gotchas: [
      "out inherits whichever attribute is named: position/x/y/scale read as canvas01, index/group/rotation/other channels are unitless — there is no unit conversion.",
      "Reading a multi-component named channel without a dot returns only component 0 (e.g. color yields red); use a dotted name like color.y for another channel.",
      "vec2 shape on scalar built-ins (index, rotation, group, z, nx/ny/nz) returns [value, 0]; only position/scale and multi-component channels fill both components.",
    ],
  },
  backend: "webgl2",
  noMaskInput: true,
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
      suggestAttrsIncludeBuiltins: true,
    },
    {
      name: "shape",
      label: "Type",
      type: "enum",
      options: SHAPES as unknown as string[],
      control: "segmented",
      default: "scalar",
    },
    {
      name: "index",
      label: "Index",
      type: "scalar",
      min: 0,
      max: 10000,
      softMax: 99,
      step: 1,
      default: 0,
    },
  ],
  primaryOutput: "scalar",
  resolvePrimaryOutput(params): SocketType {
    return (params.shape as string) === "vec2" ? "vec2" : "scalar";
  },
  auxOutputs: [],

  compute({ inputs, params }) {
    const shape = ((params.shape as string) ?? "scalar") as Shape;
    const src = inputs.points;
    if (!src || src.kind !== "points" || src.count === 0) {
      return { primary: zeroOf(shape) };
    }
    const name = ((params.attr_name as string) ?? "").trim();
    if (!name || !pointAttrExists(src, name)) {
      return { primary: zeroOf(shape) };
    }
    const raw = Math.floor((params.index as number) ?? 0);
    const i = Number.isFinite(raw)
      ? Math.max(0, Math.min(src.count - 1, raw))
      : 0;
    if (shape === "vec2") {
      const v = readPointAttrVec2(src, name, i) ?? [0, 0];
      return { primary: { kind: "vec2", value: v } satisfies Vec2Value };
    }
    return {
      primary: {
        kind: "scalar",
        value: readPointAttr(src, name, i) ?? 0,
      } satisfies ScalarValue,
    };
  },
};
