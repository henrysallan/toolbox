// After Effects export — keyframe tracks (spec 091926_after-effects-handoff.md
// §2, §4.2).
//
// A toolbox track (KeyframeAnimationBlock) → an AeProp in AE units. The
// pipeline, per dimension:
//
//   1. each toolbox segment → its AeEasePlan (easing.ts) → AE curve pieces in
//      absolute (seconds, AE value) coordinates: hold / linear / a cubic
//      bezier / "dense" (no closed form, e.g. spring);
//   2. the dimensions are merged onto one key-time grid (AE keys a
//      multi-dimensional property at shared times): a cubic piece split at
//      another dimension's key is two cubics (de Casteljau), so merging
//      scaleX and scaleY tracks with different key times stays exact;
//   3. keys are emitted (eases per dimension, or one ease for spatial / color
//      / path properties), then VERIFIED: the emitted keys are re-evaluated
//      with AE's semantics (evaluateAeKeys) at every frame and compared with
//      evaluateKeyframesAt; any key interval past tolerance — or one AE cannot
//      key at all (a hold in one dimension while another moves) — is replaced
//      by linear keys at every frame, which is exact at frames.
//
// Value maps into AE units must be affine per dimension (px = W·x + offset,
// percent = 100·s, …): an affine map of a cubic is a cubic, so easing
// survives it untouched.

import {
  defaultSegmentHandles,
  evaluateKeyframesAt,
  type Keyframe,
  type KeyframeAnimationBlock,
} from "@/engine/keyframes";
import {
  ANCHOR_IN_PREFIX,
  ANCHOR_OUT_PREFIX,
  ANCHOR_P_PREFIX,
  GPOINT_C_PREFIX,
  GPOINT_X_PREFIX,
  GPOINT_Y_PREFIX,
  LAYER_OPACITY_PREFIX,
  anchorTrackId,
  parseChannelKey,
  parseRampParamKey,
  type RampStopField,
} from "@/engine/conventions";
import type { ParamType, SplineSubpath } from "@/engine/types";
import type { AeEase, AeFidelity, AeFidelityPolicy, AeInterp, AeKey, AePath, AeProp } from "../types";
import {
  AE_INFLUENCE_MAX,
  AE_INFLUENCE_MIN,
  pieceControlPoints,
  piecesMonotone,
  planSegmentEase,
  solveCubicX,
  type AeEasePiece,
} from "./easing";
import { ticksPerFrameOf, type AeTimebase } from "./time";
import { aeRoundCornersPath, planCorners, splineToAePaths, type AeCanvas, type AeCornerPlan } from "./coords";
import { roundCornersPerAnchor } from "@/engine/spline-math";

// ---------------------------------------------------------------------------
// Virtual animation keys (conventions.ts)
// ---------------------------------------------------------------------------

export type AeAnimationKey =
  | { kind: "param"; param: string }
  | { kind: "layerOpacity"; layerId: string }
  | { kind: "gpoint"; field: "x" | "y" | "c"; pointId: string }
  | { kind: "ramp"; field: RampStopField; param: string; stopId: string }
  | { kind: "channel"; name: string }
  | { kind: "anchor"; field: "p" | "in" | "out"; anchorId: string };

export function parseAnimationKey(key: string): AeAnimationKey {
  if (key.startsWith(LAYER_OPACITY_PREFIX)) return { kind: "layerOpacity", layerId: key.slice(LAYER_OPACITY_PREFIX.length) };
  if (key.startsWith(GPOINT_X_PREFIX)) return { kind: "gpoint", field: "x", pointId: key.slice(GPOINT_X_PREFIX.length) };
  if (key.startsWith(GPOINT_Y_PREFIX)) return { kind: "gpoint", field: "y", pointId: key.slice(GPOINT_Y_PREFIX.length) };
  if (key.startsWith(GPOINT_C_PREFIX)) return { kind: "gpoint", field: "c", pointId: key.slice(GPOINT_C_PREFIX.length) };
  const ramp = parseRampParamKey(key);
  if (ramp) return { kind: "ramp", field: ramp.field, param: ramp.paramName, stopId: ramp.stopId };
  const ch = parseChannelKey(key);
  if (ch !== null) return { kind: "channel", name: ch };
  const id = anchorTrackId(key);
  if (id !== null) {
    const field = key.startsWith(ANCHOR_P_PREFIX) ? "p" : key.startsWith(ANCHOR_IN_PREFIX) ? "in" : key.startsWith(ANCHOR_OUT_PREFIX) ? "out" : "p";
    return { kind: "anchor", field, anchorId: id };
  }
  return { kind: "param", param: key };
}

// The ParamType a track's keyframes interpolate as. `defType` is the def's
// own type for a literal param, or the channel row's type for `ch:` keys
// (scalar / toggle → boolean / pick → enum / color); undefined when unknown.
export function animationKeyParamType(k: AeAnimationKey, defType?: ParamType): ParamType | undefined {
  switch (k.kind) {
    case "layerOpacity":
      return "scalar";
    case "gpoint":
      return k.field === "c" ? "color" : "scalar";
    case "ramp":
      return k.field === "color" ? "color" : "scalar";
    case "anchor":
      return "vec2";
    case "channel":
    case "param":
      return defType;
  }
}

// ---------------------------------------------------------------------------
// AE semantics
// ---------------------------------------------------------------------------

// How a multi-dimensional property eases: one ease per dimension (non-spatial
// 2-D / 3-D), or ONE ease on the value's magnitude — spatial position (px/s
// along the path), color, and shape paths.
export type AeEaseMode = "perDim" | "spatial" | "color" | "shape";

// One-ease speed units for properties whose value has no natural length.
// Spatial is AE-documented (px/s along the motion path). For COLOR we assume
// the Euclidean length of the 0–1 RGB(A) delta per second, and for SHAPE
// (path) keys progress through the morph per second (the whole morph = 1).
// Neither was keyed in M0 — the runtime lane should confirm both; fix them
// here only. Linear and hold keys do not depend on them, and the color
// expression / dense modes never emit eased color keys.
export const AE_SHAPE_EASE_MAGNITUDE = 1;

function magnitude(mode: AeEaseMode, d: readonly number[]): number {
  if (mode === "shape") return AE_SHAPE_EASE_MAGNITUDE;
  let s = 0;
  for (const x of d) s += x * x;
  return Math.sqrt(s);
}

const asArray = (v: unknown): number[] => (Array.isArray(v) ? (v as number[]) : [v as number]);

