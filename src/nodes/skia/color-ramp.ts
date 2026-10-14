import {
  COLOR_RAMP_INTERP_OPTIONS,
  COLOR_RAMP_MAX_STOPS,
  COLOR_RAMP_SMOOTH_SIGMA,
  COLOR_RAMP_SPACE_OPTIONS,
  normalizeRampInterp,
  normalizeRampSpace,
  type ColorRampInterp,
  type ColorRampSpace,
  type ColorRampStop,
} from "@/engine/color-ramp";
import { linearToOklab, oklabToOklch, srgbToLinear } from "@/engine/color-space";
import { bindDerived } from "@/engine/skia/scene-ir";
import { defineSkslNode, mirrorParams, parseSkslColor } from "@/engine/skia/library";
import { colorRampNode } from "../effect/color-ramp";

// Color Ramp (Skia) — the Skia-layer port of Color Ramp
// (specdocs/101326_skia-target.md §3.2). It evaluates makeColorRampSampler
// (engine/color-ramp.ts) per pixel instead of baking the GL node's 1024-texel
// LUT: stops ride as uniform arrays (16 = COLOR_RAMP_MAX_STOPS, Skia needs a
// constant bound) walked by loop index. `constant` keeps the LUT's 1/1024
// step grid so its edges land where the GL node puts them.
//
// Every interpolation × every space is ported:
//   - linear / ease / smoother / sine / ease_in / ease_out / constant in
//     srgb / linear / oklab: closed form; only the bracketing stop pair is
//     converted to the blend space, per pixel.
//   - cardinal / monotone / bspline: cubic Hermite per interval. The
//     tangents (and bspline's shifted knot values) are fitted in JS once per
//     change of the stops — rampModel() below, the sampler's own fit — and
//     ride as `stops_work` / `stops_tan` (derived binds on `stops`).
//   - oklch / oklch_long: the knots' LCh values with the sampler's hue
//     unwrapping (short / long way round) ride in `stops_work`; the shader
//     gamut-maps like oklchToSrgbGamutMapped (14 chroma bisection steps).
//   - smooth: the sampler blurs a 512-sample linear ramp with a Gaussian
//     (σ = 0.04) — a 125-tap convolution per sample that cannot run per
//     pixel. rampModel() runs that exact blur and hands the shader 32
//     uniform samples of it plus their slopes; the shader interpolates them
//     with cubic Hermite (check:skia-color measures the error against the
//     sampler: ≤ 0.1/255 in srgb / linear / oklab, worst 0.73/255 for a
//     hard step — two stops at one position — blurred in OKLCH long).
//
// Uniform cost per node: 16 + 16 + 32 + 32 array slots (positions, colors,
// work, tangents) plus five scalars, whatever the mode — the program text
// may not depend on param values.
//
// rampModel() re-implements the sampler's fitting (the engine keeps those
// steps private); check:skia-color replays the model in JS against
// makeColorRampSampler for every interpolation × space, so a change to the
// sampler that the model does not follow fails the gate.

const MAX = COLOR_RAMP_MAX_STOPS;
// Samples of the blurred `smooth` ramp in stops_work / stops_tan (uniform
// spacing 1/31). The spline modes use the first MAX entries.
export const SMOOTH_TABLE = 32;
const TABLE = SMOOTH_TABLE;
const INTERP_INDEX = (name: ColorRampInterp) => (COLOR_RAMP_INTERP_OPTIONS as readonly string[]).indexOf(name);
const SPACE_INDEX = (name: ColorRampSpace) => (COLOR_RAMP_SPACE_OPTIONS as readonly string[]).indexOf(name);

