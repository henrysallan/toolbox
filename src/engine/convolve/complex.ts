// Complex separable circular convolution — the coefficient solver.
//
// The Gaussian is the only circularly-symmetric kernel that is linearly
// separable, which is why every naive blur looks soft. The way out
// (Niemitalo; productionized by Garcia as Circular Separable Convolution
// DoF) is to parameterize the Gaussian with a COMPLEX exponent:
//
//     g(t) = e^(-a·t² + i·b·t²)
//
// The 2D product is still separable AND still circularly symmetric,
// because it collapses to a function of r² alone:
//
//     g(x)·g(y) = e^((-a + i·b)·(x² + y²)) = e^((-a + i·b)·r²)
//
// So a weighted sum of the real and imaginary parts of a few such
// components approximates any circularly-symmetric profile at separable
// (O(r), not O(r²)) cost. One component rings hard; two largely kills it;
// three or four give a genuinely flat-topped disc.
//
// We do NOT ship a hardcoded coefficient table. Writing s = r², every
// basis function is
//
//     Re: e^(-a·s)·cos(b·s)      Im: e^(-a·s)·sin(b·s)
//
// which is LINEAR in the recombination weights (A, B) — so for fixed
// (a, b) the weights are an ordinary least-squares fit against a target
// radial profile. That buys two things a fixed table doesn't:
//   * no magic numbers to transcribe wrong, and
//   * `disc` / `ring` / `soft` stop being special cases. They are the same
//     solver against a different target profile.
//
// The only nonlinear part is (a, b) itself, which we reduce to two
// parameters — a_j = aScale·(j+1), b_j = bScale·(j+1), i.e. damped
// harmonics — and grid-search. Intuition for why that family works: with
// a → 0 the basis IS a Fourier series in s, and fitting a step function
// (the disc edge) gives textbook Gibbs ringing. `a` damps the higher
// harmonics, trading ring for softness. That is exactly the
// components-vs-artifacts knob the technique is known for, so the search
// is exploring the right axis.

export type BokehShape = "disc" | "ring" | "soft";

export type ComplexComponent = {
  a: number;
  b: number;
  /** Recombination weight on the real part. */
  A: number;
  /** Recombination weight on the imaginary part. */
  B: number;
};

export const MAX_BOKEH_COMPONENTS = 4;

// The 1D kernel argument runs over [-1, 1], so the 2D support is the unit
// square and s = x² + y² reaches 2 at the corners. Fit over the whole
// square or the corners are unconstrained and blow up.
const S_MAX = 2;
const FIT_SAMPLES = 256;

// Ridge term on the normal equations. Doubles as an anti-ringing penalty:
// large cancelling coefficients are exactly what produces overshoot, so
// discouraging their magnitude improves the visual result, not just the
// conditioning.
const RIDGE = 1e-3;

// ---------------------------------------------------------------------
// Target radial profiles, as a function of s = r²
// ---------------------------------------------------------------------

// A hard step is the honest target for a disc, but softening it very
// slightly over a couple of samples measurably reduces Gibbs overshoot
// for the same component count.
const EDGE_SOFTEN = 0.06;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function makeTarget(shape: BokehShape, ring: number): (s: number) => number {
  if (shape === "soft") {
    // Soft-edged disc: energy falls off from the middle outward. Reads as
    // a "creamy" bokeh rather than a hard aperture.
    return (s) => 1 - smoothstep(0.15, 1.0, s);
  }
  if (shape === "ring") {
    // Donut. `ring` is the fraction of the radius that is hollow, so
    // ring→0 is a thin rim and ring→1 is the solid disc.
    const inner = Math.max(0, Math.min(0.999, 1 - ring));
    const sInner = inner * inner;
    return (s) => {
      const outer = 1 - smoothstep(1 - EDGE_SOFTEN, 1 + EDGE_SOFTEN, s);
      const hole = smoothstep(sInner - EDGE_SOFTEN, sInner + EDGE_SOFTEN, s);
      return outer * hole;
    };
  }
  // disc
  return (s) => 1 - smoothstep(1 - EDGE_SOFTEN, 1 + EDGE_SOFTEN, s);
}

// ---------------------------------------------------------------------
// Least squares
// ---------------------------------------------------------------------

