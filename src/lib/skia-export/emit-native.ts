// emit-native.ts — the Reanimated-native export mode, `animation: "native"`
// (specdocs/101326_skia-target.md §3.5c, the §1.3 easing table).
//
// The default (worklet) export replays toolbox's own curve math on one
// master clock: frame-exact and scrubbable, but the app only controls time.
// Native mode gives every animated value its own shared value, driven by
// idiomatic Reanimated animations, so app code can interrupt one, chain from
// it, or hand it to a gesture (cancelAnimation, withSpring to a new target):
//
//   scalar track   withSequence(withTiming(key, { duration, easing }), …) —
//                  one step per keyframe segment
//   hold           withDelay(duration, withTiming(next, { duration: 0 }))
//   spring         withSpring(next, springToReanimated(key, ms)) from rest,
//                  then a wait at `next` to the following key (M3 lane C)
//   color track    one 0..1 progress shared value per segment
//                  (withDelay(start, withTiming(1, { duration, easing })) or
//                  withSpring(1, …)), mixed by colorAt() in a
//                  useDerivedValue: toolbox's own OKLab / RGB lerp (copied
//                  from toolbox-timeline.ts at export) and the 8-bit snap
//                  evaluateTrack applies
//   iTime, sampled values   one linear withTiming clock, in seconds
//
// Easings (NATIVE_EASINGS): Reanimated's own function wherever it equals
// toolbox's — bit for bit, to the last ulp, or (Easing.bezier) to its
// solver's precision, checked per segment — and toolbox's formula as a
// worklet easing everywhere else, never a lookalike.
//
// The price is time. Reanimated starts each withSequence step on the frame
// its predecessor finished, and a withTiming finishes on the first frame at
// or past its duration. Durations end 1 µs early and play() starts in a
// frame callback, so on a steady display clock every step still lands on
// its toolbox frame (≤ 1e-5 of range from the worklet value, measured);
// a frame timestamp that arrives early by more than that makes the rest of
// that value's sequence a frame late. manifest.json says so; the spec has
// the measured numbers (`npm run parity:skia -- --bundle native*`,
// check-skia-native).
//
// Segments (M3 lane B's markers → toolbox-clock.ts SEGMENTS, shipped here
// too): the planner slices every track by a window (`NativeWindow`) — the
// whole timeline for play(), each segment for playSegment(name, { loop,
// from }), which puts every value at its SEGMENT_STARTS value and plays its
// window. A window edge inside a key segment (a marker mid-curve, keys past
// either end of the timeline) is a `tbxCut*` easing: toolbox's own curve
// over the cut as the fraction of its move, so it stays exact.
//
// `from: "current"` (an interruption): a scalar's first step is a withTiming
// / withSpring from wherever the value is, so it runs from there to its
// target along that step's curve. A color is a mix of progresses, which
// can't start anywhere else, so it gets the same motion explicitly: the
// offset from the segment's start color to the color on screen (in the
// track's OKLab / RGB mixing space, colorOffset) fades out by a weight that
// runs 1 → 0 over the segment's first move with that move's own timing and
// easing (<key>FromSegmentAnimation — a linear glide over a lead before the
// first key, a step for a hold, withSpring for a spring), mixed in by
// colorFrom; at weight 0 it is colorAt exactly, so from "start" and play()
// are bit-identical to before (lane C, 2026-10-14).

import { effectChildrenCode, effectComponentImports, effectFillJsx, emitSkiaBundle } from "./emit";
import { timelineConstSource } from "./emit-shared";
import type { SkiaExportPlan } from "./plan";
import { emitSceneBundle, sampleKeys, type SceneDriver } from "./scene-emit";
import { NO_EXPORT_SEGMENTS, type ExportSegments } from "./segments";
import type { ScenePlan } from "./scene-plan";
import { Bezier as reanimatedBezier } from "./reanimated-easing";
import { springSkslArgs, springToReanimated, type ReanimatedSpringConfig } from "./spring";
import {
  cubicBezierEase,
  easeOf,
  evaluateTrackRaw,
  springEase,
  type TimelineBezier,
  type TimelineKey,
  type TimelineTrack,
} from "./runtime/toolbox-timeline";

// The Reanimated release native bundles are checked against (skia-harness).
export const NATIVE_REANIMATED_VERSION = "4.7.0";

export type NativeEasingClass =
  // Reanimated's function IS toolbox's: max |Δ| = 0 over the gate's grid.
  | "exact"
  // Algebraically equal; the float evaluation differs in the last ulp.
  | "ulp"
  // The same cubic, solved by Reanimated's own Bezier (4 Newton + 10
  // bisection steps); within BEZIER_TOLERANCE, checked per segment.
  | "solver"
  // No Reanimated function equals it: toolbox's formula ships as a worklet
  // easing (toolbox-timeline.ts's own function).
  | "custom"
  // Reanimated's own withSpring, physics config from springToReanimated
  // (M3 lane C): ≤ 1e-11 × |B − A| at frame timestamps (check:spring-easing).
  | "physics"
  // A step: withDelay + an instant withTiming.
  | "hold"
  // Not exportable in native mode on this base.
  | "refused";

export interface NativeEasingRow {
  easing: string;
  // What the emitter writes for it (null: custom / hold / refused).
  reanimated: string | null;
  cls: NativeEasingClass;
  // custom rows: the nearest Reanimated function, which the gate proves
  // is NOT toolbox's curve.
  candidate?: string;
  note: string;
}

// The §1.3 table, as the emitter applies it. check-skia-native evaluates
// every `reanimated` / `candidate` expression against Reanimated's Easing
// and asserts the class.
export const NATIVE_EASINGS: readonly NativeEasingRow[] = [
  { easing: "linear", reanimated: "Easing.linear", cls: "exact", note: "t" },
  { easing: "easeInSine", reanimated: "Easing.sin", cls: "exact", note: "1 − cos(tπ/2); (t·π)/2 rounds exactly like t·(π/2)" },
  { easing: "easeOutSine", reanimated: "Easing.out(Easing.sin)", cls: "ulp", note: "1 − (1 − cos((1−t)π/2)) vs sin(tπ/2)" },
  { easing: "easeInOutSine", reanimated: "Easing.inOut(Easing.sin)", cls: "ulp", note: "second half: cos((1−t)π) vs −cos(tπ)" },
  { easing: "easeInQuad", reanimated: "Easing.quad", cls: "exact", note: "t²" },
  { easing: "easeIn", reanimated: "Easing.quad", cls: "exact", note: "legacy alias of easeInQuad" },
  { easing: "easeOutQuad", reanimated: "Easing.out(Easing.quad)", cls: "exact", note: "1 − (1−t)²" },
  { easing: "easeOut", reanimated: "Easing.out(Easing.quad)", cls: "exact", note: "legacy alias of easeOutQuad" },
  { easing: "easeInOutQuad", reanimated: "Easing.inOut(Easing.quad)", cls: "exact", note: "(2t)²/2 rounds like 2t²; pow(x, 2) = x·x" },
  { easing: "easeInOut", reanimated: "Easing.inOut(Easing.quad)", cls: "exact", note: "legacy alias of easeInOutQuad" },
  { easing: "easeInCubic", reanimated: "Easing.cubic", cls: "exact", note: "t³" },
  { easing: "easeOutCubic", reanimated: "Easing.out(Easing.cubic)", cls: "exact", note: "1 − (1−t)³, same operation order" },
  { easing: "easeInOutCubic", reanimated: "Easing.inOut(Easing.cubic)", cls: "ulp", note: "second half: x·x·x vs pow(x, 3)" },
  {
    easing: "easeInExpo",
    reanimated: null,
    cls: "custom",
    candidate: "Easing.exp",
    note: "Easing.exp(0) = 2^−10 ≈ 0.00098, not 0 (toolbox special-cases t = 0)",
  },
  {
    easing: "easeOutExpo",
    reanimated: null,
    cls: "custom",
    candidate: "Easing.out(Easing.exp)",
    note: "Easing.out(Easing.exp)(1) = 1 − 2^−10, 0.1% short (toolbox special-cases t = 1)",
  },
  { easing: "easeInBack", reanimated: "Easing.back(1.70158)", cls: "ulp", note: "t²((s+1)t − s) vs (s+1)t³ − st²" },
  { easing: "easeOutBack", reanimated: "Easing.out(Easing.back(1.70158))", cls: "ulp", note: "1 − back(1−t) vs 1 + (s+1)(t−1)³ + s(t−1)²" },
  { easing: "easeOutBounce", reanimated: "Easing.bounce", cls: "exact", note: "Penner's constants; Easing.bounce is already the out-bounce" },
  {
    easing: "easeOutElastic",
    reanimated: null,
    cls: "custom",
    candidate: "Easing.elastic(1)",
    note: "Easing.elastic(b) is a different curve (1 − cos³(tπ/2)·cos(tbπ))",
  },
  { easing: "hold", reanimated: null, cls: "hold", note: "withDelay(segment, withTiming(next, { duration: 0 }))" },
  {
    easing: "cubicBezier",
    reanimated: "Easing.bezier(x1, y1, x2, y2)",
    cls: "solver",
    note: "x clamped to [0, 1] as toolbox does; a shape Reanimated's solver misses by more than BEZIER_TOLERANCE ships toolbox's cubicBezierEase instead",
  },
  {
    easing: "customBezier",
    reanimated: "Easing.bezier(normalised handles)",
    cls: "solver",
    note: "scalar keys: the handles as the segment's normalised (x1, y1, x2, y2), same guard; equal keys with moving handles refuse; color tracks play it linear, as toolbox does",
  },
  {
    easing: "spring",
    reanimated: "withSpring(target, springToReanimated(key, segmentMs))",
    cls: "physics",
    note: "lane C's spring IS Reanimated's withSpring from rest (physics config: stiffness ω0², ζ to the bit); it rests at settle/1.01 of the segment, so a wait holds the target to the next key; colors spring a 0..1 progress (Reanimated would spring each channel in linear RGB)",
  },
];

