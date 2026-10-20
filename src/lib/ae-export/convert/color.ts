// After Effects export — color (spec 091926_after-effects-handoff.md §4.3;
// owner decision §11.4).
//
// Toolbox interpolates color keys in OKLab by default; AE interpolates the
// 0–1 RGB values linearly. A hue-changing tween bends badly (red→blue's
// midpoint: OKLab [140,83,162] vs AE [128,0,128]). Per track, three answers:
//
//   expression  an AE expression that OKLab-lerps key(i) → key(i+1) with the
//               segment's own easing — exact, keys stay editable colors,
//               not graph-editable (§11.4: the default on shape / solid colors)
//   dense       linear keys every 1/n of each segment, n the smallest count
//               that keeps AE's RGB lerp within tolerance of the OKLab curve
//               (2/255 by default; §11.4: the default elsewhere)
//   rgb         accept AE's RGB lerp, keep the eases, report the worst ΔE
//
// Colors are emitted as 0–1 RGB floats (alpha rides separately: a fill's
// opacity). `colorSpace: "rgb"` tracks are AE's own math and export natively.
//
// Ramps (color-ramp.ts) export as gradient stops: srgb + linear is AE's own
// gradient, 1:1; every other space / curve is sampled from the engine's
// sampler into as many stops as the tolerance needs.

import {
  evaluateKeyframesAt,
  easeKeyframeOut,
  type Keyframe,
  type KeyframeAnimationBlock,
} from "@/engine/keyframes";
import { linearToOklab, oklabToLinear, rgbToOklab, linearToSrgb, srgbToLinear } from "@/engine/color-space";
import { resolveSpring, springRestTime, SPRING_SETTLE_MARGIN } from "@/engine/spring-easing";
import {
  makeColorRampSampler,
  normalizeRampInterp,
  normalizeRampSpace,
  COLOR_RAMP_MAX_STOPS,
  type ColorRampInterp,
  type ColorRampSpace,
  type ColorRampStop,
} from "@/engine/color-ramp";
import type { AeColorPolicy, AeGradientStops, AeKey, AeProp, AeRGB } from "../types";
import { ticksPerFrameOf, type AeTimebase } from "./time";
import {
  combinedTracksToAe,
  component,
  evaluateAeKeys,
  frameTime,
  spatialTrackToAe,
  type AeKeyContext,
  type AeTrackReport,
} from "./keys";

export type Rgba = [number, number, number, number];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// A keyframe color value (hex or 0–1 tuple) → 0–1 RGBA, keyframes.ts's rule.
export function colorToRgba(v: unknown): Rgba {
  return [component(v, 0), component(v, 1), component(v, 2), component(v, 3)];
}

export function hexToAeRgb(hex: string): AeRGB {
  return [component(hex, 0), component(hex, 1), component(hex, 2)];
}

export function clampRgb(c: readonly number[]): AeRGB {
  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}

// keyframes.ts lerpRgbaOklab, operation for operation (unclamped).
export function oklabLerp(a: Rgba, b: Rgba, t: number): Rgba {
  const A = rgbToOklab(a[0], a[1], a[2]);
  const B = rgbToOklab(b[0], b[1], b[2]);
  const L = A[0] + (B[0] - A[0]) * t;
  const aa = A[1] + (B[1] - A[1]) * t;
  const bb = A[2] + (B[2] - A[2]) * t;
  const lin = oklabToLinear(L, aa, bb);
  return [linearToSrgb(lin[0]), linearToSrgb(lin[1]), linearToSrgb(lin[2]), a[3] + (b[3] - a[3]) * t];
}

