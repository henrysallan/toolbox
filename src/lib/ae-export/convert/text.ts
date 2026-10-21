// Text animators → After Effects text selectors (spec 091926 §4.7; measured
// in specdocs/ae-m4/text.md). Pure.
//
// Toolbox (src/engine/text-animators.ts) drives unit i (a character, spaces
// included, or a word) of N with t' = ease(t):
//
//   uniform   t = clamp01(a)
//   cascade   t = clamp01((a − pos_i·(1 − w)) / w),  w = softness,
//             pos_i = f | 1 − f | |2f − 1| | 1 − |2f − 1| | hash(seed + i·φ)
//             (forward / backward / center / edges / random), f = i/(N − 1)
//
// and the property is lerp(min, max, t'). AE selects each unit with a Range
// Selector, measured in AE 26.5 to be exactly lottie-web's model
// (aeRangeSelection: a ramp sampled at the unit centre i + ½ between Start
// and End (+ Offset), Ease High / Low a cubic bezier applied to the clamped
// ramp; percent Start / End / Offset are limited to ±100 %, index units to
// ±99999), or an Expression Selector, whose value per unit is any expression
// of textIndex / textTotal (clamped to ±100 %).
//
// A linear cascade is a ramp in the unit index, so it IS a Range Selector:
// forward / backward one Ramp, center / edges two Ramps combined by Min /
// Max, Start / End in index units and the Offset linear in the amount (so
// toolbox's amount keys become Offset keys). A per-unit easing becomes Ease
// High / Low when the best fit is within tolerance (smoothstep exactly);
// otherwise, and for `random` (AE's Randomize Order permutes the units,
// toolbox hashes each to an independent position), the cascade is an
// Expression Selector that replays toolbox's formula — its own Amount
// carries the amount keys, read back as `value`.

import { applyEasingOrCurve, CUSTOM_EASING, EASINGS } from "@/engine/easing";
import type { AeProp, AeTextAnimator, AeTextSelector } from "../types";
import { evaluateAeProp } from "./keys";

export type AeTextSelectorShape = "square" | "ramp-up" | "ramp-down" | "triangle" | "round" | "smooth";
export type AeTextSelectorMode = "add" | "subtract" | "intersect" | "min" | "max" | "difference";
export type TextCascadeDirection = "forward" | "backward" | "center" | "edges" | "random";

// ---------------------------------------------------------------------------
// AE's Range Selector (lottie-web TextSelectorProp.getMult; measured ≡ AE)
// ---------------------------------------------------------------------------

export interface AeRangeModel {
  units: "percentage" | "index";
  start: number;
  end: number;
  offset: number;
  shape: AeTextSelectorShape;
  easeHigh: number; // −100..100
  easeLow: number;
  amount: number; // percent, −100..100
  smoothness?: number; // percent; Square only
  mode?: AeTextSelectorMode;
}

// Cubic bezier y(x) through (0,0), (x1,y1), (x2,y2), (1,1); x solved by bisection.
function bezierAt(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 48; k++) {
    const u = (lo + hi) / 2;
    const bx = 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
    if (bx < x) lo = u;
    else hi = u;
  }
  const u = (lo + hi) / 2;
  return 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
}

