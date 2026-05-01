import type { NodeDefinition } from "@/engine/types";

// Standalone clamp primitive. Math has Min and Max as ops and a
// "Clamp to 0-1" toggle, but a dedicated node with explicit lo/hi
// inputs is more discoverable and avoids the two-Math-nodes
// composition for arbitrary ranges.

export const clampNode: NodeDefinition = {
  type: "clamp",
  name: "Clamp",
  category: "utility",
  description:
    "Clamp a scalar into [Lo, Hi]. Lo and Hi can be wired or set in the panel; if Lo > Hi they are swapped before clamping.",
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "value", type: "scalar", required: false, label: "Value" },
    { name: "lo", type: "scalar", required: false, label: "Lo" },
    { name: "hi", type: "scalar", required: false, label: "Hi" },
  ],
  params: [
    {
      name: "value",
      label: "Value",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.001,
      default: 0,
    },
    {
      name: "lo",
      label: "Lo",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "hi",
      label: "Hi",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 1,
      step: 0.001,
      default: 1,
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],

  compute({ inputs, params }) {
    const v =
      inputs.value?.kind === "scalar"
        ? inputs.value.value
        : ((params.value as number) ?? 0);
    let lo =
      inputs.lo?.kind === "scalar"
        ? inputs.lo.value
        : ((params.lo as number) ?? 0);
    let hi =
      inputs.hi?.kind === "scalar"
        ? inputs.hi.value
        : ((params.hi as number) ?? 1);
    if (lo > hi) {
      const t = lo;
      lo = hi;
      hi = t;
    }
    const out = Math.max(lo, Math.min(hi, v));
    return { primary: { kind: "scalar", value: out } };
  },
};
