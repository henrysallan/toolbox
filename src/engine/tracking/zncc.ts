// Zero-mean normalized cross-correlation of a pattern over a search
// window at integer offsets. Returns the score map, best peak, and
// second-best-outside-radius (peak sharpness). Integral images keep
// window mean / variance O(1); the cross term is O(search·pattern).
// Spec: 082226_motion-tracking.md §7.3.

import { grabPatch, type GrayImage } from "./gray";

export interface ZnccPeak {
  dx: number;
  dy: number;
  score: number;
  sharpness: number;
}

export interface ZnccResult {
  peak: ZnccPeak;
  /** scores[(dy - minDy) * nDx + (dx - minDx)] */
  scores: Float32Array;
  minDx: number;
  minDy: number;
  nDx: number;
  nDy: number;
}

function integral2(img: GrayImage): { sum: Float64Array; sumsq: Float64Array; iw: number; ih: number } {
  const w = img.width;
  const h = img.height;
  const iw = w + 1;
  const ih = h + 1;
  const sum = new Float64Array(iw * ih);
  const sumsq = new Float64Array(iw * ih);
  for (let y = 1; y <= h; y++) {
    let row = 0;
    let rowsq = 0;
    for (let x = 1; x <= w; x++) {
      const v = img.data[(y - 1) * w + (x - 1)]!;
      row += v;
      rowsq += v * v;
      const i = y * iw + x;
      sum[i] = sum[(y - 1) * iw + x]! + row;
      sumsq[i] = sumsq[(y - 1) * iw + x]! + rowsq;
    }
  }
  return { sum, sumsq, iw, ih };
}

function rectSum(ii: Float64Array, iw: number, x0: number, y0: number, x1: number, y1: number): number {
  return (
    ii[y1 * iw + x1]! -
    ii[y0 * iw + x1]! -
    ii[y1 * iw + x0]! +
    ii[y0 * iw + x0]!
  );
}

function preparePattern(pattern: Float32Array): { zm: Float32Array; norm: number; n: number } {
  const n = pattern.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += pattern[i]!;
  mean /= n;
  const zm = new Float32Array(n);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = pattern[i]! - mean;
    zm[i] = d;
    ss += d * d;
  }
  return { zm, norm: Math.sqrt(ss), n };
}

/**
 * Correlate `pattern` (pw×ph, already grabbed) against `img` at integer
 * offsets of the pattern's top-left. Search is the inclusive pixel range
 * of top-left positions [minDx, maxDx] × [minDy, maxDy].
 */
export function znccSearch(
  img: GrayImage,
  pattern: Float32Array,
  pw: number,
  ph: number,
  minDx: number,
  minDy: number,
  maxDx: number,
  maxDy: number,
  secondBestRadius = 3
): ZnccResult {
  const { zm, norm: pNorm, n } = preparePattern(pattern);
  const { sum, sumsq, iw } = integral2(img);
  const nDx = Math.max(0, maxDx - minDx + 1);
  const nDy = Math.max(0, maxDy - minDy + 1);
  const scores = new Float32Array(Math.max(1, nDx * nDy));
  let best = -2;
  let bestDx = minDx;
  let bestDy = minDy;

  const imgW = img.width;
  for (let dy = minDy; dy <= maxDy; dy++) {
    for (let dx = minDx; dx <= maxDx; dx++) {
      if (dx < 0 || dy < 0 || dx + pw > img.width || dy + ph > img.height) {
        scores[(dy - minDy) * nDx + (dx - minDx)] = -2;
        continue;
      }
      const s = rectSum(sum, iw, dx, dy, dx + pw, dy + ph);
      const sq = rectSum(sumsq, iw, dx, dy, dx + pw, dy + ph);
      const meanS = s / n;
      const varS = Math.max(0, sq - (s * s) / n);
      const stdS = Math.sqrt(varS);
      if (pNorm < 1e-12 || stdS < 1e-12) {
        scores[(dy - minDy) * nDx + (dx - minDx)] = 0;
        continue;
      }
      let num = 0;
      let pi = 0;
      for (let j = 0; j < ph; j++) {
        const row = (dy + j) * imgW + dx;
        for (let i = 0; i < pw; i++) {
          num += zm[pi]! * (img.data[row + i]! - meanS);
          pi++;
        }
      }
      const score = num / (pNorm * stdS);
      scores[(dy - minDy) * nDx + (dx - minDx)] = score;
      if (score > best) {
        best = score;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  let second = -2;
  const r2 = secondBestRadius * secondBestRadius;
  for (let dy = minDy; dy <= maxDy; dy++) {
    for (let dx = minDx; dx <= maxDx; dx++) {
      const ddx = dx - bestDx;
      const ddy = dy - bestDy;
      if (ddx * ddx + ddy * ddy <= r2) continue;
      const s = scores[(dy - minDy) * nDx + (dx - minDx)]!;
      if (s > second) second = s;
    }
  }
  const sharpness =
    second <= 1e-8 ? (best > 0 ? 1e6 : 1) : best / Math.max(1e-8, second);

  return {
    peak: { dx: bestDx, dy: bestDy, score: best, sharpness },
    scores,
    minDx,
    minDy,
    nDx,
    nDy,
  };
}

/** Search a pattern centered at (cx, cy) inside a searchW×searchH box. */
export function znccAt(
  img: GrayImage,
  cx: number,
  cy: number,
  pattern: Float32Array,
  pw: number,
  ph: number,
  searchW: number,
  searchH: number
): { x: number; y: number; conf: number; sharpness: number } {
  const halfW = (pw - 1) / 2;
  const halfH = (ph - 1) / 2;
  const predLeft = cx - halfW;
  const predTop = cy - halfH;
  const searchHalfW = (searchW - pw) / 2;
  const searchHalfH = (searchH - ph) / 2;
  const minDx = Math.round(predLeft - searchHalfW);
  const minDy = Math.round(predTop - searchHalfH);
  const maxDx = Math.round(predLeft + searchHalfW);
  const maxDy = Math.round(predTop + searchHalfH);
  const result = znccSearch(img, pattern, pw, ph, minDx, minDy, maxDx, maxDy);
  return {
    x: result.peak.dx + halfW,
    y: result.peak.dy + halfH,
    conf: result.peak.score,
    sharpness: result.peak.sharpness,
  };
}

export function grabAndZncc(
  img: GrayImage,
  cx: number,
  cy: number,
  pw: number,
  ph: number,
  searchW: number,
  searchH: number,
  pattern: Float32Array
): { x: number; y: number; conf: number; sharpness: number } {
  return znccAt(img, cx, cy, pattern, pw, ph, searchW, searchH);
}

export { grabPatch };
