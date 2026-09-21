import type { NodeDefinition } from "@/engine/types";
import { EASING_OPTIONS, applyEasing } from "@/engine/easing";
import {
  defaultFloatCurve,
  sampleFloatCurve,
  sanitizeFloatCurve,
  type CurvePoint,
} from "@/engine/float-curve";

// Scene time as a scalar output.
//
// Base value comes from `ctx.time` (seconds) or tick-derived fractional
// frames (`ctx.tick / ctx.ticksPerFrame`), selected by `unit`. A post-processing
// `mode` then shapes the base value:
//
//   linear    : pass through, then `scale`/`offset`.
//   pingpong  : oscillates min→max→min. Its own intuitive controls:
//                 period_frames — frames per full min→max→min cycle. Always
//                              frame-based, regardless of `unit` (which is
//                              hidden for this mode): frames are how loops
//                              are timed here. Replaces the old `rate`
//                              (cycles per unit), which itself replaced
//                              `period`. Reads the tick clock, so motion
//                              stays sub-frame smooth when the RAF outruns
//                              the project fps.
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
//   sawtooth  : (2026-09-20) the plain rising ramp ping-pong lacked — min→max
//               over `period_frames`, then a hard reset to min. Shares every
//               ping-pong control (period_frames, min / max / amplitude, the
//               easing enum + curve, intensity), so with the defaults it is
//               exactly the 0→1 loop driver a cyclic per-point effect wants:
//               scrub-exact, tick-derived, and seamless when the scene length
//               is a multiple of the period. Easing reshapes the ramp; an
//               overshoot curve pushes past max just before the reset.
//   stepped   : a staircase described the way people think about one:
//               "change the output by `step_size` every step, and a step
//               lasts `step_seconds` (or `step_frames`, whichever `unit`
//               picks)". The time base is divided into steps of that
//               duration; the output is (step index + eased fraction) ·
//               step_size + offset. Easing applies to the fractional position
//               between step N and N+1: at `linear` this is a plain ramp
//               (step_size / duration per unit of time); at `smoothstep` the
//               value holds near the step boundaries and glides in the
//               middle; at `step` (no easing) it becomes a hard staircase.
//               Stepped intentionally ignores the global `scale` (hidden for
//               it). Before 2026-09-19 `step_size` was the step DURATION in
//               the selected unit and doubled as the per-step rise, so
//               `scale` was the ratio that turned time units into output
//               units — "+1 every 12 frames" needed scale 0.0833, which no
//               slider lands on. `offset` still applies: it is the value
//               before the first step completes.
//
// Both eased modes share an `ease_intensity` coefficient: a single knob that
// blends the eased curve against the raw linear ramp — 0 = no easing (linear),
// 1 = the exact named curve, >1 = exaggerated (stronger overshoot / snappier
// polynomials). Default 1.
//
// Either easing enum also offers `custom`: the ramp then goes through
// `easing_curve`, a float_curve param (x = ramp position, y = eased value)
// edited in the panel — or, exposed as a socket, driven by the Float Curve
// node's `curve` aux or an Expression node in `curve` output mode. That is
// how a hand-drawn or formula-defined easing reaches the transitions
// without a new socket on the node body: the param IS the socket once
// exposed (091926_float-curve-socket.md). The float-curve model is clamped
// to the unit square (monotone cubic, no overshoot), so a custom curve
// cannot push past the ends the way back/elastic/bounce do — those stay in
// the enum. `ease_intensity` blends a custom curve exactly like a named one.
//
// Marked `stable: false` so the evaluator fingerprints with ctx.time each
// frame — downstream caches invalidate but independent subgraphs don't.
//
// The easing curve set + intensity coefficient live in engine/easing.ts,
// shared with the Text node's per-character animators. Old-save migrations
// (`period → rate → period_frames`, `scale/offset → amplitude`, and the
// stepped `step_size` → duration + size split) live in migrateSceneTimeParams
// below, which migrateLoadedParams (lib/project.ts) calls for every loaded
// node and fragment.

