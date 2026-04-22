// Dither kernels and operations. Ported from the Dither Lab utility module
// with no behavioral changes — only type annotations added for TypeScript.

export interface Kernel {
  offsets: [number, number, number][];
  divisor: number;
}

export const KERNELS: Record<string, Kernel> = {
  "floyd-steinberg": {
    offsets: [
      [1, 0, 7],
      [-1, 1, 3],
      [0, 1, 5],
      [1, 1, 1],
    ],
    divisor: 16,
  },
  atkinson: {
    offsets: [
      [1, 0, 1],
      [2, 0, 1],
      [-1, 1, 1],
      [0, 1, 1],
      [1, 1, 1],
      [0, 2, 1],
    ],
    divisor: 8,
  },
  stucki: {
    offsets: [
      [1, 0, 8], [2, 0, 4],
      [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
      [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1],
    ],
    divisor: 42,
  },
  burkes: {
    offsets: [
      [1, 0, 8], [2, 0, 4],
      [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
    ],
    divisor: 32,
  },
  sierra: {
    offsets: [
      [1, 0, 5], [2, 0, 3],
      [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2],
      [-1, 2, 2], [0, 2, 3], [1, 2, 2],
    ],
    divisor: 32,
  },
  jarvis: {
    offsets: [
      [1, 0, 7], [2, 0, 5],
      [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
      [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1],
    ],
    divisor: 48,
  },
};

const BAYER8: number[][] = [
  [0, 48, 12, 60, 3, 51, 15, 63],
  [32, 16, 44, 28, 35, 19, 47, 31],
  [8, 56, 4, 52, 11, 59, 7, 55],
  [40, 24, 36, 20, 43, 27, 39, 23],
  [2, 50, 14, 62, 1, 49, 13, 61],
  [34, 18, 46, 30, 33, 17, 45, 29],
  [10, 58, 6, 54, 9, 57, 5, 53],
  [42, 26, 38, 22, 41, 25, 37, 21],
];

export function ditherKernelBW(
  data: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  threshold: number,
  spread: number,
  kernel: Kernel
) {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] =
      0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  const { offsets, divisor } = kernel;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const old = gray[idx];
      const nw = old < threshold ? 0 : 255;
      gray[idx] = nw;
      const err = (old - nw) * spread;
      for (let k = 0; k < offsets.length; k++) {
        const dx = offsets[k][0], dy = offsets[k][1], wt = offsets[k][2];
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny < h) {
          gray[ny * w + nx] += (err * wt) / divisor;
        }
      }
    }
  }
  for (let i = 0; i < w * h; i++) {
    const v = gray[i];
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
  }
}

export function ditherKernelColor(
  data: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  levels: number,
  spread: number,
  kernel: Kernel
) {
  const len = w * h;
  const ch = [
    new Float32Array(len),
    new Float32Array(len),
    new Float32Array(len),
  ];
  for (let i = 0; i < len; i++) {
    ch[0][i] = data[i * 4];
    ch[1][i] = data[i * 4 + 1];
    ch[2][i] = data[i * 4 + 2];
  }
  const step = 255 / (levels - 1);
  const { offsets, divisor } = kernel;
  for (let c = 0; c < 3; c++) {
    const arr = ch[c];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const old = arr[idx];
        const nw = Math.round(Math.round(old / step) * step);
        arr[idx] = nw;
        const err = (old - nw) * spread;
        for (let k = 0; k < offsets.length; k++) {
          const dx = offsets[k][0], dy = offsets[k][1], wt = offsets[k][2];
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < w && ny < h)
            arr[ny * w + nx] += (err * wt) / divisor;
        }
      }
    }
  }
  for (let i = 0; i < len; i++) {
    data[i * 4] = Math.max(0, Math.min(255, ch[0][i]));
    data[i * 4 + 1] = Math.max(0, Math.min(255, ch[1][i]));
    data[i * 4 + 2] = Math.max(0, Math.min(255, ch[2][i]));
  }
}

export function ditherOrderedBW(
  data: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  threshold: number
) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const gray =
        0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const bayer = (BAYER8[y & 7][x & 7] / 64 - 0.5) * (255 - threshold);
      const v = gray + bayer < threshold ? 0 : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
  }
}

export function ditherOrderedColor(
  data: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  levels: number
) {
  const step = 255 / (levels - 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const bayer = (BAYER8[y & 7][x & 7] / 64 - 0.5) * step;
      for (let c = 0; c < 3; c++) {
        const v = data[i + c] + bayer;
        data[i + c] = Math.max(
          0,
          Math.min(255, Math.round(Math.round(v / step) * step))
        );
      }
    }
  }
}

export function ditherThresholdBW(
  data: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  threshold: number
) {
  for (let i = 0; i < w * h; i++) {
    const g =
      0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    const v = g < threshold ? 0 : 255;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
  }
}

export function ditherThresholdColor(
  data: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  levels: number
) {
  const step = 255 / (levels - 1);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) {
      data[i * 4 + c] = Math.round(Math.round(data[i * 4 + c] / step) * step);
    }
  }
}
