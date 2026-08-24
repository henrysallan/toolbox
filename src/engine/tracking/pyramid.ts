// Gaussian pyramid over GrayImage. 5-tap [1,4,6,4,1]/16 then subsample
// by 2. Level count is chosen from search size so the coarsest search
// window stays around ~16–24 px. Spec: 082226_motion-tracking.md §7.3.

import { at, makeGray, type GrayImage } from "./gray";

const KERNEL = [1, 4, 6, 4, 1];
const KERNEL_SUM = 16;

export function pyramidLevelCount(searchSize: number): number {
  let levels = 1;
  let s = searchSize;
  while (s > 24 && levels < 4) {
    s = Math.floor(s / 2);
    levels++;
  }
  return levels;
}

function blurSeparable(img: GrayImage): GrayImage {
  const { width: w, height: h } = img;
  const tmp = makeGray(w, h);
  const out = makeGray(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        s += at(img, xx, y) * KERNEL[k + 2]!;
      }
      tmp.data[y * w + x] = s / KERNEL_SUM;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        s += tmp.data[yy * w + x]! * KERNEL[k + 2]!;
      }
      out.data[y * w + x] = s / KERNEL_SUM;
    }
  }
  return out;
}

export function downsample2(img: GrayImage): GrayImage {
  const blurred = blurSeparable(img);
  const w = Math.max(1, Math.floor(img.width / 2));
  const h = Math.max(1, Math.floor(img.height / 2));
  const out = makeGray(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out.data[y * w + x] = at(blurred, x * 2, y * 2);
    }
  }
  return out;
}

export function buildPyramid(img: GrayImage, levels: number): GrayImage[] {
  const n = Math.max(1, levels);
  const pyr: GrayImage[] = [img];
  for (let i = 1; i < n; i++) {
    const prev = pyr[i - 1]!;
    if (prev.width < 8 || prev.height < 8) break;
    pyr.push(downsample2(prev));
  }
  return pyr;
}

export function scaleCoord(x: number, fromLevel: number, toLevel: number): number {
  const f = 2 ** (fromLevel - toLevel);
  return x * f;
}