const COLOR_RAMP_SKSL = `float3 tbx_color_ramp_to_working(float3 c, int space) {
  if (space == ${SPACE_INDEX("linear")}) return tbx_srgb_to_linear3(c);
  if (space == ${SPACE_INDEX("oklab")}) return tbx_srgb_to_oklab(c);
  if (space == ${SPACE_INDEX("oklch")} || space == ${SPACE_INDEX("oklch_long")}) {
    float3 lab = tbx_srgb_to_oklab(c);
    return float3(lab.x, length(lab.yz), atan(lab.z, lab.y) * 57.29577951308232);
  }
  return c;
}

bool tbx_color_ramp_in_gamut(float3 lin) {
  return all(greaterThan(lin, float3(-0.0005))) && all(lessThan(lin, float3(1.0005)));
}

float3 tbx_color_ramp_lch_linear(float L, float C, float h) {
  float r = h * 0.017453292519943295;
  return tbx_oklab_to_linear(float3(L, C * cos(r), C * sin(r)));
}

float4 tbx_color_ramp_from_working(float4 v, int space) {
  float3 c;
  if (space == ${SPACE_INDEX("linear")}) c = tbx_linear_to_srgb3(clamp(v.rgb, 0.0, 1.0));
  else if (space == ${SPACE_INDEX("oklab")}) c = tbx_linear_to_srgb3(clamp(tbx_oklab_to_linear(v.rgb), 0.0, 1.0));
  else if (space == ${SPACE_INDEX("oklch")} || space == ${SPACE_INDEX("oklch_long")}) {
    // oklchToSrgbGamutMapped: keep L and h, shrink C until the color fits.
    float L = clamp(v.x, 0.0, 1.0);
    float C = max(v.y, 0.0);
    float3 lin = tbx_color_ramp_lch_linear(L, C, v.z);
    if (!tbx_color_ramp_in_gamut(lin)) {
      float lo = 0.0;
      float hi = C;
      for (int i = 0; i < 14; i++) {
        float mid = (lo + hi) * 0.5;
        if (tbx_color_ramp_in_gamut(tbx_color_ramp_lch_linear(L, mid, v.z))) lo = mid;
        else hi = mid;
      }
      lin = tbx_color_ramp_lch_linear(L, lo, v.z);
    }
    c = tbx_linear_to_srgb3(clamp(lin, 0.0, 1.0));
  } else c = clamp(v.rgb, 0.0, 1.0);
  return float4(c, clamp(v.a, 0.0, 1.0));
}

float4 tbx_color_ramp_knot(float4 c, int space) {
  return float4(tbx_color_ramp_to_working(c.rgb, space), clamp(c.a, 0.0, 1.0));
}

float tbx_color_ramp_remap(float f, int interp) {
  if (interp == ${INTERP_INDEX("ease")}) return f * f * (3.0 - 2.0 * f);
  if (interp == ${INTERP_INDEX("smoother")}) return f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  if (interp == ${INTERP_INDEX("sine")}) return 0.5 - 0.5 * cos(3.141592653589793 * f);
  if (interp == ${INTERP_INDEX("ease_in")}) return f * f;
  if (interp == ${INTERP_INDEX("ease_out")}) return 1.0 - (1.0 - f) * (1.0 - f);
  return f;
}

// Cubic Hermite on [pa, pb] with per-unit-t tangents (the sampler's hermite).
float4 tbx_color_ramp_hermite(float4 a, float4 b, float4 ma, float4 mb, float pa, float pb, float t) {
  float h = max(pb - pa, 1e-4);
  float f = (t - pa) / h;
  float f2 = f * f;
  float f3 = f2 * f;
  return (2.0 * f3 - 3.0 * f2 + 1.0) * a + (f3 - 2.0 * f2 + f) * h * ma
       + (-2.0 * f3 + 3.0 * f2) * b + (f3 - f2) * h * mb;
}

float4 tbx_color_ramp(float2 uv, float2 res, float stops_pos[${MAX}], float4 stops_color[${MAX}],
                      float stops_count, float4 stops_work[${TABLE}], float4 stops_tan[${TABLE}],
                      float offset, int interpolation, int space, float4 src) {
  float t = clamp(tbx_luma709(src.rgb), 0.0, 1.0);
  // offset 0 keeps t = 1 on the last stop; any other offset wraps.
  if (abs(offset) > 1e-8) t = fract(t + offset);
  // The GL node's LUT puts a constant ramp's steps on a 1/1024 grid of t.
  if (interpolation == ${INTERP_INDEX("constant")}) t = (floor(t * 1024.0) + 0.5) / 1024.0;
  bool spline = interpolation == ${INTERP_INDEX("cardinal")} || interpolation == ${INTERP_INDEX("monotone")}
             || interpolation == ${INTERP_INDEX("bspline")};
  // Knots come pre-fitted (stops_work) for the splines and in OKLCH, where
  // the hue is unwrapped across the whole ramp; else from the stop colors.
  bool fitted = spline || space == ${SPACE_INDEX("oklch")} || space == ${SPACE_INDEX("oklch_long")};
  float4 ramp;
  if (stops_count < 0.5) {
    ramp = float4(t, t, t, 1.0);
  } else {
    // One walk finds the last stop and the first interval [pa, pb] with
    // t <= pb (makeColorRampSampler's bracket on sorted stops).
    float pfirst = stops_pos[0];
    float4 cfirst = stops_color[0];
    float pa = pfirst;
    float4 ca = cfirst;
    float4 xa = stops_work[0];
    float4 ta = stops_tan[0];
    float pb = pfirst;
    float4 cb = cfirst;
    float4 xb = xa;
    float4 tb = ta;
    float plast = pfirst;
    float4 clast = cfirst;
    bool found = false;
    for (int i = 1; i < ${MAX}; i++) {
      if (float(i) >= stops_count) break;
      plast = stops_pos[i];
      clast = stops_color[i];
      if (!found) {
        pb = plast;
        cb = clast;
        xb = stops_work[i];
        tb = stops_tan[i];
        if (t <= pb) found = true;
        else {
          pa = pb;
          ca = cb;
          xa = xb;
          ta = tb;
        }
      }
    }
    float4 w;
    if (t <= pfirst) w = tbx_color_ramp_knot(cfirst, space);
    else if (t >= plast) w = tbx_color_ramp_knot(clast, space);
    else if (interpolation == ${INTERP_INDEX("smooth")}) {
      // 32 uniform samples of the blurred ramp, Hermite between them.
      float x = t * ${(TABLE - 1).toFixed(1)};
      float k = min(floor(x), ${(TABLE - 2).toFixed(1)});
      float4 sa = stops_work[0];
      float4 sb = stops_work[1];
      float4 ma = stops_tan[0];
      float4 mb = stops_tan[1];
      for (int j = 1; j < ${TABLE - 1}; j++) {
        if (float(j) == k) {
          sa = stops_work[j];
          sb = stops_work[j + 1];
          ma = stops_tan[j];
          mb = stops_tan[j + 1];
        }
      }
      w = tbx_color_ramp_hermite(sa, sb, ma, mb, k / ${(TABLE - 1).toFixed(1)}, (k + 1.0) / ${(TABLE - 1).toFixed(1)}, t);
    } else {
      float4 wa = fitted ? xa : tbx_color_ramp_knot(ca, space);
      float4 wb = fitted ? xb : tbx_color_ramp_knot(cb, space);
      if (interpolation == ${INTERP_INDEX("constant")}) w = wa;
      else if (spline) w = tbx_color_ramp_hermite(wa, wb, ta, tb, pa, pb, t);
      else w = wa + (wb - wa) * tbx_color_ramp_remap((t - pa) / max(pb - pa, 1e-4), interpolation);
    }
    ramp = tbx_color_ramp_from_working(w, space);
  }
  // The ramp decides color; the source's alpha still decides coverage.
  return float4(ramp.rgb, ramp.a * src.a);
}`;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// The stops exactly as makeColorRampSampler sees them: positioned ones,
// sorted (stable), capped at 16, positions clamped, colors parsed.
function sortedStops(raw: unknown): ColorRampStop[] {
  return (Array.isArray(raw) ? (raw as ColorRampStop[]) : [])
    .filter((s) => s && typeof s.position === "number")
    .sort((a, b) => a.position - b.position)
    .slice(0, MAX);
}

