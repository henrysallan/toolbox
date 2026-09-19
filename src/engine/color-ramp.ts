// Shared color-ramp model + CPU sampler. Lives engine-side so engine
// rasterizers (e.g. per-subpath spline fill in Rasterize Spline) can sample a
// ramp without an engine→nodes import (invariant #1). The Color Ramp node
// re-exports `ColorRampStop` / `COLOR_RAMP_MAX_STOPS` from here for
// back-compat with existing importers.
//
// A ramp is sampled along two independent axes (091626_ramp-space-interp.md):
//   interp — the CURVE: how the blend factor moves between stops (per-
//            interval eases, splines through the stops, a Gaussian smooth,
//            or hard steps);
//   space  — the COLOR SPACE the blend happens in (gamma sRGB, linear light,
//            OKLab, OKLCH with a short or long hue path).
// Every consumer — CPU rgba() strings, float tuples, the GPU LUT — goes
// through `makeColorRampSampler`, so they agree to the last digit.

import type { ImageValue, ParamDef, RenderContext } from "./types";
import {
  linearToOklab,
  linearToSrgb,
  oklabToLinear,
  oklabToOklch,
  oklchToSrgbGamutMapped,
  srgbToLinear,
} from "./color-space";

export interface ColorRampStop {
  id: string;
  position: number; // 0..1
  color: string; // hex, e.g. "#ff00aa"
  // Per-stop opacity in [0, 1]. Optional so stops saved before alpha support
  // keep working — treat `undefined` as fully opaque.
  alpha?: number;
}

export const COLOR_RAMP_MAX_STOPS = 16;

// ---------------------------------------------------------------------
// Option vocabularies (shared by every node that exposes a ramp)
// ---------------------------------------------------------------------

export const COLOR_RAMP_INTERP_OPTIONS = [
  "linear",
  "ease",
  "smoother",
  "sine",
  "ease_in",
  "ease_out",
  "cardinal",
  "monotone",
  "bspline",
  "smooth",
  "constant",
] as const;
export type ColorRampInterp = (typeof COLOR_RAMP_INTERP_OPTIONS)[number];

export const COLOR_RAMP_INTERP_LABELS: Record<ColorRampInterp, string> = {
  linear: "Linear",
  ease: "Ease (smoothstep)",
  smoother: "Smoother (quintic)",
  sine: "Sine",
  ease_in: "Ease in",
  ease_out: "Ease out",
  cardinal: "Cardinal spline",
  monotone: "Monotone spline",
  bspline: "B-spline",
  smooth: "Gaussian smooth",
  constant: "Constant",
};

export const COLOR_RAMP_SPACE_OPTIONS = [
  "srgb",
  "linear",
  "oklab",
  "oklch",
  "oklch_long",
] as const;
export type ColorRampSpace = (typeof COLOR_RAMP_SPACE_OPTIONS)[number];

export const COLOR_RAMP_SPACE_LABELS: Record<ColorRampSpace, string> = {
  srgb: "sRGB",
  linear: "Linear RGB",
  oklab: "OKLab",
  oklch: "OKLCH (short hue)",
  oklch_long: "OKLCH (long hue)",
};

// Params saved before the vocabulary grew hold one of the original three
// values; anything unknown (a typo over MCP, a future option) reads as the
// default rather than throwing the sampler off.
export function normalizeRampInterp(v: unknown): ColorRampInterp {
  return typeof v === "string" &&
    (COLOR_RAMP_INTERP_OPTIONS as readonly string[]).includes(v)
    ? (v as ColorRampInterp)
    : "linear";
}

export function normalizeRampSpace(v: unknown): ColorRampSpace {
  return typeof v === "string" &&
    (COLOR_RAMP_SPACE_OPTIONS as readonly string[]).includes(v)
    ? (v as ColorRampSpace)
    : "srgb";
}

// Param-def factories so every ramp-bearing node declares the same enum
// (same options, same labels) — pass `name`, and `visibleIf` / `default`
// / `label` as the node needs.
export function rampInterpParam(
  over: Partial<ParamDef> & { name: string }
): ParamDef {
  return {
    label: "Ramp interpolation",
    type: "enum",
    options: [...COLOR_RAMP_INTERP_OPTIONS],
    optionLabels: COLOR_RAMP_INTERP_LABELS,
    default: "linear",
    ...over,
  };
}