// The selector's ease: Ease Low > 0 pulls the first handle along x, < 0 up y;
// Ease High likewise on the second (measured: High 100 / Low 0 at m = 0.05
// selects 0.307, AE 0.3072).
export function aeSelectorEaser(easeLow: number, easeHigh: number): (m: number) => number {
  if (easeLow === 0 && easeHigh === 0) return (m) => m;
  let x1 = 0;
  let y1 = 0;
  let x2 = 1;
  let y2 = 1;
  if (easeLow > 0) x1 = easeLow / 100;
  else y1 = -easeLow / 100;
  if (easeHigh > 0) x2 = 1 - easeHigh / 100;
  else y2 = 1 + easeHigh / 100;
  return (m) => bezierAt(x1, y1, x2, y2, m);
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => clamp(v, 0, 1);

// Selection of unit `i` (0-based) of `total`, before the mode combines it.
export function aeRangeSelection(s: AeRangeModel, i: number, total: number): number {
  const div = s.units === "index" ? 1 : 100 / Math.max(1, total);
  const o = s.offset / div;
  let a = s.start / div + o;
  let b = s.end / div + o;
  if (a > b) [a, b] = [b, a];
  let m = 0;
  const span = b - a;
  switch (s.shape) {
    case "ramp-up":
      m = span === 0 ? (i >= b ? 1 : 0) : clamp01((i + 0.5 - a) / span);
      break;
    case "ramp-down":
      m = span === 0 ? (i >= b ? 0 : 1) : 1 - clamp01((i + 0.5 - a) / span);
      break;
    case "triangle":
      if (span !== 0) {
        m = clamp01((i + 0.5 - a) / span);
        m = m < 0.5 ? 2 * m : 1 - 2 * (m - 0.5);
      }
      break;
    case "round":
      if (span !== 0) {
        const x = -span / 2 + Math.min(Math.max(0, i + 0.5 - a), span);
        m = Math.sqrt(Math.max(0, 1 - (x * x) / ((span / 2) * (span / 2))));
      }
      break;
    case "smooth":
      if (span !== 0) m = (1 + Math.cos(Math.PI + (Math.PI * 2 * Math.min(Math.max(0, i + 0.5 - a), span)) / span)) / 2;
      break;
    case "square":
    default:
      // Coverage of the unit's cell [i, i + 1] by [a, b].
      m = clamp01(Math.min(b, i + 1) - Math.max(a, i));
      break;
  }
  m = aeSelectorEaser(s.easeLow, s.easeHigh)(m);
  const sm = s.shape === "square" ? (s.smoothness ?? 100) : 100;
  if (sm !== 100) {
    const k = Math.max(1e-8, sm / 100);
    const th = 0.5 - k / 2;
    m = m < th ? 0 : Math.min(1, (m - th) / k);
  }
  return (m * s.amount) / 100;
}

export function aeCombineSelection(mode: AeTextSelectorMode, prev: number, cur: number): number {
  switch (mode) {
    case "subtract":
      return prev - cur;
    case "intersect":
      return prev * cur;
    case "min":
      return Math.min(prev, cur);
    case "max":
      return Math.max(prev, cur);
    case "difference":
      return Math.abs(prev - cur);
    case "add":
    default:
      return prev + cur;
  }
}

// Several selectors of one animator, top to bottom, the result clamped to
// AE's ±100 %.
export function aeSelection(selectors: AeRangeModel[], i: number, total: number): number {
  let v = 0;
  for (const s of selectors) v = aeCombineSelection(s.mode ?? "add", v, aeRangeSelection(s, i, total));
  return clamp(v, -1, 1);
}

// ---------------------------------------------------------------------------
// The toolbox side
// ---------------------------------------------------------------------------

export interface TextDriveConfig {
  driver: "cascade" | "uniform";
  direction: TextCascadeDirection;
  softness: number;
  seed: number;
  easing: string;
  easeIntensity: number;
  curve: unknown;
}

// Toolbox's per-unit easing (applyEasingOrCurve: clamps its input, does not
// clamp its output).
export const toolboxEase = (c: TextDriveConfig, t: number) => applyEasingOrCurve(c.easing, t, c.easeIntensity, c.curve);

// An unknown easing name plays linear (applyEasing's fallback).
export const isLinearEase = (c: TextDriveConfig) => c.easeIntensity === 0 || c.easing === "linear" || (c.easing !== CUSTOM_EASING && !EASINGS[c.easing]);

// The largest |t'| the easing reaches over [0, 1] (back / elastic overshoot
// past 1): AE's selection is clamped to ±100 %, so the animator's property
// carries this factor and the selection is divided by it.
export function easeHeadroom(c: TextDriveConfig): number {
  if (isLinearEase(c)) return 1;
  let m = 1;
  for (let k = 0; k <= 1000; k++) m = Math.max(m, Math.abs(toolboxEase(c, k / 1000)));
  return m > 1 + 1e-9 ? m : 1;
}

// ---------------------------------------------------------------------------
// Toolbox drive → AE selector
// ---------------------------------------------------------------------------

export interface AeRangePlan {
  shape: "ramp-up" | "ramp-down";
  // Index units. Offset = offsetPerAmount · amount (toolbox's 0–1 amount).
  start: number;
  end: number;
  offsetPerAmount: number;
  mode: "add" | "min" | "max";
}

export type AeSelectorPlan =
  // Square over every unit; Amount (%) = 100 · sel(t') per frame.
  | { route: "uniform" }
  // Range Selector(s) in index units; easeFit.error is the max |Δ| of the
  // per-unit value as a fraction of the property's range (0 = exact).
  | { route: "range"; selectors: AeRangePlan[]; easeLow: number; easeHigh: number; amount: number; error: number }
  // An Expression Selector: its Amount holds 100 · amount (keys), the
  // expression returns the selection percent.
  | { route: "expression"; expression: string; reason: string };

export interface AeSelectorRequest extends TextDriveConfig {
  // Units the selector counts (characters incl. spaces, or words).
  total: number;
  // AE's selection is 1 − t' (a property whose rest is toolbox's max) instead of t'.
  complement: boolean;
  // AE's selection is divided by this (easeHeadroom); ≥ 1.
  headroom: number;
  // "editable" accepts an Ease High / Low fit within `tolerance`; "exact"
  // only an exact one.
  fidelity: "editable" | "exact";
  tolerance: number;
  // Word units read from the layer's own text (an Expression Selector over
  // characters): AE's "Words" leaves the spaces out, toolbox's word owns the
  // whitespace after it — which matters for Tracking by word (measured: a
  // two-glyph word's spacing came out ⅔ of toolbox's).
  wordsFromText?: boolean;
}

export const TEXT_EASE_FIT_TOLERANCE = 0.005;
const EXACT_FIT = 1e-4;

// The selection AE should produce for unit i (what the plan's selectors and
// expressions are checked against): t'/headroom, or (1 − t')/headroom.
export function wantedSelection(req: AeSelectorRequest, amount: number, i: number): number {
  const t = toolboxDrive(req, amount, i, req.total);
  return (req.complement ? 1 - t : t) / req.headroom;
}

// Toolbox's t' for unit i of `total` (engine/text-animators.ts driveT).
export function toolboxDrive(c: TextDriveConfig, amount: number, i: number, total: number): number {
  let t: number;
  if (c.driver === "cascade") {
    const w = clamp(c.softness, 0.0001, 1);
    const start = unitPos(c.direction, i, total, c.seed) * (1 - w);
    t = clamp01((clamp01(amount) - start) / w);
  } else t = clamp01(amount);
  return toolboxEase(c, t);
}

function hashUnit(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function unitPos(dir: TextCascadeDirection, i: number, total: number, seed: number): number {
  if (total <= 1) return 0;
  const f = i / (total - 1);
  if (dir === "backward") return 1 - f;
  if (dir === "center") return Math.abs(f - 0.5) * 2;
  if (dir === "edges") return 1 - Math.abs(f - 0.5) * 2;
  if (dir === "random") return hashUnit(seed + i * 2654435761);
  return f;
}

// Best Ease Low / High for `target` (a monotone 0→1 curve), minimax over 65
// samples: a coarse grid, then two refinements.
export function fitSelectorEase(target: (u: number) => number): { low: number; high: number; error: number } {
  const us = Array.from({ length: 65 }, (_, k) => k / 64);
  const want = us.map(target);
  const err = (low: number, high: number) => {
    const e = aeSelectorEaser(low, high);
    let m = 0;
    for (let k = 0; k < us.length; k++) m = Math.max(m, Math.abs(e(us[k]) - want[k]));
    return m;
  };
  let best = { low: 0, high: 0, error: err(0, 0) };
  const scan = (lo0: number, lo1: number, hi0: number, hi1: number, step: number) => {
    for (let l = lo0; l <= lo1 + 1e-9; l += step)
      for (let h = hi0; h <= hi1 + 1e-9; h += step) {
        const L = clamp(l, -100, 100);
        const Hh = clamp(h, -100, 100);
        const e = err(L, Hh);
        if (e < best.error) best = { low: L, high: Hh, error: e };
      }
  };
  scan(-100, 100, -100, 100, 5);
  scan(best.low - 5, best.low + 5, best.high - 5, best.high + 5, 0.5);
  scan(best.low - 0.5, best.low + 0.5, best.high - 0.5, best.high + 0.5, 0.05);
  scan(best.low - 0.05, best.low + 0.05, best.high - 0.05, best.high + 0.05, 0.005);
  scan(best.low - 0.005, best.low + 0.005, best.high - 0.005, best.high + 0.005, 0.0005);
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return { low: r(best.low), high: r(best.high), error: err(r(best.low), r(best.high)) };
}

export function planTextSelector(req: AeSelectorRequest): AeSelectorPlan {
  const linear = isLinearEase(req);
  const w = clamp(req.softness, 0.0001, 1);
  // Softness 1 (or a uniform driver): every unit shares t = clamp01(a).
  if (req.driver !== "cascade" || w >= 1) return { route: "uniform" };
  if (req.wordsFromText) return { route: "expression", expression: textSelectorExpression(req), reason: "word units with toolbox's whitespace (AE's Words leaves the spaces out)" };
  const N = Math.max(1, req.total);
  const dir: TextCascadeDirection = N <= 1 ? "forward" : req.direction;
  if (dir === "random") return { route: "expression", expression: textSelectorExpression(req), reason: "random order: AE's Randomize Order permutes the units, toolbox hashes each to its own position" };
  let ease = { low: 0, high: 0, error: 0 };
  if (!linear) {
    const E = (t: number) => toolboxEase(req, t);
    ease = fitSelectorEase(req.complement ? (u) => 1 - E(1 - u) : E);
    const ok = ease.error <= EXACT_FIT || (req.fidelity === "editable" && ease.error <= req.tolerance);
    if (!ok || req.headroom > 1)
      return {
        route: "expression",
        expression: textSelectorExpression(req),
        reason: `${req.easing} easing: Ease High / Low reproduce it within ${(ease.error * 100).toFixed(2)}% at best${req.fidelity === "editable" ? ` (tolerance ${(req.tolerance * 100).toFixed(2)}%)` : " (policy exact)"}`,
      };
  }
  const sel = rangeSelectors(dir, N, w);
  const out = req.complement ? sel.map(complementOf) : sel;
  return { route: "range", selectors: out, easeLow: ease.low, easeHigh: ease.high, amount: 100 / req.headroom, error: ease.error };
}

// 1 − selection: the opposite ramps, Min ↔ Max (the easer is monotone, so it
// commutes with Min / Max).
function complementOf(s: AeRangePlan): AeRangePlan {
  return { ...s, shape: s.shape === "ramp-up" ? "ramp-down" : "ramp-up", mode: s.mode === "min" ? "max" : s.mode === "max" ? "min" : s.mode };
}

// The linear cascade as ramps over the unit index (derivation in
// specdocs/ae-m4/text.md): t_i = clamp01((a − pos_i·(1 − w))/w) is a ramp of
// width D units whose ends move D/w units per unit of amount.
function rangeSelectors(dir: TextCascadeDirection, N: number, w: number): AeRangePlan[] {
  if (N <= 1) {
    // pos = 0: t = clamp01(a/w).
    return [{ shape: "ramp-down", start: -0.5, end: 0.5, offsetPerAmount: 1 / w, mode: "add" }];
  }
  if (dir === "forward" || dir === "backward") {
    const D = (w * (N - 1)) / (1 - w);
    const k = D / w;
    return dir === "forward"
      ? [{ shape: "ramp-down", start: 0.5 - D, end: 0.5, offsetPerAmount: k, mode: "add" }]
      : [{ shape: "ramp-up", start: N - 0.5, end: N - 0.5 + D, offsetPerAmount: -k, mode: "add" }];
  }
  const c = (N - 1) / 2;
  const D = (w * (N - 1)) / (2 * (1 - w));
  const k = D / w;
  if (dir === "center")
    return [
      { shape: "ramp-up", start: c + 0.5, end: c + 0.5 + D, offsetPerAmount: -k, mode: "add" },
      { shape: "ramp-down", start: c + 0.5 - D, end: c + 0.5, offsetPerAmount: k, mode: "min" },
    ];
  // edges
  return [
    { shape: "ramp-up", start: N - 0.5, end: N - 0.5 + D, offsetPerAmount: -k, mode: "add" },
    { shape: "ramp-down", start: 0.5 - D, end: 0.5, offsetPerAmount: k, mode: "max" },
  ];
}

// The plan's selectors as AE models at amount `a` (for checks).
export function rangeModelsAt(plan: Extract<AeSelectorPlan, { route: "range" }>, a: number): AeRangeModel[] {
  return plan.selectors.map((s) => ({
    units: "index",
    start: s.start,
    end: s.end,
    offset: s.offsetPerAmount * a,
    shape: s.shape,
    easeLow: plan.easeLow,
    easeHigh: plan.easeHigh,
    amount: plan.amount,
    mode: s.mode,
  }));
}

// ---------------------------------------------------------------------------
// The Expression Selector
// ---------------------------------------------------------------------------

const num = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e12) / 1e12));

