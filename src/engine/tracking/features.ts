// Shi–Tomasi corner detection with grid bucketing + optional mask.
// Min eigenvalue of the structure tensor; features spread by picking
// the best per cell then filling the quota. Spec: 082226_motion-tracking.md §7.3.

import { at, sampleBilinear, type GrayImage } from "./gray";

export interface Feature {
  x: number;
  y: number;
  score: number;
}

function sobel(img: GrayImage): { Ix: Float32Array; Iy: Float32Array } {
  const w = img.width;
  const h = img.height;
  const Ix = new Float32Array(w * h);
  const Iy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      Ix[i] =
        -at(img, x - 1, y - 1) +
        at(img, x + 1, y - 1) +
        -2 * at(img, x - 1, y) +
        2 * at(img, x + 1, y) +
        -at(img, x - 1, y + 1) +
        at(img, x + 1, y + 1);
      Iy[i] =
        -at(img, x - 1, y - 1) -
        2 * at(img, x, y - 1) -
        at(img, x + 1, y - 1) +
        at(img, x - 1, y + 1) +
        2 * at(img, x, y + 1) +
        at(img, x + 1, y + 1);
    }
  }
  return { Ix, Iy };
}

function minEigen(ix2: number, iy2: number, ixiy: number): number {
  // λ_min of [[ix2, ixiy], [ixiy, iy2]]
  const tr = ix2 + iy2;
  const det = ix2 * iy2 - ixiy * ixiy;
  const disc = Math.max(0, tr * tr - 4 * det);
  return 0.5 * (tr - Math.sqrt(disc));
}

function pointInQuad(x: number, y: number, q: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
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

export function detectShiTomasi(
  img: GrayImage,
  opts: {
    count: number;
    window?: number;
    quad?: Array<[number, number]>;
    mask?: GrayImage;
    minScore?: number;
  }
): Feature[] {
  const win = opts.window ?? 3;
  const r = Math.floor(win / 2);
  const { Ix, Iy } = sobel(img);
  const w = img.width;
  const h = img.height;
  const scores = new Float32Array(w * h);
  const minScore = opts.minScore ?? 1e-6;

  for (let y = r + 1; y < h - r - 1; y++) {
    for (let x = r + 1; x < w - r - 1; x++) {
      if (opts.quad && !pointInQuad(x, y, opts.quad)) continue;
      if (opts.mask && sampleBilinear(opts.mask, x, y) < 0.5) continue;
      let ix2 = 0;
      let iy2 = 0;
      let ixiy = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const i = (y + dy) * w + (x + dx);
          const gx = Ix[i]!;
          const gy = Iy[i]!;
          ix2 += gx * gx;
          iy2 += gy * gy;
          ixiy += gx * gy;
        }
      }
      scores[y * w + x] = minEigen(ix2, iy2, ixiy);
    }
  }

  // Grid-bucket: split the bounding box into ~sqrt(count)*2 cells, pick
  // the best per cell, then fill from a global leftover list.
  const xs = opts.quad?.map((c) => c[0]) ?? [0, w - 1];
  const ys = opts.quad?.map((c) => c[1]) ?? [0, h - 1];
  const minX = Math.max(r + 1, Math.floor(Math.min(...xs)));
  const maxX = Math.min(w - r - 2, Math.ceil(Math.max(...xs)));
  const minY = Math.max(r + 1, Math.floor(Math.min(...ys)));
  const maxY = Math.min(h - r - 2, Math.ceil(Math.max(...ys)));
  const nCells = Math.max(2, Math.ceil(Math.sqrt(opts.count) * 2));
  const cellW = Math.max(1, (maxX - minX + 1) / nCells);
  const cellH = Math.max(1, (maxY - minY + 1) / nCells);
  const bestInCell: Feature[][] = Array.from({ length: nCells * nCells }, () => []);

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const s = scores[y * w + x]!;
      if (s < minScore) continue;
      const cx = Math.min(nCells - 1, Math.floor((x - minX) / cellW));
      const cy = Math.min(nCells - 1, Math.floor((y - minY) / cellH));
      bestInCell[cy * nCells + cx]!.push({ x, y, score: s });
    }
  }

  const picked: Feature[] = [];
  const leftover: Feature[] = [];
  for (const cell of bestInCell) {
    cell.sort((a, b) => b.score - a.score);
    if (cell[0]) picked.push(cell[0]);
    for (let i = 1; i < cell.length; i++) leftover.push(cell[i]!);
  }
  leftover.sort((a, b) => b.score - a.score);
  const minSep = 4;
  const farEnough = (f: Feature) =>
    picked.every((p) => Math.hypot(p.x - f.x, p.y - f.y) >= minSep);
  for (const f of leftover) {
    if (picked.length >= opts.count) break;
    if (farEnough(f)) picked.push(f);
  }
  picked.sort((a, b) => b.score - a.score);
  return picked.slice(0, opts.count);
}
