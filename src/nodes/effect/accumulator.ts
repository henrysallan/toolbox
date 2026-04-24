import type {
  NodeDefinition,
  RenderContext,
  ScalarValue,
} from "@/engine/types";

// Scalar accumulator — integrates an input value over time. Useful for
// any "keep growing" signal: a rotation that spins, a phase that cycles,
// a counter that ticks.
//
// Two modes:
//   - integrate: output += input × dt (frame-rate independent; an input
//     of 90 means "90 units/second" which is how users typically author
//     speeds)
//   - sum: output += input (adds per evaluation regardless of elapsed
//     wall-clock time)
//
// Range behavior:
//   - free:  unbounded
//   - clamp: result saturates at [min, max]
//   - wrap:  result wraps through [min, max] — perfect for angles or
//            any cyclical value
//
// Reset behavior:
//   - auto-reset on scene time 0 (matches RD and Sim Zones)
//   - `reset` input > 0.5 zeros the value to `initial` and holds it
//     there while the signal stays high — drops below 0.5 and it
//     resumes accumulating
//   - accumulation is gated on ctx.playing, so pausing the scene
//     actually pauses the integral

interface AccumState {
  value: number;
  lastTime: number;
  initialized: boolean;
}

function applyRange(
  v: number,
  range: string,
  min: number,
  max: number
): number {
  if (range === "clamp") return Math.max(min, Math.min(max, v));
  if (range === "wrap") {
    const width = max - min;
    if (width <= 0) return min;
    return min + (((v - min) % width) + width) % width;
  }
  return v;
}

function stateKey(nodeId: string): string {
  return `accumulator:${nodeId}`;
}

export const accumulatorNode: NodeDefinition = {
  type: "accumulator",
  name: "Accumulator",
  category: "utility",
  description:
    "Integrate a scalar over time. Output grows or oscillates as the input accumulates each frame. Auto-resets on scene time 0; an optional reset input clears to the initial value while held.",
  backend: "webgl2",
  // State lives between frames; fingerprintExtras mixes in ctx.time so
  // the cache re-evaluates us every frame during playback.
  stable: false,
  inputs: [
    { name: "input", type: "scalar", required: true },
    { name: "reset", type: "scalar", required: false },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["integrate", "sum"],
      default: "integrate",
    },
    {
      name: "initial",
      label: "Initial",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.01,
      default: 0,
    },
    {
      name: "range",
      label: "Range",
      type: "enum",
      options: ["free", "clamp", "wrap"],
      default: "free",
    },
    {
      name: "min",
      label: "Min",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.01,
      default: 0,
      visibleIf: (p) => p.range !== "free",
    },
    {
      name: "max",
      label: "Max",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.range !== "free",
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],

  fingerprintExtras(_params, ctx) {
    return `t:${ctx.time.toFixed(4)}|p:${ctx.playing ? 1 : 0}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const initial = (params.initial as number) ?? 0;
    const mode = (params.mode as string) ?? "integrate";
    const range = (params.range as string) ?? "free";
    const min = (params.min as number) ?? 0;
    const max = (params.max as number) ?? 1;

    const key = stateKey(nodeId);
    let state = ctx.state[key] as AccumState | undefined;
    if (!state) {
      state = { value: initial, lastTime: ctx.time, initialized: false };
      ctx.state[key] = state;
    }

    // Auto-reset when scene time wraps back to 0 (RAF loop or scrub to
    // start). Matches the convention used by RD and Sim Zones.
    const wasNonZero = state.lastTime > 0.05;
    const isNearZero = ctx.time < 0.05;
    const shouldAutoReset =
      !state.initialized || (wasNonZero && isNearZero);

    const resetSignal =
      inputs.reset?.kind === "scalar" ? inputs.reset.value : 0;
    const explicitReset = resetSignal > 0.5;

    if (shouldAutoReset || explicitReset) {
      state.value = initial;
      state.initialized = true;
    }

    // Accumulate only when the scene is playing AND reset isn't being
    // held. Integrate by dt so an input of "90" feels like 90 units
    // per second regardless of frame rate. Negative dt (user scrubbed
    // backward) is clamped to zero so the accumulator freezes rather
    // than running in reverse — rewind semantics would require
    // keyframe storage, which is a bigger feature.
    if (ctx.playing && !explicitReset) {
      const dt = Math.max(0, ctx.time - state.lastTime);
      const input =
        inputs.input?.kind === "scalar" ? inputs.input.value : 0;
      const inc = mode === "integrate" ? input * dt : input;
      state.value += inc;
    }
    state.lastTime = ctx.time;

    const out = applyRange(state.value, range, min, max);
    return {
      primary: { kind: "scalar", value: out } satisfies ScalarValue,
    };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    delete ctx.state[stateKey(nodeId)];
  },
};