export function rampSpaceParam(
  over: Partial<ParamDef> & { name: string }
): ParamDef {
  return {
    label: "Ramp color space",
    type: "enum",
    options: [...COLOR_RAMP_SPACE_OPTIONS],
    optionLabels: COLOR_RAMP_SPACE_LABELS,
    default: "srgb",
    ...over,
  };
}

// ---------------------------------------------------------------------
// Stop validation
// ---------------------------------------------------------------------

const STOP_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function normalizeStopHex(raw: string): string | null {
  const s = raw.trim();
  if (!STOP_HEX.test(s)) return null;
  let h = s.slice(1).toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8 && h.endsWith("ff")) h = h.slice(0, 6);
  return `#${h}`;
}

export function newColorRampStopId(): string {
  return `stop-${Math.random().toString(36).slice(2, 8)}`;
}

// Remote / recipe write of a `color_ramp` param (or a GLSL ramp() channel).
// Same [{position, color, alpha?}] shape both paths accept; ids are minted
// when the caller omits them.
export function vetColorRampStops(
  value: unknown
): { ok: true; value: ColorRampStop[] } | { ok: false; reason: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > COLOR_RAMP_MAX_STOPS)
    return {
      ok: false,
      reason: `expected 1–${COLOR_RAMP_MAX_STOPS} stops as [{position, color, alpha?}]`,
    };
  const stops: ColorRampStop[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return { ok: false, reason: "each stop must be an object" };
    const rec = raw as Record<string, unknown>;
    const pos = rec.position;
    const hex = typeof rec.color === "string" ? normalizeStopHex(rec.color) : null;
    if (typeof pos !== "number" || !Number.isFinite(pos) || pos < 0 || pos > 1)
      return { ok: false, reason: "stop.position must be a number in 0..1" };
    if (!hex) return { ok: false, reason: 'stop.color must be "#rrggbb"' };
    const alpha =
      typeof rec.alpha === "number" && Number.isFinite(rec.alpha)
        ? Math.max(0, Math.min(1, rec.alpha))
        : hex.length === 9
          ? parseInt(hex.slice(7, 9), 16) / 255
          : undefined;
    stops.push({
      id: typeof rec.id === "string" && rec.id ? rec.id : newColorRampStopId(),
      position: pos,
      color: hex.slice(0, 7),
      ...(alpha !== undefined && alpha < 1 ? { alpha } : {}),
    });
  }
  return { ok: true, value: stops };
}

// ---------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------

// Slide `t` by `offset` and wrap into [0, 1). Offset 0 keeps the legacy
// clamp so t=1 still hits the last stop (GLSL `fract(1.0)` would snap it
// to 0). Non-zero offsets loop: 1.2 looks like 0.2, and a sample that
// pushes past 1 re-enters at the start of the ramp. Matches GLSL `fract`
// for negative values (`floor`, not `%`).
export function offsetRampT(t: number, offset = 0): number {
  const tc = Math.max(0, Math.min(1, t));
  if (!(Math.abs(offset) > 1e-8)) return tc;
  const x = tc + offset;
  return x - Math.floor(x);
}