export function rgbLerp(a: Rgba, b: Rgba, t: number): Rgba {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

// ΔE_OK × 100: Euclidean OKLab distance on the scale where ~2 is a just-
// noticeable difference.
export function deltaEOK(a: readonly number[], b: readonly number[]): number {
  const A = linearToOklab(srgbToLinear(clamp01(a[0])), srgbToLinear(clamp01(a[1])), srgbToLinear(clamp01(a[2])));
  const B = linearToOklab(srgbToLinear(clamp01(b[0])), srgbToLinear(clamp01(b[1])), srgbToLinear(clamp01(b[2])));
  return 100 * Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

// Toolbox's color at a tick of the track's clock, RGB clamped as
// colorValueToHex clamps it on the way to a node.
export function colorTrackValueAt(block: KeyframeAnimationBlock, tick: number): AeRGB {
  const v = evaluateKeyframesAt(block, "color", tick);
  return clampRgb(colorToRgba(v ?? block.keyframes[0]?.value));
}

function keySeconds(k: Keyframe, ctx: AeTimebase & { offsetTicks?: number }): number {
  return (k.tick + (ctx.offsetTicks ?? 0)) / (ticksPerFrameOf(ctx) * ctx.fps);
}

function hasAlpha(block: KeyframeAnimationBlock): boolean {
  return block.keyframes.some((k) => Math.abs(component(k.value, 3) - 1) > 1e-9);
}

// ---------------------------------------------------------------------------
// Dense keys
// ---------------------------------------------------------------------------

// Smallest n such that n uniform linear-RGB pieces through the curve
// c(u) = clamp(lerp(a, b, ease(u))) stay within `tol255` of it (per channel,
// `samples` + 1 points over the segment — §4.3's measure). null past `max`.
export function colorSegmentsNeeded(
  a: Rgba,
  b: Rgba,
  ease: (u: number) => number,
  tol255: number,
  opts: { space?: "oklab" | "rgb"; max?: number; samples?: number } = {}
): number | null {
  const max = opts.max ?? 64;
  const samples = opts.samples ?? 1000;
  const lerp = opts.space === "rgb" ? rgbLerp : oklabLerp;
  const curve = (u: number) => clampRgb(lerp(a, b, ease(u)));
  const ref: AeRGB[] = [];
  for (let i = 0; i <= samples; i++) ref.push(curve(i / samples));
  const tol = tol255 / 255;
  for (let n = 1; n <= max; n++) {
    const keys: AeRGB[] = [];
    for (let k = 0; k <= n; k++) keys.push(curve(k / n));
    let worst = 0;
    for (let i = 0; i <= samples && worst < tol; i++) {
      const u = i / samples;
      const k = Math.min(n - 1, Math.floor(u * n));
      const w = u * n - k;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(keys[k][c] + (keys[k + 1][c] - keys[k][c]) * w - ref[i][c]));
    }
    if (worst < tol) return n;
  }
  return null;
}

export interface AeColorReport extends AeTrackReport {
  mode: "native" | "expression" | "dense" | "rgb";
  // Worst per-channel deviation from toolbox at frames, 0–255.
  maxError255: number;
  // rgb mode: the worst ΔE_OK×100 between AE's RGB lerp and toolbox's OKLab.
  worstDeltaE?: number;
}

export interface AeColorTrackResult {
  prop: AeProp<AeRGB>;
  // Present when the keys carry alpha (8-digit hex): opacity percent, keyed
  // with the same easing (toolbox lerps alpha with the color's progress).
  alpha?: AeProp<number>;
  report: AeColorReport;
}

// Dense mode: every non-hold segment becomes n uniform linear pieces
// (colorSegmentsNeeded); a segment needing more than `maxSegments` gets a key
// at every frame instead (exact at frames).
export function denseColorTrackToAe(
  block: KeyframeAnimationBlock,
  ctx: AeKeyContext & { tolerance255?: number; maxSegments?: number }
): { prop: AeProp<AeRGB>; perSegment: number[]; report: AeColorReport } {
  const tol255 = ctx.tolerance255 ?? 2;
  const max = ctx.maxSegments ?? 64;
  const ks = block.keyframes;
  const space = block.colorSpace === "rgb" ? "rgb" : "oklab";
  const tpf = ticksPerFrameOf(ctx);
  const keys: AeKey<AeRGB>[] = [];
  const perSegment: number[] = [];
  const at = (k: Keyframe) => clampRgb(colorToRgba(k.value));
  const push = (key: AeKey<AeRGB>) => {
    const last = keys[keys.length - 1];
    if (last && Math.abs(last.t - key.t) < 1e-9) {
      last.v = key.v;
      last.outInterp = key.outInterp;
      return;
    }
    keys.push(key);
  };
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    const ta = keySeconds(a, ctx);
    const tb = keySeconds(b, ctx);
    if (a.easingOut === "hold") {
      push({ t: ta, v: at(a), inInterp: i === 0 ? "hold" : (keys[keys.length - 1]?.outInterp ?? "linear"), outInterp: "hold" });
      perSegment.push(0);
      continue;
    }
    const A = colorToRgba(a.value);
    const B = colorToRgba(b.value);
    const ease = (u: number) => easeKeyframeOut(a, u);
    const n = colorSegmentsNeeded(A, B, ease, tol255, { space, max });
    const lerp = space === "rgb" ? rgbLerp : oklabLerp;
    const inInterp = keys.length ? (keys[keys.length - 1].outInterp === "hold" ? "hold" : "linear") : "linear";
    push({ t: ta, v: at(a), inInterp, outInterp: "linear" });
    if (n !== null) {
      for (let k = 1; k < n; k++) push({ t: ta + ((tb - ta) * k) / n, v: clampRgb(lerp(A, B, ease(k / n))), inInterp: "linear", outInterp: "linear" });
      perSegment.push(n);
    } else {
      // Keys on every frame strictly inside the segment, values from toolbox.
      const off = ctx.offsetTicks ?? 0;
      const f0 = Math.floor((a.tick + off) / tpf) + 1;
      const f1 = Math.ceil((b.tick + off) / tpf) - 1;
      let count = 1;
      for (let f = f0; f <= f1; f++) {
        const t = frameTime(f, ctx);
        if (t <= ta + 1e-9 || t >= tb - 1e-9) continue;
        push({ t, v: colorTrackValueAt(block, f * tpf - off), inInterp: "linear", outInterp: "linear" });
        count++;
      }
      perSegment.push(count);
    }
  }
  const last = ks[ks.length - 1];
  if (ks.length > 1) {
    const prevOut = keys[keys.length - 1]?.outInterp ?? "linear";
    push({ t: keySeconds(last, ctx), v: at(last), inInterp: prevOut === "hold" ? "hold" : "linear", outInterp: prevOut === "hold" ? "hold" : "linear" });
  }
  const prop: AeProp<AeRGB> = keys.length < 2 ? { v: at(ks[0]) } : { keys, dims: 3 };
  const maxError255 = measureColor(prop, block, ctx);
  return {
    prop,
    perSegment,
    report: {
      mode: "dense",
      maxError255,
      maxError: maxError255 / 255,
      dense: [],
      fidelity: maxError255 <= tol255 ? "exact" : "approx",
      notes: [`${keys.length} keys for ${Math.max(0, ks.length - 1)} segment(s) within ${tol255}/255`],
    },
  };
}