// Toolbox easing as expression source: `t = …;` (t already clamped).
function easeSource(c: TextDriveConfig): string[] {
  if (isLinearEase(c)) return [];
  const I = num(c.easeIntensity);
  if (c.easing === CUSTOM_EASING) {
    // The float curve, sampled: 257 values, linear between (≤ 1e-5 off a
    // monotone cubic).
    const lut = Array.from({ length: 257 }, (_, k) => Math.round(applyEasingOrCurve(CUSTOM_EASING, k / 256, 1, c.curve) * 1e6) / 1e6);
    return [
      `var L = ${JSON.stringify(lut)};`,
      "var x = t * 256, k = Math.min(255, Math.floor(x));",
      `t = t + ${I} * (L[k] + (L[k + 1] - L[k]) * (x - k) - t);`,
    ];
  }
  const name = EASINGS[c.easing] ? c.easing : "linear";
  if (name === "linear") return [];
  const fam = /^ease-(in-out|in|out)-(.+)$/.exec(name);
  const base: Record<string, string> = {
    quad: "return u * u;",
    cubic: "return u * u * u;",
    quart: "return u * u * u * u;",
    quint: "return u * u * u * u * u;",
    sine: "return 1 - Math.cos((u * Math.PI) / 2);",
    expo: "return u <= 0 ? 0 : Math.pow(2, 10 * (u - 1));",
    circ: "return 1 - Math.sqrt(Math.max(0, 1 - u * u));",
    back: "return 2.70158 * u * u * u - 1.70158 * u * u;",
    elastic: "if (u <= 0) return 0; if (u >= 1) return 1; return -Math.pow(2, 10 * u - 10) * Math.sin((u * 10 - 10.75) * ((2 * Math.PI) / 3));",
    bounce:
      "var v = 1 - u, r; if (v < 1 / 2.75) r = 7.5625 * v * v; else if (v < 2 / 2.75) { v -= 1.5 / 2.75; r = 7.5625 * v * v + 0.75; } else if (v < 2.5 / 2.75) { v -= 2.25 / 2.75; r = 7.5625 * v * v + 0.9375; } else { v -= 2.625 / 2.75; r = 7.5625 * v * v + 0.984375; } return 1 - r;",
  };
  let inFn: string;
  let variant: string;
  if (name === "step") return [`t = t + ${I} * ((t < 1 ? 0 : 1) - t);`];
  if (name === "smoothstep") return [`t = t + ${I} * (t * t * (3 - 2 * t) - t);`];
  if (name === "smootherstep") return [`t = t + ${I} * (t * t * t * (t * (t * 6 - 15) + 10) - t);`];
  if (name === "ease-in" || name === "ease-out" || name === "ease-in-out") {
    inFn = base.quad;
    variant = name === "ease-in" ? "in" : name === "ease-out" ? "out" : "in-out";
  } else if (fam && base[fam[2]]) {
    inFn = base[fam[2]];
    variant = fam[1];
  } else return [];
  const call = variant === "in" ? "tbxIn(t)" : variant === "out" ? "1 - tbxIn(1 - t)" : "(t < 0.5 ? tbxIn(2 * t) / 2 : 1 - tbxIn(2 * (1 - t)) / 2)";
  return [`function tbxIn(u) { ${inFn} }`, `t = t + ${I} * (${call} - t);`];
}

