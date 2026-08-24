// Homography helpers: normalized DLT, RANSAC, LM refinement, apply/invert,
// degeneracy checks. H is a 9-vector, row-major 3×3, mapping source → dest
// in the same pixel space. Spec: 082226_motion-tracking.md §7.3.

export type Homography = number[]; // length 9

export function identityH(): Homography {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function applyH(H: Homography, x: number, y: number): [number, number] {
  const w = H[6]! * x + H[7]! * y + H[8]!;
  if (Math.abs(w) < 1e-12) return [x, y];
  return [(H[0]! * x + H[1]! * y + H[2]!) / w, (H[3]! * x + H[4]! * y + H[5]!) / w];
}

export function invertH(H: Homography): Homography | null {
  const a = H[0]!, b = H[1]!, c = H[2]!;
  const d = H[3]!, e = H[4]!, f = H[5]!;
  const g = H[6]!, h = H[7]!, i = H[8]!;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  const invDet = 1 / det;
  return [
    A * invDet,
    (c * h - b * i) * invDet,
    (b * f - c * e) * invDet,
    B * invDet,
    (a * i - c * g) * invDet,
    (c * d - a * f) * invDet,
    C * invDet,
    (b * g - a * h) * invDet,
    (a * e - b * d) * invDet,
  ];
}

export function mulH(A: Homography, B: Homography): Homography {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        A[r * 3]! * B[c]! + A[r * 3 + 1]! * B[3 + c]! + A[r * 3 + 2]! * B[6 + c]!;
    }
  }
  return out;
}

export function normalizeH(H: Homography): Homography {
  const s = H[8] !== 0 ? H[8]! : Math.hypot(...H) || 1;
  return H.map((v) => v / s);
}

function meanDist(
  pts: Array<[number, number]>,
  cx: number,
  cy: number
): number {
  let s = 0;
  for (const [x, y] of pts) s += Math.hypot(x - cx, y - cy);
  return pts.length === 0 ? 1 : s / pts.length;
}

function normalizePoints(pts: Array<[number, number]>): {
  T: Homography;
  n: Array<[number, number]>;
} {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= pts.length;
  cy /= pts.length;
  const d = meanDist(pts, cx, cy) || 1;
  const s = Math.SQRT2 / d;
  const T: Homography = [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
  const n: Array<[number, number]> = pts.map(([x, y]) => [s * (x - cx), s * (y - cy)]);
  return { T, n };
}

function jacobiSmallestEigenvector(A: number[][]): number[] {
  // Jacobi rotations on a 9×9 symmetric matrix; return eigenvector for
  // the smallest eigenvalue (DLT nullspace).
  const n = A.length;
  const M = A.map((r) => r.slice());
  const V = Array.from({ length: n }, (_, i) => {
    const r = new Array(n).fill(0);
    r[i] = 1;
    return r as number[];
  });
  for (let iter = 0; iter < 64; iter++) {
    let p = 0;
    let q = 1;
    let max = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const v = Math.abs(M[i]![j]!);
        if (v > max) {
          max = v;
          p = i;
          q = j;
        }
      }
    }
    if (max < 1e-15) break;
    const app = M[p]![p]!;
    const aqq = M[q]![q]!;
    const apq = M[p]![q]!;
    const tau = (aqq - app) / (2 * apq);
    const t = Math.sign(tau) / (Math.abs(tau) + Math.hypot(1, tau));
    const c = 1 / Math.hypot(1, t);
    const s = t * c;
    for (let k = 0; k < n; k++) {
      if (k === p || k === q) continue;
      const mkp = M[k]![p]!;
      const mkq = M[k]![q]!;
      M[k]![p] = M[p]![k] = c * mkp - s * mkq;
      M[k]![q] = M[q]![k] = s * mkp + c * mkq;
    }
    M[p]![p] = app - t * apq;
    M[q]![q] = aqq + t * apq;
    M[p]![q] = M[q]![p] = 0;
    for (let k = 0; k < n; k++) {
      const vkp = V[k]![p]!;
      const vkq = V[k]![q]!;
      V[k]![p] = c * vkp - s * vkq;
      V[k]![q] = s * vkp + c * vkq;
    }
  }
  let minI = 0;
  let minV = M[0]![0]!;
  for (let i = 1; i < n; i++) {
    if (M[i]![i]! < minV) {
      minV = M[i]![i]!;
      minI = i;
    }
  }
  return V.map((row) => row[minI]!);
}