// The value AE plays for `keys` at comp time t (seconds): constant before the
// first key and after the last; HOLD keeps key i's value; LINEAR on both
// sides lerps; otherwise the (time, value) cubic of key i's out ease and key
// i+1's in ease. A LINEAR side next to a BEZIER one reads as a 33.3% handle
// at the linear speed (never emitted here). Ease lists shorter than the
// dimension count are padded with their last entry, as build.jsx does.
export function evaluateAeKeys(keys: readonly AeKey<unknown>[], t: number, mode: AeEaseMode = "perDim"): number[] {
  const n = keys.length;
  if (n === 0) return [];
  if (t <= keys[0].t) return asArray(keys[0].v).slice();
  if (t >= keys[n - 1].t) return asArray(keys[n - 1].v).slice();
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const va = asArray(a.v);
  const vb = asArray(b.v);
  if (a.outInterp === "hold" || b.inInterp === "hold") return va.slice();
  const D = b.t - a.t;
  if (a.outInterp === "linear" && b.inInterp === "linear") {
    const w = (t - a.t) / D;
    return va.map((x, i) => x + (vb[i] - x) * w);
  }
  const ease = (list: readonly AeEase[] | undefined, i: number, interp: AeInterp, delta: number): AeEase =>
    interp === "linear" || !list || list.length === 0
      ? { speed: delta / D, influence: 100 / 3 }
      : list[Math.min(i, list.length - 1)];
  if (mode === "perDim") {
    return va.map((x0, i) => {
      const x1 = vb[i];
      const o = ease(a.easeOut, i, a.outInterp, x1 - x0);
      const p = ease(b.easeIn, i, b.inInterp, x1 - x0);
      return cubicAt(a.t, x0, b.t, x1, o, p, t);
    });
  }
  const d = va.map((x, i) => vb[i] - x);
  const L = magnitude(mode, d);
  const o = ease(a.easeOut, 0, a.outInterp, L);
  const p = ease(b.easeIn, 0, b.inInterp, L);
  const s = cubicAt(a.t, 0, b.t, L, o, p, t);
  if (!(L > 0)) return va.slice();
  return va.map((x, i) => x + d[i] * (s / L));
}

// AE's temporal cubic between (t0, v0) and (t1, v1).
function cubicAt(t0: number, v0: number, t1: number, v1: number, out: AeEase, inn: AeEase, t: number): number {
  const D = t1 - t0;
  const fo = out.influence / 100;
  const fi = inn.influence / 100;
  const x1 = Math.min(1, Math.max(0, fo));
  const x2 = Math.min(1, Math.max(0, 1 - fi));
  const y1 = v0 + out.speed * fo * D;
  const y2 = v1 - inn.speed * fi * D;
  const s = solveCubicX(x1, x2, (t - t0) / D);
  const o = 1 - s;
  return o * o * o * v0 + 3 * o * o * s * y1 + 3 * o * s * s * y2 + s * s * s * v1;
}

// An AeProp of numbers / number tuples at time t.
export function evaluateAeProp(prop: AeProp<unknown>, t: number, mode: AeEaseMode = "perDim"): number[] {
  if ("v" in prop) return asArray(prop.v).slice();
  return evaluateAeKeys(prop.keys, t, mode);
}

// A path property at time t (one ease, AE_SHAPE_EASE_MAGNITUDE units).
export function evaluateAePathProp(prop: AeProp<AePath>, t: number): AePath {
  if ("v" in prop) return prop.v;
  const keys = prop.keys;
  const flat = keys.map((k) => ({ ...k, v: flattenPath(k.v) }));
  return unflattenPath(evaluateAeKeys(flat, t, "shape"), keys[0].v.closed);
}

function flattenPath(p: AePath): number[] {
  const out: number[] = [];
  for (let i = 0; i < p.vertices.length; i++) {
    out.push(p.vertices[i][0], p.vertices[i][1], p.inTangents[i][0], p.inTangents[i][1], p.outTangents[i][0], p.outTangents[i][1]);
  }
  return out;
}