const stopRgb = (s: ColorRampStop): [number, number, number] => {
  const [r, g, b] = parseSkslColor(typeof s.color === "string" ? s.color.slice(0, 7) : s.color);
  return [r, g, b];
};

export function packRampStops(raw: unknown): { pos: number[]; color: number[]; count: number } {
  const sorted = sortedStops(raw);
  const pos = new Array<number>(MAX).fill(0);
  const color = new Array<number>(MAX * 4).fill(0);
  sorted.forEach((s, i) => {
    pos[i] = clamp01(s.position);
    const [r, g, b] = stopRgb(s);
    color.splice(i * 4, 4, r, g, b, clamp01(s.alpha ?? 1));
  });
  return { pos, color, count: sorted.length };
}

// ---- the sampler's fitting, for the shader's uniform arrays -------------------------
// Mirrors engine/color-ramp.ts (toWorking, unwrapHues, cardinalTangents,
// monotoneTangents, bsplineKnots, the smooth blur) step for step.

type Vec = [number, number, number, number];
interface Knot {
  p: number;
  v: Vec;
}
const MIN_SPAN = 1e-4;

function toWorking(space: ColorRampSpace, rgb: [number, number, number]): [number, number, number] {
  if (space === "srgb") return rgb;
  const lin: [number, number, number] = [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
  if (space === "linear") return lin;
  const lab = linearToOklab(lin[0], lin[1], lin[2]);
  return space === "oklab" ? lab : oklabToOklch(lab[0], lab[1], lab[2]);
}

function unwrapHues(knots: Knot[], longer: boolean): void {
  const n = knots.length;
  let last = NaN;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(knots[i].v[2])) last = knots[i].v[2];
    else if (Number.isFinite(last)) knots[i].v[2] = last;
  }
  last = NaN;
  for (let i = n - 1; i >= 0; i--) {
    if (Number.isFinite(knots[i].v[2])) last = knots[i].v[2];
    else knots[i].v[2] = Number.isFinite(last) ? last : 0;
  }
  for (let i = 1; i < n; i++) {
    const h0 = knots[i - 1].v[2];
    let d = ((((knots[i].v[2] - h0) % 360) + 540) % 360) - 180;
    if (longer && d > -180 && d < 180) d = d >= 0 ? d - 360 : d + 360;
    knots[i].v[2] = h0 + d;
  }
}

