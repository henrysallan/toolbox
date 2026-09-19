// Grain node v2 — engine-side helpers (specdocs/091626_grain-node-v2.md).
//
// Everything the Grain node needs that is not GL: the vocabularies, the
// grain clock (project ticks → "grain frames"), the temporal moving-average
// kernel with its variance normalisation, the cache key the node folds into
// its fingerprint, the CPU mirror of the shader's hash → sample step (for
// scripts/check-grain.mts), and the saved-project migration. Pure functions,
// no DOM, no GL — importable from the check scripts and from lib/project.ts.
//
// The one idea that matters: a blend of independent unit-variance noise
// frames `g = Σ wₖ εₖ` has variance `Σ wₖ²`, not 1. A plain lerp between two
// grain frames loses 29% of its contrast at the midpoint — the "breathing"
// every naive crossfade of noise shows. Every kernel here is renormalised by
// `1 / sqrt(Σ wₖ²)` so the grain's standard deviation is exactly the
// `luminance` / `chromatic` amount at every instant.

import { pcg3d } from "./voronoi-geometry";
import {
  defaultFloatCurve,
  sampleFloatCurve,
  sanitizeFloatCurve,
  type CurvePoint,
} from "./float-curve";
import { linearToSrgb, srgbToLinear } from "./color-space";

// ---------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------

// `classic` is the pre-v2 node kept verbatim (float hash, triangular noise,
// seed as a continuous re-roll) so saved projects render pixel-identical.
// `fine` is the integer-hash model: per-cell white noise, Gaussian by
// default, frame-locked, with the temporal kernel below. Later milestones
// add soft / film / parametric / plate.
export const GRAIN_MODELS = [
  "fine",
  "soft",
  "film",
  "parametric",
  "sensor",
  "video",
  "plate",
  "classic",
] as const;
export type GrainModel = (typeof GRAIN_MODELS)[number];

// static   — grain time is `evolution` alone; nothing moves unless that does.
// animated — grain time advances with the project clock at `rate` fps.
// looping  — animated, with the frame index wrapped modulo the loop period.
export const GRAIN_MOTIONS = ["static", "animated", "looping"] as const;
export type GrainMotion = (typeof GRAIN_MOTIONS)[number];

// Per-sample PDF. All three are scaled to unit standard deviation so the
// amount params keep their meaning when the shape changes.
export const GRAIN_DISTRIBUTIONS = ["gaussian", "triangular", "uniform"] as const;
export type GrainDistribution = (typeof GRAIN_DISTRIBUTIONS)[number];

export function normalizeGrainModel(v: unknown): GrainModel {
  return (GRAIN_MODELS as readonly string[]).includes(v as string)
    ? (v as GrainModel)
    : "fine";
}

export function normalizeGrainMotion(v: unknown): GrainMotion {
  return (GRAIN_MOTIONS as readonly string[]).includes(v as string)
    ? (v as GrainMotion)
    : "animated";
}

export function normalizeGrainDistribution(v: unknown): GrainDistribution {
  return (GRAIN_DISTRIBUTIONS as readonly string[]).includes(v as string)
    ? (v as GrainDistribution)
    : "gaussian";
}

// Shader-side enum index for `u_dist`.
export function grainDistributionIndex(d: GrainDistribution): number {
  return d === "gaussian" ? 0 : d === "triangular" ? 1 : 2;
}

// ---------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------

// Hard cap on the kernel's taps (the shader's uniform array length). With
// taps = 2·ceil(3σ) + 2 this admits σ up to 3 grain frames.
export const GRAIN_MAX_TAPS = 20;
export const GRAIN_MAX_SMOOTHNESS = 3;
// Resolution of the cache key while the kernel is smooth: finer than any
// visible change, coarse enough that paused re-evals at the same tick hit.
export const GRAIN_KEY_QUANTUM = 1 / 256;

// Continuous project frame — the same timebase Scene Time and Noise's
// looping evolution use, so sub-frame Time Offset shifts and slow scrubs
// stay smooth. Integer `frame` is the fallback when ticks are unavailable.
export function grainFrameNow(ctx: {
  tick: number;
  ticksPerFrame: number;
  frame: number;
}): number {
  return ctx.ticksPerFrame > 0 ? ctx.tick / ctx.ticksPerFrame : ctx.frame;
}

// `rate` is grain frames per second; 0 / invalid means "the project fps",
// i.e. one new grain frame per project frame. rate = fps / N holds each
// grain frame for N project frames.
export function grainRate(rate: unknown, fps: number): number {
  const r = typeof rate === "number" && Number.isFinite(rate) ? rate : 0;
  const f = fps > 0 ? fps : 60;
  return r > 0 ? r : f;
}

// Grain time in grain frames. `evolution` is a continuous offset in the
// same units — the smooth successor to animating `seed`.
export function grainTime(
  motion: GrainMotion,
  frameNow: number,
  fps: number,
  rate: number,
  evolution: number
): number {
  const e = Number.isFinite(evolution) ? evolution : 0;
  if (motion === "static") return e;
  const f = fps > 0 ? fps : 60;
  return (frameNow * rate) / f + e;
}

// Loop period in grain frames from a period given in PROJECT frames (what
// the user thinks in). Rounded to a whole number of grain frames so the
// wrap lands on a hashed frame; never below 1.
export function grainLoopPeriod(
  loopFrames: unknown,
  rate: number,
  fps: number
): number {
  const lf =
    typeof loopFrames === "number" && Number.isFinite(loopFrames)
      ? loopFrames
      : 120;
  const f = fps > 0 ? fps : 60;
  return Math.max(1, Math.round((lf * rate) / f));
}

