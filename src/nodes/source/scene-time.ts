import type { NodeDefinition } from "@/engine/types";

// Scene time as a scalar output.
//
// Base value comes from `ctx.time` (seconds) or `ctx.frame` (integer frame
// index at the current target FPS), selected by `unit`. A post-processing
// `mode` then shapes the base value:
//
//   linear    : pass through
//   pingpong  : triangle wave with period `period`, so the output ramps 0→P→0
//   stepped   : discrete steps of size `step_size`, with easing applied to
//               the fractional position between step N and N+1. At easing
//               `linear` this is identity; at `smoothstep` the value holds
//               near the step boundaries and glides in the middle; at
//               `step` (no easing) it becomes a hard staircase.
//
// `scale` and `offset` are applied last, so e.g. scale=2 doubles the slope
// in linear mode or doubles the peak in pingpong mode.
//
// Marked `stable: false` so the evaluator fingerprints with ctx.time each
// frame — downstream caches invalidate but independent subgraphs don't.

type EasingFn = (t: number) => number;

const EASINGS: Record<string, EasingFn> = {
  step: (t) => (t < 1 ? 0 : 1),
  linear: (t) => t,
  "ease-in": (t) => t * t,
  "ease-out": (t) => 1 - (1 - t) * (1 - t),
  "ease-in-out": (t) =>
    t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
  "ease-in-cubic": (t) => t * t * t,
  "ease-out-cubic": (t) => 1 - Math.pow(1 - t, 3),
  smoothstep: (t) => t * t * (3 - 2 * t),
  smootherstep: (t) => t * t * t * (t * (t * 6 - 15) + 10),
};

const EASING_OPTIONS = Object.keys(EASINGS);

function applyEasing(name: string, t: number): number {
  const fn = EASINGS[name] ?? EASINGS.linear;
  return fn(Math.max(0, Math.min(1, t)));
}

export const sceneTimeNode: NodeDefinition = {
  type: "scene-time",
  name: "Scene Time",
  category: "source",
  description:
    "Emits the current playback time as a scalar. Modes: linear, ping-pong, or stepped with easing. Connect to an exposed scalar input to drive animation.",
  backend: "webgl2",
  stable: false,
  inputs: [],
  params: [
    {
      name: "unit",
      label: "Unit",
      type: "enum",
      options: ["seconds", "frames"],
      default: "seconds",
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["linear", "pingpong", "stepped"],
      default: "linear",
    },
    {
      name: "period",
      label: "Period",
      type: "scalar",
      min: 0.01,
      max: 60,
      step: 0.01,
      default: 2,
      visibleIf: (p) => p.mode === "pingpong",
    },
    {
      name: "step_size",
      label: "Step size",
      type: "scalar",
      min: 0.01,
      max: 60,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.mode === "stepped",
    },
    {
      name: "easing",
      label: "Easing",
      type: "enum",
      options: EASING_OPTIONS,
      default: "smoothstep",
      visibleIf: (p) => p.mode === "stepped",
    },
    {
      name: "scale",
      label: "Scale",
      type: "scalar",
      min: -10,
      max: 10,
      step: 0.01,
      default: 1,
    },
    {
      name: "offset",
      label: "Offset",
      type: "scalar",
      min: -100,
      max: 100,
      step: 0.01,
      default: 0,
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],

  compute({ params, ctx }) {
    const unit = (params.unit as string) ?? "seconds";
    const mode = (params.mode as string) ?? "linear";
    const scale = (params.scale as number) ?? 1;
    const offset = (params.offset as number) ?? 0;

    const base = unit === "frames" ? ctx.frame : ctx.time;

    let shaped: number;
    if (mode === "pingpong") {
      const period = Math.max(1e-4, (params.period as number) ?? 2);
      // Triangle wave: phased ∈ [0, 2P), output = P - |phased - P| so it
      // ramps 0 → P → 0 over each 2P cycle. mod-mod trick keeps the input
      // non-negative even if scale/offset push it past zero elsewhere.
      const twoP = period * 2;
      const phased = ((base % twoP) + twoP) % twoP;
      shaped = period - Math.abs(phased - period);
    } else if (mode === "stepped") {
      const step = Math.max(1e-4, (params.step_size as number) ?? 1);
      const easing = (params.easing as string) ?? "smoothstep";
      const idx = Math.floor(base / step);
      const alpha = base / step - idx;
      const eased = applyEasing(easing, alpha);
      shaped = (idx + eased) * step;
    } else {
      shaped = base;
    }

    return { primary: { kind: "scalar", value: shaped * scale + offset } };
  },
};