export type Rgba01 = [number, number, number, number];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function hexToRgb01(hex: string): [number, number, number] {
  const h = (hex ?? "#000000").replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const n = parseInt(s || "0", 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

// `rgba(R, G, B, a)` for a Canvas2D fillStyle — 8-bit channels, float alpha.
export function rgba01ToCss(c: Rgba01): string {
  const r = Math.round(clamp01(c[0]) * 255);
  const g = Math.round(clamp01(c[1]) * 255);
  const b = Math.round(clamp01(c[2]) * 255);
  return `rgba(${r}, ${g}, ${b}, ${clamp01(c[3])})`;
}

// Working-space vector: three color components in `space`, then alpha.
type Vec = [number, number, number, number];

interface Knot {
  p: number;
  v: Vec;
}

// Gaussian `smooth` mode: fixed kernel width as a fraction of the ramp.
// Wide enough to round every stop off, narrow enough that a 3-stop ramp
// still reads as three colors. A per-node width control is additive if
// a graph ever needs it.
export const COLOR_RAMP_SMOOTH_SIGMA = 0.04;
const SMOOTH_SAMPLES = 512;

// Per-interval blend-factor remaps. `constant` and the spline / smooth
// modes are handled structurally, not here.
function remapF(interp: ColorRampInterp, f: number): number {
  switch (interp) {
    case "ease":
      return f * f * (3 - 2 * f);
    case "smoother":
      return f * f * f * (f * (f * 6 - 15) + 10);
    case "sine":
      return 0.5 - 0.5 * Math.cos(Math.PI * f);
    case "ease_in":
      return f * f;
    case "ease_out":
      return 1 - (1 - f) * (1 - f);
    default:
      return f;
  }
}

function toWorking(space: ColorRampSpace, rgb: [number, number, number]): [number, number, number] {
  switch (space) {
    case "srgb":
      return rgb;
    case "linear":
      return [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
    case "oklab":
    case "oklch":
    case "oklch_long": {
      const lab = linearToOklab(
        srgbToLinear(rgb[0]),
        srgbToLinear(rgb[1]),
        srgbToLinear(rgb[2])
      );
      return space === "oklab" ? lab : oklabToOklch(lab[0], lab[1], lab[2]);
    }
  }
}

function fromWorking(space: ColorRampSpace, v: Vec): Rgba01 {
  switch (space) {
    case "srgb":
      return [clamp01(v[0]), clamp01(v[1]), clamp01(v[2]), clamp01(v[3])];
    case "linear":
      return [
        linearToSrgb(clamp01(v[0])),
        linearToSrgb(clamp01(v[1])),
        linearToSrgb(clamp01(v[2])),
        clamp01(v[3]),
      ];
    case "oklab": {
      const lin = oklabToLinear(v[0], v[1], v[2]);
      return [
        linearToSrgb(clamp01(lin[0])),
        linearToSrgb(clamp01(lin[1])),
        linearToSrgb(clamp01(lin[2])),
        clamp01(v[3]),
      ];
    }
    case "oklch":
    case "oklch_long": {
      const rgb = oklchToSrgbGamutMapped(v[0], Math.max(0, v[1]), v[2]);
      return [rgb[0], rgb[1], rgb[2], clamp01(v[3])];
    }
  }
}

// OKLCH hue is an angle, so the knots have to agree on which way round
// the circle each interval goes BEFORE any curve is fitted through them.
// Unwrap sequentially (CSS Color 4 `shorter` / `longer` hue rules); greys
// have no hue and borrow the nearest chromatic neighbour's so they don't
// inject a spurious turn.
function unwrapHues(knots: Knot[], longer: boolean): void {
  const n = knots.length;
  // Fill undefined hues forward, then backward; all-grey → 0.
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
    let d = ((((knots[i].v[2] - h0) % 360) + 540) % 360) - 180; // (-180, 180]
    if (longer) {
      if (d > -180 && d < 180) d = d >= 0 ? d - 360 : d + 360;
    }
    knots[i].v[2] = h0 + d;
  }
}

const lerpVec = (a: Vec, b: Vec, f: number): Vec => [
  a[0] + (b[0] - a[0]) * f,
  a[1] + (b[1] - a[1]) * f,
  a[2] + (b[2] - a[2]) * f,
  a[3] + (b[3] - a[3]) * f,
];

function bracket(knots: Knot[], t: number): number {
  const n = knots.length;
  for (let i = 0; i < n - 1; i++) {
    if (t >= knots[i].p && t <= knots[i + 1].p) return i;
  }
  return t < knots[0].p ? 0 : n - 2;
}

const MIN_SPAN = 1e-4;

// Cardinal (Catmull-Rom, tension 0) tangents on non-uniform knots:
// centred finite differences inside, one-sided at the ends. Units are
// per unit t, so the Hermite basis below scales them by the interval.
function cardinalTangents(knots: Knot[]): Vec[] {
  const n = knots.length;
  const m: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = knots[Math.max(0, i - 1)];
    const b = knots[Math.min(n - 1, i + 1)];
    const dp = Math.max(b.p - a.p, MIN_SPAN);
    m.push([
      (b.v[0] - a.v[0]) / dp,
      (b.v[1] - a.v[1]) / dp,
      (b.v[2] - a.v[2]) / dp,
      (b.v[3] - a.v[3]) / dp,
    ]);
  }
  return m;
}

// Fritsch–Carlson tangents per component: through every knot, C¹, and the
// interpolant never leaves the range of its two bracketing knots.
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

function hermite(knots: Knot[], m: Vec[], i: number, t: number): Vec {
  const a = knots[i];
  const b = knots[i + 1];
  const h = Math.max(b.p - a.p, MIN_SPAN);
  const f = (t - a.p) / h;
  const f2 = f * f;
  const f3 = f2 * f;
  const h00 = 2 * f3 - 3 * f2 + 1;
  const h10 = f3 - 2 * f2 + f;
  const h01 = -2 * f3 + 3 * f2;
  const h11 = f3 - f2;
  return [
    h00 * a.v[0] + h10 * h * m[i][0] + h01 * b.v[0] + h11 * h * m[i + 1][0],
    h00 * a.v[1] + h10 * h * m[i][1] + h01 * b.v[1] + h11 * h * m[i + 1][1],
    h00 * a.v[2] + h10 * h * m[i][2] + h01 * b.v[2] + h11 * h * m[i + 1][2],
    h00 * a.v[3] + h10 * h * m[i][3] + h01 * b.v[3] + h11 * h * m[i + 1][3],
  ];
}

// Cubic B-spline with the stops as control points. Approximating: interior
// stops pull the curve rather than pin it (the trade for extra smoothness).
// Written in Hermite form — at each stop the curve takes the B-spline's
// knot value (P₋₁ + 4P₀ + P₁)/6 and a centred-difference tangent — which
// is exactly the uniform cubic B-spline when stops are evenly spaced and
// stays C¹ (no slope kink) when they are not. The phantom control points
// past each end are reflections (2·P0 − P1), so the curve lands exactly
// on the end stops.
function bsplineKnots(knots: Knot[]): { vk: Knot[]; m: Vec[] } {
  const n = knots.length;
  const P = (k: number): Vec => {
    if (k < 0) {
      const p0 = knots[0].v;
      const p1 = knots[Math.min(n - 1, 1)].v;
      return [2 * p0[0] - p1[0], 2 * p0[1] - p1[1], 2 * p0[2] - p1[2], 2 * p0[3] - p1[3]];
    }
    if (k > n - 1) {
      const p0 = knots[n - 1].v;
      const p1 = knots[Math.max(0, n - 2)].v;
      return [2 * p0[0] - p1[0], 2 * p0[1] - p1[1], 2 * p0[2] - p1[2], 2 * p0[3] - p1[3]];
    }
    return knots[k].v;
  };
  const vk: Knot[] = [];
  const m: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = P(i - 1);
    const b = P(i);
    const c = P(i + 1);
    vk.push({
      p: knots[i].p,
      v: [
        (a[0] + 4 * b[0] + c[0]) / 6,
        (a[1] + 4 * b[1] + c[1]) / 6,
        (a[2] + 4 * b[2] + c[2]) / 6,
        (a[3] + 4 * b[3] + c[3]) / 6,
      ],
    });
    const pa = knots[Math.max(0, i - 1)].p;
    const pc = knots[Math.min(n - 1, i + 1)].p;
    // (P₁ − P₋₁)/2 per control-point step, scaled to per unit t: the
    // centred span covers two intervals inside, one at either end.
    const dp = Math.max(pc - pa, MIN_SPAN);
    const scale = (i === 0 || i === n - 1 ? 0.5 : 1) / dp;
    m.push([
      (c[0] - a[0]) * scale,
      (c[1] - a[1]) * scale,
      (c[2] - a[2]) * scale,
      (c[3] - a[3]) * scale,
    ]);
  }
  return { vk, m };
}

