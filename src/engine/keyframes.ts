// Per-parameter keyframe animation system.
//
// Time is stored as integer subframe ticks (`tick`); the project metadata
// holds `ticksPerFrame` (default 1000) and `fps`. Frames and seconds are
// derived from ticks. Keyframe positions and the playhead are integer
// ticks — equality is exact and there is no floating-point drift.
//
// Wire override > keyframes > constant. The evaluator applies that
// precedence; this module only does the keyframe-evaluation step.

import type { ParamType, SplineSubpath } from "./types";
import { oklabToRgb, rgbToOklab } from "./color-space";

export const DEFAULT_TICKS_PER_FRAME = 1000;
export const DEFAULT_FPS = 60;

export type EasingPreset =
  | "linear"
  // Sine
  | "easeInSine"
  | "easeOutSine"
  | "easeInOutSine"
  // Quadratic (also reachable via the legacy easeIn/Out/InOut names below)
  | "easeInQuad"
  | "easeOutQuad"
  | "easeInOutQuad"
  // Cubic
  | "easeInCubic"
  | "easeOutCubic"
  | "easeInOutCubic"
  // Exponential
  | "easeInExpo"
  | "easeOutExpo"
  // Back (overshoot before settling)
  | "easeInBack"
  | "easeOutBack"
  // Bounce / elastic
  | "easeOutBounce"
  | "easeOutElastic"
  // Discrete
  | "hold"
  // User-shaped (scalar-only; uses the keyframe's bezierHandles)
  | "customBezier"
  // User-shaped, type-agnostic: a normalized cubic-bezier time remap
  // (the keyframe's `bezier`). Authored by the Tracks editor's easing
  // overlay — not in EASING_PRESET_ORDER because it needs curve data.
  | "cubicBezier"
  // Legacy aliases preserved so existing project files keep loading.
  // Map: easeIn → easeInQuad, easeOut → easeOutQuad,
  // easeInOut → easeInOutQuad (smoothstep-ish in the old impl).
  | "easeIn"
  | "easeOut"
  | "easeInOut";

// Bezier handles describe local curve geometry around a scalar keyframe.
// `dx` is in ticks (float — handles aren't tick-quantized), `dy` is in
// the parameter's value units (float). Only meaningful when the
// keyframe's `easingOut` is "customBezier" and the parameter is scalar.
export interface BezierHandles {
  rightHandle: { dx: number; dy: number };
  leftHandle: { dx: number; dy: number };
}