// ---------------------------------------------------------------------
// Temporal kernel
// ---------------------------------------------------------------------

export interface GrainKernel {
  // Hashed frame index of tap 0. Non-negative when `loop` > 0 (the shader
  // wraps `frame0 + k` with `%`, which GLSL leaves undefined for negative
  // operands); otherwise any int32 — the shader casts to uint and two's
  // complement keeps negative frames distinct.
  frame0: number;
  // Normalised weights, `Σ w² = 1`. Length = taps ≤ GRAIN_MAX_TAPS.
  weights: number[];
  taps: number;
  // Loop period in grain frames, 0 = none.
  loop: number;
}

function positiveMod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

// Hashed frame indices must be non-negative ints: the shader casts them to
// uint and wraps looped ones with `%`, both of which GLSL leaves undefined
// for negative values. Frames are only hash keys, so a constant bias is
// free — it admits about a million frames of negative `evolution` before
// the (harmless, continuity-breaking) wrap below kicks in.
export const GRAIN_FRAME_BIAS = 1 << 20;
function keyFrame(frame: number): number {
  const k = frame + GRAIN_FRAME_BIAS;
  return k >= 0 ? k : positiveMod(k, 1 << 30);
}

// Shape of the temporal kernel. `gaussian` is the moving average sized by
// `smoothness`; `bspline` is the fixed four-tap cubic B-spline over the
// bracketing frames — C², a fifth of the cost, the budget setting.
export const GRAIN_KERNELS = ["gaussian", "bspline"] as const;
export type GrainKernelMode = (typeof GRAIN_KERNELS)[number];

export function normalizeGrainKernelMode(v: unknown): GrainKernelMode {
  return v === "bspline" ? "bspline" : "gaussian";
}

// Moving average over the hashed frames around grain time `t`.
// σ = 0 collapses to a single tap at floor(t) (hard per-frame grain). For
// σ > 0 the Gaussian taps run from floor(t) − K to floor(t) + K + 1 with
// K = ceil(3σ), so the support is symmetric about the fractional position
// and the truncated tails weigh < e^−4.5 ≈ 1% before normalisation. The
// B-spline mode ignores σ's width (any σ > 0 turns it on) and uses the
// cubic B-spline basis over floor(t) − 1 … floor(t) + 2.
export function grainKernel(
  t: number,
  sigma: number,
  loop: number,
  mode: GrainKernelMode = "gaussian"
): GrainKernel {
  const tt = Number.isFinite(t) ? t : 0;
  const base = Math.floor(tt);
  const frac = tt - base;
  const s = Math.min(GRAIN_MAX_SMOOTHNESS, Math.max(0, sigma));
  const L = loop > 0 ? Math.max(1, Math.round(loop)) : 0;
  if (s <= 1e-6) {
    return {
      frame0: L > 0 ? positiveMod(base, L) : keyFrame(base),
      weights: [1],
      taps: 1,
      loop: L,
    };
  }
  let K: number;
  let weights: number[];
  if (mode === "bspline") {
    K = 1;
    const f = frac;
    const f2 = f * f;
    const f3 = f2 * f;
    weights = [
      (1 - 3 * f + 3 * f2 - f3) / 6,
      (4 - 6 * f2 + 3 * f3) / 6,
      (1 + 3 * f + 3 * f2 - 3 * f3) / 6,
      f3 / 6,
    ];
  } else {
    K = Math.min((GRAIN_MAX_TAPS - 2) / 2, Math.ceil(3 * s));
    const taps = 2 * K + 2;
    weights = new Array(taps);
    for (let i = 0; i < taps; i++) {
      const k = i - K; // frame offset from base
      const d = (k - frac) / s;
      weights[i] = Math.exp(-0.5 * d * d);
    }
  }
  let sumSq = 0;
  for (const w of weights) sumSq += w * w;
  const norm = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < weights.length; i++) weights[i] *= norm;
  const frame0 = base - K;
  return {
    frame0: L > 0 ? positiveMod(frame0, L) : keyFrame(frame0),
    weights,
    taps: weights.length,
    loop: L,
  };
}

// ---------------------------------------------------------------------
// Drift: a slow random wander of the grain layer
// ---------------------------------------------------------------------
//
// Cubic (Catmull-Rom) interpolation of hashed knots one second apart,
// scaled to `drift` pixels — the layer wanders instead of sitting still,
// on top of whatever the kernel does to its content. Zero = off.
export function grainDriftOffset(
  tSeconds: number,
  drift: number,
  seed: number
): [number, number] {
  const d = Number.isFinite(drift) ? drift : 0;
  if (d <= 0) return [0, 0];
  const t = Number.isFinite(tSeconds) ? tSeconds : 0;
  const k = Math.floor(t);
  const f = t - k;
  const knot = (i: number): [number, number] => {
    const h = pcg3d((i + 0x100000) >>> 0, 0x2f6b7d3c, Math.imul(seed | 0, SEED_MUL) >>> 0);
    return [(h[0] >>> 0) * INV_2_32 * 2 - 1, (h[1] >>> 0) * INV_2_32 * 2 - 1];
  };
  const p0 = knot(k - 1);
  const p1 = knot(k);
  const p2 = knot(k + 1);
  const p3 = knot(k + 2);
  const cr = (a: number, b: number, c: number, e: number): number => {
    const f2 = f * f;
    const f3 = f2 * f;
    return (
      0.5 *
      (2 * b +
        (-a + c) * f +
        (2 * a - 5 * b + 4 * c - e) * f2 +
        (-a + 3 * b - 3 * c + e) * f3)
    );
  };
  return [d * cr(p0[0], p1[0], p2[0], p3[0]), d * cr(p0[1], p1[1], p2[1], p3[1])];
}

