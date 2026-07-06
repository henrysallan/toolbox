import type { NodeDefinition } from "@/engine/types";
import { EASING_OPTIONS, applyEasing } from "@/engine/easing";

// Scene time as a scalar output.
//
// Base value comes from `ctx.time` (seconds) or `ctx.frame` (integer frame
// index at the current target FPS), selected by `unit`. A post-processing
// `mode` then shapes the base value:
//
//   linear    : pass through, then `scale`/`offset`.
//   pingpong  : oscillates min→max→min. Its own intuitive controls:
//                 rate       — full cycles per unit (cycles/sec in seconds
//                              mode). Higher = faster. Replaces the old `period`.
//                 min / max  — the base range (defines the centre + span).
//                 amplitude  — multiplies the swing symmetrically around the
//                              range centre. 1 = exactly min↔max; 2 = double
//                              (overshoots both ends); 0 = frozen at centre.
//               An `easing` curve + shared `ease_intensity` reshape each ramp
//               (ease-in-out holds near the extremes; overshoot curves like
//               back/elastic push briefly past the ends). Ping-pong intentionally
//               ignores the global `scale`/`offset` (they're hidden for it) —
//               `min`/`max`/`amplitude` fully own the range, which is what made
//               the old `scale` confusing.
//   stepped   : discrete steps of size `step_size`, with easing applied to
//               the fractional position between step N and N+1. At easing
//               `linear` this is identity; at `smoothstep` the value holds
//               near the step boundaries and glides in the middle; at
//               `step` (no easing) it becomes a hard staircase. Then
//               `scale`/`offset`.
//
// Both eased modes share an `ease_intensity` coefficient: a single knob that
// blends the eased curve against the raw linear ramp — 0 = no easing (linear),
// 1 = the exact named curve, >1 = exaggerated (stronger overshoot / snappier
// polynomials). Default 1.
//
// Marked `stable: false` so the evaluator fingerprints with ctx.time each
// frame — downstream caches invalidate but independent subgraphs don't.
//
// The easing curve set + intensity coefficient live in engine/easing.ts,
// shared with the Text node's per-character animators. The `period → rate` and
// `scale/offset → amplitude` migration for old saves lives in
// migrateLoadedParams (lib/project.ts).

export const sceneTimeNode: NodeDefinition = {
  type: "scene-time",
  name: "Scene Time",
  category: "utility",
  description:
    "Emits the current playback time as a scalar. Modes: linear, ping-pong (rate + amplitude + min/max, with an easing curve on each ramp), or stepped with easing. Connect to an exposed scalar input to drive animation.",
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
      name: "rate",
      label: "Rate",
      type: "scalar",
      // Full min→max→min cycles per unit (cycles/sec in seconds mode).
      min: 0.01,
      max: 20,
      softMax: 4,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => p.mode === "pingpong",
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
      visibleIf: (p) => p.mode === "pingpong",
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
      visibleIf: (p) => p.mode === "pingpong",
    },
    {
      name: "amplitude",
      label: "Amplitude",
      type: "scalar",
      // Swing multiplier around the (min+max)/2 centre. 1 = exactly min↔max.
      min: 0,
      max: 4,
      softMax: 2,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.mode === "pingpong",
    },
    {
      name: "pingpong_easing",
      label: "Easing",
      type: "enum",
      options: EASING_OPTIONS,
      // Defaults to the original raw triangle so existing ping-pong nodes are
      // unchanged; users opt into a curve.
      default: "linear",
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
      name: "ease_intensity",
      label: "Easing intensity",
      type: "scalar",
      min: 0,
      max: 3,
      softMax: 2,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.mode === "pingpong" || p.mode === "stepped",
    },
    {
      name: "scale",
      label: "Scale",
      type: "scalar",
      min: -10,
      max: 10,
      step: 0.01,
      default: 1,
      // Ping-pong owns its range via min/max/amplitude, so scale/offset only
      // apply to linear/stepped.
      visibleIf: (p) => p.mode !== "pingpong",
    },
    {
      name: "offset",
      label: "Offset",
      type: "scalar",
      min: -100,
      max: 100,
      step: 0.01,
      default: 0,
      visibleIf: (p) => p.mode !== "pingpong",
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],

  compute({ params, ctx }) {
    const unit = (params.unit as string) ?? "seconds";
    const mode = (params.mode as string) ?? "linear";

    const base = unit === "frames" ? ctx.frame : ctx.time;
    const intensity = (params.ease_intensity as number) ?? 1;

    if (mode === "pingpong") {
      // rate = full min→max→min cycles per unit; half-cycle drives the triangle.
      const rate = Math.max(1e-4, (params.rate as number) ?? 0.5);
      const half = 0.5 / rate; // time from min to max
      const full = half * 2; // one full cycle = 1 / rate
      // mod-mod trick keeps phased non-negative even when base is.
      const phased = ((base % full) + full) % full;
      const ramp = half - Math.abs(phased - half);
      const t = ramp / half; // normalized triangle ∈ [0,1], eased below
      const easing = (params.pingpong_easing as string) ?? "linear";
      const eased = applyEasing(easing, t, intensity);
      // min/max set the centre + span; amplitude scales the swing symmetrically
      // around the centre (1 = exactly min↔max). Global scale/offset are not
      // applied here — the range is fully owned by these three.
      const lo = (params.min as number) ?? 0;
      const hi = (params.max as number) ?? 1;
      const amp = (params.amplitude as number) ?? 1;
      const center = (lo + hi) / 2;
      const span = hi - lo;
      const value = center + (eased - 0.5) * span * amp;
      return { primary: { kind: "scalar", value } };
    }

    const scale = (params.scale as number) ?? 1;
    const offset = (params.offset as number) ?? 0;
    let shaped: number;
    if (mode === "stepped") {
      const step = Math.max(1e-4, (params.step_size as number) ?? 1);
      const easing = (params.easing as string) ?? "smoothstep";
      const idx = Math.floor(base / step);
      const alpha = base / step - idx;
      const eased = applyEasing(easing, alpha, intensity);
      shaped = (idx + eased) * step;
    } else {
      shaped = base;
    }

    return { primary: { kind: "scalar", value: shaped * scale + offset } };
  },
};