// Max per-channel |AE − toolbox| × 255 over every comp frame the track spans.
function measureColor(prop: AeProp<AeRGB>, block: KeyframeAnimationBlock, ctx: AeTimebase & { offsetTicks?: number }, mode: "perDim" | "color" = "perDim"): number {
  const ks = block.keyframes;
  if (ks.length === 0) return 0;
  const tpf = ticksPerFrameOf(ctx);
  const off = ctx.offsetTicks ?? 0;
  const f0 = Math.floor((ks[0].tick + off) / tpf);
  const f1 = Math.ceil((ks[ks.length - 1].tick + off) / tpf);
  let m = 0;
  for (let f = f0; f <= f1; f++) {
    const have = "v" in prop ? prop.v : evaluateAeKeys(prop.keys, frameTime(f, ctx), mode);
    const want = colorTrackValueAt(block, f * tpf - off);
    for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(clamp01(have[c]) - want[c]) * 255);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Expression
// ---------------------------------------------------------------------------

// The per-segment easing the expression replays: linear, hold, a preset by
// name (easeOf's formulas, in the expression), a cubicBezier shape, or a
// spring as [ζ, Ω, rest] (spring-easing.ts springEase, closed form, with the
// rest point solved here — the bisection stays in TypeScript).
export type AeColorEaseSpec = ["l"] | ["h"] | ["p", string] | ["c", number, number, number, number] | ["k", number, number, number];

export function colorEaseSpecs(block: KeyframeAnimationBlock): AeColorEaseSpec[] {
  const ks = block.keyframes;
  const out: AeColorEaseSpec[] = [];
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = ks[i];
    const e = a.easingOut;
    if (e === "hold") out.push(["h"]);
    else if (e === "linear" || e === "customBezier") out.push(["l"]);
    else if (e === "cubicBezier") {
      const z = a.bezier ?? { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 };
      out.push(["c", z.x1, z.y1, z.x2, z.y2]);
    } else if (e === "spring") {
      const { zeta, settle } = resolveSpring(a.spring);
      const rest = springRestTime(zeta);
      out.push(["k", zeta, (SPRING_SETTLE_MARGIN * rest) / settle, rest]);
    } else out.push(["p", e]);
  }
  return out;
}