// What the node appends to its fingerprint while animated: the integer
// grain frame when the kernel is hard (so a 60 Hz preview of a 24 fps
// project recomputes 24×/s, not 60×/s), or the quantised continuous time
// when it is smooth.
export function grainTimeKey(t: number, sigma: number): string {
  const tt = Number.isFinite(t) ? t : 0;
  if (sigma <= 1e-6) return String(Math.floor(tt));
  return String(Math.round(tt / GRAIN_KEY_QUANTUM) * GRAIN_KEY_QUANTUM);
}

// ---------------------------------------------------------------------
// CPU mirror of the shader's per-(cell, frame) draw
// ---------------------------------------------------------------------
//
// Keep in lockstep with `sample4` in nodes/effect/grain.ts (GRAIN_NOISE_FS):
// same keys, same hash chaining, same Box–Muller. The integer hashes are
// bit-exact with the GPU (uint32 both sides); the float transcendentals are
// not, so this mirror is for statistics (mean, variance, decorrelation) and
// for reproducing the key schedule, not for pixel equality.

const INV_2_32 = 1 / 4294967296;
const SEED_MUL = 0x9e3779b9;
const CHAIN_A: [number, number, number] = [0x68e31da4, 0xb5297a4d, 0x1b56c4e9];
const CHAIN_B: [number, number, number] = [0x1b56c4e9, 0x68e31da4, 0xb5297a4d];

function words01(h: [number, number, number]): [number, number, number] {
  return [(h[0] >>> 0) * INV_2_32, (h[1] >>> 0) * INV_2_32, (h[2] >>> 0) * INV_2_32];
}

function boxMuller(u0: number, u1: number): [number, number] {
  const r = Math.sqrt(-2 * Math.log(Math.max(u0, 1e-7)));
  const a = 2 * Math.PI * u1;
  return [r * Math.cos(a), r * Math.sin(a)];
}

// Unit-variance draws for one grain cell and hashed frame:
// [luma, r, g, b] — luma is its own channel so `chromatic` adds
// independent per-channel grain on top of `luminance`.
export function grainSampleCpu(
  cellX: number,
  cellY: number,
  frame: number,
  seed: number,
  dist: GrainDistribution
): [number, number, number, number] {
  const z = ((frame | 0) ^ Math.imul(seed | 0, SEED_MUL)) >>> 0;
  const h0 = pcg3d(cellX >>> 0, cellY >>> 0, z);
  const h1 = pcg3d(
    (h0[0] ^ CHAIN_A[0]) >>> 0,
    (h0[1] ^ CHAIN_A[1]) >>> 0,
    (h0[2] ^ CHAIN_A[2]) >>> 0
  );
  const a = words01(h0);
  const b = words01(h1);
  if (dist === "gaussian") {
    const [g0, g1] = boxMuller(a[0], a[1]);
    const [g2, g3] = boxMuller(b[0], b[1]);
    return [g0, g1, g2, g3];
  }
  if (dist === "uniform") {
    const k = Math.sqrt(3);
    return [
      (a[0] * 2 - 1) * k,
      (a[1] * 2 - 1) * k,
      (a[2] * 2 - 1) * k,
      (b[0] * 2 - 1) * k,
    ];
  }
  // triangular: sum of two uniforms, std 1/√6 → ×√6. Eight independent
  // uniforms → a third hash.
  const h2 = pcg3d(
    (h1[0] ^ CHAIN_B[0]) >>> 0,
    (h1[1] ^ CHAIN_B[1]) >>> 0,
    (h1[2] ^ CHAIN_B[2]) >>> 0
  );
  const c = words01(h2);
  const k = Math.sqrt(6);
  return [
    (a[0] + a[1] - 1) * k,
    (a[2] + b[0] - 1) * k,
    (b[1] + b[2] - 1) * k,
    (c[0] + c[1] - 1) * k,
  ];
}

// The kernel applied at one cell: the temporal process the shader renders,
// for the gate's variance checks.
export function grainProcessCpu(
  cellX: number,
  cellY: number,
  kernel: GrainKernel,
  seed: number,
  dist: GrainDistribution
): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < kernel.taps; i++) {
    let f = kernel.frame0 + i;
    if (kernel.loop > 0) f = f % kernel.loop;
    const s = grainSampleCpu(cellX, cellY, f, seed, dist);
    const w = kernel.weights[i];
    out[0] += w * s[0];
    out[1] += w * s[1];
    out[2] += w * s[2];
    out[3] += w * s[3];
  }
  return out;
}

// ---------------------------------------------------------------------
// Grain size: units → cell size in render pixels
// ---------------------------------------------------------------------
//
// `scale` (labelled Size) is the grain cell size. `px` is render pixels
// (the legacy meaning, does not follow output size). `1080p px` is pixels
// on a 1080-tall canvas, scaled by H/1080 at render time so a 4K export
// keeps the 1080p preview's look. The µm units take `size_um` instead and
// convert through the film gauge's frame width: 35 mm 4-perf is 24.89 mm
// across, so at 1920 px wide one pixel is 13 µm and a 26 µm grain is 2 px.
export const GRAIN_SIZE_UNITS = [
  "px",
  "1080p px",
  "um 35mm",
  "um super 16",
  "um super 8",
] as const;
export type GrainSizeUnit = (typeof GRAIN_SIZE_UNITS)[number];