// Normalized cubic-bezier easing — CSS cubic-bezier(x1, y1, x2, y2)
// semantics. Control points are relative to the segment: x a fraction of
// its duration, y a fraction of its value delta. x stays inside [0,1] so
// time is monotonic (the same clamp interpolate() applies to customBezier
// handles); y is unclamped, so a handle above 1 / below 0 overshoots.
// Evaluates as a pure time remap t → t' (cubicBezierEase) and then rides
// whatever interpolation the parameter type uses — which is what makes it
// type-agnostic where `customBezier` (handles in value units) is
// scalar-only. Authored by the Tracks editor's easing overlay
// (specdocs/091726_easing-editor.md); a SavedEasing is one of these plus
// an id and a name.
export interface BezierEasing {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Keyframe {
  tick: number;
  value: unknown;
  easingOut: EasingPreset;
  bezierHandles?: BezierHandles;
  // Read when `easingOut` is "cubicBezier"; a missing shape plays linear.
  bezier?: BezierEasing;
}

export interface KeyframeAnimationBlock {
  // Mirrors the diamond's "animation off / animation on" state. When
  // false, keyframes are preserved on disk but ignored at evaluation.
  animated: boolean;
  // Mirrors the visibility eye — controls whether the param shows as a
  // track in the Track Editor. Independent of `animated`.
  trackVisible: boolean;
  // LEGACY — the old per-row ∿ toggle that opted a track into the Graph
  // Editor. No longer read (the graph follows the keyframe selection in
  // the Tracks/Layers editor); kept so old saves round-trip. Never
  // affected evaluation.
  graphVisible?: boolean;
  keyframes: Keyframe[];
  // Color-only: interpolation color space. Default "oklab".
  colorSpace?: "oklab" | "rgb";
}

export type AnimationMap = Record<string, KeyframeAnimationBlock>;

// Project-wide time metadata. Lives on the graph payload alongside
// nodes/edges. `ticksPerFrame` is locked at 1000 in v1; `fps` and
// `sceneDurationTicks` are user-editable.
export interface ProjectTimeline {
  ticksPerFrame: number;
  fps: number;
  sceneDurationTicks: number;
}

export const DEFAULT_PROJECT_TIMELINE: ProjectTimeline = {
  ticksPerFrame: DEFAULT_TICKS_PER_FRAME,
  fps: DEFAULT_FPS,
  // 5 seconds at 60fps as a reasonable default.
  sceneDurationTicks: 5 * 60 * DEFAULT_TICKS_PER_FRAME,
};

// ---------------------------------------------------------------------
// Tick / frame / second conversions
// ---------------------------------------------------------------------

export function ticksToFrames(tick: number, ticksPerFrame: number): number {
  return tick / ticksPerFrame;
}
export function framesToTicks(frame: number, ticksPerFrame: number): number {
  return Math.round(frame * ticksPerFrame);
}
export function ticksToSeconds(
  tick: number,
  ticksPerFrame: number,
  fps: number
): number {
  return tick / (ticksPerFrame * fps);
}
export function secondsToTicks(
  seconds: number,
  ticksPerFrame: number,
  fps: number
): number {
  return Math.round(seconds * ticksPerFrame * fps);
}
export function snapTickToFrame(tick: number, ticksPerFrame: number): number {
  return Math.round(tick / ticksPerFrame) * ticksPerFrame;
}

// ---------------------------------------------------------------------
// Type gating: which ParamTypes are keyframable
// ---------------------------------------------------------------------
//
// Broader than `paramSocketType` (which restricts wirable types). Booleans
// and enums can be keyframed with step interpolation even though they
// can't be wired in v1.

export function isKeyframable(type: ParamType): boolean {
  switch (type) {
    case "scalar":
    case "vec2":
    case "vec3":
    case "vec4":
    case "color":
    case "boolean":
    case "enum":
    // The whole spline shape keyframes as one value ("Path Animation" on the
    // Spline Draw node) — anchors lerp by index between keyframed states.
    case "spline_anchors":
      return true;
    default:
      return false;
  }
}

// Step-only types: discrete values that can't be smoothly interpolated.
// Easing on these is forced to "hold".
export function isStepOnly(type: ParamType): boolean {
  return type === "boolean" || type === "enum";
}

// ---------------------------------------------------------------------
// Easing curves
// ---------------------------------------------------------------------
//
// Standard cubic-bezier presets. Returns t' in [0,1] from input u in [0,1].

// Standard easing functions, all f: [0,1] -> [0,1] (or slightly outside
// for back/elastic which intentionally overshoot). Sourced from the
// standard easing-functions catalog so behavior matches what motion
// designers expect from "easeOutBack" etc.

const HALF_PI = Math.PI / 2;
const TAU = Math.PI * 2;

export function easeOf(preset: EasingPreset, u: number): number {
  switch (preset) {
    case "linear":
      return u;

    // Sine
    case "easeInSine":
      return 1 - Math.cos(u * HALF_PI);
    case "easeOutSine":
      return Math.sin(u * HALF_PI);
    case "easeInOutSine":
      return -(Math.cos(Math.PI * u) - 1) / 2;

    // Quadratic (legacy easeIn/Out/InOut alias these)
    case "easeIn":
    case "easeInQuad":
      return u * u;
    case "easeOut":
    case "easeOutQuad":
      return 1 - (1 - u) * (1 - u);
    case "easeInOut":
    case "easeInOutQuad":
      return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;

    // Cubic
    case "easeInCubic":
      return u * u * u;
    case "easeOutCubic": {
      const i = 1 - u;
      return 1 - i * i * i;
    }
    case "easeInOutCubic":
      return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;

    // Exponential
    case "easeInExpo":
      return u === 0 ? 0 : Math.pow(2, 10 * u - 10);
    case "easeOutExpo":
      return u === 1 ? 1 : 1 - Math.pow(2, -10 * u);

    // Back (overshoot)
    case "easeInBack": {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return c3 * u * u * u - c1 * u * u;
    }
    case "easeOutBack": {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      const i = u - 1;
      return 1 + c3 * i * i * i + c1 * i * i;
    }

    // Bounce / elastic
    case "easeOutBounce": {
      const n1 = 7.5625;
      const d1 = 2.75;
      if (u < 1 / d1) return n1 * u * u;
      if (u < 2 / d1) {
        const x = u - 1.5 / d1;
        return n1 * x * x + 0.75;
      }
      if (u < 2.5 / d1) {
        const x = u - 2.25 / d1;
        return n1 * x * x + 0.9375;
      }
      const x = u - 2.625 / d1;
      return n1 * x * x + 0.984375;
    }
    case "easeOutElastic": {
      if (u === 0) return 0;
      if (u === 1) return 1;
      const c4 = TAU / 3;
      return Math.pow(2, -10 * u) * Math.sin((u * 10 - 0.75) * c4) + 1;
    }

    case "hold":
      // Caller branches on hold before calling easeOf; this is a safety net.
      return 0;
    case "customBezier":
      // Caller handles custom bezier with explicit handles.
      return u;
    case "cubicBezier":
      // Caller evaluates the keyframe's normalized shape (cubicBezierEase).
      return u;
    default:
      // A preset this build doesn't know (a file from a newer build, a
      // hand-edited name). Linear is the honest fallback — falling off the
      // switch returned undefined and NaN'd the whole segment.
      return u;
  }
}

// All easing presets in display order. Used by the easing picker grid.
export const EASING_PRESET_ORDER: EasingPreset[] = [
  "linear",
  "easeInSine",
  "easeOutSine",
  "easeInOutSine",
  "easeInQuad",
  "easeOutQuad",
  "easeInOutQuad",
  "easeInCubic",
  "easeOutCubic",
  "easeInOutCubic",
  "easeInExpo",
  "easeOutExpo",
  "easeInBack",
  "easeOutBack",
  "easeOutBounce",
  "easeOutElastic",
  "hold",
  "customBezier",
];

export const EASING_PRESET_LABELS: Record<EasingPreset, string> = {
  linear: "Linear",
  easeInSine: "Ease In Sine",
  easeOutSine: "Ease Out Sine",
  easeInOutSine: "Ease In-Out Sine",
  easeInQuad: "Ease In Quad",
  easeOutQuad: "Ease Out Quad",
  easeInOutQuad: "Ease In-Out Quad",
  easeInCubic: "Ease In Cubic",
  easeOutCubic: "Ease Out Cubic",
  easeInOutCubic: "Ease In-Out Cubic",
  easeInExpo: "Ease In Expo",
  easeOutExpo: "Ease Out Expo",
  easeInBack: "Ease In Back",
  easeOutBack: "Ease Out Back",
  easeOutBounce: "Ease Out Bounce",
  easeOutElastic: "Ease Out Elastic",
  hold: "Hold",
  customBezier: "Custom Bezier",
  cubicBezier: "Bezier",
  // Legacy aliases — kept readable for any UI that displays them.
  easeIn: "Ease In",
  easeOut: "Ease Out",
  easeInOut: "Ease In-Out",
};

// A named easing curve the user saved from the Graph Editor, reusable
// across the project (persists on SavedProject.savedEasings). The shape
// is a BezierEasing — control points normalized to the segment, curve from
// (0,0) to (1,1). The Graph Editor applies one by denormalizing it into
// tick/value-unit BezierHandles on a scalar segment; the easing overlay
// writes the same four numbers onto a keyframe as a `cubicBezier`.
export interface SavedEasing extends BezierEasing {
  id: string;
  name: string;
}

// Validate a loaded `savedEasings` payload (untrusted: hand-edited
// files, older/newer builds). Keeps well-formed entries, drops the rest.
export function sanitizeSavedEasings(v: unknown): SavedEasing[] {
  if (!Array.isArray(v)) return [];
  const out: SavedEasing[] = [];
  for (const e of v) {
    if (e == null || typeof e !== "object") continue;
    const { id, name, x1, y1, x2, y2 } = e as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string") continue;
    if (
      ![x1, y1, x2, y2].every(
        (n) => typeof n === "number" && Number.isFinite(n)
      )
    ) {
      continue;
    }
    out.push({
      id,
      name,
      x1: x1 as number,
      y1: y1 as number,
      x2: x2 as number,
      y2: y2 as number,
    });
  }
  return out;
}

let savedEasingSeq = 0;
// Ids for user-saved easings: unique within a session and across saves
// (time-stamped), so the Graph Editor's dropdown and the easing overlay's
// preset tray can key on them while names stay free to change.
export function newSavedEasingId(): string {
  savedEasingSeq += 1;
  return `ease-${Date.now().toString(36)}-${savedEasingSeq}`;
}

// The identity easing as a cubic: handles parked on the diagonal at
// thirds, so they are visible and grabbable (CSS `linear` puts them on the
// anchors — zero-length handles nobody can pick up).
export const LINEAR_BEZIER: BezierEasing = {
  x1: 1 / 3,
  y1: 1 / 3,
  x2: 2 / 3,
  y2: 2 / 3,
};

// Cubic-bezier equivalents for the named presets that have one. The
// power-basis curves (t², 2t−t², t³, 1−(1−t)³) ARE cubics, so with x at
// thirds (x(u) = u) those entries reproduce the preset exactly; the
// in-out pairs are two half-curves and sine isn't polynomial, so those
// are the customary CSS approximations. Expo, back, bounce, elastic and
// hold are not a single cubic and have no entry — callers sample easeOf()
// for them. Seeds the easing editor and draws the Graph Editor's ghost
// handles, so the two agree.
export const EASING_PRESET_BEZIER: Partial<Record<EasingPreset, BezierEasing>> =
  {
    linear: LINEAR_BEZIER,
    easeIn: { x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 1 / 3 },
    easeInQuad: { x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 1 / 3 },
    easeOut: { x1: 1 / 3, y1: 2 / 3, x2: 2 / 3, y2: 1 },
    easeOutQuad: { x1: 1 / 3, y1: 2 / 3, x2: 2 / 3, y2: 1 },
    easeInOut: { x1: 0.455, y1: 0.03, x2: 0.515, y2: 0.955 },
    easeInOutQuad: { x1: 0.455, y1: 0.03, x2: 0.515, y2: 0.955 },
    easeInCubic: { x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 0 },
    easeOutCubic: { x1: 1 / 3, y1: 1, x2: 2 / 3, y2: 1 },
    easeInOutCubic: { x1: 0.645, y1: 0.045, x2: 0.355, y2: 1 },
    easeInSine: { x1: 0.47, y1: 0, x2: 0.745, y2: 0.715 },
    easeOutSine: { x1: 0.39, y1: 0.575, x2: 0.565, y2: 1 },
    easeInOutSine: { x1: 0.445, y1: 0.05, x2: 0.55, y2: 0.95 },
  };

// Evaluate a normalized cubic-bezier easing as a time remap: solve
// x(u) = t for u (x1/x2 clamped into [0,1] keeps the curve monotonic so
// the solution is unique), return y(u). y is not clamped — overshoot is
// the point of a handle outside the unit square.
export function cubicBezierEase(e: BezierEasing, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const u = solveBezierX(clamp01(e.x1), clamp01(e.x2), t);
  const omu = 1 - u;
  return 3 * omu * omu * u * e.y1 + 3 * omu * u * u * e.y2 + u * u * u;
}

// Gate an untrusted shape (a hand-edited file, an MCP payload): four
// finite numbers, x clamped into [0,1], y kept as authored.
export function sanitizeBezierEasing(v: unknown): BezierEasing | null {
  if (v == null || typeof v !== "object") return null;
  const { x1, y1, x2, y2 } = v as Record<string, unknown>;
  if (
    ![x1, y1, x2, y2].every(
      (n) => typeof n === "number" && Number.isFinite(n)
    )
  ) {
    return null;
  }
  return {
    x1: clamp01(x1 as number),
    y1: y1 as number,
    x2: clamp01(x2 as number),
    y2: y2 as number,
  };
}

// The normalized shape of the segment a→b, whatever kind of easing it
// carries: a cubicBezier reads straight back; a scalar customBezier
// normalizes its tick / value-unit handles (missing handles fall back to
// the chord-third defaults the plot draws with; a flat segment normalizes
// dy against 1 raw value unit — a dip on a flat segment has no delta to
// be relative to); a preset with a cubic equivalent returns that table
// entry. null for hold and the presets no single cubic expresses (expo,
// back, bounce, elastic) — callers sample easeOf() to draw those.
export function normalizedBezierOfSegment(
  a: Keyframe,
  b: Keyframe
): BezierEasing | null {
  if (a.easingOut === "cubicBezier") return a.bezier ?? LINEAR_BEZIER;
  if (a.easingOut === "customBezier") {
    const span = b.tick - a.tick;
    if (!(span > 0)) return null;
    if (typeof a.value !== "number" || typeof b.value !== "number") {
      return null;
    }
    const dv = b.value - a.value;
    const vd = Math.abs(dv) > 1e-9 ? dv : 1;
    const defaults = defaultSegmentHandles(a, b);
    const right = a.bezierHandles?.rightHandle ?? defaults.right;
    const left = b.bezierHandles?.leftHandle ?? defaults.left;
    return {
      x1: clamp01(right.dx / span),
      y1: right.dy / vd,
      x2: clamp01(1 + left.dx / span),
      y2: 1 + left.dy / vd,
    };
  }
  return EASING_PRESET_BEZIER[a.easingOut] ?? null;
}

// Denormalize a shape onto the scalar segment a→b: tick/value-unit
// handles for the outgoing key (right) and the incoming key (left) — the
// pair interpolate() reads for a customBezier segment.
export function bezierHandlesForSegment(
  e: BezierEasing,
  a: Keyframe,
  b: Keyframe
): { right: { dx: number; dy: number }; left: { dx: number; dy: number } } {
  const span = b.tick - a.tick;
  const dv = (b.value as number) - (a.value as number);
  return {
    right: { dx: e.x1 * span, dy: e.y1 * dv },
    left: { dx: (e.x2 - 1) * span, dy: (e.y2 - 1) * dv },
  };
}

// Sample an easing function (or `hold`) into an SVG polyline path
// covering the box [0..w, 0..h]. Y is flipped so 0 = bottom, 1 = top.
// Includes a small vertical pad so back/elastic overshoot stays visible.
export function easingPathFor(
  preset: EasingPreset,
  w: number,
  h: number,
  samples = 32
): string {
  const padTop = h * 0.18;
  const padBot = h * 0.18;
  const usableH = h - padTop - padBot;
  const yFor = (v: number) => padTop + (1 - v) * usableH;
  if (preset === "hold") {
    // Two horizontal segments: at y=0 from x=0..w*0.95, then a vertical
    // jump to y=1 at the end.
    return `M 0 ${yFor(0)} L ${w * 0.95} ${yFor(0)} L ${w * 0.95} ${yFor(1)} L ${w} ${yFor(1)}`;
  }
  if (preset === "customBezier" || preset === "cubicBezier") {
    // Diagonal placeholder — the real shape lives on the keyframe.
    return `M 0 ${yFor(0)} L ${w} ${yFor(1)}`;
  }
  let d = "";
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    const v = easeOf(preset, u);
    const x = u * w;
    const y = yFor(v);
    d += i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d;
}

// The same box and vertical pad as easingPathFor, for a normalized cubic
// (a saved easing / cubicBezier shape) — one `C` command, so a tile of a
// user curve draws exactly the curve that plays.
export function bezierPathFor(e: BezierEasing, w: number, h: number): string {
  const padTop = h * 0.18;
  const padBot = h * 0.18;
  const usableH = h - padTop - padBot;
  const yFor = (v: number) => padTop + (1 - v) * usableH;
  const f = (n: number) => n.toFixed(2);
  return `M 0 ${f(yFor(0))} C ${f(e.x1 * w)} ${f(yFor(e.y1))} ${f(e.x2 * w)} ${f(yFor(e.y2))} ${f(w)} ${f(yFor(1))}`;
}

// ---------------------------------------------------------------------
// Color interpolation (OKLab default)
// ---------------------------------------------------------------------

type RGBA = [number, number, number, number];

// sRGB ↔ OKLab live in color-space.ts (shared with the ramp sampler).

// Color keyframe values arrive in two forms: 0..1 RGBA tuples (gradient
// point / ramp stop virtual keys seed tuples) and hex strings (literal
// color params keyframe their stored value verbatim). Interpolation math
// needs tuples, so coerce here — a hex string parses to [r,g,b,a] with
// the alpha from an 8-digit `#rrggbbaa` (6-digit ⇒ 1). Alpha-in is
// unconditional (tuples are engine-internal); whether it survives back
// into the param's hex is the flag-gated colorValueToHex's call.
function toRgbaTuple(v: unknown): RGBA {
  if (Array.isArray(v) && v.length >= 3) {
    return [
      typeof v[0] === "number" ? v[0] : 0,
      typeof v[1] === "number" ? v[1] : 0,
      typeof v[2] === "number" ? v[2] : 0,
      typeof v[3] === "number" ? v[3] : 1,
    ];
  }
  if (typeof v === "string") {
    let h = v.replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h.slice(0, 6) || "0", 16);
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [
      ((n >> 16) & 0xff) / 255,
      ((n >> 8) & 0xff) / 255,
      (n & 0xff) / 255,
      Number.isFinite(a) ? a : 1,
    ];
  }
  return [0, 0, 0, 1];
}

