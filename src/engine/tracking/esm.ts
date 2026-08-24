// Efficient second-order minimization of a homography over a region
// (planar refine). Inverse-compositional ESM: Jacobian is the average
// of template and warped-image steepest-descent images. 2–4 iterations
// at the fine level, pixels inside the quad (and not masked). Spec:
// 082226_motion-tracking.md §5.2 step 4, §7.3.

import { sampleBilinear, type GrayImage } from "./gray";
import {
  applyH,
  identityH,
  invertH,
  mulH,
  normalizeH,
  type Homography,
} from "./homography";

function pointInQuad(
  x: number,
  y: number,
  q: Array<[number, number]>
): boolean {
  // Ray-crossings on TL TR BR BL.
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const yi = q[i]![1];
    const yj = q[j]![1];
    const xi = q[i]![0];
    const xj = q[j]![0];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function gradAt(img: GrayImage, x: number, y: number): [number, number] {
  const gx = 0.5 * (sampleBilinear(img, x + 1, y) - sampleBilinear(img, x - 1, y));
  const gy = 0.5 * (sampleBilinear(img, x, y + 1) - sampleBilinear(img, x, y - 1));
  return [gx, gy];
}

function solve8(A: number[][], b: number[]): number[] | null {
  const n = 8;
  const M = A.map((r) => r.slice());
  const x = b.slice();
  for (let i = 0; i < n; i++) {
    let piv = i;
    let best = Math.abs(M[i]![i]!);
    for (let r = i + 1; r < n; r++) {
      const v = Math.abs(M[r]![i]!);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-14) return null;
    if (piv !== i) {
      [M[i], M[piv]] = [M[piv]!, M[i]!];
      [x[i], x[piv]] = [x[piv]!, x[i]!];
    }
    const diag = M[i]![i]!;
    for (let c = i; c < n; c++) M[i]![c] /= diag;
    x[i] /= diag;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r]![i]!;
      for (let c = i; c < n; c++) M[r]![c] -= f * M[i]![c]!;
      x[r] -= f * x[i]!;
    }
  }
  return x;
}

/**
 * Photometric ESM polish of H (ref → current). Samples a stride-grid of
 * pixels inside `refCorners`. Returns a refined H, or the input if the
 * linear system is singular / error increases.
 */
export function refineEsm(
  refImg: GrayImage,
  curImg: GrayImage,
  H0: Homography,
  refCorners: Array<[number, number]>,
  opts?: { iterations?: number; stride?: number; mask?: GrayImage }
): Homography {
  let H = normalizeH(H0.slice());
  const iters = opts?.iterations ?? 4;
  const stride = Math.max(1, opts?.stride ?? 2);
  const xs = refCorners.map((c) => c[0]);
  const ys = refCorners.map((c) => c[1]);
  const minX = Math.floor(Math.min(...xs));
  const maxX = Math.ceil(Math.max(...xs));
  const minY = Math.floor(Math.min(...ys));
  const maxY = Math.ceil(Math.max(...ys));

  const samples: Array<[number, number]> = [];
  for (let y = minY; y <= maxY; y += stride) {
    for (let x = minX; x <= maxX; x += stride) {
      if (!pointInQuad(x, y, refCorners)) continue;
      if (opts?.mask && sampleBilinear(opts.mask, x, y) < 0.5) continue;
      samples.push([x, y]);
    }
  }
  if (samples.length < 16) return H;

  let lastErr = Infinity;
  for (let iter = 0; iter < iters; iter++) {
    const Hi = invertH(H);
    if (!Hi) return H;
    const JtJ: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const Jte = new Array(8).fill(0);
    let sse = 0;
    let count = 0;
    for (const [x, y] of samples) {
      const T = sampleBilinear(refImg, x, y);
      const [cx, cy] = applyH(H, x, y);
      const I = sampleBilinear(curImg, cx, cy);
      const e = I - T;
      sse += e * e;
      count++;
      const [gTx, gTy] = gradAt(refImg, x, y);
      const [gIx, gIy] = gradAt(curImg, cx, cy);
      // Average gradients, then push through ∂W/∂h at identity (ESM).
      const gx = 0.5 * (gTx + gIx);
      const gy = 0.5 * (gTy + gIy);
      const w = H[6]! * x + H[7]! * y + H[8]!;
      if (Math.abs(w) < 1e-12) continue;
      const invW = 1 / w;
      const u = cx;
      const v = cy;
      const ju = [
        x * invW,
        y * invW,
        invW,
        0,
        0,
        0,
        -u * x * invW,
        -u * y * invW,
      ];
      const jv = [
        0,
        0,
        0,
        x * invW,
        y * invW,
        invW,
        -v * x * invW,
        -v * y * invW,
      ];
      const J = ju.map((a, k) => gx * a + gy * jv[k]!);
      for (let a = 0; a < 8; a++) {
        Jte[a] += J[a]! * e;
        for (let b = a; b < 8; b++) {
          const s = J[a]! * J[b]!;
          JtJ[a]![b] += s;
          if (a !== b) JtJ[b]![a] += s;
        }
      }
    }
    if (count === 0) return H;
    const mean = sse / count;
    if (mean > lastErr * 1.05) break;
    lastErr = mean;
    const damped = JtJ.map((row, i) =>
      row.map((v, j) => v + (i === j ? 1e-4 * (Math.abs(v) + 1) : 0))
    );
    const dp = solve8(damped, Jte.map((v) => -v));
    if (!dp) break;
    const dH: Homography = [
      dp[0]!,
      dp[1]!,
      dp[2]!,
      dp[3]!,
      dp[4]!,
      dp[5]!,
      dp[6]!,
      dp[7]!,
      0,
    ];
    // Inverse-compositional: H ← H ∘ (I + dH)^{-1} ≈ H ∘ (I - dH)
    const inc = identityH().map((v, i) => v - dH[i]!);
    const incN = normalizeH(inc);
    H = normalizeH(mulH(H, incN));
    const mag = dp.reduce((s, v) => s + v * v, 0);
    if (mag < 1e-12) break;
  }
  return H;
}