// Camera-aperture frame widths in millimetres.
export const GRAIN_GAUGE_WIDTH_MM: Record<string, number> = {
  "um 35mm": 24.89,
  "um super 16": 12.52,
  "um super 8": 5.79,
};

export function normalizeGrainSizeUnit(v: unknown): GrainSizeUnit {
  return (GRAIN_SIZE_UNITS as readonly string[]).includes(v as string)
    ? (v as GrainSizeUnit)
    : "px";
}

export function grainSizeUnitIsMicrons(unit: GrainSizeUnit): boolean {
  return unit.startsWith("um ");
}

export interface GrainCell {
  // Cell size in render pixels before aspect.
  basePx: number;
  // Cell width / height in render pixels after aspect (area preserved),
  // each at least one pixel.
  cellW: number;
  cellH: number;
}

export function grainCellPx(
  scale: unknown,
  sizeUm: unknown,
  unit: GrainSizeUnit,
  aspect: unknown,
  canvasW: number,
  canvasH: number
): GrainCell {
  const s = Math.max(1, typeof scale === "number" && Number.isFinite(scale) ? scale : 1);
  const um = Math.max(0.1, typeof sizeUm === "number" && Number.isFinite(sizeUm) ? sizeUm : 20);
  let basePx: number;
  if (unit === "1080p px") {
    basePx = (s * Math.max(1, canvasH)) / 1080;
  } else if (grainSizeUnitIsMicrons(unit)) {
    const widthMm = GRAIN_GAUGE_WIDTH_MM[unit] ?? 24.89;
    const umPerPx = (widthMm * 1000) / Math.max(1, canvasW);
    basePx = um / umPerPx;
  } else {
    basePx = s;
  }
  const a = typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const r = Math.sqrt(a);
  return {
    basePx,
    cellW: Math.max(1, basePx * r),
    cellH: Math.max(1, basePx / r),
  };
}

// ---------------------------------------------------------------------
// Soft model: spatial blur + octave weights
// ---------------------------------------------------------------------
//
// The plate is zero-mean noise, so a blur needs no mean preservation —
// normalise its 1-D weights to Σw² = 1 instead and the blurred plate stays
// unit variance by construction (separable: (Σwₓ²)(Σw_y²) = 1), the same
// rule the temporal kernel follows. `softness` is the Gaussian σ in grain
// cells.
export const GRAIN_BLUR_MAX_TAPS = 15;
export const GRAIN_MAX_SOFTNESS = 2;

export interface GrainBlur {
  taps: number; // odd; 1 = no blur
  weights: number[]; // Σw² = 1
}

export function grainBlurWeights(sigma: number): GrainBlur {
  const s = Math.min(GRAIN_MAX_SOFTNESS, Math.max(0, Number.isFinite(sigma) ? sigma : 0));
  if (s <= 1e-6) return { taps: 1, weights: [1] };
  const half = Math.min((GRAIN_BLUR_MAX_TAPS - 1) / 2, Math.ceil(3 * s));
  const taps = 2 * half + 1;
  const weights: number[] = new Array(taps);
  let sumSq = 0;
  for (let i = 0; i < taps; i++) {
    const d = (i - half) / s;
    const w = Math.exp(-0.5 * d * d);
    weights[i] = w;
    sumSq += w * w;
  }
  const norm = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < taps; i++) weights[i] *= norm;
  return { taps, weights };
}

// Coarser octaves at 2× and 4× the cell size mixed in with weights
// (1, ρ, ρ²), ρ = irregularity, renormalised to Σw² = 1 so the total grain
// keeps unit variance. ρ = 0 is the single octave.
export const GRAIN_MAX_OCTAVES = 3;

export function grainOctaveWeights(irregularity: number): number[] {
  const r = Math.min(1, Math.max(0, Number.isFinite(irregularity) ? irregularity : 0));
  if (r <= 1e-6) return [1];
  const raw = [1, r, r * r];
  const norm = 1 / Math.sqrt(raw.reduce((acc, w) => acc + w * w, 0));
  return raw.map((w) => w * norm);
}

// Each octave hashes from its own seed so the octaves are independent.
export function grainOctaveSeed(seed: number, octave: number): number {
  return (Math.max(0, Math.round(seed)) + 7919 * octave) >>> 0;
}

// ---------------------------------------------------------------------
// Film model: Boolean disc grains (after Newson, Delon & Galerne 2017)
// ---------------------------------------------------------------------
//
// Grains are discs with log-normal radii centred on a Poisson process
// whose density follows the local tone: fitting the Boolean model's
// coverage probability 1 − exp(−λ·E[πR²]) to the intensity u gives
// λ(u) = −ln(1 − u) / (π E[R²]). Shadows carry sparse isolated grains,
// highlights sparse holes — the morphology changes with tone, which no
// additive noise does. The shader walks the 3×3 cells around each pixel
// with GRAIN_FILM_SLOTS candidate grains per cell (each present with
// probability μ/slots, μ = expected grains per cell — binomial standing in
// for Poisson), unions their soft coverages, and normalises the deviation
// from u by the Bernoulli std sqrt(u(1−u)) so the amount params keep
// meaning "standard deviation".
export const GRAIN_FILM_SLOTS = 4;

// Render-resolution divisor for the film pass (decision 4 of the design
// Q&A): the disc search costs 9 × slots hashes per pixel per tap, so a
// canvas-sized pass at 4K wants an escape hatch.
export const GRAIN_QUALITIES = ["full", "half", "quarter"] as const;
export type GrainQuality = (typeof GRAIN_QUALITIES)[number];