const ROW = new Map(NATIVE_EASINGS.map((r) => [r.easing, r]));

// How far Reanimated's Easing.bezier may land from toolbox's cubicBezierEase
// (in eased fraction, max over BEZIER_GRID samples) before the emitter ships
// toolbox's solver as a custom easing instead. Ordinary shapes measure
// 1e-7..1e-6; a vertical tangent (x1 = 1, x2 = 0) misses by ~0.1.
export const BEZIER_TOLERANCE = 2e-6;
const BEZIER_GRID = 4096;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Max |Reanimated Bezier − toolbox cubicBezierEase| over the grid.
export function bezierSolverError(b: TimelineBezier): number {
  const ra = reanimatedBezier(b.x1, b.y1, b.x2, b.y2);
  let max = 0;
  for (let i = 0; i <= BEZIER_GRID; i++) {
    const t = i / BEZIER_GRID;
    const d = Math.abs(ra(t) - cubicBezierEase(b, t));
    if (d > max) max = d;
  }
  return max;
}

// ---- literals ------------------------------------------------------------------

function num(v: number): string {
  return Object.is(v, -0) ? "-0" : String(v);
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const objKey = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
const member = (k: string) => (IDENT.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`);
const local = (k: string) => k.replace(/[^A-Za-z0-9_$]/g, "_");

// ---- the plan -------------------------------------------------------------------------

export type NativeEase =
  | { kind: "reanimated"; code: string; cls: "exact" | "ulp" | "solver"; err?: number }
  // withSpring(target, config); it rests `restFrames` into the segment.
  | { kind: "spring"; config: ReanimatedSpringConfig; restFrames: number }
  // The value doesn't move over the step (a hold whose jump lies past the
  // window, a cut of a flat stretch): a timed wait at the target.
  | { kind: "wait" }
  | { kind: "custom"; name: string; why: string }
  | { kind: "hold" }
  | { kind: "refused"; reason: string };

interface CustomEasing {
  name: string;
  decl: string;
  why: string;
}

export interface NativeStep {
  // The key segment it plays (index of its first key).
  segment: number;
  // Toolbox ticks of the segment (clipped to the window start).
  from: number;
  to: number;
  // The segment's duration in ms (withTiming's `duration`; hold: the wait)
  // and in toolbox frames (what the emitted code writes).
  ms: number;
  frames: number;
  // From the window start to the step's start, in ms and frames.
  startMs: number;
  startFrames: number;
  // withTiming's target (color segments: 1).
  target: number;
  ease: NativeEase;
  // The toolbox easing name, and "f0 → f120 easeOutBack".
  easing: string;
  label: string;
}

export interface NativeValue {
  // Key in ToolboxAnimations.values / TRACKS.
  key: string;
  from: string;
  // The track as data (no BindRef scale: the reader applies it).
  track: TimelineTrack;
  // The value at the window start (scalar tracks; colors: 0).
  initial: number;
  // scalar: the withSequence steps, in order; color: one step per animated
  // segment (each its own progress shared value).
  steps: NativeStep[];
  // color: every segment's progress at the window start (1 = over before
  // it, 0 = not started).
  progressInit: number[];
  // ms from the window start to the end of the last step.
  endMs: number;
}

// Where an animation starts and ends on the toolbox timeline (ticks): the
// whole timeline today, a marker's state window once markers land.
export interface NativeWindow {
  name: string;
  fromTick: number;
  toTick: number;
}

export interface NativeTimeline {
  fps: number;
  ticksPerFrame: number;
  durationTicks: number;
}

export class NativePlanner {
  readonly customs = new Map<string, CustomEasing>();
  readonly problems: string[] = [];
  readonly warnings: string[] = [];
  private bezierN = 0;
  private cutN = 0;

  constructor(readonly tl: NativeTimeline) {}

  ms(ticks: number): number {
    return (ticks * 1000) / (this.tl.fps * this.tl.ticksPerFrame);
  }

  at(tick: number): string {
    const f = tick / this.tl.ticksPerFrame;
    return Number.isInteger(f) ? `f${f}` : `f${+f.toFixed(3)}`;
  }

  private custom(key: string, make: () => CustomEasing): NativeEase {
    let c = this.customs.get(key);
    if (!c) {
      c = make();
      this.customs.set(key, c);
    }
    return { kind: "custom", name: c.name, why: c.why };
  }

  private preset(easing: string): NativeEase {
    const row = ROW.get(easing);
    if (!row) return { kind: "refused", reason: `easing "${easing}" has no Reanimated mapping in this exporter` };
    if (row.cls === "refused") return { kind: "refused", reason: `easing "${easing}": ${row.note}` };
    if (row.cls === "custom") {
      const name = `tbx${easing[0].toUpperCase()}${easing.slice(1)}`;
      return this.custom(easing, () => ({
        name,
        why: row.note,
        decl: `// ${easing}: ${row.note}.\nconst ${name} = (t: number) => {\n  "worklet";\n  return easeOf(${JSON.stringify(easing)}, t);\n};`,
      }));
    }
    return { kind: "reanimated", code: row.reanimated!, cls: row.cls as "exact" | "ulp" };
  }

  private bezier(b: TimelineBezier, easing: string): NativeEase {
    const err = bezierSolverError(b);
    if (err <= BEZIER_TOLERANCE) {
      return { kind: "reanimated", code: `Easing.bezier(${num(b.x1)}, ${num(b.y1)}, ${num(b.x2)}, ${num(b.y2)})`, cls: "solver", err };
    }
    const shape = [b.x1, b.y1, b.x2, b.y2].map((x) => +x.toPrecision(6)).join(", ");
    return this.custom(`bezier:${JSON.stringify(b)}`, () => {
      const name = `tbxBezier${this.bezierN++}`;
      const data = `${name.toUpperCase()}_SHAPE`;
      const why = `Reanimated's Easing.bezier(${shape}) misses toolbox's curve by ${err.toExponential(1)}`;
      return {
        name,
        why,
        decl:
          `// ${easing} (${shape}): ${why} — toolbox's solver instead.\n` +
          `const ${data}: TimelineBezier = { x1: ${num(b.x1)}, y1: ${num(b.y1)}, x2: ${num(b.x2)}, y2: ${num(b.y2)} };\n` +
          `const ${name} = (t: number) => {\n  "worklet";\n  return cubicBezierEase(${data}, t);\n};`,
      };
    });
  }

  // The easing of the segment prev → next, exactly as toolbox-timeline.ts's
  // interpolate() picks it.
  ease(track: TimelineTrack, prev: TimelineKey, next: TimelineKey): NativeEase {
    const e = prev.easing;
    if (e === "hold") return { kind: "hold" };
    if (e === "spring") {
      const span = next.tick - prev.tick;
      if (!(span > 0)) return { kind: "reanimated", code: "Easing.linear", cls: "exact" };
      // The curve rests at u = rest / omega (= settle / 1.01): withSpring's
      // energy snap, which lands on the first frame at or past it.
      const a = springSkslArgs(prev.spring);
      const frames = span / this.tl.ticksPerFrame;
      return { kind: "spring", config: springToReanimated(prev.spring, this.ms(span)), restFrames: (a.rest / a.omega) * frames };
    }
    if (e === "customBezier") {
      // Value-unit handles are scalar-only; anything else plays easeOf's
      // fallback, linear.
      if (track.kind !== "scalar") return { kind: "reanimated", code: "Easing.linear", cls: "exact" };
      const span = next.tick - prev.tick;
      const y0 = prev.value as number;
      const dv = (next.value as number) - y0;
      const right = prev.right ?? { dx: span * 0.33, dy: dv * 0.33 };
      const left = next.left ?? { dx: -span * 0.33, dy: -dv * 0.33 };
      const x1 = clamp01(span > 0 ? right.dx / span : 0);
      const x2 = clamp01(span > 0 ? 1 + left.dx / span : 1);
      if (dv === 0) {
        if (right.dy === 0 && left.dy === 0) return { kind: "reanimated", code: "Easing.linear", cls: "exact" };
        return {
          kind: "refused",
          reason: "a customBezier between equal keys whose handles move the value — a withTiming between equal values can't leave and come back",
        };
      }
      return this.bezier({ x1, y1: right.dy / dv, x2, y2: 1 + left.dy / dv }, "customBezier");
    }
    if (e === "cubicBezier") {
      const b = prev.bezier ?? { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 };
      return this.bezier({ x1: clamp01(b.x1), y1: b.y1, x2: clamp01(b.x2), y2: b.y2 }, "cubicBezier");
    }
    return this.preset(e);
  }

  // One track sliced to `win`: what a native animation plays from the
  // window start. Null (with problems) when it can't.
  value(key: string, from: string, track: TimelineTrack, win: NativeWindow): NativeValue | null {
    const ks = track.keys;
    const where = `${from} (${key})`;
    if (!ks.length) {
      this.problems.push(`${where}: a track with no keys.`);
      return null;
    }
    const finite = (v: unknown) =>
      track.kind === "scalar"
        ? typeof v === "number" && Number.isFinite(v)
        : Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
    if (!ks.every((k) => finite(k.value))) {
      this.problems.push(`${where}: a key isn't a finite ${track.kind === "scalar" ? "number" : "color"}.`);
      return null;
    }
    const steps: NativeStep[] = [];
    const progressInit: number[] = [];
    let ok = true;
    let endMs = 0;
    for (let i = 0; i + 1 < ks.length; i++) {
      const prev = ks[i];
      const next = ks[i + 1];
      const label = `${this.at(prev.tick)} → ${this.at(next.tick)} ${prev.easing}`;
      if (next.tick <= win.fromTick) {
        progressInit.push(1);
        continue;
      }
      if (prev.tick >= win.toTick) {
        progressInit.push(0);
        continue;
      }
      // The part of this key segment inside the window.
      const a = Math.max(prev.tick, win.fromTick);
      const b = Math.min(next.tick, win.toTick);
      const span = next.tick - prev.tick;
      const ua = span > 0 ? (a - prev.tick) / span : 0;
      const ub = span > 0 ? (b - prev.tick) / span : 1;
      const cut = a > prev.tick || b < next.tick;
      let ease: NativeEase;
      let target: number;
      let p0 = 0;
      if (prev.easing === "hold") {
        // Holds stay holds; one whose jump falls outside the window waits.
        ease = b < next.tick ? { kind: "wait" } : { kind: "hold" };
        target = track.kind === "scalar" ? ((b < next.tick ? prev.value : next.value) as number) : b < next.tick ? 0 : 1;
      } else if (!cut) {
        ease = this.ease(track, prev, next);
        target = track.kind === "scalar" ? (next.value as number) : 1;
      } else {
        // A window edge inside the segment (a marker, or keys past either end
        // of the timeline): a withTiming can't start or stop partway along a
        // curve, so the cut plays toolbox's own curve over [a, b] as the
        // fraction of its move — exact, whatever the easing.
        const c = this.cut(key, track, i, a, b, ua, ub);
        if (c.kind === "refused") {
          this.problems.push(`${where}: segment ${label}, cut to ${this.at(a)}–${this.at(b)}: ${c.reason}.`);
          ok = false;
          progressInit.push(0);
          continue;
        }
        ease = c.ease;
        target = c.target;
        p0 = c.start;
      }
      if (ease.kind === "refused") {
        this.problems.push(`${where}: segment ${label}: ${ease.reason}.`);
        ok = false;
        progressInit.push(0);
        continue;
      }
      progressInit.push(track.kind === "color" && a > prev.tick ? p0 : 0);
      const step: NativeStep = {
        segment: i,
        from: a,
        to: b,
        ms: this.ms(b - a),
        frames: (b - a) / this.tl.ticksPerFrame,
        startMs: this.ms(a - win.fromTick),
        startFrames: (a - win.fromTick) / this.tl.ticksPerFrame,
        target,
        ease,
        easing: prev.easing,
        label: cut ? `${label}, cut to ${this.at(a)}–${this.at(b)}` : label,
      };
      steps.push(step);
      endMs = Math.max(endMs, step.startMs + step.ms);
    }
    if (!ok) return null;
    const initial = track.kind === "scalar" ? (evaluateTrackRaw(track, win.fromTick) as number) : 0;
    return { key, from, track, initial, steps, progressInit, endMs };
  }

  // A key segment cut to [a, b] (ticks; ua, ub its fractions): the target
  // and a worklet easing that replays toolbox's curve over the cut as the
  // fraction of the move — evaluateTrackRaw for scalars, the segment's eased
  // fraction (segmentEase) for a color's progress.
  private cut(
    key: string,
    track: TimelineTrack,
    seg: number,
    a: number,
    b: number,
    ua: number,
    ub: number
  ): { kind: "ok"; ease: NativeEase; target: number; start: number } | { kind: "refused"; reason: string } {
    const prev = track.keys[seg];
    const scalar = track.kind === "scalar";
    const at = (u: number) => (scalar ? (evaluateTrackRaw(track, prev.tick + u * (track.keys[seg + 1].tick - prev.tick)) as number) : segmentFraction(prev, u));
    const va = scalar ? (evaluateTrackRaw(track, a) as number) : segmentFraction(prev, ua);
    const vb = scalar ? (evaluateTrackRaw(track, b) as number) : segmentFraction(prev, ub);
    if (va === vb) {
      for (let i = 1; i < 64; i++) {
        if (at(ua + ((ub - ua) * i) / 64) !== va) {
          return { kind: "refused", reason: "the curve leaves and comes back to the same value over the cut — no withTiming between equal values can follow it" };
        }
      }
      return { kind: "ok", ease: { kind: "wait" }, target: vb, start: va };
    }
    const name = `tbxCut${this.cutN++}`;
    const read = scalar
      ? `(evaluateTrackRaw(TRACKS${member(key)}, ${num(a)} + t * ${num(b - a)}) as number)`
      : `segmentEase(TRACKS${member(key)}.keys[${seg}], ${num(ua)} + t * ${num(ub - ua)})`;
    const why = `toolbox's ${prev.easing} cut to ${this.at(a)}–${this.at(b)}`;
    this.customs.set(`cut:${name}`, {
      name,
      why,
      decl: `// ${key}: ${why}, as the fraction of the move ${num(va)} → ${num(vb)}.\nconst ${name} = (t: number) => {\n  "worklet";\n  return (${read} - ${num(va)}) / ${num(vb - va)};\n};`,
    });
    return { kind: "ok", ease: { kind: "custom", name, why }, target: vb, start: va };
  }
}

