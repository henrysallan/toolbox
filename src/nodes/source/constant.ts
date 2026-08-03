import type { NodeDefinition } from "@/engine/types";

// Bare scalar literal source. Avoids routing single numbers through Math
// (Math at "Add" with B unconnected works, but a dedicated primitive
// reads cleaner in the graph and is easier to discover in the menu).
//
// The slider exposes one number; the node forwards it as a scalar.
// `mode` picks float vs integer output, and `step` sets the increment the
// value moves in (2 → 2, 4, 6…; 1.2 → 1.2, 2.4, 3.6…) — both the UI
// controls (via stepFrom) and the emitted value quantize to it.
// Stable — value comes from params, no time/external state.

// Effective increment. Integer mode forces a whole number ≥ 1 so the
// slider and the emitted value stay on integers. The 0.001 default matches
// the param's historic static step, so projects saved before `step`
// existed keep their exact values through the compute-side quantize.
function effectiveStep(params: Record<string, unknown>): number {
  const raw =
    typeof params.step === "number" && params.step > 0 ? params.step : 0.001;
  return params.mode === "integer" ? Math.max(1, Math.round(raw)) : raw;
}

export const constantNode: NodeDefinition = {
  type: "constant",
  name: "Constant",
  category: "utility",
  description:
    "Emits a single scalar value, in float or integer mode, snapped to a configurable step (2 → 2, 4, 6…; 1.2 → 1.2, 2.4, 3.6…). Use to feed exposed scalar inputs without routing through a Math node.",
  backend: "webgl2",
  stable: true,
  inputs: [],
  params: [
    {
      name: "value",
      label: "Value",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.001,
      stepFrom: effectiveStep,
      default: 1,
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["float", "integer"],
      control: "segmented",
      default: "float",
    },
    {
      name: "step",
      label: "Step",
      type: "scalar",
      min: 0.001,
      max: 1000,
      softMax: 10,
      step: 0.001,
      // Integer mode: the increment itself moves in whole numbers.
      stepFrom: (p) => (p.mode === "integer" ? 1 : undefined),
      default: 0.001,
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],

  compute({ params }) {
    const raw = (params.value as number) ?? 0;
    // Quantize to the increment so wired/keyframed values step too (a
    // keyframe ramp with step 2 emits 0, 2, 4…). toFixed(6) scrubs float
    // error the same way NumberField's snap does.
    const step = effectiveStep(params);
    let value = parseFloat((Math.round(raw / step) * step).toFixed(6));
    if (params.mode === "integer") value = Math.round(value);
    return { primary: { kind: "scalar", value } };
  },
};