// Toolbox's cascade, verbatim: per unit (textIndex is 1-based), the amount
// from this selector's own Amount (value[0] = 100 · amount).
export function textSelectorExpression(req: AeSelectorRequest): string {
  const w = clamp(req.softness, 0.0001, 1);
  const pos: Record<TextCascadeDirection, string> = {
    forward: "f",
    backward: "1 - f",
    center: "Math.abs(f - 0.5) * 2",
    edges: "1 - Math.abs(f - 0.5) * 2",
    random: `tbxHash(${num(req.seed)} + i * 2654435761)`,
  };
  const cascade = req.driver === "cascade" && w < 1;
  const L = [
    `// toolbox text animator (engine/text-animators.ts): ${cascade ? `${req.direction} cascade, softness ${num(w)}` : "uniform"}${isLinearEase(req) ? "" : `, ${req.easing} easing`}${req.wordsFromText ? ", by word" : ""}.`,
    "// Animate this selector's Amount (100 = the whole sweep).",
    "var a = Math.min(1, Math.max(0, value[0] / 100));",
    `var n = textTotal, i = textIndex - 1, w = ${num(w)};`,
  ];
  if (req.wordsFromText)
    L.push(
      "// Toolbox's words: whitespace joins the word before it, a line starts a new one.",
      "var src = Array.from(String(text.sourceText)), ids = [], wd = -1, pw = true, k, sp;",
      "for (k = 0; k < src.length; k++) {",
      '  if (src[k] === "\\r" || src[k] === "\\n" || src[k] === "\\u0003") { pw = true; continue; }',
      "  sp = /\\s/.test(src[k]);",
      "  if (!sp && pw) wd++;",
      "  pw = sp;",
      "  ids.push(Math.max(0, wd));",
      "}",
      "i = ids[i] || 0;",
      "n = Math.max(1, wd + 1);"
    );
  L.push("var f = n > 1 ? i / (n - 1) : 0;");
  if (req.direction === "random")
    L.push("function tbxHash(m) { var x = (m | 0) ^ 0x9e3779b9; x = Math.imul(x ^ (x >>> 16), 0x45d9f3b); x = Math.imul(x ^ (x >>> 16), 0x45d9f3b); x ^= x >>> 16; return (x >>> 0) / 4294967296; }");
  L.push(
    `var p = n > 1 ? ${cascade ? pos[req.direction] : "0"} : 0;`,
    cascade ? "var t = Math.min(1, Math.max(0, (a - p * (1 - w)) / w));" : "var t = a;",
    ...easeSource(req),
    `${req.complement ? "100 * (1 - t)" : "100 * t"}${req.headroom > 1 ? ` / ${num(req.headroom)}` : ""};`
  );
  return L.join("\n");
}