// Fresh-node step durations. Also what the stepped migration writes into the
// duration param the old save did NOT use (each unit keeps its own value, and
// a loaded params record is never back-filled from the def's defaults).
export const STEP_SECONDS_DEFAULT = 1;
export const STEP_FRAMES_DEFAULT = 12;

// The enum value that routes easing through `easing_curve`. Appended to the
// shared curve list rather than added to engine/easing.ts: the Text
// animators share that list and have no curve param to honour it with.
export const CUSTOM_EASING = "custom";
const SCENE_TIME_EASING_OPTIONS = [...EASING_OPTIONS, CUSTOM_EASING];

// The two period-driven modes share one control set (period_frames, min /
// max / amplitude, pingpong_easing, ease_intensity) and ignore unit / scale
// / offset. Param visibility keys off this so a mode added later joins by
// name alone.
export function isCyclic(mode: unknown): boolean {
  return mode === "pingpong" || mode === "sawtooth";
}

// sanitizeFloatCurve allocates a fresh array per call, which would defeat
// sampleFloatCurve's by-identity tangent cache every frame. Param values
// round-trip by reference through the evaluator (a wired curve arrives as
// the producer's own `points` array), so the raw array is a sound key.
const sanitizedCurves = new WeakMap<object, CurvePoint[]>();
function curveOf(raw: unknown): CurvePoint[] {
  if (!Array.isArray(raw)) return sanitizeFloatCurve(raw, 0, 1);
  let clean = sanitizedCurves.get(raw);
  if (!clean) {
    clean = sanitizeFloatCurve(raw, 0, 1);
    sanitizedCurves.set(raw, clean);
  }
  return clean;
}

// Ease a [0,1] ramp position by the named curve, or by `easing_curve` when
// the enum says custom. Both paths clamp t and blend against the raw ramp
// with `intensity`, exactly as applyEasing does for the named set.
function easeRamp(
  params: Record<string, unknown>,
  name: string,
  t: number,
  intensity: number
): number {
  if (name !== CUSTOM_EASING) return applyEasing(name, t, intensity);
  const tt = Math.max(0, Math.min(1, t));
  const eased = sampleFloatCurve(curveOf(params.easing_curve), tt);
  return tt + intensity * (eased - tt);
}