function lerpRgba(a: RGBA, b: RGBA, t: number): RGBA {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    a[3] + (b[3] - a[3]) * t,
  ];
}

function lerpRgbaOklab(a: RGBA, b: RGBA, t: number): RGBA {
  const A = rgbToOklab(a[0], a[1], a[2]);
  const B = rgbToOklab(b[0], b[1], b[2]);
  const L = A[0] + (B[0] - A[0]) * t;
  const aa = A[1] + (B[1] - A[1]) * t;
  const bb = A[2] + (B[2] - A[2]) * t;
  const [r, g, bch] = oklabToRgb(L, aa, bb);
  const alpha = a[3] + (b[3] - a[3]) * t;
  return [r, g, bch, alpha];
}

// ---------------------------------------------------------------------
// Value interpolation
// ---------------------------------------------------------------------

function lerpScalar(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function lerpArray(a: number[], b: number[], t: number): number[] {
  const n = Math.min(a.length, b.length);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

// --- spline shape interpolation (Spline Draw "Path Animation") -------------
//
// The keyframe value is the node's stored spline `{ subpaths }`. We morph
// anchor-by-anchor by index: positions and bezier handle offsets lerp. A
// missing handle is treated as a zero-length one so a handle can smoothly
// grow/retract across keyframes. Counts are expected to match (the author
// keyframes, edits point *positions*, keyframes again); on a mismatch we
// morph the common prefix and keep the "from" anchor for the remainder
// rather than throwing. Topology flags (closed) snap to the "from" state.

type SplineKfValue = { subpaths: SplineSubpath[] };
type Handle = [number, number] | undefined;

function lerpHandle(a: Handle, b: Handle, t: number): Handle {
  if (!a && !b) return undefined;
  const ax = a?.[0] ?? 0;
  const ay = a?.[1] ?? 0;
  const bx = b?.[0] ?? 0;
  const by = b?.[1] ?? 0;
  return [ax + (bx - ax) * t, ay + (by - ay) * t];
}

// Live-corner radius (SplineAnchor.cornerRadius) lerps like a handle: a
// missing radius is a zero one, so a corner can smoothly round/sharpen
// across keyframes. Both-missing stays undefined (no field minted).
function lerpCornerRadius(
  a: number | undefined,
  b: number | undefined,
  t: number
): number | undefined {
  if (a == null && b == null) return undefined;
  const av = a ?? 0;
  const bv = b ?? 0;
  return av + (bv - av) * t;
}

// Width-profile multiplier (SplineAnchor.width) lerps the same way, except
// a MISSING width means 1 (the neutral multiplier), not 0.
function lerpWidth(
  a: number | undefined,
  b: number | undefined,
  t: number
): number | undefined {
  if (a == null && b == null) return undefined;
  const av = a ?? 1;
  const bv = b ?? 1;
  return av + (bv - av) * t;
}

function lerpSpline(
  a: SplineKfValue,
  b: SplineKfValue,
  t: number
): SplineKfValue {
  const aSubs = a?.subpaths ?? [];
  const bSubs = b?.subpaths ?? [];
  return {
    subpaths: aSubs.map((sa, si) => {
      const sb = bSubs[si];
      if (!sb) return sa;
      const aAnch = sa.anchors ?? [];
      const bAnch = sb.anchors ?? [];
      const anchors = aAnch.map((aa, i) => {
        const ba = bAnch[i];
        if (!ba) return aa;
        return {
          pos: [
            aa.pos[0] + (ba.pos[0] - aa.pos[0]) * t,
            aa.pos[1] + (ba.pos[1] - aa.pos[1]) * t,
          ] as [number, number],
          inHandle: lerpHandle(aa.inHandle, ba.inHandle, t),
          outHandle: lerpHandle(aa.outHandle, ba.outHandle, t),
          broken: aa.broken,
          cornerRadius: lerpCornerRadius(aa.cornerRadius, ba.cornerRadius, t),
          cornerStyle: aa.cornerStyle,
          width: lerpWidth(aa.width, ba.width, t),
        };
      });
      return { ...sa, anchors };
    }),
  };
}

// Default handle geometry for a customBezier segment a→b when a key
// doesn't carry explicit handles: one third of the segment in x and y —
// control points on the chord, i.e. a straight line. Shared by
// evaluation and the Graph Editor's drawing/editing defaults so the
// curve the plot shows is exactly the curve that plays.
export function defaultSegmentHandles(
  a: Keyframe,
  b: Keyframe
): {
  right: { dx: number; dy: number };
  left: { dx: number; dy: number };
} {
  const span = b.tick - a.tick;
  const dv = (b.value as number) - (a.value as number);
  return {
    right: { dx: span * 0.33, dy: dv * 0.33 },
    left: { dx: -span * 0.33, dy: -dv * 0.33 },
  };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Solve u ∈ [0,1] such that bezierX(u) = x for the 1D cubic with control
// points 0, x1, x2, 1. Callers clamp x1/x2 into [0,1], which makes the
// curve monotonic non-decreasing (CSS cubic-bezier semantics), so a
// solution exists and is unique. Newton from a good seed, bisection
// fallback for flat spots.
function solveBezierX(x1: number, x2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bez = (u: number) =>
    3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  const deriv = (u: number) =>
    3 * (1 - u) * (1 - u) * x1 +
    6 * (1 - u) * u * (x2 - x1) +
    3 * u * u * (1 - x2);
  let u = x;
  for (let i = 0; i < 8; i++) {
    const err = bez(u) - x;
    if (Math.abs(err) < 1e-7) return u;
    const d = deriv(u);
    if (d < 1e-6) break;
    u = clamp01(u - err / d);
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 32; i++) {
    u = (lo + hi) / 2;
    if (bez(u) < x) lo = u;
    else hi = u;
  }
  return (lo + hi) / 2;
}

function interpolate(
  paramType: ParamType,
  prev: Keyframe,
  next: Keyframe,
  rawT: number,
  colorSpace: "oklab" | "rgb"
): unknown {
  // Hold easing snaps to prev's value until next.tick (handled before
  // interpolation kicks in; this is the safety net).
  if (prev.easingOut === "hold") return prev.value;

  // Step-only types ignore easing and snap.
  if (isStepOnly(paramType)) return prev.value;

  let t: number;
  if (prev.easingOut === "customBezier" && paramType === "scalar") {
    // Custom bezier on scalars: the full 2D cubic the Graph Editor
    // draws. x comes from the handles' dx (as a fraction of the
    // segment's duration, clamped into [0,1] so time stays monotonic),
    // y from their dy (value units). Solve x(u) = rawT for u, then
    // evaluate y(u). Handles a key doesn't carry fall back to the same
    // chord-third defaults the plot draws with — previously time was
    // parametric (u ≈ rawT) and missing dys read as 0, so horizontal
    // handle edits silently didn't play back.
    const span = next.tick - prev.tick;
    const defaults = defaultSegmentHandles(prev, next);
    const right = prev.bezierHandles?.rightHandle ?? defaults.right;
    const left = next.bezierHandles?.leftHandle ?? defaults.left;
    const x1 = clamp01(span > 0 ? right.dx / span : 0);
    const x2 = clamp01(span > 0 ? 1 + left.dx / span : 1);
    const u = solveBezierX(x1, x2, rawT);
    const y0 = prev.value as number;
    const y3 = next.value as number;
    const y1 = y0 + right.dy;
    const y2 = y3 + left.dy;
    const omu = 1 - u;
    return (
      omu * omu * omu * y0 +
      3 * omu * omu * u * y1 +
      3 * omu * u * u * y2 +
      u * u * u * y3
    );
  }
  // cubicBezier is a time remap, so it applies to every interpolable type
  // below — the normalized shape needs no value units.
  t =
    prev.easingOut === "cubicBezier"
      ? cubicBezierEase(prev.bezier ?? LINEAR_BEZIER, rawT)
      : easeOf(prev.easingOut, rawT);

  switch (paramType) {
    case "scalar":
      return lerpScalar(prev.value as number, next.value as number, t);
    case "vec2":
    case "vec3":
    case "vec4":
      return lerpArray(prev.value as number[], next.value as number[], t);
    case "color": {
      const a = toRgbaTuple(prev.value);
      const b = toRgbaTuple(next.value);
      return colorSpace === "rgb" ? lerpRgba(a, b, t) : lerpRgbaOklab(a, b, t);
    }
    case "spline_anchors":
      return lerpSpline(
        prev.value as SplineKfValue,
        next.value as SplineKfValue,
        t
      );
    default:
      return prev.value;
  }
}

// ---------------------------------------------------------------------
// Public evaluation entry
// ---------------------------------------------------------------------

// Evaluate the animation block at the given absolute tick. Returns
// `undefined` when the block is empty / disabled (caller should fall
// through to the constant value).
export function evaluateKeyframesAt(
  block: KeyframeAnimationBlock,
  paramType: ParamType,
  tick: number
): unknown | undefined {
  if (!block.animated || block.keyframes.length === 0) return undefined;

  const ks = block.keyframes;
  const colorSpace = block.colorSpace ?? "oklab";

  // Clamp before-first / after-last.
  if (tick <= ks[0].tick) return ks[0].value;
  const last = ks[ks.length - 1];
  if (tick >= last.tick) return last.value;

  // Binary search for the segment containing `tick`.
  let lo = 0;
  let hi = ks.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ks[mid].tick <= tick) lo = mid;
    else hi = mid;
  }
  const prev = ks[lo];
  const next = ks[hi];

  if (tick === prev.tick) return prev.value;
  if (tick === next.tick) return next.value;

  // Hold easing: snap to prev until next.
  if (prev.easingOut === "hold") return prev.value;

  const span = next.tick - prev.tick;
  const u = span > 0 ? (tick - prev.tick) / span : 0;
  return interpolate(paramType, prev, next, u, colorSpace);
}

// ---------------------------------------------------------------------
// Mutation helpers (pure — return new arrays; callers wrap in setState)
// ---------------------------------------------------------------------

export function emptyAnimationBlock(): KeyframeAnimationBlock {
  return { animated: false, trackVisible: true, keyframes: [] };
}

// Insert (or update if tick matches) a keyframe. Keeps the list sorted by
// `tick`. Existing easing is preserved on update; new keyframes default to
// the supplied easing (caller supplies the user's preferred default).
export function upsertKeyframe(
  block: KeyframeAnimationBlock,
  tick: number,
  value: unknown,
  defaultEasing: EasingPreset = "easeInOut"
): KeyframeAnimationBlock {
  const ks = block.keyframes;
  const idx = ks.findIndex((k) => k.tick === tick);
  if (idx >= 0) {
    const next = ks.slice();
    next[idx] = { ...next[idx], value };
    return { ...block, keyframes: next };
  }
  // Insert sorted.
  const newKf: Keyframe = { tick, value, easingOut: defaultEasing };
  let insertAt = ks.findIndex((k) => k.tick > tick);
  if (insertAt < 0) insertAt = ks.length;
  const next = [...ks.slice(0, insertAt), newKf, ...ks.slice(insertAt)];
  return { ...block, keyframes: next };
}

export function removeKeyframeAt(
  block: KeyframeAnimationBlock,
  tick: number
): KeyframeAnimationBlock {
  return {
    ...block,
    keyframes: block.keyframes.filter((k) => k.tick !== tick),
  };
}

export function findKeyframeAt(
  block: KeyframeAnimationBlock,
  tick: number
): Keyframe | undefined {
  return block.keyframes.find((k) => k.tick === tick);
}

// Diamond color state: empty / yellow / red. Driven by animation flag and
// whether the playhead is exactly on a keyframe.
export type DiamondState = "empty" | "yellow" | "red";

export function diamondStateFor(
  block: KeyframeAnimationBlock | undefined,
  tick: number
): DiamondState {
  if (!block || !block.animated) return "empty";
  return findKeyframeAt(block, tick) ? "red" : "yellow";
}