// interpolate()'s eased fraction for a segment starting at `prev` (color
// tracks: customBezier plays linear) — the TS twin of toolbox-native.ts
// segmentEase.
function segmentFraction(prev: TimelineKey, u: number): number {
  if (prev.easing === "hold") return 0;
  if (prev.easing === "cubicBezier") return cubicBezierEase(prev.bezier ?? { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 }, u);
  if (prev.easing === "spring") return springEase(prev.spring, u);
  return easeOf(prev.easing, u);
}

// ---- animations.ts --------------------------------------------------------------------

function easingArg(e: NativeEase): string {
  return e.kind === "reanimated" ? e.code : e.kind === "custom" ? e.name : "Easing.linear";
}

function springConfig(c: ReanimatedSpringConfig): string {
  return `{ stiffness: ${num(c.stiffness)}, damping: ${num(c.damping)}, mass: ${num(c.mass)}, velocity: ${num(c.velocity)}, overshootClamping: ${c.overshootClamping}, energyThreshold: ${num(c.energyThreshold)} }`;
}

function stepComment(s: NativeStep): string {
  const e = s.ease;
  const how =
    e.kind === "reanimated"
      ? e.cls === "solver"
        ? ` (Reanimated's solver, ≤ ${(e.err ?? 0).toExponential(1)} off)`
        : e.cls === "ulp"
          ? " (equal to the last ulp)"
          : ""
      : e.kind === "custom"
        ? " (toolbox's curve)"
        : e.kind === "spring"
          ? ` (Reanimated's withSpring; rests ${+e.restFrames.toFixed(2)} frames in)`
          : "";
  return `// ${s.label}${how}`;
}

// The frames from a spring step's start to the frame its energy snap lands
// on, at the timeline's fps (the first frame at or past its rest time).
function springRestFrame(e: { restFrames: number }): number {
  return Math.ceil(e.restFrames - 1e-9);
}