function unflattenPath(f: number[], closed: boolean): AePath {
  const p: AePath = { vertices: [], inTangents: [], outTangents: [], closed };
  for (let i = 0; i + 5 < f.length; i += 6) {
    p.vertices.push([f[i], f[i + 1]]);
    p.inTangents.push([f[i + 2], f[i + 3]]);
    p.outTangents.push([f[i + 4], f[i + 5]]);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Curve model
// ---------------------------------------------------------------------------

export interface AeKeyContext extends AeTimebase {
  fidelity: AeFidelityPolicy;
  // The track's ticks run on a clock offset by this many ticks (a layer's
  // interior, time.ts layerTimings). AE key times are comp seconds.
  offsetTicks?: number;
  // Verifier tolerance in AE units: |AE − toolbox| ≤ abs + rel·|Δ of the
  // toolbox segment|. Default rel 0.65% Editable (the table's worst fit plus
  // margin) / 0.11% Exact (the expo floor is 0.098%), abs 1e-4.
  tolerance?: { abs?: number; rel?: number };
  // Extra comp frames the verifier must cover beyond the keys (e.g. the comp
  // range); constant outside the keys anyway.
  frames?: [number, number];
}

// ae = scale·v + offset, per dimension.
export interface AeAffine {
  scale: number;
  offset: number;
}

const IDENTITY: AeAffine = { scale: 1, offset: 0 };

export interface AeTrackReport {
  // Max |AE − toolbox| over the verified frames, AE units (max over dims).
  maxError: number;
  // Key intervals replaced by per-frame linear keys, and why.
  dense: { t0: number; t1: number; reason: string; error?: number }[];
  // exact (float noise) | approx (a best fit within tolerance) | sampled
  // (some intervals are per-frame keys — exact at frames).
  fidelity: AeFidelity;
  notes: string[];
}

export interface AeTrackResult<T> {
  prop: AeProp<T>;
  report: AeTrackReport;
}

type SegKind = "hold" | "linear" | "bezier" | "const" | "dense";

// One AE curve piece of one dimension, absolute coordinates.
interface Seg {
  t0: number;
  t1: number;
  v0: number;
  v1: number;
  kind: SegKind;
  // Bezier control points (seconds, AE units).
  c?: [number, number, number, number];
  // |Δ| of the toolbox segment this piece came from — the relative tolerance's
  // reference (a bounce piece runs 1 → 1, its segment does not).
  ref: number;
  reason?: string;
}

// A dimension: its pieces in time order (empty = static at `value`).
interface Dim {
  segs: Seg[];
  value: number;
}

function keyTime(k: Keyframe, ctx: AeKeyContext): number {
  return (k.tick + (ctx.offsetTicks ?? 0)) / (ticksPerFrameOf(ctx) * ctx.fps);
}

// Dimension `dim` of a keyframe value: numbers, tuples, booleans, and color
// hex strings (#rgb / #rrggbb / #rrggbbaa → 0–1 RGBA, keyframes.ts's
// toRgbaTuple rule: 6 digits ⇒ alpha 1).
export function component(v: unknown, dim: number): number {
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return typeof v[dim] === "number" ? (v[dim] as number) : dim === 3 ? 1 : 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return hexComponent(v, dim);
  return 0;
}

function hexComponent(hex: string, dim: number): number {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
  if (dim === 3) {
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return Number.isFinite(a) ? a : 1;
  }
  const n = parseInt(h.slice(0, 6) || "0", 16);
  return ((n >> (16 - 8 * dim)) & 0xff) / 255;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// One dimension of a toolbox track → pieces.
function dimFromTrack(block: KeyframeAnimationBlock, paramType: ParamType, dim: number, map: AeAffine, ctx: AeKeyContext): Dim {
  const ks = block.keyframes;
  const val = (k: Keyframe) => map.scale * component(k.value, dim) + map.offset;
  if (!block.animated || ks.length === 0) return { segs: [], value: map.offset };
  if (ks.length === 1) return { segs: [], value: val(ks[0]) };
  const segs: Seg[] = [];
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    const ta = keyTime(a, ctx);
    const tb = keyTime(b, ctx);
    const va = val(a);
    const vb = val(b);
    const D = tb - ta;
    const dv = vb - va;
    const ref = Math.abs(dv);
    const plan = planSegmentEase(a, b, paramType, ctx.fidelity);
    switch (plan.kind) {
      case "hold":
        segs.push({ t0: ta, t1: tb, v0: va, v1: vb, kind: "hold", ref });
        break;
      case "linear":
        segs.push({ t0: ta, t1: tb, v0: va, v1: vb, kind: "linear", ref });
        break;
      case "sampled":
        segs.push({ t0: ta, t1: tb, v0: va, v1: vb, kind: "dense", ref, reason: `${a.easingOut}: no AE form, sampled per frame` });
        break;
      case "valueBezier": {
        // interpolate()'s scalar customBezier: x from dx / span (clamped into
        // [0, 1]), y from dy in value units — AE's own handle model.
        const span = b.tick - a.tick;
        const def = defaultSegmentHandles(a, b);
        const right = a.bezierHandles?.rightHandle ?? def.right;
        const left = b.bezierHandles?.leftHandle ?? def.left;
        const x1 = clamp01(span > 0 ? right.dx / span : 0);
        const x2 = clamp01(span > 0 ? 1 + left.dx / span : 1);
        segs.push({
          t0: ta,
          t1: tb,
          v0: va,
          v1: vb,
          kind: "bezier",
          c: [ta + x1 * D, va + map.scale * right.dy, ta + x2 * D, vb + map.scale * left.dy],
          ref: Math.max(ref, Math.abs(map.scale * right.dy), Math.abs(map.scale * left.dy)),
        });
        break;
      }
      case "pieces":
        for (const p of plan.pieces) {
          const cp = pieceControlPoints(p);
          segs.push({
            t0: ta + p.u0 * D,
            t1: ta + p.u1 * D,
            v0: va + p.v0 * dv,
            v1: va + p.v1 * dv,
            kind: "bezier",
            c: [ta + cp[2] * D, va + cp[3] * dv, ta + cp[4] * D, va + cp[5] * dv],
            ref,
          });
        }
        break;
    }
  }
  return { segs, value: val(ks[0]) };
}

// The part of `s` on [a, b] ⊆ [s.t0, s.t1].
function restrict(s: Seg, a: number, b: number): Seg {
  if (a <= s.t0 && b >= s.t1) {
    if (s.kind === "hold" && s.v0 === s.v1) return { ...s, kind: "const" };
    return s;
  }
  switch (s.kind) {
    case "hold":
      // Only the piece that ends at the jump is a real hold; before it the
      // dimension just stays put.
      return b < s.t1 || s.v0 === s.v1
        ? { ...s, t0: a, t1: b, v1: s.v0, kind: "const" }
        : { ...s, t0: a, t1: b };
    case "const":
      return { ...s, t0: a, t1: b };
    case "linear":
    case "dense": {
      const at = (t: number) => s.v0 + ((s.v1 - s.v0) * (t - s.t0)) / (s.t1 - s.t0);
      return { ...s, t0: a, t1: b, v0: at(a), v1: at(b) };
    }
    case "bezier": {
      let cur = s;
      if (a > cur.t0) cur = splitBezier(cur, a)[1];
      if (b < cur.t1) cur = splitBezier(cur, b)[0];
      return cur;
    }
  }
}

// de Casteljau at the parameter where the time coordinate reaches τ.
function splitBezier(s: Seg, tau: number): [Seg, Seg] {
  const [c1t, c1v, c2t, c2v] = s.c!;
  const D = s.t1 - s.t0;
  const x1 = (c1t - s.t0) / D;
  const x2 = (c2t - s.t0) / D;
  const u = solveCubicX(Math.min(1, Math.max(0, x1)), Math.min(1, Math.max(0, x2)), (tau - s.t0) / D);
  const lerp = (p: number, q: number) => p + (q - p) * u;
  const P0 = [s.t0, s.v0];
  const P1 = [c1t, c1v];
  const P2 = [c2t, c2v];
  const P3 = [s.t1, s.v1];
  const Q1 = [lerp(P0[0], P1[0]), lerp(P0[1], P1[1])];
  const M12 = [lerp(P1[0], P2[0]), lerp(P1[1], P2[1])];
  const R2 = [lerp(P2[0], P3[0]), lerp(P2[1], P3[1])];
  const Q2 = [lerp(Q1[0], M12[0]), lerp(Q1[1], M12[1])];
  const R1 = [lerp(M12[0], R2[0]), lerp(M12[1], R2[1])];
  const M = [lerp(Q2[0], R1[0]), lerp(Q2[1], R1[1])];
  // Pin the split exactly at τ (M[0] is τ to the solver's precision).
  return [
    { ...s, t1: tau, v1: M[1], c: [Q1[0], Q1[1], Q2[0], Q2[1]] },
    { ...s, t0: tau, v0: M[1], c: [R1[0], R1[1], R2[0], R2[1]] },
  ];
}

function valueAt(d: Dim, t: number): number {
  if (d.segs.length === 0) return d.value;
  if (t <= d.segs[0].t0) return d.segs[0].v0;
  const last = d.segs[d.segs.length - 1];
  if (t >= last.t1) return last.v1;
  for (const s of d.segs) if (t <= s.t1) return restrict(s, s.t0, t).v1;
  return last.v1;
}

// One key interval of the merged property.
interface Interval {
  t0: number;
  t1: number;
  kind: "hold" | "linear" | "bezier" | "dense";
  segs: Seg[]; // per dimension, aligned to [t0, t1]
  reason?: string;
}

const TIME_EPS = 1e-9;

function mergeDims(dims: Dim[]): { times: number[]; intervals: Interval[] } {
  const all: number[] = [];
  for (const d of dims) for (const s of d.segs) all.push(s.t0, s.t1);
  all.sort((a, b) => a - b);
  const times: number[] = [];
  for (const t of all) if (times.length === 0 || t - times[times.length - 1] > TIME_EPS) times.push(t);
  const intervals: Interval[] = [];
  for (let k = 0; k + 1 < times.length; k++) {
    const a = times[k];
    const b = times[k + 1];
    const segs = dims.map((d): Seg => {
      const s = d.segs.find((x) => x.t0 <= a + TIME_EPS && x.t1 >= b - TIME_EPS);
      if (!s) {
        const v = valueAt(d, a);
        return { t0: a, t1: b, v0: v, v1: v, kind: "const", ref: 0 };
      }
      return restrict(s, Math.max(a, s.t0), Math.min(b, s.t1));
    });
    const kinds = new Set(segs.map((s) => s.kind));
    let kind: Interval["kind"];
    let reason: string | undefined;
    if (kinds.has("dense")) {
      kind = "dense";
      reason = segs.find((s) => s.kind === "dense")?.reason;
    } else if (kinds.has("hold")) {
      if ([...kinds].every((x) => x === "hold" || x === "const")) kind = "hold";
      else {
        kind = "dense";
        reason = "one dimension holds while another moves (AE interpolation is per key, not per dimension)";
      }
    } else if (kinds.has("bezier")) kind = "bezier";
    else kind = "linear";
    intervals.push({ t0: a, t1: b, kind, segs, reason });
  }
  return { times, intervals };
}

// ---------------------------------------------------------------------------
// Key emission
// ---------------------------------------------------------------------------

function easeFromHandle(dt: number, dv: number, D: number): AeEase {
  let f = dt / D;
  if (!(f >= AE_INFLUENCE_MIN / 100)) f = AE_INFLUENCE_MIN / 100;
  if (f > AE_INFLUENCE_MAX / 100) f = AE_INFLUENCE_MAX / 100;
  // Keep the control point's height when the influence clamps.
  return { influence: 100 * f, speed: dv / (f * D) };
}

// A dimension's cubic on its interval (linear / const as their exact cubic).
function controls(s: Seg): [number, number, number, number] {
  if (s.kind === "bezier" && s.c) return s.c;
  const D = s.t1 - s.t0;
  const dv = s.v1 - s.v0;
  return [s.t0 + D / 3, s.v0 + dv / 3, s.t1 - D / 3, s.v1 - dv / 3];
}

// Spatial / color / shape: one ease on the magnitude. Only intervals whose
// dimensions move along one straight line with one progress curve qualify;
// the builders below guarantee that (or mark the interval dense).
function emit(times: number[], intervals: Interval[], mode: AeEaseMode, oracle: (tick: number) => number[], ctx: AeKeyContext): AeKey<number[]>[] {
  const keys: AeKey<number[]>[] = [];
  const valueAtKey = (k: number): number[] =>
    k < intervals.length ? intervals[k].segs.map((s) => s.v0) : intervals[intervals.length - 1].segs.map((s) => s.v1);
  const interpOf = (iv: Interval): AeInterp => (iv.kind === "bezier" ? "bezier" : iv.kind === "hold" ? "hold" : "linear");
  for (let k = 0; k < times.length; k++) {
    const key: AeKey<number[]> = { t: times[k], v: valueAtKey(k), inInterp: "linear", outInterp: "linear" };
    if (k > 0) key.inInterp = interpOf(intervals[k - 1]);
    if (k < intervals.length) key.outInterp = interpOf(intervals[k]);
    if (k === 0) key.inInterp = key.outInterp === "hold" ? "hold" : "linear";
    if (k === times.length - 1) key.outInterp = key.inInterp === "hold" ? "hold" : "linear";
    keys.push(key);
  }
  // Eases.
  for (let k = 0; k < intervals.length; k++) {
    const iv = intervals[k];
    if (iv.kind !== "bezier") continue;
    const D = iv.t1 - iv.t0;
    const a = keys[k];
    const b = keys[k + 1];
    if (mode === "perDim") {
      a.easeOut = iv.segs.map((s) => {
        const c = controls(s);
        return easeFromHandle(c[0] - s.t0, c[1] - s.v0, D);
      });
      b.easeIn = iv.segs.map((s) => {
        const c = controls(s);
        return easeFromHandle(s.t1 - c[2], s.v1 - c[3], D);
      });
    } else {
      // The builders store a single-ease interval as one progress dimension
      // (segs[0], 0 → L) followed by the value dimensions.
      const s = iv.segs[0];
      const c = controls(s);
      a.easeOut = [easeFromHandle(c[0] - s.t0, c[1] - s.v0, D)];
      b.easeIn = [easeFromHandle(s.t1 - c[2], s.v1 - c[3], D)];
    }
  }
  // Dense intervals: per-frame linear keys, values from the oracle.
  const out: AeKey<number[]>[] = [];
  for (let k = 0; k < keys.length; k++) {
    out.push(keys[k]);
    if (k < intervals.length && intervals[k].kind === "dense") {
      const iv = intervals[k];
      keys[k].outInterp = "linear";
      delete keys[k].easeOut;
      keys[k + 1].inInterp = "linear";
      delete keys[k + 1].easeIn;
      for (const f of framesInside(iv.t0, iv.t1, ctx)) {
        out.push({ t: frameTime(f, ctx), v: oracle(frameTick(f, ctx)), inInterp: "linear", outInterp: "linear" });
      }
    }
  }
  if (mode !== "perDim") for (const key of out) key.v = key.v.slice(1);
  return out;
}

// A comp frame's time by the same formula as key times (tick / (tpf·fps)),
// so a frame on a key's tick lands on the key's time to the bit, and the
// toolbox tick of that frame on the track's own clock (exact integers).
export function frameTime(f: number, ctx: AeTimebase): number {
  const tpf = ticksPerFrameOf(ctx);
  return (f * tpf) / (tpf * ctx.fps);
}

function frameTick(f: number, ctx: AeKeyContext): number {
  return f * ticksPerFrameOf(ctx) - (ctx.offsetTicks ?? 0);
}

function framesInside(t0: number, t1: number, ctx: AeKeyContext): number[] {
  const out: number[] = [];
  const f0 = Math.ceil(t0 * ctx.fps - 1e-6);
  const f1 = Math.floor(t1 * ctx.fps + 1e-6);
  for (let f = f0; f <= f1; f++) {
    const t = frameTime(f, ctx);
    if (t > t0 + 1e-9 && t < t1 - 1e-9) out.push(f);
  }
  return out;
}

function framesBetween(t0: number, t1: number, ctx: AeTimebase): number[] {
  const out: number[] = [];
  const f0 = Math.ceil(t0 * ctx.fps - 1e-6);
  const f1 = Math.floor(t1 * ctx.fps + 1e-6);
  for (let f = f0; f <= f1; f++) {
    const t = frameTime(f, ctx);
    if (t >= t0 - 1e-9 && t <= t1 + 1e-9) out.push(f);
  }
  return out;
}

function defaultTolerance(ctx: AeKeyContext): { abs: number; rel: number } {
  return {
    abs: ctx.tolerance?.abs ?? 1e-4,
    rel: ctx.tolerance?.rel ?? (ctx.fidelity === "exact" ? 0.0011 : 0.0065),
  };
}

// The full build-verify-densify loop over merged intervals. `oracle(tick)` is
// toolbox's value in AE units at a tick of the track's own clock (for
// single-ease modes WITHOUT the progress dimension).
function finalize(
  times: number[],
  intervals: Interval[],
  mode: AeEaseMode,
  oracle: (tick: number) => number[],
  ctx: AeKeyContext
): { keys: AeKey<number[]>[]; report: AeTrackReport } {
  const tol = defaultTolerance(ctx);
  const single = mode !== "perDim";
  const dense: AeTrackReport["dense"] = [];
  const oracleFull = single ? (tick: number) => [0, ...oracle(tick)] : oracle;
  let keys = emit(times, intervals, mode, oracleFull, ctx);
  let refMax = 0;
  // Verify each non-dense interval at its frames.
  let changed = false;
  for (let k = 0; k < intervals.length; k++) {
    const iv = intervals[k];
    if (iv.kind === "dense") {
      dense.push({ t0: iv.t0, t1: iv.t1, reason: iv.reason ?? "no AE form" });
      continue;
    }
    const ref = Math.max(0, ...iv.segs.slice(single ? 1 : 0).map((s) => s.ref));
    refMax = Math.max(refMax, ref);
    const allowed = tol.abs + tol.rel * ref;
    let worst = 0;
    for (const f of framesBetween(iv.t0, iv.t1, ctx)) {
      const have = evaluateAeKeys(keys, frameTime(f, ctx), mode);
      const want = oracle(frameTick(f, ctx));
      for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(have[i] - want[i]));
    }
    if (worst > allowed) {
      intervals[k] = { ...iv, kind: "dense", reason: `AE curve misses by ${worst.toPrecision(3)} (> ${allowed.toPrecision(3)})` };
      dense.push({ t0: iv.t0, t1: iv.t1, reason: intervals[k].reason!, error: worst });
      changed = true;
    }
  }
  if (changed) keys = emit(times, intervals, mode, oracleFull, ctx);
  // Final measurement over every frame the keys span (+ ctx.frames).
  let maxError = 0;
  if (times.length > 0) {
    let t0 = times[0];
    let t1 = times[times.length - 1];
    if (ctx.frames) {
      t0 = Math.min(t0, ctx.frames[0] / ctx.fps);
      t1 = Math.max(t1, ctx.frames[1] / ctx.fps);
    }
    for (const f of framesBetween(t0, t1, ctx)) {
      const have = evaluateAeKeys(keys, frameTime(f, ctx), mode);
      const want = oracle(frameTick(f, ctx));
      for (let i = 0; i < want.length; i++) maxError = Math.max(maxError, Math.abs(have[i] - want[i]));
    }
  }
  return {
    keys,
    report: {
      maxError,
      dense,
      // Float noise counts as exact; a best fit (Editable) is approx.
      fidelity: dense.length > 0 ? "sampled" : maxError <= 1e-6 * (1 + refMax) ? "exact" : "approx",
      notes: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

// A track or a constant (an un-keyed param's stored value).
export type AeTrackSource = KeyframeAnimationBlock | number | number[] | undefined;

export function isKeyed(src: AeTrackSource): src is KeyframeAnimationBlock {
  return !!src && typeof src === "object" && !Array.isArray(src) && src.animated && src.keyframes.length > 1;
}

function sourceValueAt(src: AeTrackSource, paramType: ParamType, dim: number, tick: number, fallback: number): number {
  if (src === undefined) return fallback;
  if (typeof src === "number") return src;
  if (Array.isArray(src)) return typeof src[dim] === "number" ? src[dim] : fallback;
  if (!src.animated || src.keyframes.length === 0) return fallback;
  const v = evaluateKeyframesAt(src, paramType, tick);
  return v === undefined ? fallback : component(v, dim);
}

function dimFromSource(src: AeTrackSource, paramType: ParamType, dim: number, map: AeAffine, ctx: AeKeyContext, fallback: number): Dim {
  if (isKeyed(src)) return dimFromTrack(src, paramType, dim, map, ctx);
  return { segs: [], value: map.scale * sourceValueAt(src, paramType, dim, 0, fallback) + map.offset };
}

function staticOrKeys(keys: AeKey<number[]>[], dims: number, scalar: boolean): AeProp<number | number[]> {
  if (keys.length === 0) return { v: scalar ? 0 : new Array(dims).fill(0) };
  const unwrap = (k: AeKey<number[]>): AeKey<number | number[]> => (scalar ? { ...k, v: k.v[0] } : k);
  return { keys: keys.map(unwrap), dims: dims as 1 | 2 | 3 | 4 };
}

export interface AeNumericOptions extends AeKeyContext {
  // Per-dimension affine map into AE units (one entry applies to all dims).
  map?: AeAffine | AeAffine[];
  // Value of a missing / un-keyed dimension before the map (default 0).
  fallback?: number[];
}

// Toolbox's value of `parts` in AE units at a tick of the track's clock.
export function partsOracle(parts: { src: AeTrackSource; paramType: ParamType; dim?: number }[], opts: AeNumericOptions): (tick: number) => number[] {
  return (tick) =>
    parts.map((p, d) => {
      const m = mapFor(opts, d);
      return m.scale * sourceValueAt(p.src, p.paramType, p.dim ?? 0, tick, opts.fallback?.[d] ?? 0) + m.offset;
    });
}

function mapFor(opts: AeNumericOptions, d: number): AeAffine {
  const m = opts.map;
  if (!m) return IDENTITY;
  return Array.isArray(m) ? (m[d] ?? m[m.length - 1]) : m;
}

// One scalar or vector track → a non-spatial property (one ease per
// dimension). Static when the track has < 2 keys; `stored` is the param's
// constant for an un-keyed track.
export function numericTrackToAe(
  src: AeTrackSource,
  paramType: "scalar" | "vec2" | "vec3" | "vec4",
  opts: AeNumericOptions
): AeTrackResult<number | number[]> {
  const n = paramType === "scalar" ? 1 : Number(paramType.slice(3));
  return combinedTracksToAe(
    Array.from({ length: n }, (_, d) => ({ src, paramType, dim: d })),
    opts,
    paramType === "scalar"
  );
}

// Several scalar tracks (or dims of tracks) → ONE multi-dimensional,
// non-spatial property: scaleX + scaleY → Scale, pivotX + pivotY → Anchor
// Point, gpoint_x + gpoint_y → a point. Key times are the union; every cubic
// is split exactly at the others' keys.
export function combinedTracksToAe(
  parts: { src: AeTrackSource; paramType: ParamType; dim?: number }[],
  opts: AeNumericOptions,
  scalar = false
): AeTrackResult<number | number[]> {
  const dims = parts.map((p, d) => dimFromSource(p.src, p.paramType, p.dim ?? 0, mapFor(opts, d), opts, opts.fallback?.[d] ?? 0));
  const { times, intervals } = mergeDims(dims);
  const oracle = partsOracle(parts, opts);
  if (times.length === 0) {
    const v = dims.map((d) => d.value);
    return {
      prop: { v: scalar ? v[0] : v },
      report: { maxError: 0, dense: [], fidelity: "exact", notes: [] },
    };
  }
  const { keys, report } = finalize(times, intervals, "perDim", oracle, opts);
  return { prop: staticOrKeys(keys, parts.length, scalar), report };
}

// Do these tracks key at the same ticks with the same easing data? (Then a
// vector made of them moves along one straight line per segment.)
export function tracksShareTiming(tracks: AeTrackSource[]): boolean {
  const keyed = tracks.filter(isKeyed);
  if (keyed.length < 2) return true;
  const [first, ...rest] = keyed;
  return rest.every(
    (b) =>
      b.keyframes.length === first.keyframes.length &&
      b.keyframes.every((k, i) => {
        const a = first.keyframes[i];
        if (k.tick !== a.tick || k.easingOut !== a.easingOut) return false;
        if (k.easingOut === "customBezier" && i < b.keyframes.length - 1) return false;
        if (k.easingOut === "cubicBezier" && JSON.stringify(k.bezier) !== JSON.stringify(a.bezier)) return false;
        if (k.easingOut === "spring" && JSON.stringify(k.spring) !== JSON.stringify(a.spring)) return false;
        return true;
      })
  );
}

// Spatial position from per-axis tracks that share timing (tracksShareTiming)
// or one vec2/vec3 track: straight lines between keys, ONE ease per key on
// the distance along the path (px/s). Returns null when a segment's progress
// overshoots or reverses (back, bounce, elastic, spring…): AE's spatial speed
// is a magnitude, so those need separated dimensions (the caller falls back
// to separatedPositionToAe).
export function spatialTrackToAe(
  parts: { src: AeTrackSource; paramType: ParamType; dim?: number }[],
  opts: AeNumericOptions,
  // "color": one ease on the RGB delta (non-spatial); a segment whose
  // progress overshoots or reverses goes dense instead of failing the track.
  mode: "spatial" | "color" = "spatial"
): AeTrackResult<number[]> | null {
  const srcs = parts.map((p) => p.src);
  if (!tracksShareTiming(srcs.filter((s, i) => parts.findIndex((p) => p.src === s) === i))) return null;
  const lead = srcs.find(isKeyed);
  const oracle = partsOracle(parts, opts);
  if (!lead) {
    return { prop: { v: oracle(0) }, report: { maxError: 0, dense: [], fidelity: "exact", notes: [] } };
  }
  const ks = lead.keyframes;
  const paramType = parts.find((p) => p.src === lead)!.paramType;
  const times: number[] = [];
  const intervals: Interval[] = [];
  // Key values straight from the keys (sampling at a key's tick would read a
  // hold segment's old value on the wrong side of float noise).
  const valueAtKey = (i: number) =>
    parts.map((p, d) => {
      const m = mapFor(opts, d);
      const v = isKeyed(p.src) ? component(p.src.keyframes[i].value, p.dim ?? 0) : sourceValueAt(p.src, p.paramType, p.dim ?? 0, 0, opts.fallback?.[d] ?? 0);
      return m.scale * v + m.offset;
    });
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    const ta = keyTime(a, opts);
    const tb = keyTime(b, opts);
    const pa = valueAtKey(i);
    const pb = valueAtKey(i + 1);
    const dp = pb.map((x, d) => x - pa[d]);
    const L = Math.hypot(...dp);
    const D = tb - ta;
    const plan = planSegmentEase(a, b, paramType, opts.fidelity);
    const lin = (t0: number, t1: number, v0: number[], v1: number[], kind: Interval["kind"], s0: number, s1: number, c?: Seg["c"], reason?: string): Interval => ({
      t0,
      t1,
      kind,
      reason,
      segs: [
        { t0, t1, v0: s0, v1: s1, kind: kind === "dense" ? "dense" : kind === "bezier" ? "bezier" : kind === "hold" ? "hold" : "linear", c, ref: L },
        ...v0.map((x, d): Seg => ({ t0, t1, v0: x, v1: v1[d], kind: "linear", ref: Math.abs(dp[d]) })),
      ],
    });
    if (i === 0) times.push(ta);
    if (plan.kind === "hold") intervals.push(lin(ta, tb, pa, pb, "hold", 0, L));
    else if (plan.kind === "linear") intervals.push(lin(ta, tb, pa, pb, "linear", 0, L));
    else if (plan.kind === "sampled") intervals.push(lin(ta, tb, pa, pb, "dense", 0, L, undefined, `${a.easingOut}: no AE form, sampled per frame`));
    else if (plan.kind === "valueBezier") return null;
    else if (!piecesMonotone(flattenDips(plan.pieces)) && (mode === "spatial" || !smallOvershoot(plan.pieces))) {
      if (mode === "spatial") return null;
      intervals.push(lin(ta, tb, pa, pb, "dense", 0, L, undefined, `${a.easingOut} overshoots or returns: one color ease cannot`));
    } else {
      const ok = piecesMonotone(flattenDips(plan.pieces));
      for (const p of ok ? flattenDips(plan.pieces) : plan.pieces) {
        const cp = pieceControlPoints(p);
        const t0 = ta + p.u0 * D;
        const t1 = ta + p.u1 * D;
        const v0 = pa.map((x, d) => x + dp[d] * p.v0);
        const v1 = pa.map((x, d) => x + dp[d] * p.v1);
        const s0 = p.v0 * L;
        const s1 = p.v1 * L;
        // Progress in px along the whole segment's line, re-based to this piece.
        intervals.push(lin(t0, t1, v0, v1, "bezier", s0 - s0, s1 - s0, [ta + cp[2] * D, cp[3] * L - s0, ta + cp[4] * D, cp[5] * L - s0]));
        if (p.u1 < 1) times.push(t1);
      }
    }
    times.push(tb);
  }
  const { keys, report } = finalize(times, intervals, mode, oracle, opts);
  return { prop: { keys, dims: parts.length as 1 | 2 | 3 | 4 }, report };
}

// Linear keys at every comp frame in [f0, f1] from `oracle(tick)` — for values
// that are not a keyframe track at all (a local pivot riding an animated
// bounding box, a sum of two independently eased tracks). Exact at frames.
// Static when every sample agrees.
export function sampledTrackToAe(
  frames: [number, number],
  oracle: (tick: number) => number[],
  ctx: AeKeyContext,
  reason = "sampled per frame"
): AeTrackResult<number[]> {
  const keys: AeKey<number[]>[] = [];
  for (let f = frames[0]; f <= frames[1]; f++) {
    keys.push({ t: frameTime(f, ctx), v: oracle(frameTick(f, ctx)), inInterp: "linear", outInterp: "linear" });
  }
  const same = keys.every((k) => k.v.every((x, i) => Math.abs(x - keys[0].v[i]) < 1e-12));
  if (keys.length < 2 || same) {
    return { prop: { v: keys[0]?.v ?? [] }, report: { maxError: 0, dense: [], fidelity: "exact", notes: [] } };
  }
  return {
    prop: { keys, dims: keys[0].v.length as 1 | 2 | 3 | 4 },
    report: { maxError: 0, dense: [{ t0: keys[0].t, t1: keys[keys.length - 1].t, reason }], fidelity: "sampled", notes: [] },
  };
}

// The comp-frame span [first, last] a track's keys cover.
export function keyFrameSpan(src: AeTrackSource, ctx: AeKeyContext): [number, number] | null {
  if (!isKeyed(src)) return null;
  const tpf = ticksPerFrameOf(ctx);
  const off = ctx.offsetTicks ?? 0;
  const ks = src.keyframes;
  return [Math.floor((ks[0].tick + off) / tpf), Math.ceil((ks[ks.length - 1].tick + off) / tpf)];
}

// A one-ease (spatial / color) speed is a magnitude, so a fit whose end slope
// dips a hair below zero (the minimax sine fits: −0.004) is flattened to 0;
// the verifier then holds the changed curve to tolerance like any other.
const DIP = 0.02;
function flattenDips(pieces: readonly AeEasePiece[]): AeEasePiece[] {
  return pieces.map((p) => ({
    ...p,
    outSlope: p.outSlope < 0 && p.outSlope > -DIP ? 0 : p.outSlope,
    inSlope: p.inSlope < 0 && p.inSlope > -DIP ? 0 : p.inSlope,
  }));
}

// A color's one ease may carry a fit's slight over/undershoot (the in-out
// cubic fit dips 4% of the way at its control point, ~0.6% on the curve):
// pieces that each move forward and whose controls stay within 5% of [0, 1].
// Back, bounce and elastic do not qualify. AE's handling of a one-ease color
// past its keys is unverified; the verifier models it as extrapolation.
function smallOvershoot(pieces: readonly AeEasePiece[]): boolean {
  return pieces.every((p) => {
    if (!(p.v1 > p.v0)) return false;
    const [, y0, , y1, , y2, , y3] = pieceControlPoints(p);
    return [y0, y1, y2, y3].every((y) => y >= -0.05 && y <= 1.05);
  });
}

// Boolean / enum tracks: HOLD everywhere; `mapValue` turns the toolbox value
// into what AE's property takes (checkbox 0/1, a dropdown's 1-based index…).
export function stepTrackToAe<T>(src: KeyframeAnimationBlock, mapValue: (v: unknown) => T, ctx: AeKeyContext): AeProp<T> {
  const ks = src.keyframes;
  if (!src.animated || ks.length === 0) throw new Error("stepTrackToAe: empty track");
  if (ks.length === 1) return { v: mapValue(ks[0].value) };
  return {
    keys: ks.map((k) => ({ t: keyTime(k, ctx), v: mapValue(k.value), inInterp: "hold", outInterp: "hold" })),
    dims: 1,
  };
}

// ---------------------------------------------------------------------------
// Path keys (spline_anchors)
// ---------------------------------------------------------------------------

export interface AePathTrackResult {
  // One Path property per subpath, sharing key times.
  paths: AeProp<AePath>[];
  // Present when AE's Round Corners carries the live corners: px, static or
  // keyed at the same times as the paths.
  roundCorners?: AeProp<number>;
  report: AeTrackReport;
}

type SplineKf = { subpaths: SplineSubpath[] };

// Whole-shape Path Animation → AE path keys. Every key needs the same
// subpath and vertex counts (AE morphs vertex by vertex, as toolbox does by
// index); `{ error }` when they differ — bake instead. Live corners go to a
// Round Corners item when every key qualifies (planCorners "uniform"; the
// radius rides the morph as one more dimension, so an animated radius keys at
// the path's times with the same progress), otherwise they are baked into each
// key's vertices (which then also needs a constant vertex count). Verified
// per frame in px against toolbox's own morph + fillet; intervals past
// tolerance get per-frame path keys.
export function splineTrackToAe(
  block: KeyframeAnimationBlock,
  c: AeCanvas,
  ctx: AeKeyContext & { tolerancePx?: number }
): AePathTrackResult | { error: string } {
  const ks = block.keyframes;
  if (!block.animated || ks.length === 0) return { error: "not keyed" };
  const tolPx = ctx.tolerancePx ?? 0.25;
  const plans = ks.map((k) => planCorners(k.value as SplineKf, c));
  const hasCorners = plans.some((p) => p.kind !== "none");
  const uniform = hasCorners && plans.every((p) => p.kind === "uniform" || p.kind === "none");
  const mode: "raw" | "uniform" | "baked" = !hasCorners ? "raw" : uniform ? "uniform" : "baked";
  const shapeAt = (v: SplineKf): AePath[] =>
    mode === "baked" ? splineToAePaths({ subpaths: roundCornersPerAnchor(v.subpaths) }, c) : splineToAePaths(v, c);
  const radiusAt = (v: SplineKf): number => {
    for (const s of v.subpaths) for (const a of s.anchors) if ((a.cornerRadius ?? 0) > 1e-6) return (a.cornerRadius as number) * c.width;
    return 0;
  };
  const perKey = ks.map((k) => shapeAt(k.value as SplineKf));
  const counts = perKey[0].map((p) => p.vertices.length);
  for (const pk of perKey) {
    if (pk.length !== counts.length) return { error: "subpath count changes between keys" };
    for (let i = 0; i < pk.length; i++) {
      if (pk[i].vertices.length !== counts[i]) {
        return { error: `vertex count of subpath ${i} changes between keys${mode === "baked" ? " (after baking live corners)" : ""}` };
      }
    }
  }
  const closed = perKey[0].map((p) => p.closed);
  // The morph as one flattened coordinate list (+ the radius in uniform mode).
  const flat = (v: SplineKf) => {
    const f = shapeAt(v).flatMap(flattenPath);
    if (mode === "uniform") f.push(radiusAt(v));
    return f;
  };
  const toolboxAt = (tick: number): SplineKf => (evaluateKeyframesAt(block, "spline_anchors", tick) as SplineKf | undefined) ?? (ks[0].value as SplineKf);
  const oracle = (tick: number) => flat(toolboxAt(tick));
  const times: number[] = [];
  const intervals: Interval[] = [];
  const L = AE_SHAPE_EASE_MAGNITUDE;
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    const ta = keyTime(a, ctx);
    const tb = keyTime(b, ctx);
    const pa = flat(a.value as SplineKf);
    const pb = flat(b.value as SplineKf);
    const dp = pb.map((x, d) => x - pa[d]);
    const D = tb - ta;
    const plan = planSegmentEase(a, b, "spline_anchors", ctx.fidelity);
    const iv = (t0: number, t1: number, v0: number[], v1: number[], kind: Interval["kind"], cc?: Seg["c"], reason?: string): Interval => ({
      t0,
      t1,
      kind,
      reason,
      segs: [
        { t0, t1, v0: 0, v1: L, kind, c: cc, ref: 0 },
        ...v0.map((x, d): Seg => ({ t0, t1, v0: x, v1: v1[d], kind: "linear", ref: Math.abs(dp[d]) })),
      ],
    });
    if (i === 0) times.push(ta);
    if (plan.kind === "hold") intervals.push(iv(ta, tb, pa, pb, "hold"));
    else if (plan.kind === "linear" || plan.kind === "valueBezier") intervals.push(iv(ta, tb, pa, pb, "linear"));
    else if (plan.kind === "sampled") intervals.push(iv(ta, tb, pa, pb, "dense", undefined, `${a.easingOut}: no AE form, sampled per frame`));
    else {
      for (const p of plan.pieces) {
        const cp = pieceControlPoints(p);
        const span = p.v1 - p.v0;
        const v0 = pa.map((x, d) => x + dp[d] * p.v0);
        const v1 = pa.map((x, d) => x + dp[d] * p.v1);
        const t0 = ta + p.u0 * D;
        const t1 = ta + p.u1 * D;
        // A piece that starts and ends on the same shape (between bounce
        // contacts) has nothing to ease along: one ease cannot leave a shape
        // and come back.
        if (Math.abs(span) < 1e-12) intervals.push(iv(t0, t1, v0, v1, "dense", undefined, "a morph that returns to its start shape has no one-ease form"));
        else {
          const k = L / span;
          intervals.push(iv(t0, t1, v0, v1, "bezier", [ta + cp[2] * D, (cp[3] - p.v0) * k, ta + cp[4] * D, (cp[5] - p.v0) * k]));
        }
        if (p.u1 < 1) times.push(t1);
      }
    }
    times.push(tb);
  }
  // The verifier compares flattened coordinates: its tolerance is per
  // coordinate, in px.
  const { keys, report } = finalize(times, intervals, "shape", oracle, { ...ctx, tolerance: { abs: tolPx, rel: 0 } });
  if (keys.length === 0) {
    const v = shapeAt(ks[0].value as SplineKf);
    const res: AePathTrackResult = { paths: v.map((p) => ({ v: p })), report };
    if (mode === "uniform") res.roundCorners = { v: radiusAt(ks[0].value as SplineKf) };
    return res;
  }
  const paths: AeProp<AePath>[] = counts.map((n, si) => {
    const off = counts.slice(0, si).reduce((s, m) => s + m * 6, 0);
    return { keys: keys.map((k) => ({ ...k, v: unflattenPath(k.v.slice(off, off + n * 6), closed[si]) })), dims: 1 };
  });
  const result: AePathTrackResult = { paths, report };
  if (mode === "uniform") {
    const ri = counts.reduce((s, m) => s + m * 6, 0);
    const rk = keys.map((k) => ({ ...k, v: k.v[ri] }));
    if (rk.every((k) => Math.abs(k.v - rk[0].v) < 1e-9)) result.roundCorners = { v: rk[0].v };
    else {
      // The radius keys share the morph's progress curve: rescale its eases
      // from progress units to px/s (radius delta per interval).
      for (let i = 0; i + 1 < rk.length; i++) {
        const k = (rk[i + 1].v - rk[i].v) / L;
        if (rk[i].easeOut) rk[i].easeOut = rk[i].easeOut!.map((e) => ({ ...e, speed: e.speed * k }));
        if (rk[i + 1].easeIn) rk[i + 1].easeIn = rk[i + 1].easeIn!.map((e) => ({ ...e, speed: e.speed * k }));
      }
      result.roundCorners = { keys: rk, dims: 1 };
    }
    // The uniform condition must hold BETWEEN keys too: AE's fillet of the
    // morphed raw path vs toolbox's fillet of its morph, every frame.
    let dev = 0;
    for (const f of framesBetween(keys[0].t, keys[keys.length - 1].t, ctx)) {
      const t = frameTime(f, ctx);
      const tb = toolboxAt(frameTick(f, ctx));
      const want = splineToAePaths({ subpaths: roundCornersPerAnchor(tb.subpaths) }, c);
      const r = evaluateAeProp(result.roundCorners, t, "perDim")[0];
      paths.forEach((p, si) => {
        dev = Math.max(dev, maxPointDistance(aeRoundCornersPath(evaluateAePathProp(p, t), r), want[si]));
      });
    }
    report.maxError = Math.max(report.maxError, dev);
    if (dev > tolPx) report.notes.push(`Round Corners lands up to ${dev.toFixed(2)} px from toolbox's fillet between keys — bake the corners instead`);
  }
  if (mode === "baked") {
    const why = plans.find((p): p is Extract<AeCornerPlan, { kind: "baked" }> => p.kind === "baked")?.reason;
    report.notes.push(`live corners baked into the path vertices${why ? ` (${why})` : ""}`);
  }
  return result;
}

function maxPointDistance(a: AePath, b: AePath): number {
  if (a.vertices.length !== b.vertices.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.vertices.length; i++) {
    m = Math.max(
      m,
      Math.hypot(a.vertices[i][0] - b.vertices[i][0], a.vertices[i][1] - b.vertices[i][1]),
      Math.hypot(a.inTangents[i][0] - b.inTangents[i][0], a.inTangents[i][1] - b.inTangents[i][1]),
      Math.hypot(a.outTangents[i][0] - b.outTangents[i][0], a.outTangents[i][1] - b.outTangents[i][1])
    );
  }
  return m;
}

// ---------------------------------------------------------------------------
// Verifier (exported for the exporter's report and the gates)
// ---------------------------------------------------------------------------

// Max |AE − toolbox| of an already-built numeric prop against `oracle(tick)`
// (AE units, the track's own clock) at every comp frame in [f0, f1].
export function verifyAeProp(
  prop: AeProp<unknown>,
  oracle: (tick: number) => number[],
  frames: [number, number],
  ctx: AeTimebase & { offsetTicks?: number },
  mode: AeEaseMode = "perDim"
): number {
  let m = 0;
  for (let f = frames[0]; f <= frames[1]; f++) {
    const have = evaluateAeProp(prop, frameTime(f, ctx), mode);
    const want = oracle(f * ticksPerFrameOf(ctx) - (ctx.offsetTicks ?? 0));
    for (let i = 0; i < want.length; i++) m = Math.max(m, Math.abs(have[i] - want[i]));
  }
  return m;
}