export function normalizeGrainQuality(v: unknown): GrainQuality {
  return (GRAIN_QUALITIES as readonly string[]).includes(v as string)
    ? (v as GrainQuality)
    : "full";
}

export function grainQualityDivisor(q: GrainQuality): number {
  return q === "half" ? 2 : q === "quarter" ? 4 : 1;
}

export interface GrainFilmParams {
  // Mean grain radius in plate pixels (the cell size is the diameter).
  radius: number;
  // Log-normal spread of the radius: R = radius · exp(sigmaLn · z).
  sigmaLn: number;
  // Side of the search cell in plate pixels: twice the 95th-percentile
  // radius, so a grain never reaches past its neighbouring cell.
  cellSide: number;
  // Half-width of the soft disc edge in plate pixels (anti-aliasing
  // floor of 0.35 px).
  edge: number;
  // μ(u) = −ln(1 − u) · lambdaScale = expected grains per cell.
  lambdaScale: number;
}

export function grainFilmParams(
  cellBasePx: number,
  irregularity: number,
  softness: number,
  density: number,
  divisor: number
): GrainFilmParams {
  const div = Math.max(1, divisor);
  const radius = Math.max(0.25, cellBasePx / 2 / div);
  const sigmaLn = 0.6 * Math.min(1, Math.max(0, irregularity));
  const rMax = radius * Math.exp(2 * sigmaLn);
  const cellSide = Math.max(1, 2 * rMax);
  const edge = Math.max(0.35, Math.min(1, Math.max(0, softness)) * radius);
  const meanR2 = radius * radius * Math.exp(2 * sigmaLn * sigmaLn);
  const dens = Math.min(4, Math.max(0.25, Number.isFinite(density) ? density : 1));
  const lambdaScale = (dens * cellSide * cellSide) / (Math.PI * meanR2);
  return { radius, sigmaLn, cellSide, edge, lambdaScale };
}

// Expected grains per search cell at intensity u.
export function grainFilmMu(u: number, p: GrainFilmParams): number {
  const uu = Math.min(0.98, Math.max(0.02, u));
  return -Math.log(1 - uu) * p.lambdaScale;
}

// ---------------------------------------------------------------------
// Parametric model: AR(1) template (after the AV1 / H.274 codec models)
// ---------------------------------------------------------------------
//
// Video codecs strip grain, send a small parametric description and
// re-synthesise it after decode: an auto-regressive filter over Gaussian
// noise gives a template with short-range correlation, which is then
// laid over the picture in blocks at random offsets with overlapping,
// variance-preserving seams. AV1's luma template is 73×82 with a lag-3
// filter and 32×32 blocks blended with weights (27, 17)/32 — chosen so
// that 27² + 17² ≈ 32², the same Σw² = 1 rule everything here follows.
//
// Here the filter is the separable first-order AR, exact for an
// exponential correlation ρ^|dx|·ρ^|dy|:
//   g[x,y] = s·ε[x,y] + ρₓ g[x−1,y] + ρ_y g[x,y−1] − ρₓρ_y g[x−1,y−1]
// with s = sqrt((1−ρₓ²)(1−ρ_y²)) so the stationary variance is one. The
// template is built on the CPU per grain frame (≈20k texels × four
// channels) from the kernel-blended white noise — AR is linear, so
// filtering the blend equals blending the filtered frames — and uploaded;
// the GPU only tiles it.
export const GRAIN_AR_TEMPLATE = 128;
export const GRAIN_AR_MARGIN = 16;
export const GRAIN_AR_BLOCK = 32;
// Overlap of two texels per seam; weights ≈ AV1's 27/32 and 17/32.
export const GRAIN_AR_SEAM = 2;

// ρ per axis from one correlation and the aspect ratio: the correlation
// length ℓ = −1/ln ρ stretches by √aspect along x and shrinks along y.
export function grainArCoefficients(
  correlation: number,
  aspect: number
): { rhoX: number; rhoY: number } {
  const rho = Math.min(0.95, Math.max(0, Number.isFinite(correlation) ? correlation : 0));
  if (rho <= 1e-6) return { rhoX: 0, rhoY: 0 };
  const a = Number.isFinite(aspect) && aspect > 0 ? Math.sqrt(aspect) : 1;
  const ell = -1 / Math.log(rho);
  const rhoX = Math.min(0.98, Math.exp(-1 / (ell * a)));
  const rhoY = Math.min(0.98, Math.exp(-1 / (ell / a)));
  return { rhoX, rhoY };
}

// RGBA float template, `size` × `size`, unit variance per channel
// (luma, r, g, b independent). Generated with a warm-up margin so the
// causal filter is stationary inside the cropped region.
export function buildGrainArTemplate(
  kernel: GrainKernel,
  seed: number,
  dist: GrainDistribution,
  rhoX: number,
  rhoY: number,
  size: number = GRAIN_AR_TEMPLATE,
  margin: number = GRAIN_AR_MARGIN
): Float32Array {
  const G = size + margin;
  const g = new Float32Array(G * G * 4);
  const rx = Math.min(0.98, Math.max(0, rhoX));
  const ry = Math.min(0.98, Math.max(0, rhoY));
  const s = Math.sqrt((1 - rx * rx) * (1 - ry * ry));
  const rxy = rx * ry;
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      const e = grainProcessCpu(x, y, kernel, seed, dist);
      const i = (y * G + x) * 4;
      const left = x > 0 ? i - 4 : -1;
      const up = y > 0 ? i - G * 4 : -1;
      const diag = x > 0 && y > 0 ? i - G * 4 - 4 : -1;
      for (let c = 0; c < 4; c++) {
        let v = e[c] * s;
        if (left >= 0) v += rx * g[left + c];
        if (up >= 0) v += ry * g[up + c];
        if (diag >= 0) v -= rxy * g[diag + c];
        g[i + c] = v;
      }
    }
  }
  const out = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = ((y + margin) * G + margin) * 4;
    out.set(g.subarray(src, src + size * 4), y * size * 4);
  }
  return out;
}

