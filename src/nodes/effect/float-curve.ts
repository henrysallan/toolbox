import type { NodeDefinition } from "@/engine/types";
import {
  defaultFloatCurve,
  sampleFloatCurve,
  sanitizeFloatCurve,
} from "@/engine/float-curve";

// Scalar-through-an-editable-curve utility (Blender's Float Curve).
// The engine already had the curve model and monotone-cubic sampler
// (engine/float-curve.ts, used by Stroke / Repeats spacing curves) —
// this node just exposes it as a standalone scalar shaper. The curve
// maps x∈[0,1] → y∈[0,1]; inputs outside the domain hold the endpoint
// y (the sampler clamps). For other ranges, Remap into 0..1 first.

export const floatCurveNode: NodeDefinition = {
  type: "float-curve",
  name: "Float Curve",
  category: "utility",
  description:
    "Remap a scalar through an editable curve: the input is x in [0..1], the output is the curve's y there. Inputs outside 0..1 hold the endpoint values. Use Remap to bring other ranges into 0..1 first.",
  searchAliases: ["curve", "ease", "shaper"],
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "value", type: "scalar", required: false, label: "Value" },
  ],
  params: [
    {
      name: "value",
      label: "Value",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "curve",
      label: "Curve",
      type: "float_curve",
      default: defaultFloatCurve(0, 1),
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],

  compute({ inputs, params }) {
    const v =
      inputs.value?.kind === "scalar"
        ? inputs.value.value
        : ((params.value as number) ?? 0.5);
    const curve = sanitizeFloatCurve(params.curve, 0, 1);
    const out = sampleFloatCurve(curve, v);
    return { primary: { kind: "scalar", value: out } };
  },
};
