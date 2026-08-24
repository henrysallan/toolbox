// Output-time smoothing and offline error correction over sparse sample
// arrays. Gaussian-over-frames and Savitzky–Golay (order 2); MAD spike
// detector; cubic-Hermite gap fill; constant-velocity / acceleration
// prediction. Spec: 082226_motion-tracking.md §9.

export type SmoothMode = "gaussian" | "savgol";

export interface SampleArrays {
  frames: number[];
  x: number[];
  y: number[];
  rot?: number[];
  scale?: number[];
  conf: number[];
  status: number[];
}

function isLost(status: number): boolean {
  return status === 4;
}

/** σ = radius/2, truncated at ±radius, renormalized at the ends.
 *  Lost samples are excluded (weights redistribute). */
export function smoothGaussian(
  frames: readonly number[],
  values: readonly number[],
  status: readonly number[],
  radius: number
): number[] {
  const n = values.length;
  const out = values.slice();
  if (radius <= 0 || n === 0) return out;
  const sigma = radius / 2;
  const twoS2 = 2 * sigma * sigma;
  for (let i = 0; i < n; i++) {
    if (isLost(status[i]!)) continue;
    const fi = frames[i]!;
    // Endpoints keep their authored value so a one-sided kernel can't
    // pull them toward the interior (spec §9.1).
    if (i === 0 || i === n - 1) {
      out[i] = values[i]!;
      continue;
    }
    let wsum = 0;
    let vsum = 0;
    for (let j = 0; j < n; j++) {
      if (isLost(status[j]!)) continue;
      const df = frames[j]! - fi;
      if (Math.abs(df) > radius) continue;
      const w = Math.exp(-(df * df) / twoS2);
      wsum += w;
      vsum += w * values[j]!;
    }
    if (wsum > 0) out[i] = vsum / wsum;
  }
  return out;
}

/** Savitzky–Golay, polynomial order 2, window 2r+1. Asymmetric windows
 *  at the ends (fit on what's there). Reproduces degree ≤ 2 exactly. */
export function smoothSavgol(
  frames: readonly number[],
  values: readonly number[],
  status: readonly number[],
  radius: number
): number[] {
  const n = values.length;
  const out = values.slice();
  if (radius <= 0 || n === 0) return out;
  const usable: number[] = [];
  for (let i = 0; i < n; i++) if (!isLost(status[i]!)) usable.push(i);
  if (usable.length < 3) return out;

  for (const i of usable) {
    const fi = frames[i]!;
    const window: number[] = [];
    for (const j of usable) {
      if (Math.abs(frames[j]! - fi) <= radius) window.push(j);
    }
    if (window.length < 3) {
      out[i] = values[i]!;
      continue;
    }
    // Fit y = a + b t + c t² with t = frame - fi, evaluate at 0.
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    let y0 = 0, y1 = 0, y2 = 0;
    for (const j of window) {
      const t = frames[j]! - fi;
      const t2 = t * t;
      const y = values[j]!;
      s0 += 1;
      s1 += t;
      s2 += t2;
      s3 += t2 * t;
      s4 += t2 * t2;
      y0 += y;
      y1 += y * t;
      y2 += y * t2;
    }
    // Normal equations 3×3.
    const a = solve3(
      [
        [s0, s1, s2],
        [s1, s2, s3],
        [s2, s3, s4],
      ],
      [y0, y1, y2]
    );
    out[i] = a ? a[0]! : values[i]!;
  }
  return out;
}

function solve3(M: number[][], b: number[]): number[] | null {
  const A = M.map((r) => r.slice());
  const x = b.slice();
  for (let i = 0; i < 3; i++) {
    let piv = i;
    let best = Math.abs(A[i]![i]!);
    for (let r = i + 1; r < 3; r++) {
      const v = Math.abs(A[r]![i]!);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-14) return null;
    if (piv !== i) {
      [A[i], A[piv]] = [A[piv]!, A[i]!];
      [x[i], x[piv]] = [x[piv]!, x[i]!];
    }
    const diag = A[i]![i]!;
    for (let c = i; c < 3; c++) A[i]![c] /= diag;
    x[i] /= diag;
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = A[r]![i]!;
      for (let c = i; c < 3; c++) A[r]![c] -= f * A[i]![c]!;
      x[r] -= f * x[i]!;
    }
  }
  return x;
}