function cardinalTangents(knots: Knot[]): Vec[] {
  const n = knots.length;
  return knots.map((_k, i) => {
    const a = knots[Math.max(0, i - 1)];
    const b = knots[Math.min(n - 1, i + 1)];
    const dp = Math.max(b.p - a.p, MIN_SPAN);
    return [0, 1, 2, 3].map((c) => (b.v[c] - a.v[c]) / dp) as Vec;
  });
}

function monotoneTangents(knots: Knot[]): Vec[] {
  const n = knots.length;
  const m: Vec[] = knots.map(() => [0, 0, 0, 0]);
  for (let c = 0; c < 4; c++) {
    const d: number[] = [];
    for (let k = 0; k < n - 1; k++) {
      d[k] = (knots[k + 1].v[c] - knots[k].v[c]) / Math.max(knots[k + 1].p - knots[k].p, MIN_SPAN);
    }
    const mc: number[] = new Array(n);
    mc[0] = d[0];
    mc[n - 1] = d[n - 2];
    for (let k = 1; k < n - 1; k++) mc[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
    for (let k = 0; k < n - 1; k++) {
      if (d[k] === 0) {
        mc[k] = 0;
        mc[k + 1] = 0;
        continue;
      }
      const a = mc[k] / d[k];
      const b = mc[k + 1] / d[k];
      const s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        mc[k] = tau * a * d[k];
        mc[k + 1] = tau * b * d[k];
      }
    }
    for (let k = 0; k < n; k++) m[k][c] = mc[k];
  }
  return m;
}

function bsplineKnots(knots: Knot[]): { vk: Knot[]; m: Vec[] } {
  const n = knots.length;
  const reflect = (p0: Vec, p1: Vec): Vec => [0, 1, 2, 3].map((c) => 2 * p0[c] - p1[c]) as Vec;
  const P = (k: number): Vec => {
    if (k < 0) return reflect(knots[0].v, knots[Math.min(n - 1, 1)].v);
    if (k > n - 1) return reflect(knots[n - 1].v, knots[Math.max(0, n - 2)].v);
    return knots[k].v;
  };
  const vk: Knot[] = [];
  const m: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = P(i - 1);
    const b = P(i);
    const c = P(i + 1);
    vk.push({ p: knots[i].p, v: [0, 1, 2, 3].map((j) => (a[j] + 4 * b[j] + c[j]) / 6) as Vec });
    const dp = Math.max(knots[Math.min(n - 1, i + 1)].p - knots[Math.max(0, i - 1)].p, MIN_SPAN);
    const scale = (i === 0 || i === n - 1 ? 0.5 : 1) / dp;
    m.push([0, 1, 2, 3].map((j) => (c[j] - a[j]) * scale) as Vec);
  }
  return { vk, m };
}

