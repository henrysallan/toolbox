// Pure fitting helpers for the calibration (no AE, no Electron): imported by
// the calibration runs and by scripts/ae-export/check-calibration.mts, which
// re-derives the recorded fits from the recorded profiles.

// Second-moment σ and centre of a 1-D kernel profile (black level removed).
export function moments(p: readonly number[]): { center: number; sigma: number; sum: number } {
  let s = 0;
  let m1 = 0;
  for (let i = 0; i < p.length; i++) {
    s += p[i];
    m1 += i * p[i];
  }
  const c = m1 / s;
  let m2 = 0;
  for (let i = 0; i < p.length; i++) m2 += (i - c) ** 2 * p[i];
  return { center: c, sigma: Math.sqrt(m2 / s), sum: s };
}

// Least-squares σ of a sampled, unit-sum Gaussian against `p` (a kernel
// profile with sum ≈ 1), centre fixed at `center`; golden-section search.
export function fitGaussianSigma(p: readonly number[], center: number, lo = 0.05, hi = 200): { sigma: number; rms: number; max: number } {
  const err = (sg: number) => {
    const g = p.map((_, i) => Math.exp(-((i - center) ** 2) / (2 * sg * sg)));
    const z = g.reduce((a, b) => a + b, 0);
    let e = 0;
    for (let i = 0; i < p.length; i++) e += (p[i] - g[i] / z) ** 2;
    return e;
  };
  let a = lo;
  let b = hi;
  const r = (Math.sqrt(5) - 1) / 2;
  let c = b - r * (b - a);
  let d = a + r * (b - a);
  for (let k = 0; k < 200; k++) {
    if (err(c) < err(d)) b = d;
    else a = c;
    c = b - r * (b - a);
    d = a + r * (b - a);
  }
  const sigma = (a + b) / 2;
  const g = p.map((_, i) => Math.exp(-((i - center) ** 2) / (2 * sigma * sigma)));
  const z = g.reduce((x, y) => x + y, 0);
  let mx = 0;
  for (let i = 0; i < p.length; i++) mx = Math.max(mx, Math.abs(p[i] - g[i] / z));
  return { sigma, rms: Math.sqrt(err(sigma) / p.length), max: mx };
}

// Ordinary least squares y = a·x + b, with R² and the worst residual.
export function linearFit(xs: readonly number[], ys: readonly number[]): { a: number; b: number; r2: number; maxResidual: number } {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const a = sxy / sxx;
  const b = my - a * mx;
  let maxResidual = 0;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const e = ys[i] - (a * xs[i] + b);
    sse += e * e;
    maxResidual = Math.max(maxResidual, Math.abs(e));
  }
  return { a, b, r2: syy ? 1 - sse / syy : 1, maxResidual };
}

// Through-origin least squares y = a·x.
export function proportionalFit(xs: readonly number[], ys: readonly number[]): { a: number; maxRelResidual: number } {
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += xs[i] * ys[i];
    sxx += xs[i] * xs[i];
  }
  const a = sxy / sxx;
  let m = 0;
  for (let i = 0; i < xs.length; i++) if (ys[i]) m = Math.max(m, Math.abs(ys[i] - a * xs[i]) / Math.abs(ys[i]));
  return { a, maxRelResidual: m };
}

// The power-law γ for which a 50/50 mix of a and b blurred flat is v:
// ((a^γ + b^γ) / 2)^(1/γ) = v (bisection; mixes grow with γ).
export function fitPowerGamma(a: number, b: number, v: number, lo = 0.5, hi = 8): number {
  for (let i = 0; i < 80; i++) {
    const g = (lo + hi) / 2;
    const m = ((a ** g + b ** g) / 2) ** (1 / g);
    if (m < v) lo = g;
    else hi = g;
  }
  return (lo + hi) / 2;
}