// The expression body: plain ES5 (works in AE's JavaScript and legacy
// engines alike, though the builder sets javascript-1.0). Reads only
// numKeys, key(i).time / .value and time; its completion value is the color.
// Every constant is color-space.ts's, every formula keyframes.ts's
// (interpolate → easeKeyframeOut → lerpRgbaOklab), so it matches toolbox to
// float noise; check-convert-color runs it under an expression shim.
export function colorExpressionText(specs: AeColorEaseSpec[]): string {
  const table = JSON.stringify(specs);
  return `// toolbox: OKLab color interpolation (spec 091926 §4.3). Keys hold the colors;
// E holds each key segment's easing. Retime or recolor keys freely; a segment
// added in AE beyond E plays linear.
var E = ${table};
function tbxS2L(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function tbxL2S(c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
function tbxLab(c) {
  var r = tbxS2L(c[0]), g = tbxS2L(c[1]), b = tbxS2L(c[2]);
  var l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  var m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  var s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  var l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
          1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
          0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_];
}
function tbxRgb(L, a, b) {
  var l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  var m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  var s_ = L - 0.0894841775 * a - 1.291485548 * b;
  var l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [tbxL2S(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
          tbxL2S(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
          tbxL2S(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}
function tbxC01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function tbxSolveX(x1, x2, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  function bez(u) { return 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u; }
  function der(u) { return 3 * (1 - u) * (1 - u) * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2); }
  var u = x, i, err, d, lo = 0, hi = 1;
  for (i = 0; i < 8; i++) {
    err = bez(u) - x;
    if (Math.abs(err) < 1e-7) return u;
    d = der(u);
    if (d < 1e-6) break;
    u = tbxC01(u - err / d);
  }
  for (i = 0; i < 32; i++) { u = (lo + hi) / 2; if (bez(u) < x) lo = u; else hi = u; }
  return (lo + hi) / 2;
}
function tbxCubic(x1, y1, x2, y2, t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  var u = tbxSolveX(tbxC01(x1), tbxC01(x2), t), o = 1 - u;
  return 3 * o * o * u * y1 + 3 * o * u * u * y2 + u * u * u;
}
function tbxPreset(n, u) {
  var c1, c3, i, x;
  switch (n) {
    case "easeInSine": return 1 - Math.cos(u * (Math.PI / 2));
    case "easeOutSine": return Math.sin(u * (Math.PI / 2));
    case "easeInOutSine": return -(Math.cos(Math.PI * u) - 1) / 2;
    case "easeIn": case "easeInQuad": return u * u;
    case "easeOut": case "easeOutQuad": return 1 - (1 - u) * (1 - u);
    case "easeInOut": case "easeInOutQuad": return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    case "easeInCubic": return u * u * u;
    case "easeOutCubic": i = 1 - u; return 1 - i * i * i;
    case "easeInOutCubic": return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    case "easeInExpo": return u === 0 ? 0 : Math.pow(2, 10 * u - 10);
    case "easeOutExpo": return u === 1 ? 1 : 1 - Math.pow(2, -10 * u);
    case "easeInBack": c1 = 1.70158; c3 = c1 + 1; return c3 * u * u * u - c1 * u * u;
    case "easeOutBack": c1 = 1.70158; c3 = c1 + 1; i = u - 1; return 1 + c3 * i * i * i + c1 * i * i;
    case "easeOutBounce":
      if (u < 1 / 2.75) return 7.5625 * u * u;
      if (u < 2 / 2.75) { x = u - 1.5 / 2.75; return 7.5625 * x * x + 0.75; }
      if (u < 2.5 / 2.75) { x = u - 2.25 / 2.75; return 7.5625 * x * x + 0.9375; }
      x = u - 2.625 / 2.75; return 7.5625 * x * x + 0.984375;
    case "easeOutElastic":
      if (u === 0) return 0;
      if (u === 1) return 1;
      return Math.pow(2, -10 * u) * Math.sin((u * 10 - 0.75) * ((Math.PI * 2) / 3)) + 1;
  }
  return u;
}
function tbxSpring(z, w, rest, u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (u * w >= rest) return 1;
  var x0 = -1, v0 = 0, w1, s1, c1, env;
  if (z < 1) {
    w1 = w * Math.sqrt(1 - z * z);
    s1 = Math.sin(w1 * u);
    c1 = Math.cos(w1 * u);
    env = Math.exp(-z * w * u);
    return 1 + env * (s1 * ((v0 + z * w * x0) / w1) + x0 * c1);
  }
  env = Math.exp(-w * u);
  return 1 + env * (x0 + (v0 + w * x0) * u);
}
function tbxEase(d, u) {
  if (!d) return u;
  if (d[0] === "c") return tbxCubic(d[1], d[2], d[3], d[4], u);
  if (d[0] === "p") return tbxPreset(d[1], u);
  if (d[0] === "k") return tbxSpring(d[1], d[2], d[3], u);
  return u;
}
function tbxColor() {
  var n = numKeys, i;
  if (n < 1) return value;
  if (n < 2 || time <= key(1).time) return key(1).value;
  if (time >= key(n).time) return key(n).value;
  for (i = 1; i < n; i++) if (time < key(i + 1).time) break;
  var A = key(i).value, B = key(i + 1).value, d = E[i - 1];
  if (time === key(i).time) return A;
  if (d && d[0] === "h") return A;
  var s = tbxEase(d, (time - key(i).time) / (key(i + 1).time - key(i).time));
  var a = tbxLab(A), b = tbxLab(B);
  var c = tbxRgb(a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s);
  var al = A.length > 3 ? A[3] + (B[3] - A[3]) * s : 1;
  return [tbxC01(c[0]), tbxC01(c[1]), tbxC01(c[2]), al];
}
tbxColor();
`;
}

