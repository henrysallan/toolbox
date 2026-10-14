// toolbox-timeline — the keyframe evaluator, as Reanimated worklets.
//
// Shipped VERBATIM into every React Native Skia export (specdocs/
// 101326_skia-target.md) and imported by toolbox's own gate, which asserts
// it returns the same doubles as src/engine/keyframes.ts
// (evaluateKeyframesAt) for every easing, both color spaces, and the
// Color node's 8-bit hex round trip. Do not import anything here: the file
// must run unchanged on the Reanimated UI runtime, in a browser, and in
// Node. Every function carries the "worklet" directive so the worklets
// Babel plugin can move it to the UI thread; elsewhere it is a no-op
// string.
//
// Time is in toolbox ticks (ticksPerFrame per frame). A device clock in
// seconds converts with ticksAt(); frame-aligned times land on exact ticks
// so hold keys and segment boundaries resolve exactly as in the editor.

export type TimelineEasing = string;

export interface TimelineBezier {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// `spring` keys (toolbox's Keyframe.spring, engine/spring-easing.ts):
// Reanimated 4.7's withSpring from rest, normalised to the segment.
export interface TimelineSpring {
  // Reanimated's dampingRatio: < 1 bounces, ≥ 1 runs its critically damped
  // branch. Clamped into [0.01, 10]; junk plays 0.5.
  dampingRatio: number;
  // Fraction of the segment where the spring rests (default 1); Reanimated's
  // energy snap lands at settle / 1.01. Clamped into [0.05, 1].
  settle?: number;
  // springRestTime(dampingRatio), precomputed by the exporter so the device
  // skips the solve. Optional — the runtime solves it when absent.
  rest?: number;
}

export interface TimelineKey {
  tick: number;
  // Scalar value, or straight-alpha sRGB [r, g, b, a] in 0..1.
  value: number | number[];
  // The segment AFTER this key (toolbox's easingOut).
  easing: TimelineEasing;
  // `cubicBezier` keys: the normalized CSS-style shape.
  bezier?: TimelineBezier;
  // `spring` keys: the spring's params.
  spring?: TimelineSpring;
  // `customBezier` scalar keys: value-unit handles (dx in ticks).
  right?: { dx: number; dy: number };
  left?: { dx: number; dy: number };
}

export interface TimelineTrack {
  kind: "scalar" | "color";
  // Color interpolation space (toolbox default oklab).
  colorSpace?: "oklab" | "rgb";
  // Color tracks that reach the shader through a Color node pass a hex
  // string in between, so each sample snaps to 8 bits per channel and
  // takes the node's own alpha.
  quantize8?: boolean;
  alpha?: number;
  // Expression-channel color tracks (`ch:<name>` keyframes on the SkSL node
  // itself) reach the shader through the channel row's hex, alpha byte
  // included: with quantize8, alpha interpolates with the color and snaps
  // to 8 bits too, and `alpha` is ignored.
  quantizeAlpha?: boolean;
  // Scalar tracks whose IR value is the param × scale (BindRef.scale — a
  // degrees param feeding a radians prop). Applied after evaluation, the
  // same `value * scale` the producer computes.
  scale?: number;
  keys: TimelineKey[];
}

export function ticksAt(seconds: number, fps: number, ticksPerFrame: number): number {
  "worklet";
  const tick = seconds * fps * ticksPerFrame;
  const r = Math.round(tick);
  return Math.abs(tick - r) < 1e-6 ? r : tick;
}

function clamp01(x: number): number {
  "worklet";
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// ---- spring: Reanimated 4.7's withSpring from rest (x0 = −1, v0 = 0,
// toValue = 1), timed in segment units — springUtils.ts's under-damped /
// critically damped solutions with their operation order, and its energy
// snap. Twin of engine/spring-easing.ts (gate: check-spring-easing).

export function springState(zeta: number, omega0: number, t: number): { position: number; velocity: number } {
  "worklet";
  const x0 = -1;
  const v0 = 0;
  const toValue = 1;
  if (zeta < 1) {
    const omega1 = omega0 * Math.sqrt(1 - zeta ** 2);
    const sin1 = Math.sin(omega1 * t);
    const cos1 = Math.cos(omega1 * t);
    const underDampedEnvelope = Math.exp(-zeta * omega0 * t);
    const underDampedFrag1 = underDampedEnvelope * (sin1 * ((v0 + zeta * omega0 * x0) / omega1) + x0 * cos1);
    return {
      position: toValue + underDampedFrag1,
      velocity: -zeta * omega0 * underDampedFrag1 + underDampedEnvelope * (cos1 * (v0 + zeta * omega0 * x0) - omega1 * x0 * sin1),
    };
  }
  const criticallyDampedEnvelope = Math.exp(-omega0 * t);
  return {
    position: toValue + criticallyDampedEnvelope * (x0 + (v0 + omega0 * x0) * t),
    velocity:
      criticallyDampedEnvelope * -omega0 * (x0 + (v0 + omega0 * x0) * t) + criticallyDampedEnvelope * (v0 + omega0 * x0),
  };
}

// Reanimated's currentEnergy / initialEnergy at dimensionless time s.
function springEnergyFraction(zeta: number, s: number): number {
  "worklet";
  const st = springState(zeta, 1, s);
  const d = 1 - st.position;
  const currentEnergy = 0.5 * d ** 2 + 0.5 * st.velocity ** 2;
  return currentEnergy / 0.5;
}

// First dimensionless time (ω0·t) at which Reanimated's energy test
// (≤ 6e-9, withSpring's default energyThreshold) passes.
export function springRestTime(zeta: number): number {
  "worklet";
  const threshold = 6e-9;
  let hi = 1;
  for (let i = 0; i < 64 && !(springEnergyFraction(zeta, hi) <= threshold); i++) hi *= 2;
  let lo = 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    if (springEnergyFraction(zeta, mid) <= threshold) hi = mid;
    else lo = mid;
  }
  return hi;
}

// Progress at u ∈ [0,1]: exactly 0 / 1 at the ends and from the snap on.
export function springEase(spring: TimelineSpring | undefined, u: number): number {
  "worklet";
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const z = spring ? spring.dampingRatio : undefined;
  const s = spring ? spring.settle : undefined;
  const zeta = typeof z === "number" && Number.isFinite(z) && z > 0 ? (z < 0.01 ? 0.01 : z > 10 ? 10 : z) : 0.5;
  const settle = typeof s === "number" && Number.isFinite(s) && s > 0 ? (s < 0.05 ? 0.05 : s > 1 ? 1 : s) : 1;
  const rest = spring && typeof spring.rest === "number" ? spring.rest : springRestTime(zeta);
  const omega = (1.01 * rest) / settle;
  if (u * omega >= rest) return 1;
  return springState(zeta, omega, u).position;
}

export function easeOf(preset: string, u: number): number {
  "worklet";
  const HALF_PI = Math.PI / 2;
  switch (preset) {
    case "linear":
      return u;
    case "easeInSine":
      return 1 - Math.cos(u * HALF_PI);
    case "easeOutSine":
      return Math.sin(u * HALF_PI);
    case "easeInOutSine":
      return -(Math.cos(Math.PI * u) - 1) / 2;
    case "easeIn":
    case "easeInQuad":
      return u * u;
    case "easeOut":
    case "easeOutQuad":
      return 1 - (1 - u) * (1 - u);
    case "easeInOut":
    case "easeInOutQuad":
      return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    case "easeInCubic":
      return u * u * u;
    case "easeOutCubic": {
      const i = 1 - u;
      return 1 - i * i * i;
    }
    case "easeInOutCubic":
      return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    case "easeInExpo":
      return u === 0 ? 0 : Math.pow(2, 10 * u - 10);
    case "easeOutExpo":
      return u === 1 ? 1 : 1 - Math.pow(2, -10 * u);
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
      const c4 = (Math.PI * 2) / 3;
      return Math.pow(2, -10 * u) * Math.sin((u * 10 - 0.75) * c4) + 1;
    }
    case "spring":
      return springEase(undefined, u);
    case "hold":
      return 0;
    default:
      return u;
  }
}

