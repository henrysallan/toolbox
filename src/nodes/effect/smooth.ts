import type { NodeDefinition, RenderContext } from "@/engine/types";

// Exponential smoothing filter. Each frame the output drifts toward the
// input value; how fast is set by the `time` param (the time-constant in
// seconds — roughly how long it takes to cover ~63% of a step change).
//
// out_t = lerp(out_{t-1}, in, alpha)        where  alpha = 1 - exp(-dt / time)
//
// Smaller `time` ⇒ alpha ≈ 1 ⇒ near-instant follow.
// Larger `time` ⇒ alpha ≈ 0 ⇒ heavy damping.
//
// dt is recovered from ctx.time deltas — works correctly even if the
// scene is paused (alpha collapses to 0 when dt = 0).
//
// Stateful: stores the previous output and the previous wall time per
// node id in ctx.state. Marked stable:false so the evaluator re-runs
// every frame even when params/inputs don't change — otherwise the
// filter would freeze on cached output.

interface SmoothState {
  // Previous emitted value. Initial undefined means "snap to input on
  // first eval" so the filter doesn't need a configured starting point.
  value?: number;
  // ctx.time at the previous eval, used to compute dt. Undefined ⇒
  // first frame; treat dt as 0 (no movement) and seed from input.
  lastTime?: number;
}

function ensureState(ctx: RenderContext, nodeId: string): SmoothState {
  const key = `smooth:${nodeId}`;
  let s = ctx.state[key] as SmoothState | undefined;
  if (!s) {
    s = {};
    ctx.state[key] = s;
  }
  return s;
}

export const smoothNode: NodeDefinition = {
  type: "smooth",
  name: "Smooth",
  category: "utility",
  description:
    "Exponential smoothing filter on a scalar. Time is the smoothing time-constant (seconds) — larger values produce heavier damping. Useful for de-jittering tracker outputs (hand, object) or audio levels.",
  backend: "webgl2",
  stable: false,
  inputs: [
    { name: "value", type: "scalar", required: false, label: "Value" },
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
      name: "time",
      label: "Smoothing time (s)",
      type: "scalar",
      min: 0,
      max: 10,
      softMax: 2,
      step: 0.001,
      default: 0.25,
    },
    {
      name: "reset",
      label: "Snap to input",
      type: "boolean",
      default: false,
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const target =
      inputs.value?.kind === "scalar"
        ? inputs.value.value
        : ((params.value as number) ?? 0);
    const tau = Math.max(0, (params.time as number) ?? 0.25);
    const reset = !!params.reset;
    const state = ensureState(ctx, nodeId);

    if (reset || state.value === undefined) {
      state.value = target;
      state.lastTime = ctx.time;
      return { primary: { kind: "scalar", value: target } };
    }

    const dt = Math.max(0, ctx.time - (state.lastTime ?? ctx.time));
    state.lastTime = ctx.time;

    if (tau <= 1e-6 || dt <= 0) {
      // Time-constant zero or no time elapsed ⇒ snap to input.
      state.value = target;
      return { primary: { kind: "scalar", value: target } };
    }
    const alpha = 1 - Math.exp(-dt / tau);
    state.value = state.value + (target - state.value) * alpha;
    return { primary: { kind: "scalar", value: state.value } };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`smooth:${nodeId}`];
  },
};