// Solve (MᵀM + ridge·I) c = Mᵀt for small K (≤ 8) by Gaussian elimination
// with partial pivoting. Returns null if the system is singular.
function solveNormalEquations(
  design: Float64Array, // FIT_SAMPLES × K, row-major
  target: Float64Array, // FIT_SAMPLES
  k: number
): Float64Array | null {
  const m = FIT_SAMPLES;
  // Normal equations. Symmetric, but K is tiny — building both halves is
  // cheaper than the bookkeeping to avoid it.
  const ata = new Float64Array(k * k);
  const atb = new Float64Array(k);
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      let sum = 0;
      for (let s = 0; s < m; s++) sum += design[s * k + i] * design[s * k + j];
      ata[i * k + j] = sum + (i === j ? RIDGE : 0);
    }
    let sum = 0;
    for (let s = 0; s < m; s++) sum += design[s * k + i] * target[s];
    atb[i] = sum;
  }

  // Augmented elimination.
  const aug = new Float64Array(k * (k + 1));
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) aug[i * (k + 1) + j] = ata[i * k + j];
    aug[i * (k + 1) + k] = atb[i];
  }
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) {
      if (Math.abs(aug[r * (k + 1) + col]) > Math.abs(aug[pivot * (k + 1) + col])) {
        pivot = r;
      }
    }
    const pv = aug[pivot * (k + 1) + col];
    if (!Number.isFinite(pv) || Math.abs(pv) < 1e-12) return null;
    if (pivot !== col) {
      for (let j = col; j <= k; j++) {
        const tmp = aug[col * (k + 1) + j];
        aug[col * (k + 1) + j] = aug[pivot * (k + 1) + j];
        aug[pivot * (k + 1) + j] = tmp;
      }
    }
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = aug[r * (k + 1) + col] / aug[col * (k + 1) + col];
      if (f === 0) continue;
      for (let j = col; j <= k; j++) {
        aug[r * (k + 1) + j] -= f * aug[col * (k + 1) + j];
      }
    }
  }
  const out = new Float64Array(k);
  for (let i = 0; i < k; i++) {
    const d = aug[i * (k + 1) + i];
    if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null;
    out[i] = aug[i * (k + 1) + k] / d;
    if (!Number.isFinite(out[i])) return null;
  }
  return out;
}

// ---------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------

const A_SCALES = 16;
const B_SCALES = 16;
const A_MIN = 0.05;
const A_MAX = 3.0;
const B_MIN = 0.5;
const B_MAX = 9.0;

// Penalty on coefficient magnitude, on top of the ridge. Two fits with
// near-identical residual but wildly different coefficient norms are not
// equally good — the big-coefficient one is cancelling two large lobes
// and will ring on real footage.
const NORM_PENALTY = 2e-3;

function logspace(lo: number, hi: number, n: number, i: number): number {
  const t = n === 1 ? 0 : i / (n - 1);
  return Math.exp(Math.log(lo) + t * (Math.log(hi) - Math.log(lo)));
}

function fitOnce(
  as: Float64Array,
  bs: Float64Array,
  count: number,
  sSamples: Float64Array,
  target: Float64Array
): { comps: ComplexComponent[]; cost: number } | null {
  const k = count * 2;
  const design = new Float64Array(FIT_SAMPLES * k);
  for (let j = 0; j < count; j++) {
    const a = as[j];
    const b = bs[j];
    for (let s = 0; s < FIT_SAMPLES; s++) {
      const sv = sSamples[s];
      const decay = Math.exp(-a * sv);
      design[s * k + j * 2] = decay * Math.cos(b * sv);
      design[s * k + j * 2 + 1] = decay * Math.sin(b * sv);
    }
  }
  const c = solveNormalEquations(design, target, k);
  if (!c) return null;

  let residual = 0;
  for (let s = 0; s < FIT_SAMPLES; s++) {
    let v = 0;
    for (let i = 0; i < k; i++) v += design[s * k + i] * c[i];
    const d = v - target[s];
    residual += d * d;
  }
  residual /= FIT_SAMPLES;

  let norm = 0;
  for (let i = 0; i < k; i++) norm += c[i] * c[i];
  if (!Number.isFinite(residual) || !Number.isFinite(norm)) return null;

  const comps: ComplexComponent[] = [];
  for (let j = 0; j < count; j++) {
    comps.push({ a: as[j], b: bs[j], A: c[j * 2], B: c[j * 2 + 1] });
  }
  return { comps, cost: residual + NORM_PENALTY * norm };
}