// Evaluates an Expression Selector's text the way AE does for unit i of
// `total` with Amount `amountPct` (for checks): the returned percent / 100,
// clamped to ±1.
// `source` is the layer's text as AE gives it (lines joined by "\r").
export function evalSelectorExpression(expression: string, amountPct: number, i: number, total: number, source = ""): number {
  const f = new Function("value", "textIndex", "textTotal", "text", `"use strict"; return eval(${JSON.stringify(expression)});`) as (v: number[], ti: number, tt: number, tx: unknown) => number;
  return clamp(f([amountPct, amountPct, amountPct], i + 1, total, { sourceText: source }) / 100, -1, 1);
}

// ---------------------------------------------------------------------------
// AE's per-character result of a layer's animators (for checks)
// ---------------------------------------------------------------------------

export interface AeTextUnit {
  char: number;
  charTotal: number;
  word: number;
  wordTotal: number;
}

export interface AeGlyphState {
  opacity: number; // percent
  fillOpacity: number;
  strokeOpacity: number;
  position: [number, number]; // px
  anchor: [number, number];
  scale: [number, number]; // factor
  rotation: number; // degrees
  tracking: number; // px after the character
  fill: number[] | null; // 0–1 RGB (the document's unless an animator sets it)
  stroke: number[] | null;
}