// A scalar value's withSequence steps; each starts when its predecessor
// ends. A hold is withDelay + an instant withTiming — except as the FIRST
// step, and the lead before the first key isn't a withDelay either: a
// withSequence whose first step is a withDelay hands it the sequence's own
// LAST step as "the previous animation" whenever there is none (always on
// React Native web, where a fresh shared value's _animation is undefined,
// not null; and at every withRepeat restart), and the delay then shows
// that step's target while it waits. So the lead is a timed wait at the
// start value, and a leading hold a withTiming whose easing is a step
// (Easing.steps(1, false): 0 until the end, where withTiming lands on the
// target) — the same frames, whatever came before.
//
// A spring step is withSpring from rest (each step is a fresh animation; a
// finished predecessor carries no velocity). It finishes at its energy snap,
// settle/1.01 into the segment, so a wait at the target follows it to the
// next key — sized for the timeline's fps, since the snap lands on the
// first frame at or past the rest time.
function scalarSteps(v: NativeValue, at: (tick: number) => string, win: NativeWindow): string[] {
  const out: string[] = [];
  const lead = v.steps[0]?.startFrames ?? 0;
  v.steps.forEach((s, i) => {
    if (i === 0 && s.ease.kind === "hold") {
      out.push(`${stepComment(s)}${lead > 0 ? ` (from ${at(win.fromTick)})` : ""}\nwithTiming(${num(s.target)}, { duration: frames(${num(lead + s.frames)}), easing: Easing.steps(1, false) })`);
      return;
    }
    if (i === 0 && lead > 0) {
      out.push(`// ${at(win.fromTick)} → ${at(s.from)} wait at ${num(v.initial)}\nwithTiming(${num(v.initial)}, { duration: frames(${num(lead)}), easing: Easing.linear })`);
    }
    const e = s.ease;
    if (e.kind === "hold") {
      out.push(`${stepComment(s)}\nwithDelay(frames(${num(s.frames)}), withTiming(${num(s.target)}, { duration: 0 }))`);
    } else if (e.kind === "wait") {
      out.push(`${stepComment(s)} — no move inside the window\nwithTiming(${num(s.target)}, { duration: frames(${num(s.frames)}), easing: Easing.linear })`);
    } else if (e.kind === "spring") {
      out.push(`${stepComment(s)}\nwithSpring(${num(s.target)}, ${springConfig(e.config)})`);
      const wait = s.frames - springRestFrame(e);
      if (wait > 1e-9) out.push(`// … rest at ${num(s.target)} to ${at(s.to)}\nwithTiming(${num(s.target)}, { duration: frames(${num(wait)}), easing: Easing.linear })`);
    } else {
      out.push(`${stepComment(s)}\nwithTiming(${num(s.target)}, { duration: frames(${num(s.frames)}), easing: ${easingArg(e)} })`);
    }
  });
  return out;
}

// A color segment's progress: 0 → 1 from its start (a cut segment: its
// eased fraction at the cut's ends), measured from the window start (no
// chain — each segment is its own shared value). A spring springs the
// progress (Reanimated would spring a color per channel in linear RGB); it
// stays at 1 once it rests.
function colorStep(s: NativeStep): string {
  if (s.ease.kind === "hold") return `withDelay(frames(${num(s.startFrames + s.frames)}), withTiming(1, { duration: 0 }))`;
  const t =
    s.ease.kind === "spring"
      ? `withSpring(1, ${springConfig(s.ease.config)})`
      : `withTiming(${num(s.target)}, { duration: frames(${num(s.frames)}), easing: ${easingArg(s.ease)} })`;
  return s.startFrames > 0 ? `withDelay(frames(${num(s.startFrames)}), ${t})` : t;
}

// playSegment(…, { from: "current" }) on a color: its fade weight, 1 → 0
// over the window's first move, timed and eased as a scalar's first
// withSequence step runs from its current value (scalarSteps): a lead before
// the first key glides linearly, a hold waits and steps, a spring springs,
// anything else is the step's own withTiming.
function colorFade(s: NativeStep): string {
  const lead = s.startFrames;
  if (s.ease.kind === "hold") return `withTiming(0, { duration: frames(${num(lead + s.frames)}), easing: Easing.steps(1, false) })`;
  if (lead > 0) return `withTiming(0, { duration: frames(${num(lead)}), easing: Easing.linear })`;
  if (s.ease.kind === "spring") return `withSpring(0, ${springConfig(s.ease.config)})`;
  return `withTiming(0, { duration: frames(${num(s.frames)}), easing: ${easingArg(s.ease)} })`;
}

const indent = (s: string, pad: string) => s.replace(/\n/g, `\n${pad}`);

export interface NativeModule {
  // animations.ts
  source: string;
  // toolbox-native.ts
  helpers: string;
  // ToolboxAnimations.values, in order.
  keys: { key: string; kind: "scalar" | "color" | "clock" }[];
}

const HEADER = (what: string, edit: string) =>
  `// Generated by toolbox — ${what}.\n// Do not edit by hand: change ${edit} and export again.\n`;

// Every emitted duration ends this much early (frames() in animations.ts).
export const FRAME_MARGIN_MS = 0.001;

export const NATIVE_DRIFT_NOTE =
  "Reanimated starts each withSequence step on the frame its predecessor finished, and a withTiming finishes on the first frame at or past its duration. On a steady display clock every step still lands on its toolbox frame (durations end 1 µs early to absorb float noise); a frame whose timestamp arrives early by more than that pushes the rest of that value's sequence one frame late, and the lag adds up step by step. Export with animation \"worklet\" for frame-exact playback whatever the clock does.";

function wrapComment(text: string): string {
  const out: string[] = [];
  let line = "//";
  for (const w of text.split(" ")) {
    if (line.length + 1 + w.length > 78) {
      out.push(line);
      line = "//";
    }
    line += ` ${w}`;
  }
  out.push(line);
  return out.join("\n");
}

interface ModuleOptions {
  name: string;
  timeline: NativeTimeline;
  canvas?: { width: number; height: number };
  // ToolboxAnimations.values key of the clock (null: no clock).
  clock: string | null;
  // Import TIMELINE from here instead of declaring it (the scene bundle's
  // timeline.ts owns it).
  timelineFrom?: string;
  edit: string;
  runtimeSource: string;
  window: NativeWindow;
  // The composition's named segments (toolbox-clock.ts SEGMENTS), each with
  // every value planned over its window, in `values` order.
  segments: NativeSegmentPlan[];
}

export interface NativeSegmentPlan {
  name: string;
  win: NativeWindow;
  values: NativeValue[];
}

// `looped(<the value's steps>, …)` for one window, indented under `pad`.
function scalarAnimation(v: NativeValue, at: (tick: number) => string, win: NativeWindow, totalMs: string, pad: string): string {
  if (!v.steps.length) return `${num(v.initial)}; // no move here`;
  const steps = scalarSteps(v, at, win);
  const inner = `${pad}    `;
  const body =
    steps.length === 1 ? indent(steps[0], `${pad}  `) : `withSequence(\n${inner}${steps.map((s) => indent(s, inner)).join(`,\n${inner}`)}\n${pad}  )`;
  return `looped(\n${pad}  ${body},\n${pad}  ${num(v.endMs)},\n${pad}  ${totalMs},\n${pad}  ${num(v.initial)},\n${pad}  loop\n${pad});`;
}