export function smoothArrays(
  samples: SampleArrays,
  radius: number,
  mode: SmoothMode
): SampleArrays {
  const fn = mode === "savgol" ? smoothSavgol : smoothGaussian;
  const out: SampleArrays = {
    frames: samples.frames.slice(),
    x: fn(samples.frames, samples.x, samples.status, radius),
    y: fn(samples.frames, samples.y, samples.status, radius),
    conf: samples.conf.slice(),
    status: samples.status.slice(),
  };
  if (samples.rot) out.rot = fn(samples.frames, samples.rot, samples.status, radius);
  if (samples.scale) out.scale = fn(samples.frames, samples.scale, samples.status, radius);
  return out;
}

export interface SpikeHit {
  index: number;
  frame: number;
}

/** Residual against a running median (window 7) of the track, normalized
 *  by the MAD of residuals. Manual samples (status 1) are never flagged. */
export function detectSpikes(
  samples: SampleArrays,
  threshold = 3.5
): SpikeHit[] {
  const n = samples.frames.length;
  const hits: SpikeHit[] = [];
  if (n < 7) return hits;
  const residuals: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (isLost(samples.status[i]!)) continue;
    const lo = Math.max(0, i - 3);
    const hi = Math.min(n - 1, i + 3);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let j = lo; j <= hi; j++) {
      if (j === i || isLost(samples.status[j]!)) continue;
      xs.push(samples.x[j]!);
      ys.push(samples.y[j]!);
    }
    if (xs.length < 3) continue;
    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);
    const mx = xs[xs.length >> 1]!;
    const my = ys[ys.length >> 1]!;
    residuals[i] = Math.hypot(samples.x[i]! - mx, samples.y[i]! - my);
  }
  const used = residuals.filter((r, i) => r > 0 && !isLost(samples.status[i]!));
  if (used.length < 4) return hits;
  const sorted = used.slice().sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1]!;
  const devs = used.map((r) => Math.abs(r - med)).sort((a, b) => a - b);
  // Floor so a numerically-clean track doesn't flag every 0.1 px wobble,
  // and so a spike's contamination of neighboring medians stays under the
  // 3.5 MAD threshold.
  const mad = Math.max(devs[devs.length >> 1]! || 0, 0.5);
  for (let i = 0; i < n; i++) {
    if (samples.status[i] === 1) continue; // never flag manual
    if (isLost(samples.status[i]!)) continue;
    if (residuals[i]! / mad > threshold) {
      hits.push({ index: i, frame: samples.frames[i]! });
    }
  }
  return hits;
}

function hermiteInterp(
  t0: number, v0: number, m0: number,
  t1: number, v1: number, m1: number,
  t: number
): number {
  const dt = t1 - t0;
  if (Math.abs(dt) < 1e-9) return v0;
  const u = (t - t0) / dt;
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return h00 * v0 + h10 * dt * m0 + h01 * v1 + h11 * dt * m1;
}

function tangentAt(
  frames: readonly number[],
  values: readonly number[],
  i: number,
  usable: readonly number[]
): number {
  const pos = usable.indexOf(i);
  const prev = pos > 0 ? usable[pos - 1]! : i;
  const next = pos < usable.length - 1 ? usable[pos + 1]! : i;
  const dt = frames[next]! - frames[prev]!;
  if (Math.abs(dt) < 1e-9) return 0;
  return (values[next]! - values[prev]!) / dt;
}

/** Replace flagged samples with cubic Hermite through the nearest
 *  unflagged neighbors on each side (2+2). Marks them `repaired` (2). */
export function repairSpikes(
  samples: SampleArrays,
  hits: SpikeHit[]
): SampleArrays {
  const flagged = new Set(hits.map((h) => h.index));
  return interpolateIndices(samples, flagged);
}

/** Fill lost/predicted runs shorter than maxGap with Hermite interpolation. */
export function fillGaps(samples: SampleArrays, maxGap = 12): SampleArrays {
  const n = samples.frames.length;
  const flagged = new Set<number>();
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    const bad = i < n && (samples.status[i] === 3 || samples.status[i] === 4);
    if (bad && runStart < 0) runStart = i;
    if (!bad && runStart >= 0) {
      const a = samples.frames[runStart]!;
      const b = samples.frames[i - 1]!;
      if (b - a + 1 <= maxGap) {
        for (let k = runStart; k < i; k++) flagged.add(k);
      }
      runStart = -1;
    }
  }
  return interpolateIndices(samples, flagged);
}