export interface ColorRampSamplerOpts {
  interp?: ColorRampInterp;
  space?: ColorRampSpace;
}

export type ColorRampSampler = (t: number, offset?: number) => Rgba01;

// Build a sampler once (sort + parse + convert stops, fit tangents / the
// smooth buffer), then call it per subpath / per LUT texel. `offset`
// slides the phase per call (offsetRampT), so one sampler serves every
// per-copy phase shift. Semantics shared by every mode: stops sorted by
// position, `t` clamped to the outer stops, straight (non-premultiplied)
// alpha interpolated with the same curve as color.
export function makeColorRampSampler(
  stops: ColorRampStop[],
  opts: ColorRampSamplerOpts = {}
): ColorRampSampler {
  const interp = normalizeRampInterp(opts.interp);
  const space = normalizeRampSpace(opts.space);
  const sorted = (Array.isArray(stops) ? stops : [])
    .filter((s) => s && typeof s.position === "number")
    .sort((a, b) => a.position - b.position)
    .slice(0, COLOR_RAMP_MAX_STOPS);
  const n = sorted.length;

  if (n === 0) {
    return (t, offset = 0) => {
      const tc = offsetRampT(t, offset);
      return [tc, tc, tc, 1];
    };
  }

  const knots: Knot[] = sorted.map((s) => {
    const w = toWorking(space, hexToRgb01(s.color));
    return {
      p: clamp01(s.position),
      v: [w[0], w[1], w[2], clamp01(s.alpha ?? 1)],
    };
  });
  if (space === "oklch" || space === "oklch_long") unwrapHues(knots, space === "oklch_long");

  const first = fromWorking(space, knots[0].v);
  const last = fromWorking(space, knots[n - 1].v);
  if (n === 1) return () => [...first] as Rgba01;

  // Piecewise-linear evaluation in working space — the base every other
  // mode is defined against.
  const linearAt = (tc: number): Vec => {
    if (tc <= knots[0].p) return knots[0].v;
    if (tc >= knots[n - 1].p) return knots[n - 1].v;
    const i = bracket(knots, tc);
    const a = knots[i];
    const b = knots[i + 1];
    return lerpVec(a.v, b.v, (tc - a.p) / Math.max(b.p - a.p, MIN_SPAN));
  };

  let evalAt: (tc: number) => Vec;
  switch (interp) {
    case "constant":
      evalAt = (tc) => {
        if (tc >= knots[n - 1].p) return knots[n - 1].v;
        return knots[bracket(knots, tc)].v;
      };
      break;
    case "cardinal":
    case "monotone": {
      const m = interp === "cardinal" ? cardinalTangents(knots) : monotoneTangents(knots);
      evalAt = (tc) => hermite(knots, m, bracket(knots, tc), tc);
      break;
    }
    case "bspline": {
      const { vk, m } = bsplineKnots(knots);
      evalAt = (tc) => hermite(vk, m, bracket(vk, tc), tc);
      break;
    }
    case "smooth": {
      // Gaussian blur of the linear ramp along t. The signal is extended
      // past each end by point reflection (v(-x) = 2v(0) − v(x)), so the
      // symmetric kernel leaves the end colors exactly in place instead
      // of dragging them toward the neighbour.
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
      evalAt = (tc) => {
        const x = tc * (N - 1);
        const i = Math.min(N - 2, Math.floor(x));
        return lerpVec(blurred[i], blurred[i + 1], x - i);
      };
      break;
    }
    case "linear":
      evalAt = linearAt;
      break;
    default:
      evalAt = (tc) => {
        if (tc <= knots[0].p) return knots[0].v;
        if (tc >= knots[n - 1].p) return knots[n - 1].v;
        const i = bracket(knots, tc);
        const a = knots[i];
        const b = knots[i + 1];
        const f = remapF(interp, (tc - a.p) / Math.max(b.p - a.p, MIN_SPAN));
        return lerpVec(a.v, b.v, f);
      };
  }

  return (t, offset = 0) => {
    const tc = offsetRampT(t, offset);
    if (tc <= knots[0].p) return [...first] as Rgba01;
    if (tc >= knots[n - 1].p) return [...last] as Rgba01;
    return fromWorking(space, evalAt(tc));
  };
}