export function emitNativeModule(planner: NativePlanner, values: NativeValue[], o: ModuleOptions): NativeModule {
  const tl = o.timeline;
  const totalMs = planner.ms(tl.durationTicks);
  const durationSec = tl.durationTicks / (tl.fps * tl.ticksPerFrame);
  const at = (t: number) => planner.at(t);
  const segs = o.segments;
  const animated = values.filter((v, i) => v.steps.length || segs.some((s) => s.values[i].steps.length));
  const colors = values.filter((v) => v.track.kind === "color");
  const customs = [...planner.customs.values()];
  const usesEaseOf = customs.some((c) => c.decl.includes("easeOf("));
  const usesBezier = customs.some((c) => c.decl.includes("cubicBezierEase("));
  const usesRaw = customs.some((c) => c.decl.includes("evaluateTrackRaw("));
  const usesSegEase = customs.some((c) => c.decl.includes("segmentEase("));
  const segMs = (s: NativeSegmentPlan) => num(planner.ms(s.win.toTick - s.win.fromTick));
  const segLabel = (s: NativeSegmentPlan) => `${at(s.win.fromTick)}–${at(s.win.toTick)}`;

  // One function per animated value (and the clock); with segments, one more
  // per value that plays it over a named segment.
  const fns: string[] = [];
  for (const v of animated) {
    const i = values.indexOf(v);
    if (v.track.kind === "scalar") {
      fns.push(
        `\n// ${v.from} — starts at ${num(v.initial)}.\nexport function ${local(v.key)}Animation(loop = false) {\n  "worklet";\n  return ${scalarAnimation(v, at, o.window, "TIMELINE_MS", "  ")}\n}`
      );
      if (segs.length) {
        fns.push(
          `\n// ${v.key} over one segment (SEGMENTS), from the segment's start.\nexport function ${local(v.key)}SegmentAnimation(segment: SegmentName, loop = false): number {\n  "worklet";\n  switch (segment) {\n${segs
            .map((s) => `    case ${JSON.stringify(s.name)}: // ${segLabel(s)}\n      return ${scalarAnimation(s.values[i], at, s.win, segMs(s), "      ")}`)
            .join("\n")}\n  }\n  return ${local(v.key)}Animation(loop);\n}`
        );
      }
    } else {
      const space = v.track.colorSpace ?? "oklab";
      fns.push(
        `\n// ${v.from}: a 0..1 progress per segment; colorAt mixes the keys in ${space === "oklab" ? "OKLab" : "RGB"}${v.track.quantize8 ? " and snaps to 8 bits" : ""}.`
      );
      for (const s of v.steps) {
        fns.push(
          `export function ${local(v.key)}Progress${s.segment}Animation(loop = false) {\n  "worklet";\n  ${stepComment(s)}\n  return looped(${colorStep(s)}, ${num(s.startMs + s.ms)}, TIMELINE_MS, 0, loop);\n}`
        );
      }
      if (segs.length) {
        v.progressInit.forEach((_, k) => {
          const cases = segs.map((sp) => {
            const sv = sp.values[i];
            const st = sv.steps.find((x) => x.segment === k && x.ease.kind !== "wait");
            return `    case ${JSON.stringify(sp.name)}: // ${segLabel(sp)}\n      ${
              st ? `${stepComment(st)}\n      return looped(${colorStep(st)}, ${num(st.startMs + st.ms)}, ${segMs(sp)}, ${num(sv.progressInit[k])}, loop);` : `return ${num(sv.progressInit[k])}; // no move here`
            }`;
          });
          fns.push(
            `export function ${local(v.key)}Progress${k}SegmentAnimation(segment: SegmentName, loop = false): number {\n  "worklet";\n  switch (segment) {\n${cases.join("\n")}\n  }\n  return ${num(v.progressInit[k])};\n}`
          );
        });
        const fades = segs.map((sp) => {
          const first = sp.values[i].steps[0];
          return `    case ${JSON.stringify(sp.name)}: // ${segLabel(sp)}\n      ${first ? `${stepComment(first)}${first.startFrames > 0 ? ` (a ${num(first.startFrames)}-frame lead first)` : ""}\n      return ${colorFade(first)};` : `return 0; // no move here: the color jumps, as a scalar does`}`;
        });
        fns.push(
          `// ${v.key}, playSegment(…, { from: "current" }): the share of the color on screen\n// still mixed in (colorFrom), 1 → 0 over the segment's first move with that\n// move's timing and easing — the path a scalar's first step takes from where it is.\nexport function ${local(v.key)}FromSegmentAnimation(segment: SegmentName): number {\n  "worklet";\n  switch (segment) {\n${fades.join("\n")}\n  }\n  return 0;\n}`
        );
      }
    }
  }
  if (o.clock) {
    fns.push(
      `\n// The scene clock in seconds, for what has no track (iTime, sampled values).\nexport function ${o.clock}Animation(loop = false) {\n  "worklet";\n  const clock = withTiming(${num(durationSec)}, { duration: frames(${num(tl.durationTicks / tl.ticksPerFrame)}), easing: Easing.linear });\n  return loop ? withRepeat(clock, -1) : clock;\n}`
    );
    if (segs.length) {
      fns.push(
        `\n// The scene clock over one segment (from its start time).\nexport function ${o.clock}SegmentAnimation(segment: SegmentName, loop = false): number {\n  "worklet";\n  switch (segment) {\n${segs
          .map((s) => {
            const end = s.win.toTick / (tl.fps * tl.ticksPerFrame);
            return `    case ${JSON.stringify(s.name)}: {\n      const clock = withTiming(${num(end)}, { duration: frames(${num((s.win.toTick - s.win.fromTick) / tl.ticksPerFrame)}), easing: Easing.linear });\n      return loop ? withRepeat(clock, -1) : clock;\n    }`;
          })
          .join("\n")}\n  }\n  return ${o.clock}Animation(loop);\n}`
      );
    }
  }
  const code = fns.join("\n");
  const rea = new Set(["cancelAnimation", "useSharedValue"]);
  for (const name of ["Easing", "withDelay", "withRepeat", "withSequence", "withSpring", "withTiming"]) if (code.includes(`${name}(`) || code.includes(`${name}.`)) rea.add(name);
  if (colors.length) rea.add("useDerivedValue");
  const reaTypes = ["SharedValue", ...(colors.length ? ["DerivedValue"] : [])];
  const rtImports = [
    ...(usesBezier ? ["cubicBezierEase"] : []),
    ...(usesEaseOf ? ["easeOf"] : []),
    ...(usesRaw ? ["evaluateTrackRaw"] : []),
    ...(usesBezier ? ["type TimelineBezier"] : []),
    "type TimelineTrack",
  ];
  const fromCurrent = colors.length > 0 && segs.length > 0;
  const nativeImports = [...(colors.length ? (fromCurrent ? ["colorFrom", "colorOffset"] : ["colorAt"]) : []), ...(animated.length ? ["looped"] : []), ...(usesSegEase ? ["segmentEase"] : [])];

  const out: string[] = [];
  out.push(
    HEADER("Reanimated-native animations", o.edit) +
      `//\n` +
      wrapComment(
        `Native mode (toolbox export option animation: "native"): every animated value is its own shared value, driven by withSequence / withDelay / withTiming / withSpring, so app code can interrupt it, chain from it or hand it to a gesture (cancelAnimation, withSpring to a new target). Easings are Reanimated's own where they equal toolbox's and toolbox's formula otherwise (manifest.json native.values lists which).`
      ) +
      `\n//\n` +
      wrapComment(NATIVE_DRIFT_NOTE) +
      `\n`
  );
  out.push(`import { useCallback, useEffect, useMemo } from "react";`);
  out.push(
    `import {\n  ${[...rea].sort((a, b) => a.localeCompare(b)).join(",\n  ")},\n  ${reaTypes.map((t) => `type ${t}`).join(",\n  ")},\n} from "react-native-reanimated";`
  );
  out.push(`import { scheduleOnUI } from "react-native-worklets";`);
  out.push(`import { SEGMENTS, type SegmentName } from "./toolbox-clock";`);
  out.push(`import { ${rtImports.join(", ")} } from "./toolbox-timeline";`);
  if (nativeImports.length) out.push(`import { ${nativeImports.join(", ")} } from "./toolbox-native";`);
  if (o.timelineFrom) {
    out.push(`import { TIMELINE } from "${o.timelineFrom}";`);
  } else {
    out.push(`\nexport const NAME = ${JSON.stringify(o.name)};`);
    out.push(timelineConstSource(tl).replace(/^\n/, "").replace(/\n$/, ""));
    if (o.canvas) out.push(`\nexport const CANVAS = { width: ${o.canvas.width}, height: ${o.canvas.height} } as const;`);
  }
  out.push(`\n// The timeline in ms (TIMELINE.durationSec) — looped animations pad to it.\nconst TIMELINE_MS = ${num(totalMs)};`);
  if (fns.length) {
    out.push(
      `\n// Toolbox frames → ms, ${FRAME_MARGIN_MS * 1000} µs short. Reanimated ends a step on the first\n// frame at or past its duration, and the frame that lands ON a key must\n// count: without the margin, float noise in (frame time − start time)\n// pushes about half the boundaries to the next frame, a lag that adds up\n// down a withSequence.\nfunction frames(n: number): number {\n  "worklet";\n  return (n * 1000) / TIMELINE.fps - ${num(FRAME_MARGIN_MS)};\n}`
    );
  }

  out.push(
    `\n// The same curves as data: evaluateTrack(TRACKS.<key>, tick) from\n// ./toolbox-timeline is the frame-exact (worklet-mode) value.\nexport const TRACKS: Record<string, TimelineTrack> = {\n${values
      .map((v) => `  // ${v.from}\n  ${objKey(v.key)}: ${JSON.stringify(v.track)},`)
      .join("\n")}\n};`
  );

  if (customs.length) {
    out.push(`\n// ---- easings Reanimated has no equal for: toolbox-timeline.ts's own math ----`);
    for (const c of customs) out.push(`\n${c.decl}`);
  }

  if (fns.length) out.push(`\n// ---- one animation per value ----`, ...fns);

  // Each value at each segment's start (playSegment jumps there).
  const startFields: string[] = [];
  for (const v of values) startFields.push(`  ${objKey(v.key)}: ${v.track.kind === "scalar" ? "number" : "number[]"};`);
  if (o.clock) startFields.push(`  ${o.clock}: number;`);
  out.push(
    `\n// ---- segments ----\n\n// Each value at each segment's start (colors: every segment's progress) —\n// where playSegment() puts it before the segment plays.\nexport interface SegmentStart {\n${startFields.join("\n")}\n}\nexport const SEGMENT_STARTS: Record<SegmentName, SegmentStart> = {${
      segs.length
        ? `\n${segs
            .map(
              (s) =>
                `  ${JSON.stringify(s.name)}: { ${[
                  ...s.values.map((v) => `${objKey(v.key)}: ${v.track.kind === "scalar" ? num(v.initial) : `[${v.progressInit.map(num).join(", ")}]`}`),
                  ...(o.clock ? [`${o.clock}: ${num(s.win.fromTick / (tl.fps * tl.ticksPerFrame))}`] : []),
                ].join(", ")} },`
            )
            .join("\n")}\n`
        : ""
    }};`
  );

  // ---- the hook
  const keys: NativeModule["keys"] = [];
  const types: string[] = [];
  const hook: string[] = [];
  const start: string[] = [];
  const segStart: string[] = [];
  const animatedNames: string[] = [];
  const fields: string[] = [];
  for (const v of values) {
    const name = `${local(v.key)}Value`;
    const moves = animated.includes(v);
    if (v.track.kind === "scalar") {
      keys.push({ key: v.key, kind: "scalar" });
      types.push(`  // ${v.from}\n  ${objKey(v.key)}: SharedValue<number>;`);
      hook.push(`const ${name} = useSharedValue(${num(v.initial)});`);
      if (v.steps.length) start.push(`${name}.value = ${num(v.initial)};`, `${name}.value = ${local(v.key)}Animation(repeat);`);
      else start.push(`${name}.value = ${num(v.initial)};`);
      if (segs.length) {
        segStart.push(`if (jump) ${name}.value = s${member(v.key)};`, `${name}.value = ${moves ? `${local(v.key)}SegmentAnimation(segment, repeat)` : `s${member(v.key)}`};`);
      }
      if (moves) animatedNames.push(name);
    } else {
      keys.push({ key: v.key, kind: "color" });
      types.push(`  // ${v.from} — [r, g, b, a], 0..1\n  ${objKey(v.key)}: DerivedValue<number[]>;`);
      const ps = v.progressInit.map((_, k) => `${local(v.key)}Progress${k}`);
      v.progressInit.forEach((p0, k) => hook.push(`const ${ps[k]} = useSharedValue(${num(p0)});`));
      // from "current": the color on screen, read before any progress resets.
      const fromOffset = `${local(v.key)}FromOffset`;
      const fromWeight = `${local(v.key)}FromWeight`;
      const shown = `${local(v.key)}Shown`;
      if (segs.length) {
        hook.push(`const ${fromOffset} = useSharedValue([0, 0, 0, 0]);`, `const ${fromWeight} = useSharedValue(0);`);
        start.push(`${fromWeight}.value = 0;`);
        segStart.push(`const ${shown} = jump ? null : ${name}.value;`);
        animatedNames.push(fromWeight);
      }
      v.progressInit.forEach((p0, k) => {
        const st = v.steps.find((s) => s.segment === k);
        start.push(`${ps[k]}.value = ${num(p0)};`);
        if (st) start.push(`${ps[k]}.value = ${local(v.key)}Progress${k}Animation(repeat);`);
        if (segs.length) segStart.push(`${ps[k]}.value = s${member(v.key)}[${k}];`, `${ps[k]}.value = ${local(v.key)}Progress${k}SegmentAnimation(segment, repeat);`);
        if (moves) animatedNames.push(ps[k]);
      });
      if (segs.length) {
        segStart.push(
          `if (${shown}) {`,
          `  ${fromOffset}.value = colorOffset(TRACKS${member(v.key)}, ${shown}, s${member(v.key)});`,
          `  ${fromWeight}.value = 1;`,
          `  ${fromWeight}.value = ${moves ? `${local(v.key)}FromSegmentAnimation(segment)` : "0"};`,
          `} else ${fromWeight}.value = 0;`
        );
        hook.push(`const ${name} = useDerivedValue(() => colorFrom(TRACKS${member(v.key)}, [${ps.map((p) => `${p}.value`).join(", ")}], ${fromOffset}.value, ${fromWeight}.value));`);
      } else {
        hook.push(`const ${name} = useDerivedValue(() => colorAt(TRACKS${member(v.key)}, [${ps.map((p) => `${p}.value`).join(", ")}]));`);
      }
    }
    fields.push(`${objKey(v.key)}: ${name}`);
  }
  if (o.clock) {
    const name = `${o.clock}Value`;
    keys.push({ key: o.clock, kind: "clock" });
    types.push(`  // The scene clock in seconds (iTime, sampled values).\n  ${o.clock}: SharedValue<number>;`);
    hook.push(`const ${name} = useSharedValue(0);`);
    start.push(`${name}.value = 0;`, `${name}.value = ${o.clock}Animation(repeat);`);
    if (segs.length) segStart.push(`${name}.value = s.${o.clock};`, `${name}.value = ${o.clock}SegmentAnimation(segment, repeat);`);
    animatedNames.push(name);
    fields.push(`${o.clock}: ${name}`);
  }
  const valueNames = fields.map((f) => f.slice(f.lastIndexOf(" ") + 1));
  const deps = animatedNames.length ? `, ${animatedNames.join(", ")}` : "";
  const onFrame = (lines: string[], pad: string) =>
    `${pad}// Start inside a frame callback: there an animation's start time is\n${pad}// the frame's own timestamp, so every step lands on display frames\n${pad}// (outside one it is "now", somewhere between two frames).\n${pad}requestAnimationFrame(() => {\n${lines.map((l) => `${pad}  ${l}`).join("\n")}\n${pad}});\n`;
  out.push(
    `\n// ---- the hook ----\n\nexport interface ToolboxAnimationValues {\n${types.join("\n")}\n}\n\n` +
      `export interface PlaySegmentOptions {\n  // Repeat the segment until stop() / another play.\n  loop?: boolean;\n  // "start" (default): every value jumps to its value at the segment's start\n  // first — the frames toolbox shows. "current": every value animates on\n  // from where it is (an interruption): a scalar's first step runs from its\n  // current value, and a color leaves the color on screen along the\n  // segment's first move (colorFrom), joining toolbox's frames when that\n  // move ends. A value that doesn't move in the segment jumps.\n  from?: "start" | "current";\n}\n\n` +
      `export interface ToolboxAnimations {\n  values: ToolboxAnimationValues;\n  // (Re)start every value from the first frame, all on one UI frame. loop:\n  // repeat the timeline (TIMELINE.durationSec) until stop().\n  play(opts?: { loop?: boolean }): void;\n  // Play one named segment (toolbox-clock.ts SEGMENTS) the same way; false\n  // for a name SEGMENTS doesn't have.\n  playSegment(segment: SegmentName, opts?: PlaySegmentOptions): boolean;\n  // Cancel every animation where it is (each value keeps its state).\n  stop(): void;\n}\n\n` +
      `// The shared values the component reads. autoplay (default true) plays\n// on mount; pass false to call play() / playSegment() yourself, or drive\n// any value directly.\n` +
      `export function useToolboxAnimations(opts: { autoplay?: boolean; loop?: boolean } = {}): ToolboxAnimations {\n` +
      `  const { autoplay = true, loop = false } = opts;\n` +
      hook.map((l) => `  ${l}`).join("\n") +
      `\n  const play = useCallback(\n    (o: { loop?: boolean } = {}) => {\n      const repeat = o.loop ?? loop;\n      scheduleOnUI(() => {\n        "worklet";\n` +
      (start.length ? onFrame(start, "        ") : `        void repeat;\n`) +
      `      });\n    },\n    [loop${deps}]\n  );\n` +
      `  const playSegment = useCallback(\n    (segment: SegmentName, o: PlaySegmentOptions = {}) => {\n      if (!Object.prototype.hasOwnProperty.call(SEGMENTS, segment)) return false;\n` +
      (segs.length
        ? `      const repeat = o.loop ?? false;\n      const jump = (o.from ?? "start") === "start";\n      scheduleOnUI(() => {\n        "worklet";\n        const s = SEGMENT_STARTS[segment];\n` +
          onFrame(segStart, "        ") +
          `      });\n`
        : `      void SEGMENT_STARTS;\n`) +
      `      return true;\n    },\n    [${animatedNames.join(", ")}]\n  );\n` +
      `  const stop = useCallback(() => {\n${animatedNames.map((n) => `    cancelAnimation(${n});\n`).join("")}  }, [${animatedNames.join(", ")}]);\n` +
      `  useEffect(() => {\n    if (autoplay) play();\n    return stop;\n  }, [autoplay, play, stop]);\n` +
      `  return useMemo(\n    () => ({ values: { ${fields.join(", ")} }, play, playSegment, stop }),\n    [play, playSegment, stop${valueNames.length ? `, ${valueNames.join(", ")}` : ""}]\n  );\n}\n`
  );

  return {
    source: out.join("\n"),
    helpers: emitHelpers(o.runtimeSource, colors.length > 0, animated.length > 0, usesSegEase, o.edit, fromCurrent),
    keys,
  };
}

