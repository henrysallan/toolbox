import type { NodeDefinition } from "@/engine/types";

// Number → String. The missing scalar→text bridge: wire an animated scalar in
// and get a string out, so a counter / scoreboard / percentage readout can
// drive a Text node's exposed `text` (there is deliberately no string↔scalar
// coercion in the engine — this node is the explicit conversion).
//
// Input socket + same-named param fallback is the Math/Compare pattern: the
// wire wins when connected, the slider stands in when it isn't, so the node is
// useful (and previewable) before anything is plugged into it.
//
// Stable — output depends only on inputs and params.

// Group the integer part in threes: 1234567.5 → "1,234,567.5". Operates on the
// already-formatted string so it can't perturb the rounding.
function groupThousands(s: string, sep: string): string {
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf(".");
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const rest = dot === -1 ? "" : body.slice(dot);
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return (neg ? "-" : "") + grouped + rest;
}

export const numberToStringNode: NodeDefinition = {
  type: "number-to-string",
  name: "Number to String",
  category: "utility",
  description:
    "Formats a number as text — decimal places, zero-padding, thousands " +
    "separators, prefix/suffix. Wire it into a Text node's text to show an " +
    "animated value (counters, scores, percentages).",
  backend: "webgl2",
  stable: true,
  noMaskInput: true,
  inputs: [{ name: "value", label: "Value", type: "scalar", required: false }],
  params: [
    {
      name: "value",
      label: "Value",
      type: "scalar",
      min: -1000000,
      max: 1000000,
      softMax: 100,
      step: 0.01,
      default: 0,
    },
    {
      name: "decimals",
      label: "Decimals",
      type: "scalar",
      min: 0,
      max: 10,
      step: 1,
      default: 0,
    },
    {
      name: "trimZeros",
      label: "Trim zeros",
      type: "boolean",
      default: false,
    },
    {
      name: "pad",
      label: "Min digits",
      type: "scalar",
      min: 0,
      max: 12,
      step: 1,
      default: 0,
    },
    {
      name: "thousands",
      label: "Thousands",
      type: "boolean",
      default: false,
    },
    {
      name: "prefix",
      label: "Prefix",
      type: "string",
      default: "",
      placeholder: "$",
    },
    {
      name: "suffix",
      label: "Suffix",
      type: "string",
      default: "",
      placeholder: "%",
    },
  ],
  primaryOutput: "string",
  auxOutputs: [],

  compute({ inputs, params }) {
    const wired = inputs.value;
    const raw =
      wired?.kind === "scalar" ? wired.value : ((params.value as number) ?? 0);
    const decimals = Math.max(
      0,
      Math.min(10, Math.round((params.decimals as number) ?? 0))
    );
    const pad = Math.max(0, Math.min(12, Math.round((params.pad as number) ?? 0)));

    // Non-finite input would render "NaN"/"Infinity" into a caption; 0 is the
    // quieter failure, matching how the scalar sockets treat garbage.
    let body = Number.isFinite(raw) ? raw.toFixed(decimals) : (0).toFixed(decimals);

    if (params.trimZeros && decimals > 0 && body.includes(".")) {
      body = body.replace(/\.?0+$/, "");
    }

    if (pad > 0) {
      // Pad the INTEGER digits only, inside the sign — "-007", not "0-07".
      const neg = body.startsWith("-");
      let digits = neg ? body.slice(1) : body;
      const dot = digits.indexOf(".");
      const intPart = dot === -1 ? digits : digits.slice(0, dot);
      const rest = dot === -1 ? "" : digits.slice(dot);
      if (intPart.length < pad) {
        digits = "0".repeat(pad - intPart.length) + intPart + rest;
      }
      body = (neg ? "-" : "") + digits;
    }

    if (params.thousands) body = groupThousands(body, ",");

    const prefix = (params.prefix as string) ?? "";
    const suffix = (params.suffix as string) ?? "";
    return { primary: { kind: "string", value: prefix + body + suffix } };
  },
};
