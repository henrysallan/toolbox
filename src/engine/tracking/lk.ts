// Inverse-compositional Lucas–Kanade refinement. Warps: translation (2),
// translate_rotate (3), translate_scale (3), similarity / translate_rotate_
// scale (4), affine (6 — planar features). Precomputed steepest-descent
// images + Hessian on the template; 2–5 iterations; bilinear sampling
// with the pattern's sub-pixel origin. Spec: 082226_motion-tracking.md §7.3.

import { at, sampleBilinear, type GrayImage } from "./gray";

export type WarpType =
  | "translate"
  | "translate_rotate"
  | "translate_scale"
  | "translate_rotate_scale"
  | "affine";

export interface LkResult {
  x: number;
  y: number;
  rot: number;
  scale: number;
  /** Affine params [a, b, c, d, tx, ty] mapping template-local (u,v) → image.
   *  Present only for affine warp. */
  affine?: [number, number, number, number, number, number];
  iterations: number;
}

function dof(warp: WarpType): number {
  switch (warp) {
    case "translate":
      return 2;
    case "translate_rotate":
    case "translate_scale":
      return 3;
    case "translate_rotate_scale":
      return 4;
    case "affine":
      return 6;
  }
}

function templateGradients(T: GrayImage): { Ix: Float32Array; Iy: Float32Array } {
  const w = T.width;
  const h = T.height;
  const Ix = new Float32Array(w * h);
  const Iy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const xm = x === 0 ? at(T, x, y) : at(T, x - 1, y);
      const xp = x === w - 1 ? at(T, x, y) : at(T, x + 1, y);
      const ym = y === 0 ? at(T, x, y) : at(T, x, y - 1);
      const yp = y === h - 1 ? at(T, x, y) : at(T, x, y + 1);
      Ix[i] = 0.5 * (xp - xm);
      Iy[i] = 0.5 * (yp - ym);
    }
  }
  return { Ix, Iy };
}

function steepestDescent(
  Ix: Float32Array,
  Iy: Float32Array,
  w: number,
  h: number,
  warp: WarpType
): Float32Array[] {
  const n = dof(warp);
  const sd: Float32Array[] = Array.from({ length: n }, () => new Float32Array(w * h));
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = x - cx;
      const v = y - cy;
      const gx = Ix[i]!;
      const gy = Iy[i]!;
      // ∂W/∂p columns, evaluated at identity, times ∇T.
      sd[0]![i] = gx; // tx
      sd[1]![i] = gy; // ty
      if (warp === "translate") continue;
      if (warp === "translate_rotate") {
        // rotation about center: ∂W/∂θ = (-v, u) at identity
        sd[2]![i] = -gx * v + gy * u;
      } else if (warp === "translate_scale") {
        // uniform scale about center: ∂W/∂s = (u, v)
        sd[2]![i] = gx * u + gy * v;
      } else if (warp === "translate_rotate_scale") {
        sd[2]![i] = -gx * v + gy * u;
        sd[3]![i] = gx * u + gy * v;
      } else {
        // affine: W = [1+a, b; c, 1+d] [u;v] + t
        sd[2]![i] = gx * u; // a
        sd[3]![i] = gx * v; // b
        sd[4]![i] = gy * u; // c
        sd[5]![i] = gy * v; // d
      }
    }
  }
  return sd;
}

function hessian(sd: Float32Array[], nPix: number): number[][] {
  const n = sd.length;
  const H: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      const a = sd[i]!;
      const b = sd[j]!;
      for (let k = 0; k < nPix; k++) s += a[k]! * b[k]!;
      H[i]![j] = s;
      H[j]![i] = s;
    }
  }
  return H;
}

function invert(M: number[][]): number[][] | null {
  const n = M.length;
  const A = M.map((row) => row.slice());
  const I = Array.from({ length: n }, (_, i) => {
    const r = new Array(n).fill(0);
    r[i] = 1;
    return r;
  });
  for (let i = 0; i < n; i++) {
    let piv = i;
    let best = Math.abs(A[i]![i]!);
    for (let r = i + 1; r < n; r++) {
      const v = Math.abs(A[r]![i]!);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-12) return null;
    if (piv !== i) {
      [A[i], A[piv]] = [A[piv]!, A[i]!];
      [I[i], I[piv]] = [I[piv]!, I[i]!];
    }
    const diag = A[i]![i]!;
    for (let c = 0; c < n; c++) {
      A[i]![c] /= diag;
      I[i]![c] /= diag;
    }
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = A[r]![i]!;
      for (let c = 0; c < n; c++) {
        A[r]![c] -= f * A[i]![c]!;
        I[r]![c] -= f * I[i]![c]!;
      }
    }
  }
  return I;
}