// ---------------------------------------------------------------------
// Sensor and video models: component weights
// ---------------------------------------------------------------------
//
// `sensor` is the fine plate plus what a digital camera adds on top of
// shot noise: a FIXED PATTERN (static per-pixel offsets — the one grain
// that legitimately never moves), row / column BANDING (one value per
// line, smoothed over time by the same kernel), and a coarse chroma-only
// BLOTCH plate (the demosaic / denoise footprint). Components are mixed
// with weights renormalised to Σw² = 1 so the total stays unit variance.
export const GRAIN_BANDING_AXES = ["rows", "columns"] as const;
export type GrainBandingAxis = (typeof GRAIN_BANDING_AXES)[number];

export function normalizeGrainBandingAxis(v: unknown): GrainBandingAxis {
  return v === "columns" ? "columns" : "rows";
}

// [shot, fixed pattern, banding], Σw² = 1; everything off ⇒ pure shot.
export function grainSensorWeights(
  shot: number,
  fixed: number,
  banding: number
): [number, number, number] {
  const raw = [shot, fixed, banding].map((w) =>
    Math.min(1, Math.max(0, Number.isFinite(w) ? w : 0))
  );
  const sumSq = raw.reduce((acc, w) => acc + w * w, 0);
  if (sumSq <= 1e-12) return [1, 0, 0];
  const norm = 1 / Math.sqrt(sumSq);
  return [raw[0] * norm, raw[1] * norm, raw[2] * norm];
}

// Base plate + chroma blotch plate weights, Σw² = 1; blotch 0 ⇒ base only.
export function grainBlotchWeights(blotch: number): number[] {
  const b = Math.min(1, Math.max(0, Number.isFinite(blotch) ? blotch : 0));
  if (b <= 1e-6) return [1];
  const norm = 1 / Math.sqrt(1 + b * b);
  return [norm, b * norm];
}

// Hashed "frame" of the fixed-pattern draw — far outside any real frame
// key (frames sit at GRAIN_FRAME_BIAS + f, loops in [0, P)).
export const GRAIN_FIXED_FRAME = 0x3fffffff;

// ---------------------------------------------------------------------
// Application: working space
// ---------------------------------------------------------------------
//
// `display` adds the grain to the sRGB values as stored (the legacy look).
// `linear` decodes to linear light first — constant-variance noise there
// is shot-noise-like: heavy in the shadows, gone in the highlights once
// re-encoded. `log` adds it on a Cineon-style log encoding, which is
// multiplicative in linear light — a density noise, the film case.
//
// The amount params keep one meaning across spaces: the DISPLAY standard
// deviation the grain would have at mid grey (linear 0.18). Each space
// rescales the grain by the ratio of encode slopes at that point, so
// switching space changes where the grain lives in the tone curve, not
// how strong it reads overall.
export const GRAIN_SPACES = ["display", "linear", "log"] as const;
export type GrainSpace = (typeof GRAIN_SPACES)[number];

export function normalizeGrainSpace(v: unknown): GrainSpace {
  return (GRAIN_SPACES as readonly string[]).includes(v as string)
    ? (v as GrainSpace)
    : "display";
}

export function grainSpaceIndex(s: GrainSpace): number {
  return s === "linear" ? 1 : s === "log" ? 2 : 0;
}

// Log encoding: L = (log2(x + OFF) − log2(OFF)) / RANGE maps linear 0 → 0
// and linear 4 → 1. Mirrored as literals in the composite shader.
export const GRAIN_LOG_OFFSET = 1 / 1024;
export const GRAIN_LOG_RANGE =
  Math.log2(4 + GRAIN_LOG_OFFSET) - Math.log2(GRAIN_LOG_OFFSET);

export function grainLinToLog(x: number): number {
  return (Math.log2(Math.max(0, x) + GRAIN_LOG_OFFSET) - Math.log2(GRAIN_LOG_OFFSET)) / GRAIN_LOG_RANGE;
}

export function grainLogToLin(l: number): number {
  return Math.pow(2, l * GRAIN_LOG_RANGE + Math.log2(GRAIN_LOG_OFFSET)) - GRAIN_LOG_OFFSET;
}

const MID_GREY_LINEAR = 0.18;

function slopeAt(f: (x: number) => number, x: number): number {
  const h = 1e-4;
  return (f(x + h) - f(x - h)) / (2 * h);
}

// Multiplier applied to the (display-std) grain before it is added in
// the chosen space, so the result reads at the same strength at mid grey.
export function grainSpaceGain(space: GrainSpace): number {
  const displaySlope = slopeAt(linearToSrgb, MID_GREY_LINEAR);
  if (space === "linear") return 1 / displaySlope;
  if (space === "log") return slopeAt(grainLinToLog, MID_GREY_LINEAR) / displaySlope;
  return 1;
}