export function dlt(
  src: Array<[number, number]>,
  dst: Array<[number, number]>
): Homography | null {
  const n = Math.min(src.length, dst.length);
  if (n < 4) return null;
  const ns = normalizePoints(src.slice(0, n));
  const nd = normalizePoints(dst.slice(0, n));
  const AtA: number[][] = Array.from({ length: 9 }, () => new Array(9).fill(0));
  for (let i = 0; i < n; i++) {
    const [x, y] = ns.n[i]!;
    const [u, v] = nd.n[i]!;
    const r1 = [x, y, 1, 0, 0, 0, -u * x, -u * y, -u];
    const r2 = [0, 0, 0, x, y, 1, -v * x, -v * y, -v];
    for (const row of [r1, r2]) {
      for (let a = 0; a < 9; a++) {
        for (let b = 0; b < 9; b++) AtA[a]![b] += row[a]! * row[b]!;
      }
    }
  }
  const h = jacobiSmallestEigenvector(AtA);
  const Hn = normalizeH(h);
  const Ti = invertH(nd.T);
  if (!Ti) return null;
  return normalizeH(mulH(Ti, mulH(Hn, ns.T)));
}

export function reprojectionError(
  H: Homography,
  src: Array<[number, number]>,
  dst: Array<[number, number]>
): number[] {
  const n = Math.min(src.length, dst.length);
  const err: number[] = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = applyH(H, src[i]![0], src[i]![1]);
    err.push(Math.hypot(x - dst[i]![0], y - dst[i]![1]));
  }
  return err;
}

function hashInt(s: number): number {
  // xorshift-ish, deterministic from seed
  let x = (s + 1) * 0x9e3779b1;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

export function ransacHomography(
  src: Array<[number, number]>,
  dst: Array<[number, number]>,
  opts?: { threshold?: number; iters?: number; seed?: number }
): { H: Homography; inliers: number[]; inlierRatio: number } | null {
  const n = Math.min(src.length, dst.length);
  if (n < 4) return null;
  const thr = opts?.threshold ?? 1.5;
  const iters = opts?.iters ?? Math.min(200, 40 + n * 2);
  let seed = opts?.seed ?? 1;
  let bestIn: number[] = [];
  let bestH: Homography | null = null;

  const pick4 = (): number[] => {
    const idx: number[] = [];
    let guard = 0;
    while (idx.length < 4 && guard++ < 40) {
      seed = hashInt(seed);
      const k = seed % n;
      if (!idx.includes(k)) idx.push(k);
    }
    return idx;
  };

  for (let t = 0; t < iters; t++) {
    const idx = pick4();
    if (idx.length < 4) continue;
    const H = dlt(
      idx.map((i) => src[i]!),
      idx.map((i) => dst[i]!)
    );
    if (!H || isDegenerateH(H)) continue;
    const err = reprojectionError(H, src, dst);
    const inliers: number[] = [];
    for (let i = 0; i < n; i++) if (err[i]! <= thr) inliers.push(i);
    if (inliers.length > bestIn.length) {
      bestIn = inliers;
      bestH = H;
    }
  }
  if (!bestH || bestIn.length < 4) return null;
  const refined = dlt(
    bestIn.map((i) => src[i]!),
    bestIn.map((i) => dst[i]!)
  );
  const H = refined ?? bestH;
  const polished = refineHomographyLM(
    H,
    bestIn.map((i) => src[i]!),
    bestIn.map((i) => dst[i]!)
  );
  const finalH = polished ?? H;
  const err = reprojectionError(finalH, src, dst);
  const inliers: number[] = [];
  for (let i = 0; i < n; i++) if (err[i]! <= thr) inliers.push(i);
  return { H: finalH, inliers, inlierRatio: inliers.length / n };
}

export function isDegenerateH(H: Homography): boolean {
  const det =
    H[0]! * (H[4]! * H[8]! - H[5]! * H[7]!) -
    H[1]! * (H[3]! * H[8]! - H[5]! * H[6]!) +
    H[2]! * (H[3]! * H[7]! - H[4]! * H[6]!);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-10) return true;
  // Condition: if the affine 2×2 block is near-singular, the plane is edge-on.
  const a = H[0]!, b = H[1]!, c = H[3]!, d = H[4]!;
  const det2 = a * d - b * c;
  if (Math.abs(det2) < 1e-8) return true;
  return false;
}