// ---- toolbox-native.ts -------------------------------------------------------------

// A top-level `function name(…) {…}` of the shipped runtime, verbatim.
function runtimeFunction(src: string, name: string): string {
  const m = new RegExp(`^function ${name}\\([^]*?^}$`, "m").exec(src);
  if (!m) throw new Error(`emit-native: toolbox-timeline.ts has no top-level function ${name} to copy`);
  return m[0];
}

const COLOR_FUNCTIONS = ["srgbToLinear", "linearToSrgb", "rgbToOklab", "oklabToRgb", "lerpColor"];

// playSegment(…, { from: "current" }) for colors (see the header): the mix
// colorAt snaps, the track's mixing space, the offset of the color on screen
// from the segment's start color, and colorAt with that offset faded in.
// Each calls only worklets declared above it (the capture-order rule).
const FROM_CURRENT_HELPERS = `// colorAt before its 8-bit snap.
function colorMix(track: TimelineTrack, p: number[]): number[] {
  "worklet";
  const ks = track.keys;
  let k = 0;
  while (k < p.length - 1 && p[k] === 1) k++;
  const t = p[k];
  const a = ks[k].value as number[];
  const b = ks[k + 1].value as number[];
  return t === 0 ? a : t === 1 ? b : lerpColor(a, b, t, track.colorSpace ?? "oklab");
}

// colorAt's 8-bit snap.
function colorSnap(track: TimelineTrack, c: number[]): number[] {
  "worklet";
  if (!track.quantize8) return c;
  const q = (x: number) => {
    "worklet";
    return Math.max(0, Math.min(255, Math.round(x * 255))) / 255;
  };
  return [q(c[0]), q(c[1]), q(c[2]), track.quantizeAlpha ? q(c[3]) : (track.alpha ?? 1)];
}

// A color in its track's mixing space (lerpColor's: OKLab or gamma RGB),
// alpha last — and back.
function colorToMix(c: number[], space: "oklab" | "rgb"): number[] {
  "worklet";
  if (space === "rgb") return [c[0], c[1], c[2], c[3]];
  const lab = rgbToOklab(c[0], c[1], c[2]);
  return [lab[0], lab[1], lab[2], c[3]];
}
function colorFromMix(m: number[], space: "oklab" | "rgb"): number[] {
  "worklet";
  if (space === "rgb") return m;
  const rgb = oklabToRgb(m[0], m[1], m[2]);
  return [rgb[0], rgb[1], rgb[2], m[3]];
}

// playSegment(…, { from: "current" }): how far \`from\` (the color on screen)
// sits from the color the progresses \`p\` give (the segment's start), in the
// track's mixing space.
export function colorOffset(track: TimelineTrack, from: number[], p: number[]): number[] {
  "worklet";
  const space = track.colorSpace ?? "oklab";
  const a = colorToMix(from, space);
  const b = colorToMix(colorMix(track, p), space);
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
}

// colorAt with \`offset\` mixed back in at weight \`w\`: w runs 1 → 0 over the
// segment's first move, so the color leaves where it was along that move's
// own curve; at w = 0 it is colorAt exactly.
export function colorFrom(track: TimelineTrack, p: number[], offset: number[], w: number): number[] {
  "worklet";
  if (w === 0) return colorAt(track, p);
  const space = track.colorSpace ?? "oklab";
  const m = colorToMix(colorMix(track, p), space);
  return colorSnap(track, colorFromMix([m[0] + offset[0] * w, m[1] + offset[1] * w, m[2] + offset[2] * w, m[3] + offset[3] * w], space));
}`;