export const sceneTimeNode: NodeDefinition = {
  type: "scene-time",
  name: "Scene Time",
  category: "utility",
  description:
    "Emits the current playback time as a scalar in seconds or frames. Modes: linear, ping-pong (period in frames + amplitude + min/max, with an easing curve on each ramp), sawtooth (the same controls, but a min→max ramp that resets each period — the plain 0→1 loop driver), or stepped (change by a step size every step duration, with easing on each transition). Easing can be a named curve or `custom`: an editable float curve that, exposed as a socket, a Float Curve or Expression node can drive. Connect to an exposed scalar input to drive animation.",
  facts: {
    reads: ["time"],
    gotchas: [
      "mode=pingpong and mode=sawtooth ignore unit, scale, and offset entirely; period_frames is always frame-based and min/max/amplitude alone own the output range.",
      "mode=sawtooth ramps min→max over period_frames then resets hard to min (no return ramp); it reads pingpong_easing / easing_curve / ease_intensity like ping-pong, and with the defaults is a 0→1 loop.",
      "unit=frames, pingpong and sawtooth use the tick-derived fractional frame (tick/ticksPerFrame) so motion stays smooth past project fps; integer frame count is only the ticksPerFrame<=0 fallback.",
      "mode=stepped adds step_size (output units; negative counts down) once per step and ignores scale; the step lasts step_seconds (unit=seconds) or step_frames (unit=frames).",
      "mode=stepped eases only the fraction within a step: easing=step is a hard staircase, linear a ramp at step_size/duration, smoothstep holds at the boundaries; offset is the value before step one.",
      "easing=custom (either enum) samples easing_curve, a float_curve (x=ramp position, y=eased); expose it and wire Float Curve's curve aux or an Expression with out_type=curve to drive it.",
      "easing_curve is clamped to the unit square with no overshoot, so a custom curve cannot push past the ends; back/elastic/bounce are enum-only.",
      "ease_intensity blends the eased curve against the raw linear ramp: 0=linear, 1=the exact named curve, >1 exaggerates it (overshoot/snap); shared by pingpong and stepped.",
    ],
  },
  backend: "webgl2",
  stable: false,
  inputs: [],
  params: [
    {
      name: "unit",
      label: "Unit",
      type: "enum",
      options: ["seconds", "frames"],
      control: "segmented",
      default: "seconds",
      // Ping-pong is timed in frames via period_frames, so the unit only
      // affects linear (what the output counts) and stepped (which duration
      // param is live).
      visibleIf: (p) => !isCyclic(p.mode),
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["linear", "pingpong", "sawtooth", "stepped"],
      optionLabels: {
        linear: "Linear",
        pingpong: "Ping-pong",
        sawtooth: "Sawtooth",
        stepped: "Stepped",
      },
      default: "linear",
    },
    {
      name: "period_frames",
      label: "Period (frames)",
      type: "scalar",
      // Frames per full min→max→min cycle. Frame-based regardless of `unit`
      // (hidden for this mode). Default 120 = a 2 s cycle at 60 fps, matching
      // the old default rate of 0.5 cycles/sec.
      min: 2,
      max: 3600,
      softMax: 600,
      step: 1,
      default: 120,
      visibleIf: (p) => isCyclic(p.mode),
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
      visibleIf: (p) => isCyclic(p.mode),
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
      visibleIf: (p) => isCyclic(p.mode),
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
      visibleIf: (p) => isCyclic(p.mode),
    },
    {
      name: "pingpong_easing",
      label: "Easing",
      type: "enum",
      options: SCENE_TIME_EASING_OPTIONS,
      // Defaults to the original raw triangle so existing ping-pong nodes are
      // unchanged; users opt into a curve.
      default: "linear",
      visibleIf: (p) => isCyclic(p.mode),
    },
    {
      name: "step_size",
      label: "Step size",
      type: "scalar",
      // How much the output changes per step, in OUTPUT units — not a
      // duration (that is step_seconds / step_frames). Negative counts down.
      // The slider covers ±10; the number field reaches the hard max.
      min: -10,
      max: 1000,
      softMax: 10,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.mode === "stepped",
    },
    {
      name: "step_seconds",
      label: "Step duration (s)",
      type: "scalar",
      // How long one step lasts when unit=seconds. Its frames twin below takes
      // over when unit=frames — two params rather than one so each unit keeps
      // its own value, a unit-bearing label, and a sensible increment
      // (hundredths here, whole frames there).
      min: 0.01,
      max: 60,
      softMax: 5,
      step: 0.01,
      default: STEP_SECONDS_DEFAULT,
      visibleIf: (p) => p.mode === "stepped" && p.unit !== "frames",
    },
    {
      name: "step_frames",
      label: "Step duration (frames)",
      type: "scalar",
      min: 1,
      max: 3600,
      softMax: 120,
      step: 1,
      default: STEP_FRAMES_DEFAULT,
      visibleIf: (p) => p.mode === "stepped" && p.unit === "frames",
    },
    {
      name: "easing",
      label: "Easing",
      type: "enum",
      options: SCENE_TIME_EASING_OPTIONS,
      default: "smoothstep",
      visibleIf: (p) => p.mode === "stepped",
    },
    {
      name: "easing_curve",
      label: "Easing curve",
      type: "float_curve",
      // x = position along the ramp (0 = start of a step / the min end of a
      // ping-pong swing), y = eased position. The identity ramp is the
      // neutral start — a fresh `custom` behaves like `linear` until drawn.
      // Shared by both modes: one custom shape per node, whichever mode is
      // live reads it. Exposable (paramSocketType maps float_curve), so the
      // Float Curve node's `curve` aux or an Expression in curve mode can
      // drive it; the row stays visible while exposed even if the enum is
      // switched away (ParamPanel's exposed-param rule).
      default: defaultFloatCurve(0, 1),
      visibleIf: (p) =>
        (p.mode === "stepped" && p.easing === CUSTOM_EASING) ||
        (isCyclic(p.mode) && p.pingpong_easing === CUSTOM_EASING),
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
      visibleIf: (p) => isCyclic(p.mode) || p.mode === "stepped",
    },
    {
      name: "scale",
      label: "Scale",
      type: "scalar",
      min: -10,
      max: 10,
      step: 0.01,
      default: 1,
      // Ping-pong owns its range via min/max/amplitude and stepped via
      // step_size, so scale only applies to linear.
      visibleIf: (p) => (p.mode ?? "linear") === "linear",
    },
    {
      name: "offset",
      label: "Offset",
      type: "scalar",
      min: -100,
      max: 100,
      step: 0.01,
      default: 0,
      // Ping-pong owns its range via min/max/amplitude; for stepped this is
      // the value before the first step completes.
      visibleIf: (p) => !isCyclic(p.mode),
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],

  compute({ params, ctx }) {
    const unit = (params.unit as string) ?? "seconds";
    const mode = (params.mode as string) ?? "linear";

    const base =
      unit === "frames"
        ? ctx.ticksPerFrame > 0
          ? ctx.tick / ctx.ticksPerFrame
          : ctx.frame
        : ctx.time;
    const intensity = (params.ease_intensity as number) ?? 1;

    if (isCyclic(mode)) {
      // period_frames = frames per full cycle (min→max→min for ping-pong,
      // min→max→reset for sawtooth). The timebase is the tick-derived
      // fractional frame — not integer ctx.frame — so motion stays smooth
      // when the RAF outruns the project fps, and not `base`, since these
      // modes ignore `unit`.
      const full = Math.max(1e-4, (params.period_frames as number) ?? 120);
      const frames =
        ctx.ticksPerFrame > 0 ? ctx.tick / ctx.ticksPerFrame : ctx.frame;
      // mod-mod trick keeps phased non-negative even when frames is.
      const phased = ((frames % full) + full) % full;
      let t: number; // normalized ramp position ∈ [0,1), eased below
      if (mode === "sawtooth") {
        t = phased / full;
      } else {
        const half = full / 2; // frames from min to max
        const ramp = half - Math.abs(phased - half);
        t = ramp / half;
      }
      const easing = (params.pingpong_easing as string) ?? "linear";
      const eased = easeRamp(params, easing, t, intensity);
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

    const offset = (params.offset as number) ?? 0;

    if (mode === "stepped") {
      // The step duration lives on the same axis `base` counts (seconds, or
      // fractional frames), so idx is simply "how many steps have elapsed".
      const duration = Math.max(
        1e-4,
        unit === "frames"
          ? (params.step_frames as number) ?? STEP_FRAMES_DEFAULT
          : (params.step_seconds as number) ?? STEP_SECONDS_DEFAULT
      );
      const size = (params.step_size as number) ?? 1;
      const easing = (params.easing as string) ?? "smoothstep";
      const idx = Math.floor(base / duration);
      const alpha = base / duration - idx;
      const eased = easeRamp(params, easing, alpha, intensity);
      // No `scale` here: step_size is already in output units.
      return {
        primary: { kind: "scalar", value: (idx + eased) * size + offset },
      };
    }

    const scale = (params.scale as number) ?? 1;
    return { primary: { kind: "scalar", value: base * scale + offset } };
  },
};

// Param back-compat for saved Scene Time nodes. Called from
// migrateLoadedParams (lib/project.ts) for every loaded node and fragment
// (clipboard / node presets). Additive: each new param is derived from the
// old ones so old saves keep their motion exactly, and every branch writes
// the param it is gated on, so a second pass is a no-op. `fps` is the node's
// composition fps — the ping-pong `rate → period_frames` conversion needs it;
// fragments carry no scene and pass 60.
export function migrateSceneTimeParams(
  params: Record<string, unknown>,
  fps: number
): void {
  if (params.period_frames === undefined) {
    if (params.rate === undefined) {
      // Ping-pong speed switched from `period` (half-cycle, i.e. min→max time,
      // in the selected unit) to `rate` (full min→max→min cycles per unit). A
      // full cycle is 2·period, so rate = 1 / (2·period). Applies regardless of
      // mode (period was only used by ping-pong; harmless otherwise).
      const period = typeof params.period === "number" ? params.period : 2;
      params.rate = period > 0 ? 1 / (2 * period) : 0.25;
      delete params.period;
      if (params.mode === "pingpong") {
        // Ping-pong no longer applies the global scale/offset; `amplitude` (a
        // swing multiplier around the range centre) replaces the old `scale`.
        // Old output was `(lo + t·span)·scale + offset` — a linear remap of the
        // ramp — so fold scale/offset into min/max to preserve it exactly, set
        // amplitude 1, and neutralize scale/offset (so switching to a scale-using
        // mode later starts clean). Correct for any easing: the fold is a linear
        // remap of the (possibly eased) ramp, which easing doesn't disturb.
        const scale = typeof params.scale === "number" ? params.scale : 1;
        const offset = typeof params.offset === "number" ? params.offset : 0;
        const lo = typeof params.min === "number" ? params.min : 0;
        const hi = typeof params.max === "number" ? params.max : 1;
        params.min = lo * scale + offset;
        params.max = hi * scale + offset;
        params.amplitude = 1;
        params.scale = 1;
        params.offset = 0;
      }
    }
    // Ping-pong speed then moved from `rate` (cycles per `unit`) to
    // `period_frames` (frames per full cycle, unit-independent). Same speed:
    // a cycle is 1/rate seconds (fps/rate frames) in seconds mode, 1/rate
    // frames in frames mode. Clamped ≥1 so a degenerate stored rate can't
    // produce a zero-length cycle.
    const rate =
      typeof params.rate === "number" && params.rate > 0 ? params.rate : 0.5;
    params.period_frames = Math.max(
      1,
      params.unit === "frames" ? 1 / rate : fps / rate
    );
    delete params.rate;
  }

  if (params.step_seconds === undefined && params.step_frames === undefined) {
    // Stepped mode (2026-09-19) split the old `step_size` — the step DURATION
    // in the selected unit, which also set the per-step rise before `scale` —
    // into a duration per unit (`step_seconds` / `step_frames`) and
    // `step_size` as the per-step OUTPUT change. Old output was
    // (idx + eased)·step·scale + offset; the new formula is
    // (idx + eased)·size + offset, so size = step·scale reproduces it exactly
    // for any easing. Applied regardless of mode, so a linear node that later
    // switches to stepped moves as it would have. `scale` is left alone:
    // linear still uses it, and stepped now ignores it. The duration the
    // save's unit did NOT use gets the fresh-node default — a loaded params
    // record is never back-filled from the def, so the row would otherwise
    // render empty after a unit flip.
    const step =
      typeof params.step_size === "number" && params.step_size > 0
        ? params.step_size
        : 1;
    const scale = typeof params.scale === "number" ? params.scale : 1;
    const frames = params.unit === "frames";
    params.step_frames = frames ? step : STEP_FRAMES_DEFAULT;
    params.step_seconds = frames ? STEP_SECONDS_DEFAULT : step;
    params.step_size = step * scale;
  }
}
