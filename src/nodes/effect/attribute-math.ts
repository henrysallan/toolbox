import type {
  InputSocketDef,
  NodeDefinition,
  PointAttribute,
  SocketType,
  SplineValue,
} from "@/engine/types";
import { copyPointsWith, EMPTY_POINTS } from "@/engine/points";
import {
  readSplineAnchorChannel,
  writeSplineAnchorChannel,
} from "@/engine/spline-attrs";

// Attribute Math — componentwise math on a named channel (points or
// spline anchors; 081326_point-attributes.md M3). The node-based
// convenience for the common one-liners; Point Expression's setattr
// stays the escape hatch for arbitrary formulas. The operand is a
// constant or a SECOND channel (arity-1 operands broadcast across
// components; mismatched arities read as 0). Remap fits
// [In Lo..In Hi] → [Out Lo..Out Hi], clamped.
//
// A missing source channel passes the input through unchanged — math on
// nothing is a wiring mistake, not a request to invent zeros.
// Spline-anchor reads fall back to the subpath's attrs when the anchor
// itself has no value for that name.

const OP_OPTIONS = [
  "add",
  "subtract",
  "multiply",
  "divide",
  "min",
  "max",
  "power",
  "remap",
] as const;
type Op = (typeof OP_OPTIONS)[number];

const OPERAND_OPTIONS = ["constant", "attribute"] as const;

const TARGET_OPTIONS = ["points", "spline anchors"] as const;
type Target = (typeof TARGET_OPTIONS)[number];

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

function innerTypeFor(target: Target): SocketType {
  return target === "points" ? "points" : "spline";
}

function applyOp(
  x: number,
  o: number,
  op: Op
): number {
  switch (op) {
    case "add":
      return x + o;
    case "subtract":
      return x - o;
    case "multiply":
      return x * o;
    case "divide":
      return o === 0 ? 0 : x / o;
    case "min":
      return Math.min(x, o);
    case "max":
      return Math.max(x, o);
    case "power":
      return Math.pow(x, o);
    default:
      return x;
  }
}

function runMath(
  aData: Float32Array,
  n: number,
  k: 1 | 2 | 3 | 4,
  op: Op,
  useAttr: boolean,
  bData: Float32Array | undefined,
  bArity: number | undefined,
  constant: number,
  inLo: number,
  inHi: number,
  outLo: number,
  outHi: number
): Float32Array {
  const data = new Float32Array(n * k);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < k; c++) {
      const x = aData[i * k + c];
      let y: number;
      if (op === "remap") {
        const span = inHi - inLo;
        const t = Math.min(
          Math.max(span === 0 ? 0 : (x - inLo) / span, 0),
          1
        );
        y = outLo + t * (outHi - outLo);
      } else {
        const o = !useAttr
          ? constant
          : bData && bArity === k
            ? bData[i * k + c]
            : bData && bArity === 1
              ? bData[i]
              : 0;
        y = applyOp(x, o, op);
      }
      data[i * k + c] = y;
    }
  }
  return data;
}