// ---------------------------------------------------------------------------
// The track → AE, per policy
// ---------------------------------------------------------------------------

export interface AeColorOptions extends AeKeyContext {
  policy: AeColorPolicy;
  // §11.4 "auto": expression when the track drives a shape / solid color.
  drivesShapeOrSolid?: boolean;
  // Dense tolerance, 0–255 (AeExportPolicy.colorTolerance; default 2).
  tolerance255?: number;
  maxSegments?: number;
}

// Native RGB keys (AE's own interpolation) with toolbox's easing, verified
// against an RGB-lerp oracle — exact for `colorSpace: "rgb"` tracks, the
// accept-RGB approximation for OKLab ones.
function rgbKeys(block: KeyframeAnimationBlock, ctx: AeKeyContext): { prop: AeProp<AeRGB>; report: AeTrackReport } {
  const asRgb: KeyframeAnimationBlock = { ...block, colorSpace: "rgb" };
  const parts = [0, 1, 2].map((d) => ({ src: asRgb, paramType: "color" as const, dim: d }));
  const r = spatialTrackToAe(parts, { ...ctx }, "color");
  if (!r) throw new Error("rgbKeys: a color track cannot fail the one-ease builder");
  const prop: AeProp<AeRGB> =
    "v" in r.prop ? { v: clampRgb(r.prop.v) } : { keys: r.prop.keys.map((k) => ({ ...k, v: clampRgb(k.v) })), dims: 3 };
  return { prop, report: r.report };
}