function bracket(knots: Knot[], t: number): number {
  const n = knots.length;
  for (let i = 0; i < n - 1; i++) {
    if (t >= knots[i].p && t <= knots[i + 1].p) return i;
  }
  return t < knots[0].p ? 0 : n - 2;
}

const SMOOTH_SAMPLES = 512;

// The sampler's `smooth` evalAt: a Gaussian blur of the piecewise-linear
// ramp over 512 samples, point-reflected past both ends, read back with
// linear interpolation.
function smoothEval(knots: Knot[]): (tc: number) => Vec {
  const n = knots.length;
  const linearAt = (tc: number): Vec => {
    if (tc <= knots[0].p) return knots[0].v;
    if (tc >= knots[n - 1].p) return knots[n - 1].v;
    const i = bracket(knots, tc);
    const a = knots[i];
    const b = knots[i + 1];
    const f = (tc - a.p) / Math.max(b.p - a.p, MIN_SPAN);
    return [0, 1, 2, 3].map((c) => a.v[c] + (b.v[c] - a.v[c]) * f) as Vec;
  };
  const N = SMOOTH_SAMPLES;
  const sigma = COLOR_RAMP_SMOOTH_SIGMA * (N - 1);
  const rad = Math.ceil(sigma * 3);
  const kernel: number[] = [];
  let ksum = 0;
  for (let d = -rad; d <= rad; d++) {
    const w = Math.exp(-(d * d) / (2 * sigma * sigma));
    kernel.push(w);
    ksum += w;
  }
  const base: Vec[] = [];
  for (let x = 0; x < N; x++) base.push(linearAt(x / (N - 1)));
  const v0 = base[0];
  const v1 = base[N - 1];
  const ext = (x: number): Vec => {
    if (x < 0) {
      const r = base[Math.min(N - 1, -x)];
      return [2 * v0[0] - r[0], 2 * v0[1] - r[1], 2 * v0[2] - r[2], 2 * v0[3] - r[3]];
    }
    if (x > N - 1) {
      const r = base[Math.max(0, 2 * (N - 1) - x)];
      return [2 * v1[0] - r[0], 2 * v1[1] - r[1], 2 * v1[2] - r[2], 2 * v1[3] - r[3]];
    }
    return base[x];
  };
  const blurred: Vec[] = [];
  for (let x = 0; x < N; x++) {
    const acc: Vec = [0, 0, 0, 0];
    for (let d = -rad; d <= rad; d++) {
      const s = ext(x + d);
      const w = kernel[d + rad] / ksum;
      acc[0] += s[0] * w;
      acc[1] += s[1] * w;
      acc[2] += s[2] * w;
      acc[3] += s[3] * w;
    }
    blurred.push(acc);
  }
  return (tc) => {
    const x = tc * (N - 1);
    const i = Math.min(N - 2, Math.floor(x));
    const f = x - i;
    return [0, 1, 2, 3].map((c) => blurred[i][c] + (blurred[i + 1][c] - blurred[i][c]) * f) as Vec;
  };
}

export interface RampModel {
  // float4 × SMOOTH_TABLE each: knot values / tangents (splines, OKLCH),
  // or the smooth table and its slopes.
  work: number[];
  tan: number[];
}

