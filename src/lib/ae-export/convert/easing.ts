// After Effects export — easing (spec 091926_after-effects-handoff.md §4.2,
// Appendix A).
//
// AE's value graph between two keys is a cubic bezier in (time, value): key
// A's out handle sits at (influence/100 · D, speed · influence/100 · D) from
// A, key B's in handle at the mirror image before B. M0 measured AE ≡ that
// cubic to 0.00000% (spec §13), so the only error an export carries is how far
// the cubic(s) we pick are from toolbox's easeOf().
//
// Everything here works in a SEGMENT-NORMALIZED frame: u ∈ [0, 1] is the
// fraction of the toolbox segment's duration, v the fraction of its value
// delta (0 at key A, 1 at key B; outside [0, 1] when it overshoots). A
// segment's easing becomes one or more AeEasePiece — a cubic from (u0, v0) to
// (u1, v1) with handle influences as fractions of the PIECE and slopes dv/du
// in segment units. keys.ts scales a piece into AE units: speed = slope·ΔV/D,
// influence = 100·fraction. One piece is "one AE segment per toolbox segment"
// (Editable); several are the extra keys of the Exact policy (and of bounce /
// elastic, which no single cubic can carry).
//
// The cubics below are minimax fits against easeOf (scripts/research/
// ae-easing-fidelity*.mjs computed §4.2's; these refits are tighter — the
// runtime lane measured §4.2's 3-decimal easeInOutSine at 0.2501% in AE and
// asked for minimax). check-convert-easing re-measures every row against
// easeOf and holds the recorded error to its tolerance.

import {
  easeOf,
  LINEAR_BEZIER,
  isStepOnly,
  type BezierEasing,
  type EasingPreset,
  type Keyframe,
} from "@/engine/keyframes";
import type { ParamType } from "@/engine/types";
import type { AeEase, AeFidelityPolicy } from "../types";

export const AE_INFLUENCE_MIN = 0.1;
export const AE_INFLUENCE_MAX = 100;

export function clampInfluence(pct: number): number {
  return pct < AE_INFLUENCE_MIN ? AE_INFLUENCE_MIN : pct > AE_INFLUENCE_MAX ? AE_INFLUENCE_MAX : pct;
}

// ---------------------------------------------------------------------------
// Bodymovin's formula (§4.2), both directions
// ---------------------------------------------------------------------------

// A normalized CSS cubic-bezier on a segment of `durationSec` seconds and
// `delta` value units → the two KeyframeEases:
//   outInfluence = 100·x1          outSpeed = (y1 / x1)·Δ/D
//   inInfluence  = 100·(1 − x2)    inSpeed  = ((1 − y2) / (1 − x2))·Δ/D
// x is clamped into [0.001, 1] (AE's 0.1–100% influence) keeping the control
// point's y, so a handle on the key itself becomes a 0.1% handle of the same
// height — the nearest AE can draw.
export function cubicToAeEase(c: BezierEasing, durationSec: number, delta: number): { out: AeEase; in: AeEase } {
  const p = cubicPiece(c);
  return pieceEases(p, durationSec, delta);
}