function alphaTrack(block: KeyframeAnimationBlock, ctx: AeKeyContext): AeProp<number> | undefined {
  if (!hasAlpha(block)) return undefined;
  const r = combinedTracksToAe([{ src: block, paramType: "color", dim: 3 }], { ...ctx, map: { scale: 100, offset: 0 } }, true);
  return r.prop as AeProp<number>;
}

export function colorTrackToAe(block: KeyframeAnimationBlock, opts: AeColorOptions): AeColorTrackResult {
  const ks = block.keyframes;
  if (!block.animated || ks.length === 0) throw new Error("colorTrackToAe: empty track");
  const alpha = alphaTrack(block, opts);
  if (ks.length === 1) {
    return {
      prop: { v: clampRgb(colorToRgba(ks[0].value)) },
      alpha,
      report: { mode: "native", maxError255: 0, maxError: 0, dense: [], fidelity: "exact", notes: [] },
    };
  }
  if (block.colorSpace === "rgb") {
    const r = rgbKeys(block, opts);
    const e = measureColor(r.prop, block, opts, "color");
    return { prop: r.prop, alpha, report: { ...r.report, mode: "native", maxError255: e, notes: [...r.report.notes, "RGB track: AE's own interpolation (one-ease color speed units unverified)"] } };
  }
  const policy = opts.policy === "auto" ? (opts.drivesShapeOrSolid ? "expression" : "dense") : opts.policy;
  if (policy === "dense") {
    const d = denseColorTrackToAe(block, opts);
    return { prop: d.prop, alpha, report: d.report };
  }
  if (policy === "expression") {
    const specs = colorEaseSpecs(block);
    const keys: AeKey<AeRGB>[] = ks.map((k, i) => {
      const prevHold = i > 0 && ks[i - 1].easingOut === "hold";
      const hold = i < ks.length - 1 && k.easingOut === "hold";
      return { t: keySeconds(k, opts), v: clampRgb(colorToRgba(k.value)), inInterp: prevHold ? "hold" : "linear", outInterp: hold ? "hold" : "linear" };
    });
    return {
      prop: { keys, dims: 3, expression: colorExpressionText(specs) },
      alpha,
      report: {
        mode: "expression",
        maxError255: 0,
        maxError: 0,
        dense: [],
        fidelity: "exact",
        notes: ["OKLab expression on linear RGB keys (the keys alone play AE's RGB lerp if the expression is disabled)"],
      },
    };
  }
  // Accept RGB: AE's lerp, toolbox's easing; report how far it lands.
  const r = rgbKeys(block, opts);
  const tpf = ticksPerFrameOf(opts);
  const off = opts.offsetTicks ?? 0;
  let worst = 0;
  let worst255 = 0;
  const f0 = Math.floor((ks[0].tick + off) / tpf);
  const f1 = Math.ceil((ks[ks.length - 1].tick + off) / tpf);
  for (let f = f0; f <= f1; f++) {
    const have = "v" in r.prop ? r.prop.v : evaluateAeKeys(r.prop.keys, frameTime(f, opts), "color");
    const want = colorTrackValueAt(block, f * tpf - off);
    worst = Math.max(worst, deltaEOK(have, want));
    for (let c = 0; c < 3; c++) worst255 = Math.max(worst255, Math.abs(clamp01(have[c]) - want[c]) * 255);
  }
  return {
    prop: r.prop,
    alpha,
    report: {
      ...r.report,
      mode: "rgb",
      maxError255: worst255,
      worstDeltaE: worst,
      fidelity: worst255 <= (opts.tolerance255 ?? 2) ? "exact" : "approx",
      notes: [...r.report.notes, `RGB interpolation instead of OKLab: worst ΔE_OK ${worst.toFixed(2)}, ${worst255.toFixed(1)}/255`],
    },
  };
}