function emitHelpers(runtimeSource: string, colors: boolean, animated: boolean, segEase: boolean, edit: string, fromCurrent = false): string {
  const parts: string[] = [HEADER("native-mode helpers (worklets)", edit).trimEnd()];
  const imports: string[] = [];
  if (animated) imports.push(`import { withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated";`);
  if (segEase) imports.push(`import { cubicBezierEase, easeOf, springEase, type TimelineKey, type TimelineTrack } from "./toolbox-timeline";`);
  else if (colors) imports.push(`import type { TimelineTrack } from "./toolbox-timeline";`);
  if (imports.length) parts.push(imports.join("\n"));
  if (segEase) {
    parts.push(
      `// toolbox's eased fraction u → t for the segment that starts at \`key\` (its\n// interpolate(): customBezier plays linear on colors) — a cut color\n// segment's progress (animations.ts tbxCut*).\nexport function segmentEase(key: TimelineKey, u: number): number {\n  "worklet";\n  if (key.easing === "hold") return 0;\n  if (key.easing === "cubicBezier") return cubicBezierEase(key.bezier ?? { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 }, u);\n  if (key.easing === "spring") return springEase(key.spring, u);\n  return easeOf(key.easing, u);\n}`
    );
  }
  if (animated) {
    parts.push(
      `// \`animation\` ends endMs into the timeline. loop: hold until the timeline\n// ends (the wait ends ${FRAME_MARGIN_MS * 1000} µs early, like every step), set \`reset\` (the value\n// at frame 0) and play again. withRepeat restarts on the frame a cycle\n// ends, so that frame shows the cycle's last value: \`reset\` here, the last\n// key for a value whose last key sits on the timeline end (no pad) — which\n// only shows when its first and last keys differ.\nexport function looped(animation: number, endMs: number, totalMs: number, reset: number, loop: boolean): number {\n  "worklet";\n  if (!loop) return animation;\n  if (endMs >= totalMs) return withRepeat(animation, -1);\n  return withRepeat(withSequence(animation, withDelay(totalMs - endMs - ${num(FRAME_MARGIN_MS)}, withTiming(reset, { duration: 0 }))), -1);\n}`
    );
  }
  if (colors) {
    parts.push(`// ---- copied verbatim from toolbox-timeline.ts: toolbox's color math ----`);
    for (const f of COLOR_FUNCTIONS) parts.push(runtimeFunction(runtimeSource, f));
    parts.push(
      `// A color track's value from its per-segment progresses (each 0..1, eased\n// by Reanimated): the first segment that hasn't finished mixes its two keys\n// at its progress — the keys themselves at 0 and 1, as toolbox's exact hits\n// — then snaps to 8 bits exactly as evaluateTrack does.\nexport function colorAt(track: TimelineTrack, p: number[]): number[] {\n  "worklet";\n  const ks = track.keys;\n  let k = 0;\n  while (k < p.length - 1 && p[k] === 1) k++;\n  const t = p[k];\n  const a = ks[k].value as number[];\n  const b = ks[k + 1].value as number[];\n  const c = t === 0 ? a : t === 1 ? b : lerpColor(a, b, t, track.colorSpace ?? "oklab");\n  if (!track.quantize8) return c;\n  const q = (x: number) => {\n    "worklet";\n    return Math.max(0, Math.min(255, Math.round(x * 255))) / 255;\n  };\n  return [q(c[0]), q(c[1]), q(c[2]), track.quantizeAlpha ? q(c[3]) : (track.alpha ?? 1)];\n}`
    );
    if (fromCurrent) parts.push(FROM_CURRENT_HELPERS);
  }
  return parts.join("\n\n") + "\n";
}

// ---- manifest -----------------------------------------------------------------------

function easeClass(e: NativeEase): NativeEasingClass {
  return e.kind === "reanimated" ? e.cls : e.kind === "spring" ? "physics" : e.kind === "wait" ? "hold" : e.kind;
}

function easeNative(e: NativeEase): string {
  switch (e.kind) {
    case "reanimated":
      return e.code;
    case "custom":
      return e.name;
    case "spring":
      return "withSpring";
    case "hold":
      return "withDelay + withTiming(duration 0)";
    case "wait":
      return "withTiming (a wait at the value)";
    default:
      return "refused";
  }
}

function nativeManifest(planner: NativePlanner, values: NativeValue[], clock: string | null, segs: NativeSegmentPlan[]) {
  return {
    reanimated: NATIVE_REANIMATED_VERSION,
    drift: NATIVE_DRIFT_NOTE,
    clock,
    // playSegment(name): every value's steps over each SEGMENTS window.
    segments: segs.map((s) => ({ name: s.name, from: s.win.fromTick, to: s.win.toTick, steps: s.values.reduce((n, v) => n + v.steps.length, 0) })),
    ...(segs.length
      ? {
          fromCurrent:
            "playSegment(name, { from: \"current\" }): a scalar's first step runs from its current value; a color fades from the color on screen (offset in its OKLab / RGB mixing space) over the segment's first move, with that move's timing and easing (<key>FromSegmentAnimation, colorFrom).",
        }
      : {}),
    values: values.map((v) => ({
      key: v.key,
      from: v.from,
      kind: v.track.kind,
      ...(v.track.kind === "scalar" ? { initial: v.initial } : { segments: v.progressInit.length }),
      steps: v.steps.map((s) => ({
        segment: s.segment,
        from: s.from,
        to: s.to,
        ms: s.ms,
        startMs: s.startMs,
        frames: s.frames,
        startFrames: s.startFrames,
        easing: s.easing,
        native: easeNative(s.ease),
        class: easeClass(s.ease),
        ...(s.ease.kind === "reanimated" && s.ease.err !== undefined ? { solverError: s.ease.err } : {}),
        ...(s.ease.kind === "spring" ? { spring: s.ease.config, restFrames: s.ease.restFrames } : {}),
      })),
    })),
    customEasings: [...planner.customs.values()].map((c) => ({ name: c.name, why: c.why })),
  };
}

function withManifest(json: string, extra: Record<string, unknown>): string {
  const m = JSON.parse(json) as Record<string, unknown>;
  return JSON.stringify({ ...m, animation: "native", native: extra }, null, 2) + "\n";
}