// One-shot sampler returning an `rgba(...)` string ready for a Canvas2D
// fillStyle. Builds a sampler per call — fine for a handful of samples;
// per-subpath loops should hold a `makeColorRampSampler` result instead.
export function sampleColorRamp(
  stops: ColorRampStop[],
  t: number,
  interp: ColorRampInterp = "linear",
  offset = 0,
  space: ColorRampSpace = "srgb"
): string {
  return rgba01ToCss(makeColorRampSampler(stops, { interp, space })(t, offset));
}

// Numeric sibling for consumers that feed GPU buffers rather than Canvas2D
// fillStyles. RGBA in 0..1, no 8-bit rounding.
export function sampleColorRampRgba01(
  stops: ColorRampStop[],
  t: number,
  interp: ColorRampInterp = "linear",
  offset = 0,
  space: ColorRampSpace = "srgb"
): Rgba01 {
  return makeColorRampSampler(stops, { interp, space })(t, offset);
}

// ---------------------------------------------------------------------
// GPU lookup table
// ---------------------------------------------------------------------

// Shader-side ramps sample a baked 1-D texture instead of re-deriving the
// curve math in GLSL: one CPU sampler is the spec for every backend, and
// the spline / smooth / OKLCH modes never have to be ported. Baked at
// texel CENTRES so a LINEAR fetch at `texture(lut, vec2(t, 0.5))`
// interpolates between the two nearest baked samples; `constant` snaps t
// to the texel centre in the shader (see COLOR_RAMP_LUT_GLSL) so its steps
// stay hard, quantized to 1/COLOR_RAMP_LUT_SIZE of the ramp.
export const COLOR_RAMP_LUT_SIZE = 1024;

