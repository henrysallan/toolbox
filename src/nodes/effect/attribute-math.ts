import type { NodeDefinition, PointAttribute } from "@/engine/types";
import { copyPointsWith, EMPTY_POINTS } from "@/engine/points";

// Attribute Math — componentwise math on a named point channel
// (081326_point-attributes.md M3). The node-based convenience for the
// common one-liners; Point Expression's setattr stays the escape hatch
// for arbitrary formulas. The operand is a constant or a SECOND channel
// (arity-1 operands broadcast across components; mismatched arities read
// as 0). Remap fits [In Lo..In Hi] → [Out Lo..Out Hi], clamped.
//
// A missing source channel passes the points through unchanged — math on
// nothing is a wiring mistake, not a request to invent zeros.

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

export const attributeMathNode: NodeDefinition = {
  type: "attribute-math",
  name: "Attribute Math",
  category: "point",
  subcategory: "modifier",
  description:
    "Componentwise math on a named point channel: add/subtract/multiply/divide/min/max/power against a constant or a second channel, or remap a range. Writes back in place, or to a new name via Output. A missing channel passes through unchanged.",
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
  // The written channel's NAME (Output when set, else Name) — the
  // reference wire, same convention as Set Named Attribute's.
  auxOutputs: [{ name: "name", type: "string" }],

  compute({ inputs, params }) {
    const src = inputs.points;
    const name = ((params.attr_name as string) ?? "").trim();
    const outName =
      ((params.output_name as string) ?? "").trim() || name;
    const aux = { name: { kind: "string", value: outName } as const };
    if (!src || src.kind !== "points") {
      return { primary: EMPTY_POINTS, aux };
    }
    const a = name ? src.attributes?.[name] : undefined;
    if (!a) return { primary: src, aux };

    const op = ((params.op as string) ?? "multiply") as Op;
    const useAttr =
      op !== "remap" && (params.operand as string) === "attribute";
    const operandName = ((params.operand_attr as string) ?? "").trim();
    const b = useAttr ? src.attributes?.[operandName] : undefined;
    const constant = (params.value as number) ?? 1;
    const inLo = (params.in_lo as number) ?? 0;
    const inHi = (params.in_hi as number) ?? 1;
    const outLo = (params.out_lo as number) ?? 0;
    const outHi = (params.out_hi as number) ?? 1;

    const n = src.count;
    const k = a.arity;
    const data = new Float32Array(n * k);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < k; c++) {
        const x = a.data[i * k + c];
        let y: number;
        if (op === "remap") {
          const span = inHi - inLo;
          const t = Math.min(
            Math.max(span === 0 ? 0 : (x - inLo) / span, 0),
            1
          );
          y = outLo + t * (outHi - outLo);
        } else {
          // Operand: constant, or the second channel (arity-1 broadcasts;
          // any other arity mismatch reads as 0).
          const o = !useAttr
            ? constant
            : b && b.arity === k
              ? b.data[i * k + c]
              : b && b.arity === 1
                ? b.data[i]
                : 0;
          switch (op) {
            case "add":
              y = x + o;
              break;
            case "subtract":
              y = x - o;
              break;
            case "multiply":
              y = x * o;
              break;
            case "divide":
              y = o === 0 ? 0 : x / o;
              break;
            case "min":
              y = Math.min(x, o);
              break;
            case "max":
              y = Math.max(x, o);
              break;
            case "power":
              y = Math.pow(x, o);
              break;
            default:
              y = x;
          }
        }
        data[i * k + c] = y;
      }
    }
    const result: PointAttribute = { arity: a.arity, color: a.color, data };
    return {
      primary: copyPointsWith(src, {
        attributes: { ...src.attributes, [outName]: result },
      }),
      aux,
    };
  },
};
