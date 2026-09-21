import type {
  InputSocketDef,
  NodeDefinition,
  SocketType,
  SplineValue,
} from "@/engine/types";
import {
  EMPTY_POINTS,
  isWritablePointAttr,
  readPointAttrColumn,
  withPointAttr,
} from "@/engine/points";
import {
  readSplineAnchorChannel,
  writeSplineAnchorChannel,
} from "@/engine/spline-attrs";

// Attribute Math — componentwise math on an attribute (points or spline
// anchors; 081326_point-attributes.md M3). The node-based convenience for
// the common one-liners; Point Expression's setattr stays the escape
// hatch for arbitrary formulas. On points every name is an attribute
// (092026_unified-attributes.md): the source, the operand and the output
// can each be a named channel OR a built-in — `index`, `x`, `scale`,
// `scale.x`, `rotation`, `group` — so `index ^ 1.35 → scale` is one node
// and the result lands in the point's own transform data. The operand is
// a constant or a SECOND attribute (arity-1 operands broadcast across
// components; mismatched arities read as 0). Remap fits
// [In Lo..In Hi] → [Out Lo..Out Hi], clamped. Comparisons (greater /
// less / step) write 1 or 0 per component; abs / fraction / log / exp
// are unary. The cyclic set (2026-09-20) mirrors the scalar Math node so
// a per-point phase offset or colour cycle no longer needs a Point
// Expression: `modulo` is the FLOORED modulo (result takes the operand's
// sign, so a negative x wraps up into [0, o)), `wrap` folds into
// [In Lo, In Hi) — the same rows remap uses — and `fraction` is x −
// floor(x). `log` is the natural log (x ≤ 0 → 0) and `exp` is e^x.
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
  "modulo",
  "wrap",
  "fraction",
  "abs",
  "log",
  "exp",
  "greater than",
  "less than",
  "step",
  "remap",
] as const;
type Op = (typeof OP_OPTIONS)[number];

const UNARY_OPS: ReadonlySet<string> = new Set(["abs", "fraction", "log", "exp"]);

// Remap and wrap read the lo/hi rows; the unary ops read nothing.
// Everything else reads the operand (constant or a second channel).
function usesOperand(op: unknown): boolean {
  return op !== "remap" && op !== "wrap" && !UNARY_OPS.has(op as string);
}

// Which ops show the In Lo / In Hi rows (remap's input range; wrap's
// target range).
function usesRange(op: unknown): boolean {
  return op === "remap" || op === "wrap";
}

// Blender / GLSL-style wrap into [lo, hi): a zero-width range collapses to
// lo instead of dividing by zero. Same formula as the Math node's Wrap.
export function wrapValue(v: number, lo: number, hi: number): number {
  const range = hi - lo;
  if (range === 0) return lo;
  return v - Math.floor((v - lo) / range) * range;
}

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
    case "modulo":
      // Floored modulo (Math node's "Floored Modulo"): the result takes
      // the operand's sign, so −0.25 mod 1 = 0.75 — what a cyclic phase
      // wants. A zero operand reads as 0, like divide.
      return o === 0 ? 0 : x - Math.floor(x / o) * o;
    case "abs":
      return Math.abs(x);
    case "fraction":
      return x - Math.floor(x);
    case "log":
      return x <= 0 ? 0 : Math.log(x);
    case "exp":
      return Math.exp(x);
    case "greater than":
      return x > o ? 1 : 0;
    case "less than":
      return x < o ? 1 : 0;
    case "step":
      // GLSL step(edge, x): 0 when x < edge, else 1. Operand is the edge.
      return x < o ? 0 : 1;
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
      } else if (op === "wrap") {
        y = wrapValue(x, inLo, inHi);
      } else if (UNARY_OPS.has(op)) {
        y = applyOp(x, 0, op);
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
    "Componentwise math on an attribute (points or spline anchors): add/subtract/multiply/divide/min/max/power/modulo against a constant or a second attribute, the unary abs/fraction/log/exp, wrap into [In Lo, In Hi), greater than / less than / step (0/1 comparisons), or remap a range. Writes back in place, or to a new name via Output. On points, name / with / output can each be a named channel or a built-in (index, x, y, scale, scale.x, rotation, group), so index ^ ratio → scale is one node. A missing channel passes through unchanged.",
  facts: {
    space: { out: "in:points" },
    reads: ["attr:index", "attr:scale", "attr:rotation", "attr:position", "attr:group"],
    writes: ["attr:scale", "attr:rotation", "attr:position", "attr:group"],
    gotchas: [
      "On points, attr_name / operand_attr / output_name accept built-ins (index, x, y, scale, scale.x, rotation, group) as well as channels; a built-in output lands in the typed array.",
      "index, z and nx/ny/nz are read-only outputs and pass through. Spline anchors have no built-ins. An arity-1 operand broadcasts across a higher-arity target; any other arity mismatch reads as 0.",
      "divide and modulo return 0 when the operand is exactly 0, not Infinity/NaN; modulo is FLOORED (sign of the operand), so -0.25 mod 1 = 0.75.",
      "wrap folds into [In Lo, In Hi) using the same rows remap uses (no operand); a zero-width range collapses to In Lo. fraction is x - floor(x); log is natural and reads 0 for x <= 0.",
      "greater than / less than write 1 or 0 per component with a strict inequality against the operand; step writes 1 when the channel ≥ the operand (GLSL step(operand, x)), equality on the 1 side.",
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
      suggestAttrsIncludeBuiltins: true,
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
      visibleIf: (p) => usesOperand(p.op),
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
      visibleIf: (p) => usesOperand(p.op) && p.operand !== "attribute",
    },
    {
      name: "operand_attr",
      label: "With",
      type: "string",
      default: "",
      placeholder: "second attribute",
      suggestAttrsFrom: "points",
      suggestAttrsRequire: true,
      suggestAttrsIncludeBuiltins: true,
      visibleIf: (p) => usesOperand(p.op) && p.operand === "attribute",
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
      visibleIf: (p) => usesRange(p.op),
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
      visibleIf: (p) => usesRange(p.op),
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
      // A writer: offer the writable built-ins (scale, rotation, x…) with
      // the channels; index / z / normals tint red.
      suggestAttrsFrom: "points",
      suggestAttrsIncludeBuiltins: true,
      suggestAttrsBuiltinFilter: isWritablePointAttr,
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
      usesOperand(op) && (params.operand as string) === "attribute";
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
    // Any attribute in, any writable attribute out. A missing source, or
    // a read-only output (index / z / normals), passes through.
    const a = name ? readPointAttrColumn(src, name) : undefined;
    if (!a || !isWritablePointAttr(outName)) return { primary: src, aux };

    const b = useAttr ? readPointAttrColumn(src, operandName) : undefined;
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
    return {
      primary: withPointAttr(src, outName, data, { arity: k, color: a.color }),
      aux,
    };
  },
};