export const attributeMathNode: NodeDefinition = {
  type: "attribute-math",
  name: "Attribute Math",
  category: "point",
  subcategory: "modifier",
  description:
    "Componentwise math on a named channel (points or spline anchors): add/subtract/multiply/divide/min/max/power against a constant or a second channel, or remap a range. Writes back in place, or to a new name via Output. A missing channel passes through unchanged.",
  facts: {
    space: { out: "in:points" },
    gotchas: [
      "An arity-1 operand attribute broadcasts across every component of a higher-arity target; any other arity mismatch reads as 0 for every component.",
      "divide returns 0 when the operand is exactly 0, not Infinity/NaN.",
      "remap clamps t to [0,1] before lerping, so inputs outside In Lo..In Hi saturate at Out Lo/Hi instead of extrapolating.",
      "aux name emits the resolved output name (output_name or else attr_name) as a string even when the source channel is missing and nothing was written.",
      "Spline-anchor reads fall back to the subpath's own attrs when an anchor lacks the named value, but writing always stamps a per-anchor value, flattening that fallback.",
    ],
  },
  backend: "webgl2",
  inputs: [{ name: "points", type: "points", required: true }],
  resolveInputs(params): InputSocketDef[] {
    const target = ((params.target as string) ?? "points") as Target;
    return [
      {
        name: "points",
        type: innerTypeFor(target),
        required: true,
        label: target === "points" ? "Points" : "Spline",
      },
    ];
  },
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
      name: "target",
      label: "Target",
      type: "enum",
      options: TARGET_OPTIONS as unknown as string[],
      default: "points",
    },
    {
      name: "op",
      label: "Operation",
      type: "enum",
      options: OP_OPTIONS as unknown as string[],
      default: "multiply",
    },
    {
      name: "operand",
      label: "Operand",
      type: "enum",
      options: OPERAND_OPTIONS as unknown as string[],
      default: "constant",
      visibleIf: (p) => p.op !== "remap",
    },
    {
      name: "value",
      label: "Value",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 2,
      step: 0.001,
      default: 1,
      visibleIf: (p) => p.op !== "remap" && p.operand !== "attribute",
    },
    {
      name: "operand_attr",
      label: "With",
      type: "string",
      default: "",
      placeholder: "second attribute",
      suggestAttrsFrom: "points",
      suggestAttrsRequire: true,
      visibleIf: (p) => p.op !== "remap" && p.operand === "attribute",
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
      visibleIf: (p) => p.op === "remap",
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
      visibleIf: (p) => p.op === "remap",
    },
    {
      name: "out_lo",
      label: "Out Lo",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 1,
      step: 0.001,
      default: 0,
      visibleIf: (p) => p.op === "remap",
    },
    {
      name: "out_hi",
      label: "Out Hi",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 1,
      step: 0.001,
      default: 1,
      visibleIf: (p) => p.op === "remap",
    },
    {
      name: "output_name",
      label: "Output",
      type: "string",
      default: "",
      placeholder: "same name",
    },
  ],
  primaryOutput: "points",
  resolvePrimaryOutput(params): SocketType {
    return innerTypeFor(((params.target as string) ?? "points") as Target);
  },
  // The written channel's NAME (Output when set, else Name) — the
  // reference wire, same convention as Set Named Attribute's.
  auxOutputs: [{ name: "name", type: "string" }],

  compute({ inputs, params }) {
    const target = ((params.target as string) ?? "points") as Target;
    const src = inputs.points;
    const name = ((params.attr_name as string) ?? "").trim();
    const outName =
      ((params.output_name as string) ?? "").trim() || name;
    const aux = { name: { kind: "string", value: outName } as const };
    const op = ((params.op as string) ?? "multiply") as Op;
    const useAttr =
      op !== "remap" && (params.operand as string) === "attribute";
    const operandName = ((params.operand_attr as string) ?? "").trim();
    const constant = (params.value as number) ?? 1;
    const inLo = (params.in_lo as number) ?? 0;
    const inHi = (params.in_hi as number) ?? 1;
    const outLo = (params.out_lo as number) ?? 0;
    const outHi = (params.out_hi as number) ?? 1;

    if (target === "spline anchors") {
      if (!src || src.kind !== "spline") {
        return { primary: EMPTY_SPLINE, aux };
      }
      const a = name ? readSplineAnchorChannel(src, name) : undefined;
      if (!a) return { primary: src, aux };
      const b = useAttr ? readSplineAnchorChannel(src, operandName) : undefined;
      const n = a.data.length / a.arity;
      const data = runMath(
        a.data,
        n,
        a.arity,
        op,
        useAttr,
        b?.data,
        b?.arity,
        constant,
        inLo,
        inHi,
        outLo,
        outHi
      );
      return {
        primary: writeSplineAnchorChannel(src, outName, data, a.arity),
        aux,
      };
    }

    if (!src || src.kind !== "points") {
      return { primary: EMPTY_POINTS, aux };
    }
    const a = name ? src.attributes?.[name] : undefined;
    if (!a) return { primary: src, aux };

    const b = useAttr ? src.attributes?.[operandName] : undefined;
    const n = src.count;
    const k = a.arity;
    const data = runMath(
      a.data,
      n,
      k,
      op,
      useAttr,
      b?.data,
      b?.arity,
      constant,
      inLo,
      inHi,
      outLo,
      outHi
    );
    const result: PointAttribute = { arity: a.arity, color: a.color, data };
    return {
      primary: copyPointsWith(src, {
        attributes: { ...src.attributes, [outName]: result },
      }),
      aux,
    };
  },
};
