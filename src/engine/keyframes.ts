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

export interface Keyframe {
  tick: number;
  value: unknown;
  easingOut: EasingPreset;
  bezierHandles?: BezierHandles;
}

export interface KeyframeAnimationBlock {
  // Mirrors the diamond's "animation off / animation on" state. When
  // false, keyframes are preserved on disk but ignored at evaluation.
  animated: boolean;
  // Mirrors the visibility eye — controls whether the param shows as a
  // track in the Track Editor. Independent of `animated`.
  trackVisible: boolean;
  // Toggled by the per-row graph icon — controls whether this curve is
  // drawn in the Graph Editor view. Defaults off; user opts in per
  // track. Has no effect on evaluation.
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
  // Legacy aliases — kept readable for any UI that displays them.
  easeIn: "Ease In",
  easeOut: "Ease Out",
  easeInOut: "Ease In-Out",
};

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
  if (preset === "customBezier") {
    // Diagonal placeholder.
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

// ---------------------------------------------------------------------
// Color interpolation (OKLab default)
// ---------------------------------------------------------------------

type RGBA = [number, number, number, number];

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}
function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

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
    // Custom bezier on scalars: build a 1D cubic from prev.value (y0) to
    // next.value (y3) using prev.rightHandle.dy and next.leftHandle.dy as
    // the control-point y offsets. Time is parametric: assume the handles'
    // dx components are small enough that we can treat u≈rawT (approx —
    // exact x→t solve is a future-tightening). Keeps the data contract
    // honest: handles store dy in value units.
    const right = prev.bezierHandles?.rightHandle?.dy ?? 0;
    const left = next.bezierHandles?.leftHandle?.dy ?? 0;
    const y0 = prev.value as number;
    const y3 = next.value as number;
    const y1 = y0 + right;
    const y2 = y3 + left;
    const u = rawT;
    const omu = 1 - u;
    return (
      omu * omu * omu * y0 +
      3 * omu * omu * u * y1 +
      3 * omu * u * u * y2 +
      u * u * u * y3
    );
  }
  t = easeOf(prev.easingOut, rawT);

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