// ---------------------------------------------------------------------------
// Ramps → gradient stops
// ---------------------------------------------------------------------------

// AE's gradient between stops: linear in the (gamma) RGB values, midpoints at
// 50%, end colors held outside the outer stops — the assumption is a
// non-linearized sRGB working space (the scene's project settings say so).
// Coincident offsets make a hard edge (the later stop wins from there on).
export function evaluateAeGradient(stops: AeGradientStops, t: number): Rgba {
  const col = lerpStops(
    stops.colors.map((s) => ({ o: s.offset, v: s.color as number[] })),
    t
  );
  const op = lerpStops(
    stops.opacities.map((s) => ({ o: s.offset, v: [s.opacity] })),
    t
  );
  return [col[0], col[1], col[2], op[0] ?? 1];
}

function lerpStops(s: { o: number; v: number[] }[], t: number): number[] {
  if (s.length === 0) return [0, 0, 0];
  if (t <= s[0].o) return s[0].v;
  for (let i = 0; i + 1 < s.length; i++) {
    const a = s[i];
    const b = s[i + 1];
    if (t < b.o || (i + 2 === s.length && t <= b.o)) {
      const span = b.o - a.o;
      if (!(span > 0)) return b.v;
      const w = (t - a.o) / span;
      return a.v.map((x, k) => x + (b.v[k] - x) * w);
    }
  }
  return s[s.length - 1].v;
}

export interface AeRampResult {
  stops: AeGradientStops;
  // Worst per-channel |AE gradient − toolbox ramp| over the ramp, 0–255
  // (alpha counted on the same scale).
  maxError255: number;
  // srgb + linear (or constant): AE's gradient is the ramp itself.
  exact: boolean;
}