export function cornersCross(corners: Array<[number, number]>): boolean {
  if (corners.length < 4) return true;
  // TL-TR-BR-BL. Cross if either diagonal intersection is outside, or
  // signed area of the two triangles disagrees (self-intersecting quad).
  const cross = (
    a: [number, number],
    b: [number, number],
    c: [number, number]
  ) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const [tl, tr, br, bl] = corners;
  const s1 = Math.sign(cross(tl!, tr!, br!));
  const s2 = Math.sign(cross(tr!, br!, bl!));
  const s3 = Math.sign(cross(br!, bl!, tl!));
  const s4 = Math.sign(cross(bl!, tl!, tr!));
  return !(s1 === s2 && s2 === s3 && s3 === s4 && s1 !== 0);
}

export function applyHToCorners(
  H: Homography,
  corners: Array<[number, number]>
): Array<[number, number]> {
  return corners.map(([x, y]) => applyH(H, x, y));
}

/** Gauss–Newton on 8 DoF (H[8] held at 1 after normalize). */
export function refineHomographyLM(
  H0: Homography,
  src: Array<[number, number]>,
  dst: Array<[number, number]>,
  iters = 8
): Homography | null {
  let H = normalizeH(H0.slice());
  const n = Math.min(src.length, dst.length);
  if (n < 4) return null;
  for (let iter = 0; iter < iters; iter++) {
    const JtJ: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const Jte = new Array(8).fill(0);
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const x = src[i]![0];
      const y = src[i]![1];
      const w = H[6]! * x + H[7]! * y + H[8]!;
      if (Math.abs(w) < 1e-12) continue;
      const u = (H[0]! * x + H[1]! * y + H[2]!) / w;
      const v = (H[3]! * x + H[4]! * y + H[5]!) / w;
      const eu = dst[i]![0] - u;
      const ev = dst[i]![1] - v;
      sse += eu * eu + ev * ev;
      // du/dh_k, dv/dh_k for k=0..7 (h8 fixed)
      const invW = 1 / w;
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
      for (let a = 0; a < 8; a++) {
        Jte[a] += ju[a]! * eu + jv[a]! * ev;
        for (let b = a; b < 8; b++) {
          const s = ju[a]! * ju[b]! + jv[a]! * jv[b]!;
          JtJ[a]![b] += s;
          if (a !== b) JtJ[b]![a] += s;
        }
      }
    }
    const damped = JtJ.map((row, i) =>
      row.map((v, j) => v + (i === j ? 1e-6 * (v + 1) : 0))
    );
    const dp = solve8(damped, Jte);
    if (!dp) return H;
    for (let k = 0; k < 8; k++) H[k] += dp[k]!;
    H = normalizeH(H);
    if (dp.reduce((s, v) => s + v * v, 0) < 1e-12) break;
    void sse;
  }
  return H;
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
