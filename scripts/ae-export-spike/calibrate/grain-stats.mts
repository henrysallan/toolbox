// Grain is noise: compare statistics, not pixels (spec §14). For a render
// through a grain effect: the std of the residual (out − in), the
// lag-1/2/4 px horizontal autocorrelation of that residual (its spatial
// size), and how correlated R, G and B are (mono vs colour grain).

import type { FloatImage } from "./lib.mts";

export interface GrainStats {
  std: number;
  mean: number;
  acf1: number;
  acf2: number;
  acf4: number;
  rgCorr: number;
}

// The residual is out − src (out − 0.5 when no source is given).
export function grainStats(img: FloatImage, crop = 8, src?: FloatImage): GrainStats {
  const { width: w, height: h, data } = img;
  const res = (x: number, y: number, c: number) => data[(y * w + x) * 4 + c] - (src ? src.data[(y * w + x) * 4 + c] : 0.5);
  let n = 0;
  let s = 0;
  let s2 = 0;
  for (let y = crop; y < h - crop; y++)
    for (let x = crop; x < w - crop; x++) {
      const v = res(x, y, 1);
      s += v;
      s2 += v * v;
      n++;
    }
  const mean = s / n;
  const varv = s2 / n - mean * mean;
  const acf = (lag: number) => {
    let a = 0;
    let m = 0;
    for (let y = crop; y < h - crop; y++)
      for (let x = crop; x < w - crop - lag; x++) {
        a += (res(x, y, 1) - mean) * (res(x + lag, y, 1) - mean);
        m++;
      }
    return a / m / varv;
  };
  let rg = 0;
  let rr = 0;
  let gg = 0;
  for (let y = crop; y < h - crop; y++)
    for (let x = crop; x < w - crop; x++) {
      const r = res(x, y, 0) - mean;
      const g = res(x, y, 1) - mean;
      rg += r * g;
      rr += r * r;
      gg += g * g;
    }
  return { std: Math.sqrt(varv), mean, acf1: acf(1), acf2: acf(2), acf4: acf(4), rgCorr: rg / Math.sqrt(rr * gg) };
}