// The selection of one animator for one character at time t.
export function aeAnimatorSelection(A: AeTextAnimator, u: AeTextUnit, t: number, source = ""): number {
  const sels: AeTextSelector[] = A.selectors ?? (A.selector ? [A.selector] : []);
  const ev = (p: AeProp<number> | undefined, fb: number) => (p ? (evaluateAeProp(p, t)[0] ?? fb) : fb);
  let v = 0;
  for (const S of sels) {
    const byWord = S.basedOn === "words";
    const i = byWord ? u.word : u.char;
    const N = byWord ? u.wordTotal : u.charTotal;
    let cur: number;
    if (S.kind === "expression") cur = evalSelectorExpression(S.expression, ev(S.amount, 100), i, N, source);
    else
      cur = aeRangeSelection(
        { units: S.units, start: ev(S.start, 0), end: ev(S.end, 100), offset: ev(S.offset, 0), shape: S.shape, easeHigh: ev(S.easeHigh, 0), easeLow: ev(S.easeLow, 0), amount: ev(S.amount, 100) },
        i,
        N
      );
    v = aeCombineSelection(S.mode ?? "add", v, cur);
  }
  return clamp(v, -1, 1);
}

// The measured stacking (types.ts AeTextAnimator): Position / Anchor /
// Rotation / Tracking add, Scale multiplies, Opacities and colours move from
// the value so far toward the animator's by the selection.
export function aeTextModel(animators: readonly AeTextAnimator[], units: readonly AeTextUnit[], t: number, doc: { fill?: number[]; stroke?: number[]; text?: string } = {}): AeGlyphState[] {
  return units.map((u) => {
    const g: AeGlyphState = { opacity: 100, fillOpacity: 100, strokeOpacity: 100, position: [0, 0], anchor: [0, 0], scale: [1, 1], rotation: 0, tracking: 0, fill: doc.fill ?? null, stroke: doc.stroke ?? null };
    for (const A of animators) {
      const s = aeAnimatorSelection(A, u, t, doc.text ?? "");
      const P = (m: string) => (A.properties[m] ? evaluateAeProp(A.properties[m], t) : null);
      const chain = (cur: number, m: string) => {
        const v = P(m);
        return v ? cur + (v[0] - cur) * s : cur;
      };
      g.opacity = chain(g.opacity, "ADBE Text Opacity");
      g.fillOpacity = chain(g.fillOpacity, "ADBE Text Fill Opacity");
      g.strokeOpacity = chain(g.strokeOpacity, "ADBE Text Stroke Opacity");
      const pos = P("ADBE Text Position 3D");
      if (pos) g.position = [g.position[0] + pos[0] * s, g.position[1] + pos[1] * s];
      const anc = P("ADBE Text Anchor Point 3D");
      if (anc) g.anchor = [g.anchor[0] + anc[0] * s, g.anchor[1] + anc[1] * s];
      const sc = P("ADBE Text Scale 3D");
      if (sc) g.scale = [g.scale[0] * (1 + (sc[0] / 100 - 1) * s), g.scale[1] * (1 + (sc[1] / 100 - 1) * s)];
      const rot = P("ADBE Text Rotation");
      if (rot) g.rotation += rot[0] * s;
      const trk = P("ADBE Text Tracking Amount");
      if (trk) g.tracking += trk[0] * s;
      for (const [m, key] of [["ADBE Text Fill Color", "fill"], ["ADBE Text Stroke Color", "stroke"]] as const) {
        const c = P(m);
        if (!c) continue;
        const cur = g[key] ?? c;
        g[key] = cur.map((x, i) => x + (c[i] - x) * s);
      }
    }
    return g;
  });
}
