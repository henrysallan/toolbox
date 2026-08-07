// Low-rank separable decomposition of an arbitrary 2D kernel.
//
// Any 2D kernel matrix K decomposes as K = Σ σ_i·u_i·v_iᵀ. Every rank-1
// term in that sum is separable by construction — convolve horizontally
// with v_i, vertically with u_i — so keeping the top r terms turns an
// O(r²)-per-pixel arbitrary convolution into r separable passes at O(r).
// Rank 4 is not exact, but it is close enough for aperture shapes and
// costs a fraction of the direct evaluation.
//
// This is the second plan builder over the shared core: it feeds
// `runSeparable` exactly like complex.ts does, which is what lets Bokeh's
// polygonal shapes and Convolve's user kernels share one execution path.
//
// Only the top few singular triplets are wanted, so this uses power
// iteration with deflation rather than a full Jacobi SVD — O(r·n²) per
// solve instead of O(n³) per sweep, and r is never more than 8.
//
// EVERYTHING HERE IS DETERMINISTIC. The power iteration's starting vector
// is a fixed function of its index, never random: the node's fingerprint
// cache assumes identical params produce identical output, and a random
// init would make the kernel silently differ between evaluations.

/** One rank-1 term, already converted to shader tap order. */
export type SeparableTerm = {
  /** Horizontal taps, length 2·half+1. Carries the singular value. */
  h: Float32Array;
  /** Vertical taps, length 2·half+1. */
  v: Float32Array;
};

const MAX_ITER = 60;
const TOL = 1e-9;
const EPS = 1e-12;

type Triplet = { sigma: number; u: Float64Array; v: Float64Array };

function decomposeTriplets(
  matrix: Float64Array,
  size: number,
  rank: number
): Triplet[] {
  const k = new Float64Array(matrix); // deflation mutates; don't touch the caller's
  const out: Triplet[] = [];
  const u = new Float64Array(size);
  let vv = new Float64Array(size);

  for (let t = 0; t < rank; t++) {
    if (t === 0) {
      // Column sums are an excellent first guess for a non-negative
      // kernel — the dominant singular vector of a blur aperture is
      // essentially its marginal.
      vv.fill(0);
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) vv[j] += k[i * size + j];
      }
    } else {
      // Deterministic, and varied per term so successive runs do not
      // start inside the subspace just deflated away.
      for (let j = 0; j < size; j++) vv[j] = Math.cos((j + 1) * (t + 1) * 0.9);
    }
    let norm = 0;
    for (let j = 0; j < size; j++) norm += vv[j] * vv[j];
    norm = Math.sqrt(norm);
    if (!(norm > EPS)) break;
    for (let j = 0; j < size; j++) vv[j] /= norm;

    let sigma = 0;
    let prev = -1;
    for (let iter = 0; iter < MAX_ITER; iter++) {
      // u = K·v
      u.fill(0);
      for (let i = 0; i < size; i++) {
        let acc = 0;
        const row = i * size;
        for (let j = 0; j < size; j++) acc += k[row + j] * vv[j];
        u[i] = acc;
      }
      let nu = 0;
      for (let i = 0; i < size; i++) nu += u[i] * u[i];
      nu = Math.sqrt(nu);
      if (!(nu > EPS)) { sigma = 0; break; }
      for (let i = 0; i < size; i++) u[i] /= nu;

      // v = Kᵀ·u
      const nv = new Float64Array(size);
      for (let i = 0; i < size; i++) {
        const ui = u[i];
        if (ui === 0) continue;
        const row = i * size;
        for (let j = 0; j < size; j++) nv[j] += k[row + j] * ui;
      }
      sigma = 0;
      for (let j = 0; j < size; j++) sigma += nv[j] * nv[j];
      sigma = Math.sqrt(sigma);
      if (!(sigma > EPS)) break;
      for (let j = 0; j < size; j++) nv[j] /= sigma;
      vv = nv;

      if (prev >= 0 && Math.abs(sigma - prev) <= TOL * sigma) break;
      prev = sigma;
    }
    if (!(sigma > EPS)) break;

    out.push({ sigma, u: Float64Array.from(u), v: Float64Array.from(vv) });
    // Deflate so the next iteration finds the next-largest term.
    for (let i = 0; i < size; i++) {
      const su = sigma * u[i];
      if (su === 0) continue;
      const row = i * size;
      for (let j = 0; j < size; j++) k[row + j] -= su * vv[j];
    }
  }
  return out;
}

/**
 * Decompose a SCREEN-ORDER kernel matrix (row 0 = top, col 0 = left) into
 * shader-ready separable terms.
 *
 * ─── The flip, which is the easy thing to get wrong ───
 *
 * Cell (row, col) means a screen displacement of (col−h) right and
 * (row−h) down. True convolution samples `src(p − d)`, which is what
 * makes a point light render as the aperture AS DRAWN rather than rotated
 * 180° (correlation would flip it).
 *
 * The shaders sample at `uv + dir·texel·(i − h)`, and UV is Y-UP:
 *   horizontal  (i − h) = −(col − h)  ⇒  i = 2h − col   → columns REVERSED
 *   vertical    (i − h) = +(row − h)  ⇒  i = row        → rows unchanged
 *
 * The row axis needs no reversal because the convolution flip and the
 * screen-down/UV-up flip cancel. Exactly one of the two axes reverses —
 * if both or neither do, an asymmetric kernel renders mirrored.
 */
export function decomposeKernel(
  matrix: Float64Array,
  size: number,
  rank: number,
  normalize: boolean
): SeparableTerm[] {
  const triplets = decomposeTriplets(matrix, size, Math.max(1, rank));
  if (!triplets.length) return [];

  // Energy scaling, from the closed form of the reconstruction's sum:
  // Σ_t σ_t·(Σ_i u_t[i])·(Σ_j v_t[j]). Computed on the RANK-r
  // reconstruction rather than the original matrix, so a truncated
  // decomposition still preserves brightness exactly.
  let scale = 1;
  if (normalize) {
    let total = 0;
    for (const t of triplets) {
      let su = 0;
      let sv = 0;
      for (let i = 0; i < size; i++) su += t.u[i];
      for (let j = 0; j < size; j++) sv += t.v[j];
      total += t.sigma * su * sv;
    }
    if (Math.abs(total) > 1e-9) scale = 1 / total;
  }

  return triplets.map((t) => {
    const h = new Float32Array(size);
    const v = new Float32Array(size);
    const w = t.sigma * scale;
    for (let i = 0; i < size; i++) {
      h[i] = t.v[size - 1 - i] * w; // columns reversed, singular value folded in
      v[i] = t.u[i]; // rows as-is
    }
    return { h, v };
  });
}