export function buildColorRampLutData(
  stops: ColorRampStop[],
  interp: ColorRampInterp,
  space: ColorRampSpace,
  size = COLOR_RAMP_LUT_SIZE
): Float32Array {
  const sample = makeColorRampSampler(stops, { interp, space });
  const out = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const c = sample((i + 0.5) / size);
    out[i * 4] = c[0];
    out[i * 4 + 1] = c[1];
    out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = c[3];
  }
  return out;
}

// GLSL: declares `uniform sampler2D <lut>; uniform int <constant>;` and a
// `vec4 <fn>(float t)` that reads the LUT. `t` is expected in 0..1 (apply
// any offset / fract before calling).
export function colorRampLutGlsl(fn: string, lut: string, constant: string): string {
  const N = COLOR_RAMP_LUT_SIZE.toFixed(1);
  return `
uniform sampler2D ${lut};
uniform int ${constant};
vec4 ${fn}(float t) {
  t = clamp(t, 0.0, 1.0);
  if (${constant} == 1) t = (floor(t * ${N}) + 0.5) / ${N};
  return texture(${lut}, vec2(t, 0.5));
}`;
}

export interface ColorRampLutState {
  image?: ImageValue;
  tag?: string;
}

function lutTag(stops: ColorRampStop[], interp: ColorRampInterp, space: ColorRampSpace): string {
  const parts: string[] = [interp, space];
  for (const s of Array.isArray(stops) ? stops : []) {
    if (!s || typeof s.position !== "number") continue;
    parts.push(`${s.position}:${s.color}:${s.alpha ?? 1}`);
  }
  return parts.join("|");
}

// Cached RGBA16F 1-D image (pool texture; LINEAR + CLAMP_TO_EDGE). Rebaked
// only when the stops / interp / space change; the caller keeps `state`
// per node and releases it in `dispose` via releaseColorRampLut.
export function getColorRampLut(
  ctx: Pick<RenderContext, "uploadFloat32ToImage" | "releaseTexture">,
  state: ColorRampLutState,
  stops: ColorRampStop[],
  interp: ColorRampInterp,
  space: ColorRampSpace
): ImageValue {
  const tag = lutTag(stops, interp, space);
  if (state.image && state.tag === tag) return state.image;
  if (state.image) ctx.releaseTexture(state.image.texture);
  state.image = ctx.uploadFloat32ToImage(
    buildColorRampLutData(stops, interp, space),
    COLOR_RAMP_LUT_SIZE,
    1
  );
  state.tag = tag;
  return state.image;
}

export function releaseColorRampLut(
  ctx: Pick<RenderContext, "releaseTexture">,
  state: ColorRampLutState | undefined
): void {
  if (!state?.image) return;
  ctx.releaseTexture(state.image.texture);
  state.image = undefined;
  state.tag = undefined;
}