// Local multiplicative steps for the refinement sweeps.
const REFINE_STEPS = [0.55, 0.7, 0.85, 1.0, 1.2, 1.45, 1.8, 2.2];
const REFINE_SWEEPS = 4;

const fitCache = new Map<string, ComplexComponent[]>();

/**
 * Fit `count` complex components to the requested radial profile.
 *
 * Pure and deterministic, and cached module-level by (shape, count, ring)
 * — the grid search is a few hundred small solves, which is nothing once
 * per parameter change but not something to repeat per frame.
 */
export function fitComplexComponents(
  shape: BokehShape,
  count: number,
  ring: number
): ComplexComponent[] {
  const n = Math.max(1, Math.min(MAX_BOKEH_COMPONENTS, Math.round(count)));
  const r = shape === "ring" ? Math.max(0, Math.min(1, ring)) : 0;
  const key = `${shape}:${n}:${r.toFixed(3)}`;
  const hit = fitCache.get(key);
  if (hit) return hit;

  const profile = makeTarget(shape, r);
  const sSamples = new Float64Array(FIT_SAMPLES);
  const target = new Float64Array(FIT_SAMPLES);
  for (let i = 0; i < FIT_SAMPLES; i++) {
    // Uniform in s is area-correct: the 2D area element is 2πr·dr = π·ds,
    // so equal steps in s weight equal amounts of the kernel's area.
    const s = (S_MAX * i) / (FIT_SAMPLES - 1);
    sSamples[i] = s;
    target[i] = profile(s);
  }

  // Stage 1 — coarse grid over damped harmonics (a_j, b_j) ∝ (j+1). Cheap
  // and gets into the right basin.
  let best: { comps: ComplexComponent[]; cost: number } | null = null;
  let bestA = new Float64Array(n);
  let bestB = new Float64Array(n);
  const as = new Float64Array(n);
  const bs = new Float64Array(n);
  for (let ai = 0; ai < A_SCALES; ai++) {
    const aScale = logspace(A_MIN, A_MAX, A_SCALES, ai);
    for (let bi = 0; bi < B_SCALES; bi++) {
      const bScale = logspace(B_MIN, B_MAX, B_SCALES, bi);
      for (let j = 0; j < n; j++) {
        as[j] = aScale * (j + 1);
        bs[j] = bScale * (j + 1);
      }
      const got = fitOnce(as, bs, n, sSamples, target);
      if (got && (!best || got.cost < best.cost)) {
        best = got;
        bestA = Float64Array.from(as);
        bestB = Float64Array.from(bs);
      }
    }
  }

  // Stage 2 — coordinate descent on each (a_j, b_j) independently.
  //
  // The harmonic constraint from stage 1 is a good starting guess but a
  // bad final answer: it is a 2-parameter slice through a 2N-parameter
  // space, and published coefficient sets are not harmonically related.
  // Without this refinement the search is not even monotonic in component
  // count — measured, 4 components fit the disc WORSE than 3, which is
  // the kind of result that would quietly ship as "bokeh looks lumpy".
  if (best) {
    const cur = { a: bestA, b: bestB };
    for (let sweep = 0; sweep < REFINE_SWEEPS; sweep++) {
      let improved = false;
      for (let j = 0; j < n; j++) {
        for (const which of ["a", "b"] as const) {
          // Trials all fan out from the coordinate's value at the START of
          // this pass, and the winner is applied once at the end —
          // adopting mid-loop would make each subsequent step relative to
          // a moving base.
          const origin = cur[which][j];
          let winner = origin;
          for (const step of REFINE_STEPS) {
            if (step === 1.0) continue;
            const trial = origin * step;
            if (which === "a" && (trial < 1e-3 || trial > 40)) continue;
            if (which === "b" && (trial < 1e-3 || trial > 60)) continue;
            cur[which][j] = trial;
            const got = fitOnce(cur.a, cur.b, n, sSamples, target);
            if (got && got.cost < best.cost - 1e-12) {
              best = got;
              winner = trial;
              improved = true;
            }
          }
          cur[which][j] = winner;
        }
      }
      if (!improved) break;
    }
  }

  // Fall back to a plain Gaussian rather than throwing — a blur that is
  // too soft is a far better failure than a black frame.
  const comps: ComplexComponent[] = best?.comps ?? [{ a: 2, b: 0, A: 1, B: 0 }];
  fitCache.set(key, comps);
  return comps;
}

// ---------------------------------------------------------------------
// Weight tables
// ---------------------------------------------------------------------