// ---------------------------------------------------------------------
// Application: tonal response
// ---------------------------------------------------------------------
//
// A curve from the input pixel's display luminance (0..1) to a grain
// amplitude multiplier (0..1), baked to a 256-entry LUT. Film grain lives
// in the thin parts of the negative (the scan's shadows) and prints show
// it in the midtones; sensors are noisiest in the shadows and clean in
// the highlights; nothing real has grain on clipped white.
export const GRAIN_RESPONSE_PRESETS = [
  "flat",
  "negative",
  "print",
  "digital",
  "protect highlights",
  "custom",
] as const;
export type GrainResponsePreset = (typeof GRAIN_RESPONSE_PRESETS)[number];

export function normalizeGrainResponsePreset(v: unknown): GrainResponsePreset {
  return (GRAIN_RESPONSE_PRESETS as readonly string[]).includes(v as string)
    ? (v as GrainResponsePreset)
    : "flat";
}

function curve(pts: [number, number][]): CurvePoint[] {
  return pts.map(([x, y], i) => ({ id: `r${i}`, x, y }));
}

export const GRAIN_RESPONSE_CURVES: Record<
  Exclude<GrainResponsePreset, "custom">,
  CurvePoint[]
> = {
  flat: curve([[0, 1], [1, 1]]),
  negative: curve([[0, 1], [0.25, 0.9], [0.6, 0.55], [1, 0.15]]),
  print: curve([[0, 0.25], [0.5, 1], [1, 0.2]]),
  digital: curve([[0, 1], [0.3, 0.75], [0.7, 0.4], [1, 0.1]]),
  "protect highlights": curve([[0, 1], [0.7, 1], [0.85, 0.5], [1, 0]]),
};

export function defaultGrainResponseCurve(): CurvePoint[] {
  return defaultFloatCurve(1, 1);
}

export function grainResponseCurve(
  preset: GrainResponsePreset,
  custom: unknown
): CurvePoint[] {
  if (preset === "custom") return sanitizeFloatCurve(custom, 1, 1);
  return GRAIN_RESPONSE_CURVES[preset];
}

export const GRAIN_LUT_SIZE = 256;

export function buildGrainResponseLut(points: CurvePoint[]): Uint8Array {
  const out = new Uint8Array(GRAIN_LUT_SIZE);
  for (let i = 0; i < GRAIN_LUT_SIZE; i++) {
    const y = sampleFloatCurve(points, i / (GRAIN_LUT_SIZE - 1));
    out[i] = Math.max(0, Math.min(255, Math.round(y * 255)));
  }
  return out;
}

// Cache key for the baked LUT — preset name, or the custom points.
export function grainResponseKey(preset: GrainResponsePreset, custom: unknown): string {
  if (preset !== "custom") return preset;
  return "custom:" + JSON.stringify(sanitizeFloatCurve(custom, 1, 1).map((p) => [p.x, p.y]));
}

// ---------------------------------------------------------------------
// Presets: the look params as one table
// ---------------------------------------------------------------------
//
// A preset other than `custom` drives every LOOK param below from its row
// (Physarum's pattern); amounts, motion, mix, tint and soft clip stay the
// user's. Names are generic gauge / speed descriptions — the rows are
// approximations, not measurements of any stock.
export const GRAIN_PRESETS = [
  "custom",
  "35mm fine",
  "35mm 500T",
  "super 16",
  "super 8",
  "digital ISO 800",
  "digital ISO 6400",
  "video snow",
] as const;
export type GrainPreset = (typeof GRAIN_PRESETS)[number];

export function normalizeGrainPreset(v: unknown): GrainPreset {
  return (GRAIN_PRESETS as readonly string[]).includes(v as string)
    ? (v as GrainPreset)
    : "custom";
}

export interface GrainLook {
  model: GrainModel;
  scale: number;
  size_unit: GrainSizeUnit;
  size_um: number;
  aspect: number;
  distribution: GrainDistribution;
  softness: number;
  irregularity: number;
  response_preset: GrainResponsePreset;
  space: GrainSpace;
  saturation: number;
  per_channel: boolean;
  size_r: number;
  size_g: number;
  size_b: number;
  intensity_r: number;
  intensity_g: number;
  intensity_b: number;
  // film model
  density: number;
  quality: GrainQuality;
  // parametric model
  correlation: number;
  // sensor model
  shot: number;
  fixed_pattern: number;
  banding: number;
  banding_axis: GrainBandingAxis;
  blotch: number;
  blotch_size: number;
  // video model
  streak: number;
  line_jitter: number;
  dropout: number;
  // plate model
  plate_scale: number;
  plate_center: number;
  plate_gain: number;
  plate_flips: boolean;
}

export const GRAIN_LOOK_DEFAULTS: GrainLook = {
  model: "fine",
  scale: 1,
  size_unit: "px",
  size_um: 20,
  aspect: 1,
  distribution: "gaussian",
  softness: 0.5,
  irregularity: 0.3,
  density: 1,
  quality: "full",
  correlation: 0.6,
  shot: 1,
  fixed_pattern: 0.15,
  banding: 0.1,
  banding_axis: "rows",
  blotch: 0.3,
  blotch_size: 8,
  streak: 12,
  line_jitter: 0.3,
  dropout: 0.05,
  plate_scale: 1,
  plate_center: 0.5,
  plate_gain: 4,
  plate_flips: true,
  response_preset: "flat",
  space: "display",
  saturation: 1,
  per_channel: false,
  size_r: 1,
  size_g: 1,
  size_b: 1,
  intensity_r: 1,
  intensity_g: 1,
  intensity_b: 1,
};