// A color ramp → AE gradient stops within `tolerance255`. The breakpoints
// start at the ramp's own stops; the interval with the worst error is split
// at its midpoint until every interval fits or `maxStops` is reached.
// `offset` (the ramp's phase) is not handled: pass a ramp with offset 0.
export function rampToAeStops(
  stops: ColorRampStop[],
  opts: { interp?: ColorRampInterp | string; space?: ColorRampSpace | string; tolerance255?: number; maxStops?: number; samples?: number } = {}
): AeRampResult {
  const interp = normalizeRampInterp(opts.interp);
  const space = normalizeRampSpace(opts.space);
  const tol = opts.tolerance255 ?? 1;
  const maxStops = opts.maxStops ?? 128;
  const sampler = makeColorRampSampler(stops, { interp, space });
  const sorted = (Array.isArray(stops) ? stops : [])
    .filter((s) => s && typeof s.position === "number")
    .sort((a, b) => a.position - b.position)
    .slice(0, COLOR_RAMP_MAX_STOPS);
  const toStops = (ts: number[]): AeGradientStops => {
    const colors: AeGradientStops["colors"] = [];
    const opacities: AeGradientStops["opacities"] = [];
    ts.forEach((t) => {
      const c = sampler(t);
      colors.push({ offset: clamp01(t), color: clampRgb(c) });
      opacities.push({ offset: clamp01(t), opacity: clamp01(c[3]) });
    });
    return { colors, opacities };
  };
  const measure = (g: AeGradientStops, n = opts.samples ?? 2048): number => {
    let m = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const have = evaluateAeGradient(g, t);
      const want = sampler(t);
      for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(have[c] - want[c]) * 255);
    }
    return m;
  };
  if (sorted.length === 0) {
    const g = { colors: [{ offset: 0, color: [0, 0, 0] as AeRGB }, { offset: 1, color: [1, 1, 1] as AeRGB }], opacities: [{ offset: 0, opacity: 1 }, { offset: 1, opacity: 1 }] };
    return { stops: g, maxError255: measure(g), exact: true };
  }
  const positions = sorted.map((s) => clamp01(s.position));
  if (interp === "constant") {
    // Hard steps: stop i's color from p_i up to p_{i+1}, where it switches.
    const colors: AeGradientStops["colors"] = [];
    const opacities: AeGradientStops["opacities"] = [];
    // Stop i's color as the sampler plays it inside its own interval (at a
    // stop's exact position the sampler still returns the previous color).
    const inside = (i: number) => sampler(i + 1 < positions.length ? (positions[i] + positions[i + 1]) / 2 : positions[i]);
    const col = (i: number) => clampRgb(inside(i));
    const alp = (i: number) => clamp01(inside(i)[3]);
    colors.push({ offset: positions[0], color: col(0) });
    opacities.push({ offset: positions[0], opacity: alp(0) });
    for (let i = 1; i < positions.length; i++) {
      colors.push({ offset: positions[i], color: col(i - 1) }, { offset: positions[i], color: col(i) });
      opacities.push({ offset: positions[i], opacity: alp(i - 1) }, { offset: positions[i], opacity: alp(i) });
    }
    const g = { colors, opacities };
    return { stops: g, maxError255: measure(g), exact: true };
  }
  if (space === "srgb" && interp === "linear") {
    const g = toStops(positions);
    return { stops: g, maxError255: measure(g), exact: true };
  }
  // Adaptive: within each interval between the ramp's own stops (where its
  // curve may kink), place stops greedily — each chord reaches as far as it
  // can while AE's straight blend stays within tolerance (binary search on its
  // end; checked at 48 points along the chord).
  const chordError = (a: number, b: number): number => {
    const ca = sampler(a);
    const cb = sampler(b);
    let m = 0;
    for (let i = 1; i < 48; i++) {
      const w = i / 48;
      const want = sampler(a + (b - a) * w);
      for (let ch = 0; ch < 4; ch++) m = Math.max(m, Math.abs(clamp01(ca[ch]) + (clamp01(cb[ch]) - clamp01(ca[ch])) * w - want[ch]) * 255);
    }
    return m;
  };
  const budget = tol * 0.9;
  const ts: number[] = [positions[0]];
  for (let i = 0; i + 1 < positions.length; i++) {
    const end = positions[i + 1];
    let from = positions[i];
    while (end - from > 1e-9 && ts.length < maxStops) {
      if (chordError(from, end) <= budget) break;
      let lo = from;
      let hi = end;
      for (let it = 0; it < 30; it++) {
        const mid = (lo + hi) / 2;
        if (chordError(from, mid) <= budget) lo = mid;
        else hi = mid;
      }
      from = lo > from + 1e-9 ? lo : (from + end) / 2;
      ts.push(from);
    }
    if (end > ts[ts.length - 1] + 1e-12) ts.push(end);
  }
  // Fix-up at fine resolution: OKLCH's gamut mapping can put a sharp feature
  // between a chord's check points. Split every failing interval at its worst
  // sample until all fit (or the stop budget runs out).
  for (let pass = 0; pass < 32 && ts.length < maxStops; pass++) {
    const inserts: number[] = [];
    for (let i = 0; i + 1 < ts.length; i++) {
      const a = ts[i];
      const b = ts[i + 1];
      if (!(b - a > 1e-6)) continue;
      const n = Math.ceil((b - a) * 8192) + 8;
      const ca = sampler(a);
      const cb = sampler(b);
      let worst = 0;
      let at = -1;
      for (let j = 1; j < n; j++) {
        const w = j / n;
        const want = sampler(a + (b - a) * w);
        for (let ch = 0; ch < 4; ch++) {
          const e = Math.abs(clamp01(ca[ch]) + (clamp01(cb[ch]) - clamp01(ca[ch])) * w - want[ch]) * 255;
          if (e > worst) {
            worst = e;
            at = a + (b - a) * w;
          }
        }
      }
      if (worst > tol && at > a && at < b) inserts.push(at);
    }
    if (inserts.length === 0) break;
    for (const t of inserts) {
      if (ts.length >= maxStops) break;
      let j = 0;
      while (j < ts.length && ts[j] < t) j++;
      ts.splice(j, 0, t);
    }
  }
  const g = toStops(ts);
  return { stops: g, maxError255: measure(g), exact: false };
}