// The inverse: two KeyframeEases on a segment → the normalized cubic AE plays.
// null for a flat segment (Δ = 0: the speeds have no delta to normalize by).
export function aeEaseToCubic(out: AeEase, inn: AeEase, durationSec: number, delta: number): BezierEasing | null {
  if (!(durationSec > 0) || delta === 0) return null;
  const x1 = out.influence / 100;
  const xi = inn.influence / 100;
  const k = durationSec / delta;
  return { x1, y1: out.speed * x1 * k, x2: 1 - xi, y2: 1 - inn.speed * xi * k };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

export interface AeEasePiece {
  // Segment-normalized endpoints.
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  // Handle lengths in time as a fraction of the piece's own duration
  // (AE influence / 100), and their slopes dv/du in segment units.
  outInfluence: number;
  outSlope: number;
  inInfluence: number;
  inSlope: number;
}

export type AeEasePlan =
  // AE LINEAR on both sides of the segment.
  | { kind: "linear" }
  // AE HOLD (key A's out and key B's in).
  | { kind: "hold" }
  | { kind: "pieces"; pieces: AeEasePiece[] }
  // Scalar customBezier: handles in ticks / value units, converted directly
  // from the keys (keys.ts) — no normalization, so a flat segment keeps its bump.
  | { kind: "valueBezier" }
  // Spring: no closed form in AE — dense keys sampled from toolbox.
  | { kind: "sampled" };

const X_MIN = AE_INFLUENCE_MIN / 100;

// One piece spanning the whole segment from a normalized cubic.
export function cubicPiece(c: BezierEasing): AeEasePiece {
  const x1 = Math.min(1, Math.max(X_MIN, c.x1));
  const xi = Math.min(1, Math.max(X_MIN, 1 - c.x2));
  return {
    u0: 0,
    v0: 0,
    u1: 1,
    v1: 1,
    outInfluence: x1,
    outSlope: c.y1 / x1,
    inInfluence: xi,
    inSlope: (1 - c.y2) / xi,
  };
}

// A piece's KeyframeEases on a segment of `durationSec` and `delta`.
export function pieceEases(p: AeEasePiece, durationSec: number, delta: number): { out: AeEase; in: AeEase } {
  const k = durationSec > 0 ? delta / durationSec : 0;
  return {
    out: { speed: p.outSlope * k, influence: clampInfluence(100 * p.outInfluence) },
    in: { speed: p.inSlope * k, influence: clampInfluence(100 * p.inInfluence) },
  };
}

// The piece's control points in segment-normalized (u, v).
export function pieceControlPoints(p: AeEasePiece): [number, number, number, number, number, number, number, number] {
  const h = p.u1 - p.u0;
  return [
    p.u0,
    p.v0,
    p.u0 + p.outInfluence * h,
    p.v0 + p.outSlope * p.outInfluence * h,
    p.u1 - p.inInfluence * h,
    p.v1 - p.inSlope * p.inInfluence * h,
    p.u1,
    p.v1,
  ];
}

// Solve x(s) = x on the 1-D cubic 0, x1, x2, 1 (x1, x2 ∈ [0, 1] ⇒ monotone).
// Newton from s = x, bisection when Newton stalls; to ~1e-15.
export function solveCubicX(x1: number, x2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let s = x;
  for (let i = 0; i < 12; i++) {
    const o = 1 - s;
    const f = 3 * o * o * s * x1 + 3 * o * s * s * x2 + s * s * s - x;
    if (Math.abs(f) < 1e-15) return s;
    const d = 3 * o * o * x1 + 6 * o * s * (x2 - x1) + 3 * s * s * (1 - x2);
    if (!(d > 1e-12)) break;
    const n = s - f / d;
    if (!(n > 0 && n < 1)) break;
    s = n;
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 64; i++) {
    s = (lo + hi) / 2;
    const o = 1 - s;
    const f = 3 * o * o * s * x1 + 3 * o * s * s * x2 + s * s * s;
    if (f < x) lo = s;
    else hi = s;
  }
  return (lo + hi) / 2;
}

// Value of one piece at segment time u (u0 ≤ u ≤ u1), AE semantics.
export function evaluatePiece(p: AeEasePiece, u: number): number {
  const h = p.u1 - p.u0;
  if (!(h > 0)) return p.v1;
  const x = (u - p.u0) / h;
  if (x <= 0) return p.v0;
  if (x >= 1) return p.v1;
  const x1 = Math.min(1, Math.max(0, p.outInfluence));
  const x2 = Math.min(1, Math.max(0, 1 - p.inInfluence));
  const s = solveCubicX(x1, x2, x);
  const y1 = p.v0 + p.outSlope * p.outInfluence * h;
  const y2 = p.v1 - p.inSlope * p.inInfluence * h;
  const o = 1 - s;
  return o * o * o * p.v0 + 3 * o * o * s * y1 + 3 * o * s * s * y2 + s * s * s * p.v1;
}

// A pieces plan at segment time u — the curve AE plays, normalized.
export function evaluatePieces(pieces: readonly AeEasePiece[], u: number): number {
  if (u <= 0) return pieces[0]?.v0 ?? 0;
  for (const p of pieces) if (u <= p.u1) return evaluatePiece(p, u);
  return pieces[pieces.length - 1]?.v1 ?? 1;
}

// Progress never runs backwards and stays in [0, 1] — what a spatial
// (motion-path) property can carry: AE's spatial speed is a magnitude along
// the path, so overshoot and dips need separated dimensions.
export function piecesMonotone(pieces: readonly AeEasePiece[]): boolean {
  for (const p of pieces) {
    const [, y0, , y1, , y2, , y3] = pieceControlPoints(p);
    if (!(y0 <= y1 + 1e-12 && y1 <= y2 + 1e-12 && y2 <= y3 + 1e-12)) return false;
    if (y0 < -1e-12 || y3 > 1 + 1e-12) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The per-preset table
// ---------------------------------------------------------------------------

export type AeEasingClass =
  // A single cubic that IS the preset (polynomials of degree ≤ 3).
  | "exact"
  // A minimax single-cubic fit (Editable); Exact may add keys.
  | "fit"
  // Extra keys at the preset's own break points (bounce contacts, elastic
  // extrema) — no single cubic exists, both policies use them.
  | "keys"
  // Spring: dense keys sampled from toolbox.
  | "sampled"
  | "hold"
  // The key carries its own curve (customBezier / cubicBezier).
  | "direct";

export interface AeEasingRow {
  easing: EasingPreset;
  cls: AeEasingClass;
  editable: AeEasePlan;
  exact: AeEasePlan;
  // Max |AE curve − easeOf| over the segment in normalized value (×100 = %),
  // as check-convert-easing measures it (20001 samples). 0 = polynomial
  // identity (the gate still allows 1e-12 of float noise). For
  // direct / sampled rows the number is the gate fixture's.
  error: { editable: number; exact: number };
  // What §4.2's research scripts measured for the same row, where it lists
  // one — the gate asserts we are no worse.
  spec?: { editable?: number; exact?: number };
  // Allowed drift of the measured error from `error` (absolute, normalized).
  tolerance: number;
  note: string;
}

const C1 = 1.70158; // easeOf's back overshoot constant
const BOUNCE_D1 = 2.75;
const BOUNCE_N1 = 7.5625;

// easeInSine — minimax (the mirror gives easeOutSine: easeOf's two are
// mirror images to the bit, sin(uπ/2) = 1 − (1 − cos((1−u)π/2))).
const SINE_IN: BezierEasing = {
  x1: 0.3611495807007625,
  y1: -0.00032641616282925984,
  x2: 0.67354028803475,
  y2: 0.4869091737243242,
};
const SINE_IN_OUT: BezierEasing = {
  x1: 0.36282199104664536,
  y1: -0.0015704923928574186,
  x2: 0.6371780089533546,
  y2: 1.0015704923928574,
};
const QUAD_IN_OUT: BezierEasing = {
  x1: 0.4842976669364958,
  y1: 0.04198112233586905,
  x2: 0.5157023330635042,
  y2: 0.958018877664131,
};
// x1 > x2: the influences sum to 125%. AE draws the cubic as-is (Bodymovin
// exports such keys); the best fit with x1 ≤ x2 misses by 2.1%.
const CUBIC_IN_OUT: BezierEasing = {
  x1: 0.6248852626987205,
  y1: -0.04051928213980879,
  x2: 0.37511473730127953,
  y2: 1.0405192821398088,
};
// easeInExpo — the error floor is easeOf's own jump: easeInExpo(0) = 0 but
// easeInExpo(0⁺) = 2⁻¹⁰ (0.0977%); any continuous curve through the keys
// misses by that much next to key A. easeOutExpo mirrors it at key B.
const EXPO_IN: BezierEasing = {
  x1: 0.6252644703297174,
  y1: 0.02117445183754617,
  x2: 0.8450384663420538,
  y2: -0.06991789008526964,
};

export function mirrorCubic(c: BezierEasing): BezierEasing {
  return { x1: 1 - c.x2, y1: 1 - c.y2, x2: 1 - c.x1, y2: 1 - c.y1 };
}

function piece(u0: number, v0: number, u1: number, v1: number, outInfluence: number, outSlope: number, inInfluence: number, inSlope: number): AeEasePiece {
  return { u0, v0, u1, v1, outInfluence, outSlope, inInfluence, inSlope };
}

const cubic = (c: BezierEasing): AeEasePlan => ({ kind: "pieces", pieces: [cubicPiece(c)] });

// easeInOutQuad / easeInOutCubic, exact: a key at u = 0.5 and the in / out
// halves, each a polynomial of degree ≤ 3 (x at thirds, slopes from the
// derivative): 2u² | 1 − 2(1−u)² has slope 2 at the middle, 4u³ | … slope 3.
function inOutSplit(midSlope: number): AeEasePlan {
  const t = 1 / 3;
  return {
    kind: "pieces",
    pieces: [piece(0, 0, 0.5, 0.5, t, 0, t, midSlope), piece(0.5, 0.5, 1, 1, t, midSlope, t, 0)],
  };
}

// easeOutBounce: keys at the contacts u = 0, 1/d1, 2/d1, 2.5/d1, 1. Each
// piece is one of easeOf's parabolas, which a cubic with x at thirds carries
// exactly; the slopes are the parabola's derivative at the contacts
// (±2·n1·half-width), so AE's in/out speeds differ at each contact.
function bouncePlan(): AeEasePlan {
  const d = BOUNCE_D1;
  const n = BOUNCE_N1;
  const t = 1 / 3;
  const cuts = [0, 1 / d, 2 / d, 2.5 / d, 1];
  const v = cuts.map((u) => easeOf("easeOutBounce", u));
  const half = [0, 0.5 / d, 0.25 / d, 0.125 / d];
  const pieces: AeEasePiece[] = [piece(cuts[0], v[0], cuts[1], v[1], t, 0, t, (2 * n) / d)];
  for (let k = 1; k < 4; k++) {
    const s = 2 * n * half[k];
    pieces.push(piece(cuts[k], v[k], cuts[k + 1], v[k + 1], t, -s, t, s));
  }
  return { kind: "pieces", pieces };
}

// easeOutElastic = 2^(−10u)·sin((10u − 0.75)·2π/3) + 1. Its interior extrema
// sit at u_k = ((atan(c4/ln2) + kπ)/c4 + 0.75)/10, k = 0..5 (zero slope);
// its zero crossings (value 1) at u = 0.075 + 0.15·m. Between consecutive
// extrema the curve is the same decaying half-wave scaled, so one minimax
// shape serves all five interior pieces.
const ELASTIC_C4 = (Math.PI * 2) / 3;
export const ELASTIC_EXTREMA: readonly number[] = [0, 1, 2, 3, 4, 5].map(
  (k) => ((Math.atan(ELASTIC_C4 / Math.LN2) + k * Math.PI) / ELASTIC_C4 + 0.75) / 10
);
function elasticSlope(u: number): number {
  const ph = (u * 10 - 0.75) * ELASTIC_C4;
  return Math.pow(2, -10 * u) * (-10 * Math.LN2 * Math.sin(ph) + 10 * ELASTIC_C4 * Math.cos(ph));
}
const elastic = (u: number) => easeOf("easeOutElastic", u);
const ELASTIC_LOBE = { a: 0.2965255830710988, b: 0.45823452909707807 };
// Zero crossing → extremum, and extremum → zero crossing, for the Exact
// policy's split of the two biggest lobes.
const ELASTIC_TO_EXTREMUM = { a: 0.32613794426266, b: 0.36521445085347426 };

function elasticPlan(exact: boolean): AeEasePlan {
  const e = ELASTIC_EXTREMA;
  const t = 1 / 3;
  const pieces: AeEasePiece[] = [];
  if (!exact) {
    pieces.push(piece(0, 0, e[0], elastic(e[0]), 0.30771904252968074, 7.2937919988877695, 0.44962858509617054, 0));
  } else {
    const z0 = 0.075;
    const z1 = 0.225;
    pieces.push(piece(0, 0, z0, elastic(z0), 0.31600970255332494, elasticSlope(0), 0.3665614037612579, elasticSlope(z0)));
    pieces.push(piece(z0, elastic(z0), e[0], elastic(e[0]), ELASTIC_TO_EXTREMUM.a, elasticSlope(z0), ELASTIC_TO_EXTREMUM.b, 0));
    pieces.push(piece(e[0], elastic(e[0]), z1, elastic(z1), 0.3195392878729201, 0, 0.36949994220431426, elasticSlope(z1)));
    pieces.push(piece(z1, elastic(z1), e[1], elastic(e[1]), ELASTIC_TO_EXTREMUM.a, elasticSlope(z1), ELASTIC_TO_EXTREMUM.b, 0));
  }
  for (let k = exact ? 2 : 1; k < e.length; k++) {
    pieces.push(piece(e[k - 1], elastic(e[k - 1]), e[k], elastic(e[k]), ELASTIC_LOBE.a, 0, ELASTIC_LOBE.b, 0));
  }
  // The last extremum (u ≈ 1.035) lies past the segment; easeOf snaps to 1
  // at u = 1 from 1 + 2⁻¹¹ — that jump (0.0488%) is the piece's whole error.
  pieces.push(piece(e[e.length - 1], elastic(e[e.length - 1]), 1, 1, t, 0, t, 0));
  return { kind: "pieces", pieces };
}

const LINEAR: AeEasePlan = { kind: "linear" };
const HOLD: AeEasePlan = { kind: "hold" };

const QUAD_IN: BezierEasing = { x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 1 / 3 };
const QUAD_OUT: BezierEasing = { x1: 1 / 3, y1: 2 / 3, x2: 2 / 3, y2: 1 };
const CUBIC_IN: BezierEasing = { x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 0 };
const CUBIC_OUT: BezierEasing = { x1: 1 / 3, y1: 1, x2: 2 / 3, y2: 1 };
// Appendix A: the back presets are cubics, c3·u³ − c1·u² with x at thirds.
const BACK_IN: BezierEasing = { x1: 1 / 3, y1: 0, x2: 2 / 3, y2: -C1 / 3 };
const BACK_OUT: BezierEasing = { x1: 1 / 3, y1: 1 + C1 / 3, x2: 2 / 3, y2: 1 };

const quadInOut = { editable: cubic(QUAD_IN_OUT), exact: inOutSplit(2) };

export const AE_EASINGS: readonly AeEasingRow[] = [
  { easing: "linear", cls: "exact", editable: LINEAR, exact: LINEAR, error: { editable: 0, exact: 0 }, spec: { editable: 0 }, tolerance: 1e-12, note: "AE LINEAR both sides" },
  { easing: "easeInQuad", cls: "exact", editable: cubic(QUAD_IN), exact: cubic(QUAD_IN), error: { editable: 0, exact: 0 }, spec: { editable: 0 }, tolerance: 1e-12, note: "u², x at thirds" },
  { easing: "easeIn", cls: "exact", editable: cubic(QUAD_IN), exact: cubic(QUAD_IN), error: { editable: 0, exact: 0 }, tolerance: 1e-12, note: "legacy alias of easeInQuad" },
  { easing: "easeOutQuad", cls: "exact", editable: cubic(QUAD_OUT), exact: cubic(QUAD_OUT), error: { editable: 0, exact: 0 }, spec: { editable: 0 }, tolerance: 1e-12, note: "1 − (1−u)²" },
  { easing: "easeOut", cls: "exact", editable: cubic(QUAD_OUT), exact: cubic(QUAD_OUT), error: { editable: 0, exact: 0 }, tolerance: 1e-12, note: "legacy alias of easeOutQuad" },
  { easing: "easeInCubic", cls: "exact", editable: cubic(CUBIC_IN), exact: cubic(CUBIC_IN), error: { editable: 0, exact: 0 }, spec: { editable: 0 }, tolerance: 1e-12, note: "u³" },
  { easing: "easeOutCubic", cls: "exact", editable: cubic(CUBIC_OUT), exact: cubic(CUBIC_OUT), error: { editable: 0, exact: 0 }, spec: { editable: 0 }, tolerance: 1e-12, note: "1 − (1−u)³; Appendix A: 1 s / 100 px → out (33.33, 300), in (33.33, 0)" },
  { easing: "easeInBack", cls: "exact", editable: cubic(BACK_IN), exact: cubic(BACK_IN), error: { editable: 0, exact: 0 }, spec: { editable: 0 }, tolerance: 1e-12, note: "(1/3, 0, 2/3, −c1/3), c1 = 1.70158" },
  { easing: "easeOutBack", cls: "exact", editable: cubic(BACK_OUT), exact: cubic(BACK_OUT), error: { editable: 0, exact: 0 }, spec: { editable: 0 }, tolerance: 1e-12, note: "(1/3, 1 + c1/3, 2/3, 1); M0: AE ≡ this cubic (0.00000%)" },
  { easing: "easeInOutQuad", cls: "fit", ...quadInOut, error: { editable: 0.0030314, exact: 0 }, spec: { editable: 0.0037, exact: 0 }, tolerance: 2e-6, note: "Editable: minimax cubic; Exact: key at u = 0.5 + the quad halves" },
  { easing: "easeInOut", cls: "fit", ...quadInOut, error: { editable: 0.0030314, exact: 0 }, tolerance: 2e-6, note: "legacy alias of easeInOutQuad" },
  { easing: "easeInOutCubic", cls: "fit", editable: cubic(CUBIC_IN_OUT), exact: inOutSplit(3), error: { editable: 0.0025802, exact: 0 }, spec: { editable: 0.0027, exact: 0 }, tolerance: 2e-6, note: "Editable: minimax cubic (influences sum to 125%); Exact: midpoint key + the cubic halves" },
  { easing: "easeInSine", cls: "fit", editable: cubic(SINE_IN), exact: cubic(SINE_IN), error: { editable: 0.0000207, exact: 0.0000207 }, spec: { editable: 0.0013 }, tolerance: 2e-7, note: "minimax cubic; 0.002% needs no extra keys" },
  { easing: "easeOutSine", cls: "fit", editable: cubic(mirrorCubic(SINE_IN)), exact: cubic(mirrorCubic(SINE_IN)), error: { editable: 0.0000207, exact: 0.0000207 }, spec: { editable: 0.0005 }, tolerance: 2e-7, note: "the easeInSine fit mirrored" },
  { easing: "easeInOutSine", cls: "fit", editable: cubic(SINE_IN_OUT), exact: cubic(SINE_IN_OUT), error: { editable: 0.0000765, exact: 0.0000765 }, spec: { editable: 0.0023 }, tolerance: 2e-7, note: "minimax, symmetric (M0: 0.0076% in AE; §4.2's 3-decimal fit was 0.2501%)" },
  { easing: "easeInExpo", cls: "fit", editable: cubic(EXPO_IN), exact: cubic(EXPO_IN), error: { editable: 0.0009752, exact: 0.0009752 }, spec: { editable: 0.0009 }, tolerance: 2e-6, note: "at the floor: easeOf jumps 2⁻¹⁰ just after key A; no key count beats it" },
  { easing: "easeOutExpo", cls: "fit", editable: cubic(mirrorCubic(EXPO_IN)), exact: cubic(mirrorCubic(EXPO_IN)), error: { editable: 0.0009752, exact: 0.0009752 }, spec: { editable: 0.001 }, tolerance: 2e-6, note: "the easeInExpo fit mirrored; floor = easeOf's 2⁻¹⁰ jump at key B" },
  { easing: "easeOutBounce", cls: "keys", editable: bouncePlan(), exact: bouncePlan(), error: { editable: 0, exact: 0 }, spec: { editable: 0, exact: 0 }, tolerance: 1e-12, note: "5 keys at the contacts; each parabola is exact" },
  { easing: "easeOutElastic", cls: "keys", editable: elasticPlan(false), exact: elasticPlan(true), error: { editable: 0.0011743, exact: 0.0004876 }, spec: { editable: 0.0061 }, tolerance: 2e-6, note: "Editable: 8 keys (start, 6 extrema, end); Exact: + zero-crossing keys in the two biggest lobes (10); the floor is easeOf's 2⁻¹¹ snap at u = 1" },
  { easing: "spring", cls: "sampled", editable: { kind: "sampled" }, exact: { kind: "sampled" }, error: { editable: 0, exact: 0 }, tolerance: 1e-9, note: "dense linear keys at every frame (exact at frames)" },
  { easing: "hold", cls: "hold", editable: HOLD, exact: HOLD, error: { editable: 0, exact: 0 }, spec: { editable: 0 }, tolerance: 1e-12, note: "AE HOLD" },
  { easing: "customBezier", cls: "direct", editable: { kind: "valueBezier" }, exact: { kind: "valueBezier" }, error: { editable: 0, exact: 0 }, spec: { editable: 0 }, tolerance: 1e-9, note: "scalar: the handles ARE AE's (dt, dv) handles; other types play it linear, as toolbox does" },
  { easing: "cubicBezier", cls: "direct", editable: cubic(LINEAR_BEZIER), exact: cubic(LINEAR_BEZIER), error: { editable: 0, exact: 0 }, spec: { editable: 0 }, tolerance: 1e-9, note: "Bodymovin's formula on the key's own shape (the plan here is the missing-shape default)" },
];

const ROW = new Map(AE_EASINGS.map((r) => [r.easing, r]));

export function aeEasingRow(easing: EasingPreset): AeEasingRow | undefined {
  return ROW.get(easing);
}

// How the segment a → b exports. Mirrors interpolate() in keyframes.ts:
// step-only types and hold snap; customBezier is a value-space cubic on
// scalars and linear on every other type; cubicBezier and spring are time
// remaps on every type; an unknown preset plays linear (easeOf's fallback).
export function planSegmentEase(a: Keyframe, b: Keyframe, paramType: ParamType, fidelity: AeFidelityPolicy): AeEasePlan {
  void b;
  if (isStepOnly(paramType) || a.easingOut === "hold") return HOLD;
  if (a.easingOut === "customBezier") return paramType === "scalar" ? { kind: "valueBezier" } : LINEAR;
  if (a.easingOut === "cubicBezier") return cubic(a.bezier ?? LINEAR_BEZIER);
  const row = ROW.get(a.easingOut);
  if (!row) return LINEAR;
  return fidelity === "exact" ? row.exact : row.editable;
}

// Max |plan − easeOf(preset)| over the segment at n + 1 samples — the
// number the table records. Pieces plans only (linear / hold handled by the
// caller; hold is exact by construction).
export function planError(plan: AeEasePlan, oracle: (u: number) => number, n = 20000): number {
  if (plan.kind === "linear") {
    let m = 0;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      m = Math.max(m, Math.abs(oracle(u) - u));
    }
    return m;
  }
  if (plan.kind !== "pieces") return NaN;
  let m = 0;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    m = Math.max(m, Math.abs(oracle(u) - evaluatePieces(plan.pieces, u)));
  }
  return m;
}