function interpolateIndices(samples: SampleArrays, flagged: Set<number>): SampleArrays {
  const out: SampleArrays = {
    frames: samples.frames.slice(),
    x: samples.x.slice(),
    y: samples.y.slice(),
    rot: samples.rot?.slice(),
    scale: samples.scale?.slice(),
    conf: samples.conf.slice(),
    status: samples.status.slice(),
  };
  if (flagged.size === 0) return out;
  const usable: number[] = [];
  for (let i = 0; i < samples.frames.length; i++) {
    if (!flagged.has(i) && samples.status[i] !== 4) usable.push(i);
  }
  if (usable.length < 2) return out;

  const interpChan = (values: number[], i: number): number => {
    // nearest usable on each side
    let lo = -1;
    let hi = -1;
    for (const u of usable) {
      if (u < i) lo = u;
      if (u > i && hi < 0) hi = u;
    }
    if (lo < 0 && hi < 0) return values[i]!;
    if (lo < 0) return values[hi]!;
    if (hi < 0) return values[lo]!;
    const m0 = tangentAt(samples.frames, values, lo, usable);
    const m1 = tangentAt(samples.frames, values, hi, usable);
    return hermiteInterp(
      samples.frames[lo]!,
      values[lo]!,
      m0,
      samples.frames[hi]!,
      values[hi]!,
      m1,
      samples.frames[i]!
    );
  };

  for (const i of flagged) {
    out.x[i] = interpChan(samples.x, i);
    out.y[i] = interpChan(samples.y, i);
    if (out.rot && samples.rot) out.rot[i] = interpChan(samples.rot, i);
    if (out.scale && samples.scale) out.scale[i] = interpChan(samples.scale, i);
    out.status[i] = 2;
  }
  return out;
}

export interface MotionPred {
  x: number;
  y: number;
}

/** Constant-velocity over the last 4 tracked samples. Decays to zero
 *  velocity after 8 predicted frames. Optional constant-acceleration. */
export function predictPosition(
  frames: readonly number[],
  xs: readonly number[],
  ys: readonly number[],
  status: readonly number[],
  fromFrame: number,
  toFrame: number,
  predictedStreak = 0,
  acceleration = false
): MotionPred {
  const tracked: number[] = [];
  for (let i = frames.length - 1; i >= 0 && tracked.length < 4; i--) {
    if (frames[i]! <= fromFrame && status[i] === 0) tracked.push(i);
  }
  tracked.reverse();
  if (tracked.length === 0) {
    const i = frames.length - 1;
    return { x: xs[i] ?? 0, y: ys[i] ?? 0 };
  }
  const last = tracked[tracked.length - 1]!;
  const dt = toFrame - frames[last]!;
  if (tracked.length < 2) {
    return { x: xs[last]!, y: ys[last]! };
  }
  const a = tracked[tracked.length - 2]!;
  const dtf = frames[last]! - frames[a]!;
  const vx = dtf === 0 ? 0 : (xs[last]! - xs[a]!) / dtf;
  const vy = dtf === 0 ? 0 : (ys[last]! - ys[a]!) / dtf;
  let ax = 0;
  let ay = 0;
  if (acceleration && tracked.length >= 3) {
    const b = tracked[tracked.length - 3]!;
    const dt2 = frames[a]! - frames[b]!;
    const vx0 = dt2 === 0 ? vx : (xs[a]! - xs[b]!) / dt2;
    const vy0 = dt2 === 0 ? vy : (ys[a]! - ys[b]!) / dt2;
    ax = (vx - vx0) / (dtf || 1);
    ay = (vy - vy0) / (dtf || 1);
  }
  const decay = predictedStreak >= 8 ? 0 : 1;
  return {
    x: xs[last]! + decay * (vx * dt + 0.5 * ax * dt * dt),
    y: ys[last]! + decay * (vy * dt + 0.5 * ay * dt * dt),
  };
}