// What the shader needs beyond the stop arrays for one ramp: knot values in
// the blend space (hue-unwrapped in OKLCH, B-spline-shifted for bspline),
// per-knot tangents for the splines, or the sampled `smooth` blur.
export function rampModel(raw: unknown, interpRaw: unknown, spaceRaw: unknown): RampModel {
  const interp = normalizeRampInterp(interpRaw);
  const space = normalizeRampSpace(spaceRaw);
  const work = new Array<number>(TABLE * 4).fill(0);
  const tan = new Array<number>(TABLE * 4).fill(0);
  const sorted = sortedStops(raw);
  const n = sorted.length;
  if (n === 0) return { work, tan };
  let knots: Knot[] = sorted.map((s) => {
    const w = toWorking(space, stopRgb(s));
    return { p: clamp01(s.position), v: [w[0], w[1], w[2], clamp01(s.alpha ?? 1)] };
  });
  if (space === "oklch" || space === "oklch_long") unwrapHues(knots, space === "oklch_long");
  const put = (arr: number[], i: number, v: Vec) => arr.splice(i * 4, 4, v[0], v[1], v[2], v[3]);
  if (interp === "smooth") {
    if (n < 2) return { work, tan };
    const at = smoothEval(knots);
    // Slopes by central difference on the blurred buffer's own sample step
    // (one-sided at the ends, where the point reflection leaves no kink).
    const h = 1 / (SMOOTH_SAMPLES - 1);
    for (let k = 0; k < TABLE; k++) {
      const p = k / (TABLE - 1);
      put(work, k, at(p));
      const lo = Math.max(0, p - h);
      const hi = Math.min(1, p + h);
      const a = at(lo);
      const b = at(hi);
      put(tan, k, [0, 1, 2, 3].map((c) => (b[c] - a[c]) / (hi - lo)) as Vec);
    }
    return { work, tan };
  }
  let m: Vec[] | null = null;
  if (n >= 2 && (interp === "cardinal" || interp === "monotone")) {
    m = interp === "cardinal" ? cardinalTangents(knots) : monotoneTangents(knots);
  } else if (n >= 2 && interp === "bspline") {
    const b = bsplineKnots(knots);
    knots = b.vk;
    m = b.m;
  }
  knots.forEach((k, i) => {
    put(work, i, k.v);
    if (m) put(tan, i, m[i]);
  });
  return { work, tan };
}

export const skiaColorRampNode = defineSkslNode({
  type: "skia-color-ramp",
  name: "Color Ramp (Skia)",
  mirrors: "color-ramp",
  subcategory: "modifier",
  description:
    "Skia-layer Color Ramp: remaps the upstream shader's luminance through the stops, fused into the layer's one runtime shader. Same params as Color Ramp; offset slides and wraps the ramp. Every interpolation (eases, cardinal / monotone / B-spline, Gaussian smooth, constant) and color space (sRGB, linear, OKLab, OKLCH short / long) is ported.",
  searchAliases: ["color ramp", "gradient map", "colorize", "skia", "sksl"],
  facts: {
    gotchas: [
      "Remaps Rec.709 luminance of the straight-alpha input; output alpha = stop alpha × input alpha.",
      "Evaluates the stops per pixel instead of the GL node's 1024-texel LUT; only `constant` keeps the LUT's 1/1024 step grid.",
      "Spline tangents, OKLCH hue unwrapping and the `smooth` blur are fitted in JS per change of the stops and ride as uniform arrays; smooth is 32 Hermite samples of the blur.",
      "space=oklch/oklch_long gamut-map per pixel (14 chroma bisection steps), the costliest setting.",
      "Unwired, the output is opaque black like Color Ramp's; up to 16 stops after sorting by position, extras dropped.",
    ],
  },
  fn: {
    id: "tbx.color_ramp@1",
    entry: "tbx_color_ramp",
    source: COLOR_RAMP_SKSL,
    params: [
      { name: "stops_pos", type: "float", count: MAX },
      { name: "stops_color", type: "color", count: MAX },
      { name: "stops_count", type: "float" },
      { name: "stops_work", type: "float4", count: TABLE },
      { name: "stops_tan", type: "float4", count: TABLE },
      { name: "offset", type: "float" },
      { name: "interpolation", type: "int" },
      { name: "space", type: "int" },
    ],
    inputs: [{ name: "src", mode: "pure" }],
    uses: ["tbx.color.luma", "tbx.color.srgb", "tbx.color.oklab"],
    cost: 1,
  },
  params: mirrorParams(colorRampNode, ["stops", "offset", "interpolation", "space"]),
  inputs: [{ name: "image", fnInput: "src" }],
  // The stop arrays are one param split for Skia: derived binds. The fitted
  // knots / tangents also depend on the interpolation and the space.
  binds({ params, nodeId }) {
    const { pos, color, count } = packRampStops(params.stops);
    const { work, tan } = rampModel(params.stops, params.interpolation, params.space);
    const deps = [{ node: nodeId, param: "stops" }];
    const fit = [...deps, { node: nodeId, param: "interpolation" }, { node: nodeId, param: "space" }];
    return {
      stops_pos: bindDerived(pos, deps),
      stops_color: bindDerived(color, deps),
      stops_count: bindDerived(count, deps),
      stops_work: bindDerived(work, fit),
      stops_tan: bindDerived(tan, fit),
    };
  },
  whenUnwired: () => [0, 0, 0, 1],
});
