// Grayscale image the tracking kernel operates on. Row-major, one float
// per pixel, (0, 0) = top-left pixel center. Pure TS — no GL/DOM.

export interface GrayImage {
  data: Float32Array;
  width: number;
  height: number;
}

export function makeGray(width: number, height: number, fill = 0): GrayImage {
  const data = new Float32Array(width * height);
  if (fill !== 0) data.fill(fill);
  return { data, width, height };
}

export function at(img: GrayImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
  return img.data[y * img.width + x]!;
}

export function sampleBilinear(img: GrayImage, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const a = at(img, x0, y0);
  const b = at(img, x1, y0);
  const c = at(img, x0, y1);
  const d = at(img, x1, y1);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Grab a w×h patch centered at (cx, cy). w, h should be odd. */
export function grabPatch(
  img: GrayImage,
  cx: number,
  cy: number,
  w: number,
  h: number
): Float32Array {
  const out = new Float32Array(w * h);
  const ox = cx - (w - 1) / 2;
  const oy = cy - (h - 1) / 2;
  let k = 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      out[k++] = sampleBilinear(img, ox + i, oy + j);
    }
  }
  return out;
}

export function patchToImage(patch: Float32Array, w: number, h: number): GrayImage {
  return { data: patch, width: w, height: h };
}

export function copyGray(img: GrayImage): GrayImage {
  return { data: new Float32Array(img.data), width: img.width, height: img.height };
}