function mulVec(M: number[][], v: number[]): number[] {
  return M.map((row) => row.reduce((s, a, i) => s + a * v[i]!, 0));
}

export interface LkTemplate {
  T: GrayImage;
  sd: Float32Array[];
  Hinv: number[][];
  warp: WarpType;
}

export function precomputeLk(T: GrayImage, warp: WarpType): LkTemplate | null {
  const { Ix, Iy } = templateGradients(T);
  const sd = steepestDescent(Ix, Iy, T.width, T.height, warp);
  const H = hessian(sd, T.width * T.height);
  const Hinv = invert(H);
  if (!Hinv) return null;
  return { T, sd, Hinv, warp };
}

interface WarpState {
  x: number;
  y: number;
  rot: number;
  scale: number;
  affine: [number, number, number, number, number, number];
}

function applyWarp(
  state: WarpState,
  u: number,
  v: number,
  warp: WarpType
): [number, number] {
  if (warp === "affine") {
    const [a, b, c, d, tx, ty] = state.affine;
    return [a * u + b * v + tx, c * u + d * v + ty];
  }
  const c = Math.cos(state.rot);
  const s = Math.sin(state.rot);
  const sc = state.scale;
  return [sc * (c * u - s * v) + state.x, sc * (s * u + c * v) + state.y];
}

function composeInverse(state: WarpState, dp: number[], warp: WarpType): void {
  // Inverse-compositional: p ← p ∘ Δp^{-1}. For these warps Δp is a
  // small increment around identity, so Δp^{-1} ≈ -Δp, composed on the
  // right in template space.
  const dtx = dp[0]!;
  const dty = dp[1]!;
  state.x -= dtx;
  state.y -= dty;
  if (warp === "translate") return;
  if (warp === "translate_rotate") {
    state.rot -= dp[2]!;
  } else if (warp === "translate_scale") {
    state.scale = Math.max(0.2, Math.min(5, state.scale * (1 - dp[2]!)));
  } else if (warp === "translate_rotate_scale") {
    state.rot -= dp[2]!;
    state.scale = Math.max(0.2, Math.min(5, state.scale * (1 - dp[3]!)));
  } else {
    // affine inverse-compose a small [1+da, db; dc, 1+dd] increment.
    const da = dp[2]!;
    const db = dp[3]!;
    const dc = dp[4]!;
    const dd = dp[5]!;
    const [a, b, c, d, tx, ty] = state.affine;
    // M_new = M * (I + D)^{-1} ≈ M * (I - D)
    const ia = 1 - da;
    const ib = -db;
    const ic = -dc;
    const id = 1 - dd;
    state.affine = [
      a * ia + b * ic,
      a * ib + b * id,
      c * ia + d * ic,
      c * ib + d * id,
      tx - dtx,
      ty - dty,
    ];
    state.x = state.affine[4];
    state.y = state.affine[5];
  }
}

export function refineLk(
  img: GrayImage,
  templ: LkTemplate,
  x: number,
  y: number,
  opts?: { iterations?: number; rot?: number; scale?: number }
): LkResult {
  const { T, sd, Hinv, warp } = templ;
  const w = T.width;
  const h = T.height;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const n = sd.length;
  const iters = opts?.iterations ?? 5;
  const state: WarpState = {
    x,
    y,
    rot: opts?.rot ?? 0,
    scale: opts?.scale ?? 1,
    affine: [1, 0, 0, 1, x, y],
  };

  for (let iter = 0; iter < iters; iter++) {
    const e = new Array(n).fill(0);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const u = px - cx;
        const v = py - cy;
        const [ix, iy] = applyWarp(state, u, v, warp);
        const Iw = sampleBilinear(img, ix, iy);
        const err = Iw - T.data[py * w + px]!;
        const i = py * w + px;
        for (let k = 0; k < n; k++) e[k] += sd[k]![i]! * err;
      }
    }
    const dp = mulVec(Hinv, e);
    let mag = 0;
    for (const v of dp) mag += v * v;
    composeInverse(state, dp, warp);
    if (mag < 1e-8) {
      return finish(state, warp, iter + 1);
    }
  }
  return finish(state, warp, iters);
}

function finish(state: WarpState, warp: WarpType, iterations: number): LkResult {
  if (warp === "affine") {
    return {
      x: state.affine[4],
      y: state.affine[5],
      rot: Math.atan2(state.affine[2], state.affine[0]),
      scale: Math.hypot(state.affine[0], state.affine[2]),
      affine: state.affine,
      iterations,
    };
  }
  return { x: state.x, y: state.y, rot: state.rot, scale: state.scale, iterations };
}