function solveBezierX(x1: number, x2: number, x: number): number {
  "worklet";
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let u = x;
  for (let i = 0; i < 8; i++) {
    const bez = 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
    const err = bez - x;
    if (Math.abs(err) < 1e-7) return u;
    const d =
      3 * (1 - u) * (1 - u) * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2);
    if (d < 1e-6) break;
    u = clamp01(u - err / d);
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 32; i++) {
    u = (lo + hi) / 2;
    const bez = 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
    if (bez < x) lo = u;
    else hi = u;
  }
  return (lo + hi) / 2;
}

export function cubicBezierEase(e: TimelineBezier, t: number): number {
  "worklet";
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const u = solveBezierX(clamp01(e.x1), clamp01(e.x2), t);
  const omu = 1 - u;
  return 3 * omu * omu * u * e.y1 + 3 * omu * u * u * e.y2 + u * u * u;
}

function srgbToLinear(c: number): number {
  "worklet";
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  "worklet";
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function rgbToOklab(r0: number, g0: number, b0: number): number[] {
  "worklet";
  const r = srgbToLinear(r0);
  const g = srgbToLinear(g0);
  const b = srgbToLinear(b0);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

function oklabToRgb(L: number, a: number, b: number): number[] {
  "worklet";
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

function lerpColor(a: number[], b: number[], t: number, space: "oklab" | "rgb"): number[] {
  "worklet";
  if (space === "rgb") {
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
      a[3] + (b[3] - a[3]) * t,
    ];
  }
  const A = rgbToOklab(a[0], a[1], a[2]);
  const B = rgbToOklab(b[0], b[1], b[2]);
  const rgb = oklabToRgb(
    A[0] + (B[0] - A[0]) * t,
    A[1] + (B[1] - A[1]) * t,
    A[2] + (B[2] - A[2]) * t
  );
  return [rgb[0], rgb[1], rgb[2], a[3] + (b[3] - a[3]) * t];
}

function interpolate(track: TimelineTrack, prev: TimelineKey, next: TimelineKey, rawT: number) {
  "worklet";
  if (prev.easing === "hold") return prev.value;
  if (prev.easing === "customBezier" && track.kind === "scalar") {
    const span = next.tick - prev.tick;
    const y0 = prev.value as number;
    const y3 = next.value as number;
    const dv = y3 - y0;
    const right = prev.right ?? { dx: span * 0.33, dy: dv * 0.33 };
    const left = next.left ?? { dx: -span * 0.33, dy: -dv * 0.33 };
    const x1 = clamp01(span > 0 ? right.dx / span : 0);
    const x2 = clamp01(span > 0 ? 1 + left.dx / span : 1);
    const u = solveBezierX(x1, x2, rawT);
    const y1 = y0 + right.dy;
    const y2 = y3 + left.dy;
    const omu = 1 - u;
    return omu * omu * omu * y0 + 3 * omu * omu * u * y1 + 3 * omu * u * u * y2 + u * u * u * y3;
  }
  const t =
    prev.easing === "cubicBezier"
      ? cubicBezierEase(prev.bezier ?? { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 }, rawT)
      : prev.easing === "spring"
        ? springEase(prev.spring, rawT)
        : easeOf(prev.easing, rawT);
  if (track.kind === "color") {
    return lerpColor(prev.value as number[], next.value as number[], t, track.colorSpace ?? "oklab");
  }
  const a = prev.value as number;
  return a + ((next.value as number) - a) * t;
}

// evaluateKeyframesAt, minus the param-type dispatch the export does not
// need: clamp before the first / after the last key, exact hits return the
// key's own value, hold snaps.
export function evaluateTrackRaw(track: TimelineTrack, tick: number): number | number[] {
  "worklet";
  const ks = track.keys;
  if (tick <= ks[0].tick) return ks[0].value;
  const last = ks[ks.length - 1];
  if (tick >= last.tick) return last.value;
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
  if (prev.easing === "hold") return prev.value;
  const span = next.tick - prev.tick;
  const u = span > 0 ? (tick - prev.tick) / span : 0;
  return interpolate(track, prev, next, u);
}

// What the shader uniform receives: scalars as-is; colors through the
// Color node's (or the channel row's) hex round trip when the track says so.
export function evaluateTrack(track: TimelineTrack, tick: number): number | number[] {
  "worklet";
  const v = evaluateTrackRaw(track, tick);
  if (track.kind === "scalar" && track.scale !== undefined) return (v as number) * track.scale;
  if (track.kind !== "color" || !track.quantize8) return v;
  const c = v as number[];
  const q = (x: number) => {
    "worklet";
    return Math.max(0, Math.min(255, Math.round(x * 255))) / 255;
  };
  return [q(c[0]), q(c[1]), q(c[2]), track.quantizeAlpha ? q(c[3]) : (track.alpha ?? 1)];
}