export interface NativeExportResult {
  files: Record<string, string> | null;
  problems: string[];
  warnings: string[];
}

const WINDOW = (tl: NativeTimeline): NativeWindow => ({ name: "timeline", fromTick: 0, toTick: tl.durationTicks });

// Every value planned over the whole timeline and over each named segment
// (lane B's SEGMENTS: name → [startFrame, endFrame)). Null on any problem
// (the planner holds them).
function planAll(
  planner: NativePlanner,
  entries: { key: string; from: string; track: TimelineTrack }[],
  win: NativeWindow,
  segments: ExportSegments
): { values: NativeValue[]; segs: NativeSegmentPlan[] } | null {
  const tpf = planner.tl.ticksPerFrame;
  const values: NativeValue[] = [];
  for (const e of entries) {
    const v = planner.value(e.key, e.from, e.track, win);
    if (v) values.push(v);
  }
  const segs: NativeSegmentPlan[] = segments.segments.map((s) => ({
    name: s.name,
    win: { name: s.name, fromTick: s.startFrame * tpf, toTick: s.endFrame * tpf },
    values: [],
  }));
  for (const sp of segs) {
    for (const e of entries) {
      const v = planner.value(e.key, `${e.from}, segment "${sp.name}"`, e.track, sp.win);
      if (v) sp.values.push(v);
    }
  }
  return planner.problems.length ? null : { values, segs };
}

const CLOCK_EXPORTS = `export { DURATION_SEC, MARKERS, SEGMENTS, type MarkerName, type SegmentName } from "./toolbox-clock";\n`;

// ---- SkSL Shader node bundle ----------------------------------------------------------

export function emitNativeEffect(plan: SkiaExportPlan, runtimeSource: string, segments: ExportSegments = NO_EXPORT_SEGMENTS): NativeExportResult {
  const planner = new NativePlanner(plan.timeline);
  const win = WINDOW(plan.timeline);
  const entries = plan.uniforms.flatMap((u) => (u.track ? [{ key: u.name, from: `${u.name}: ${u.from}`, track: u.track }] : []));
  const planned = planAll(planner, entries, win, segments);
  const warnings = [...plan.warnings, ...planner.warnings];
  if (!planned) return { files: null, problems: planner.problems, warnings };
  const { values, segs } = planned;
  const taken = new Set(values.map((v) => v.key));
  const clock = plan.usesTime ? (taken.has("clock") ? "clock_" : "clock") : null;
  const edit = "the SkSL Shader node";
  const mod = emitNativeModule(planner, values, {
    name: plan.name,
    timeline: plan.timeline,
    canvas: plan.canvas,
    clock,
    edit,
    runtimeSource,
    window: win,
    segments: segs,
  });
  const base = emitSkiaBundle(plan, runtimeSource, segments);
  const animatedNames = new Set(values.map((v) => v.key));
  const fields = plan.uniforms
    .map((u) => `    ${objKey(u.name)}: ${animatedNames.has(u.name) ? `A${member(u.name)}.value` : JSON.stringify(u.value)}, // ${u.from}`)
    .join("\n");
  const files: Record<string, string> = {};
  files["effect.ts"] = base["effect.ts"];
  files["animations.ts"] = mod.source;
  files["toolbox-native.ts"] = mod.helpers;
  files["toolbox-timeline.ts"] = runtimeSource;
  files["toolbox-clock.ts"] = base["toolbox-clock.ts"];
  // Child shaders (images, LUTs): emit.ts's, with their files.
  const kids = effectChildrenCode(plan, (what) => HEADER(what, edit));
  if (kids) Object.assign(files, kids.files);
  files["ToolboxEffect.tsx"] =
    HEADER("the React Native Skia component (Reanimated-native animations)", edit) +
    effectComponentImports(kids) +
    `import { useDerivedValue } from "react-native-reanimated";\n` +
    `import type { ToolboxAnimations } from "./animations";\n` +
    `import { SKSL } from "./effect";\n` +
    (kids ? `${kids.imports.join("\n")}\n` : "") +
    `\nconst effect = Skia.RuntimeEffect.Make(SKSL);\n` +
    `if (!effect) throw new Error("toolbox export: the SkSL program did not compile on this Skia build");\n` +
    `\nexport interface ToolboxEffectProps {\n  // useToolboxAnimations() — the uniforms read its shared values.\n  animations: ToolboxAnimations;\n  width: number;\n  height: number;\n  canvasRef?: React.Ref<CanvasRef>;\n}\n` +
    `\nexport function ToolboxEffect({ animations, width, height, canvasRef }: ToolboxEffectProps) {\n` +
    `  const A = animations.values;\n` +
    `  const uniforms = useDerivedValue(() => ({\n    iResolution: [width, height, 1],\n    iTime: ${clock ? `A.${clock}.value, // the scene clock (seconds)` : "0, // the program never reads iTime"}\n${fields}\n  }));\n` +
    (kids?.hooks.length ? kids.hooks.map((h) => `  ${h}\n`).join("") : "") +
    `  return (\n    <Canvas ref={canvasRef} style={{ width, height }}>\n${effectFillJsx(kids)}\n    </Canvas>\n  );\n}\n`;
  files["manifest.json"] = withManifest(base["manifest.json"], nativeManifest(planner, values, clock, segs));
  files["index.ts"] =
    HEADER("barrel", edit) +
    `\nexport { ToolboxEffect } from "./ToolboxEffect";\n` +
    `export { CANVAS, NAME, TIMELINE, TRACKS, useToolboxAnimations, type PlaySegmentOptions, type ToolboxAnimations } from "./animations";\n` +
    CLOCK_EXPORTS +
    `export { SKSL } from "./effect";\n`;
  return { files, problems: [], warnings };
}

// ---- Skia Canvas scene bundle -------------------------------------------------------------

export function emitNativeScene(plan: ScenePlan, runtimeSource: string, segments: ExportSegments = NO_EXPORT_SEGMENTS): NativeExportResult {
  const tl: NativeTimeline = { fps: plan.timeline.fps, ticksPerFrame: plan.timeline.ticksPerFrame, durationTicks: plan.timeline.durationTicks };
  const planner = new NativePlanner(tl);
  const win = WINDOW(tl);
  const keyOf = sampleKeys(plan);
  const entries: { key: string; from: string; track: TimelineTrack }[] = [];
  const supplied = new Map<string, string>();
  let needsClock = false;
  for (const b of plan.binds) {
    if (keyOf.get(b.id) !== b.id) continue; // reads another bind's key
    const p = b.plan;
    if (p.kind === "clock" || p.kind === "sampled") {
      needsClock = true;
      continue;
    }
    if (p.kind !== "track") continue;
    // The shared value holds the track's own value; a BindRef scale is
    // applied where B reads it (evaluateTrack's `v * scale`).
    const read = (t: TimelineTrack, key: string): string => {
      const { scale, ...track } = t;
      entries.push({ key, from: `${b.path}: ${p.from}`, track });
      return `A${member(key)}.value${scale === undefined ? "" : ` * ${num(scale)}`}`;
    };
    if (p.tracks.length === 1) {
      const r = read(p.tracks[0], b.id);
      supplied.set(b.id, p.pick !== undefined && p.tracks[0].kind === "color" ? `${r}[${p.pick}]` : r);
    } else {
      supplied.set(b.id, `[${p.tracks.map((t, i) => read(t, `${b.id}_${i}`)).join(", ")}]`);
    }
  }
  const planned = planAll(planner, entries, win, segments);
  const warnings = [...plan.warnings, ...planner.warnings];
  if (!planned) return { files: null, problems: planner.problems, warnings };
  const { values, segs } = planned;
  // Bind keys are b<N>: "clock" can't collide.
  const clock = needsClock ? "clock" : null;
  const edit = "the Skia layer";
  const mod = emitNativeModule(planner, values, { name: plan.name, timeline: tl, clock, timelineFrom: "./timeline", edit, runtimeSource, window: win, segments: segs });
  const driver: SceneDriver = {
    supplied,
    propDecl: "  // useToolboxAnimations() (./animations) — every animated value.\n  animations: ToolboxAnimations;\n",
    prop: "animations",
    prelude: ["const A = animations.values;", ...(clock ? [`const time = A.${clock};`] : [])],
    imports: [`import type { ToolboxAnimations } from "./animations";`],
  };
  const files = emitSceneBundle(plan, runtimeSource, segments, driver);
  files["animations.ts"] = mod.source;
  files["toolbox-native.ts"] = mod.helpers;
  files["manifest.json"] = withManifest(files["manifest.json"], nativeManifest(planner, values, clock, segs));
  files["index.ts"] =
    HEADER("barrel", edit) +
    `\nexport { ToolboxScene, ToolboxSceneGroup } from "./ToolboxScene";\n` +
    `export { TRACKS, useToolboxAnimations, type PlaySegmentOptions, type ToolboxAnimations } from "./animations";\n` +
    CLOCK_EXPORTS +
    `export { NAME, CANVAS, TIMELINE, frameAt, sampleBinds } from "./timeline";\n`;
  return { files, problems: [], warnings };
}