/**
 * Sample one component into the RGBA half-tap table the shaders read.
 *
 * g(t) = e^(-a·t²)·(cos(b·t²) + i·sin(b·t²)) is EVEN in t, so only taps
 * 0..halfTaps are stored and the shaders mirror them.
 *
 * Channel layout, per tap:
 *   .x  Re g   — the horizontal pass's real weight
 *   .y  Im g   — the horizontal pass's imaginary weight
 *   .z  w1     — the vertical pass's weight on the real input
 *   .w  w2     — the vertical pass's weight on the imaginary input
 *
 * w1/w2 fold the recombination in, which is what lets the vertical pass
 * emit the final real contribution directly instead of carrying a complex
 * result forward. Expanding A·Re(C) + B·Im(C) for C = Σ h(v)·g(v) with
 * complex h gives
 *
 *   Σ [ (A·Re g + B·Im g)·Re h  +  (B·Re g − A·Im g)·Im h ]
 *      \_______w1_______/           \_______w2_______/
 */
export function buildComplexWeights(
  comps: ComplexComponent[],
  halfTaps: number
): Float32Array[] {
  // Normalization has to happen across the whole recombined 2D kernel,
  // not per component — the components individually do not sum to
  // anything meaningful. Because the 2D kernel is the product g(x)·g(y),
  // the discrete 2D sum has a closed form in the 1D sums:
  //   Σ_{u,v} Re(g(u)g(v)) = Re((Σg)²) = (ΣRe)² − (ΣIm)²
  //   Σ_{u,v} Im(g(u)g(v)) = Im((Σg)²) = 2·ΣRe·ΣIm
  let total = 0;
  const sums = comps.map((c) => {
    let sRe = 0;
    let sIm = 0;
    for (let i = -halfTaps; i <= halfTaps; i++) {
      const t = halfTaps === 0 ? 0 : i / halfTaps;
      const s = t * t;
      const decay = Math.exp(-c.a * s);
      sRe += decay * Math.cos(c.b * s);
      sIm += decay * Math.sin(c.b * s);
    }
    return { sRe, sIm };
  });
  comps.forEach((c, j) => {
    const { sRe, sIm } = sums[j];
    total += c.A * (sRe * sRe - sIm * sIm) + c.B * (2 * sRe * sIm);
  });
  // A degenerate fit (total ≈ 0) would divide the image into oblivion.
  const norm = Math.abs(total) > 1e-6 ? 1 / total : 1;

  return comps.map((c) => {
    const out = new Float32Array((halfTaps + 1) * 4);
    const A = c.A * norm;
    const B = c.B * norm;
    for (let i = 0; i <= halfTaps; i++) {
      const t = halfTaps === 0 ? 0 : i / halfTaps;
      const s = t * t;
      const decay = Math.exp(-c.a * s);
      const re = decay * Math.cos(c.b * s);
      const im = decay * Math.sin(c.b * s);
      out[i * 4] = re;
      out[i * 4 + 1] = im;
      out[i * 4 + 2] = A * re + B * im;
      out[i * 4 + 3] = B * re - A * im;
    }
    return out;
  });
}

/**
 * The degenerate real-only case, kept in the same table layout so the
 * Gaussian rides the exact same two shaders.
 *
 * Deliberately reproduces the legacy `gaussian-blur` node tap-for-tap:
 * unit pixel stride, weights exp(-i²/2σ²), normalized by the 1D sum. With
 * `linearize` off that makes the new node pixel-identical to the old one,
 * which is the M1 verification gate.
 */
export function buildGaussianWeights(
  sigma: number,
  halfTaps: number
): Float32Array {
  const out = new Float32Array((halfTaps + 1) * 4);
  const twoSigmaSq = 2 * sigma * sigma;
  let sum = 0;
  for (let i = 0; i <= halfTaps; i++) {
    const w = Math.exp(-(i * i) / twoSigmaSq);
    out[i * 4] = w;
    sum += i === 0 ? w : 2 * w;
  }
  const norm = sum > 1e-12 ? 1 / sum : 1;
  for (let i = 0; i <= halfTaps; i++) {
    const w = out[i * 4] * norm;
    out[i * 4] = w; // horizontal real weight
    out[i * 4 + 1] = 0; // no imaginary part
    out[i * 4 + 2] = w; // vertical weight on the real input
    out[i * 4 + 3] = 0;
  }
  return out;
}