// Nuke's Grain defaults encode the received wisdom on colour negative:
// size R 3.3 / G 2.9 / B 2.5 and intensity R 0.416 / G 0.46 / B 0.85 —
// the red record coarsest, the blue heaviest. Normalised here to the
// finest channel / the green channel.
const FILM_CHANNELS = {
  per_channel: true,
  size_r: 1.32,
  size_g: 1.16,
  size_b: 1,
  intensity_r: 0.9,
  intensity_g: 1,
  intensity_b: 1.85,
};

export const GRAIN_PRESET_LOOKS: Record<Exclude<GrainPreset, "custom">, GrainLook> = {
  "35mm fine": {
    ...GRAIN_LOOK_DEFAULTS,
    model: "soft",
    scale: 1.2,
    size_unit: "1080p px",
    softness: 0.35,
    irregularity: 0.2,
    response_preset: "negative",
    space: "log",
    saturation: 0.8,
    ...FILM_CHANNELS,
  },
  "35mm 500T": {
    ...GRAIN_LOOK_DEFAULTS,
    model: "parametric",
    scale: 1.4,
    size_unit: "1080p px",
    correlation: 0.55,
    response_preset: "negative",
    space: "log",
    saturation: 0.9,
    ...FILM_CHANNELS,
  },
  "super 16": {
    ...GRAIN_LOOK_DEFAULTS,
    model: "soft",
    scale: 2.6,
    size_unit: "1080p px",
    softness: 0.5,
    irregularity: 0.5,
    response_preset: "negative",
    space: "log",
    saturation: 0.9,
    ...FILM_CHANNELS,
  },
  "super 8": {
    ...GRAIN_LOOK_DEFAULTS,
    model: "film",
    scale: 4.2,
    size_unit: "1080p px",
    softness: 0.5,
    irregularity: 0.6,
    density: 1,
    response_preset: "print",
    space: "log",
    saturation: 1,
    ...FILM_CHANNELS,
  },
  "digital ISO 800": {
    ...GRAIN_LOOK_DEFAULTS,
    model: "sensor",
    scale: 1,
    fixed_pattern: 0.1,
    banding: 0.05,
    blotch: 0.3,
    blotch_size: 8,
    response_preset: "digital",
    space: "linear",
    saturation: 1.4,
  },
  "digital ISO 6400": {
    ...GRAIN_LOOK_DEFAULTS,
    model: "sensor",
    scale: 1,
    fixed_pattern: 0.2,
    banding: 0.15,
    blotch: 0.5,
    blotch_size: 12,
    response_preset: "digital",
    space: "linear",
    saturation: 1.6,
  },
  "video snow": {
    ...GRAIN_LOOK_DEFAULTS,
    model: "video",
    scale: 1,
    streak: 14,
    line_jitter: 0.4,
    dropout: 0.08,
    response_preset: "flat",
    space: "display",
    saturation: 0.3,
  },
};

function lookNum(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

// The look the node renders: the preset's row, or the params themselves
// when `preset` is custom (falling back to the defaults for anything
// missing, so a freshly created node and an old save both resolve).
export function grainResolveLook(params: Record<string, unknown>): GrainLook {
  const preset = normalizeGrainPreset(params.preset);
  if (preset !== "custom") return { ...GRAIN_PRESET_LOOKS[preset] };
  const d = GRAIN_LOOK_DEFAULTS;
  return {
    model: normalizeGrainModel(params.model),
    scale: lookNum(params.scale, d.scale),
    size_unit: normalizeGrainSizeUnit(params.size_unit),
    size_um: lookNum(params.size_um, d.size_um),
    aspect: lookNum(params.aspect, d.aspect),
    distribution: normalizeGrainDistribution(params.distribution),
    softness: lookNum(params.softness, d.softness),
    irregularity: lookNum(params.irregularity, d.irregularity),
    density: lookNum(params.density, d.density),
    quality: normalizeGrainQuality(params.quality),
    correlation: lookNum(params.correlation, d.correlation),
    shot: lookNum(params.shot, d.shot),
    fixed_pattern: lookNum(params.fixed_pattern, d.fixed_pattern),
    banding: lookNum(params.banding, d.banding),
    banding_axis: normalizeGrainBandingAxis(params.banding_axis),
    blotch: lookNum(params.blotch, d.blotch),
    blotch_size: lookNum(params.blotch_size, d.blotch_size),
    streak: lookNum(params.streak, d.streak),
    line_jitter: lookNum(params.line_jitter, d.line_jitter),
    dropout: lookNum(params.dropout, d.dropout),
    plate_scale: lookNum(params.plate_scale, d.plate_scale),
    plate_center: lookNum(params.plate_center, d.plate_center),
    plate_gain: lookNum(params.plate_gain, d.plate_gain),
    plate_flips: params.plate_flips !== false,
    response_preset: normalizeGrainResponsePreset(params.response_preset),
    space: normalizeGrainSpace(params.space),
    saturation: lookNum(params.saturation, d.saturation),
    per_channel: params.per_channel === true,
    size_r: lookNum(params.size_r, 1),
    size_g: lookNum(params.size_g, 1),
    size_b: lookNum(params.size_b, 1),
    intensity_r: lookNum(params.intensity_r, 1),
    intensity_g: lookNum(params.intensity_g, 1),
    intensity_b: lookNum(params.intensity_b, 1),
  };
}

// ---------------------------------------------------------------------
// Saved-project migration
// ---------------------------------------------------------------------

// Nodes saved before v2 carry no `model`. They keep the original shader
// under `classic` so they render pixel-identical (including a Seed wired
// to Scene Time); new nodes default to `fine`. Called from
// lib/project.ts's migrateLoadedParams.
export function migrateGrainParams(params: Record<string, unknown>): void {
  if (params.model === undefined) params.model = "classic";
}
