// Procedural aperture rasterization.
//
// The complex-separable trick (complex.ts) only spans CIRCULARLY
// SYMMETRIC kernels — its whole basis is e^((-a+ib)·r²), a function of r
// alone. A hexagonal or star aperture is not that, so those shapes route
// through the low-rank SVD path (svd.ts) instead. This file is what
// stands between: it rasterizes the aperture to a small matrix that the
// decomposition can chew on.
//
// The user never sees the split. Bokeh's `shape` enum spans both families
// and the backend picks the decomposition, because "hexagonal bokeh" and
// "circular bokeh" are one idea to anyone holding a camera.
//
// Kernels are produced in SCREEN order — row 0 is the TOP, col 0 is the
// LEFT — because that is how they read when you draw one. The
// screen-order → tap-order conversion (including the convolution flip)
// lives in svd.ts so there is exactly one place to get it wrong.

export type ApertureShape = "hexagon" | "octagon" | "cats_eye" | "star";

/** 3×3 supersampling per cell — enough to keep polygon edges from stair-stepping. */
const SUPERSAMPLE = 3;

function polygonVertices(shape: ApertureShape, rotationRad: number): number[][] {
  if (shape === "star") {
    // 5-pointed star, alternating outer/inner radius.
    const pts: number[][] = [];
    const points = 5;
    const inner = 0.45;
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? 1 : inner;
      // −π/2 so a point faces up at zero rotation.
      const a = (i * Math.PI) / points - Math.PI / 2 + rotationRad;
      pts.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return pts;
  }
  const n = shape === "hexagon" ? 6 : 8;
  const pts: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i * 2 * Math.PI) / n - Math.PI / 2 + rotationRad;
    pts.push([Math.cos(a), Math.sin(a)]);
  }
  return pts;
}

function pointInPolygon(pts: number[][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Rasterize an aperture into a `size`×`size` matrix in screen order.
 *
 * The shape is inscribed in the unit circle, which is then mapped to the
 * matrix's half-width — so every aperture spans the same nominal radius
 * and swapping shapes does not change the apparent blur amount.
 */
export function rasterizeAperture(
  shape: ApertureShape,
  size: number,
  rotationDeg: number
): Float64Array {
  const out = new Float64Array(size * size);
  const half = (size - 1) / 2;
  const rot = (rotationDeg * Math.PI) / 180;
  const pts = shape === "cats_eye" ? null : polygonVertices(shape, rot);

  // Cat's eye = mechanical vignetting: the aperture disc clipped by the
  // lens barrel, which off-axis reads as a lens-shaped sliver. Two discs
  // intersected, offset along the rotation direction.
  const offset = 0.62;
  const ox = Math.cos(rot) * offset;
  const oy = Math.sin(rot) * offset;

  const step = 1 / SUPERSAMPLE;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = (col + (sx + 0.5) * step - 0.5 - half) / half;
          const py = (row + (sy + 0.5) * step - 0.5 - half) / half;
          let inside: boolean;
          if (pts) {
            inside = pointInPolygon(pts, px, py);
          } else {
            const d1 = px * px + py * py;
            const dx = px - ox;
            const dy = py - oy;
            inside = d1 <= 1 && dx * dx + dy * dy <= 1;
          }
          if (inside) hits++;
        }
      }
      out[row * size + col] = hits / (SUPERSAMPLE * SUPERSAMPLE);
    }
  }
  return out;
}

/**
 * A plain filled disc — the fallback when Convolve mode has no kernel
 * wired, so the node does something sensible instead of nothing.
 */
export function rasterizeDisc(size: number): Float64Array {
  const out = new Float64Array(size * size);
  const half = (size - 1) / 2;
  const step = 1 / SUPERSAMPLE;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = (col + (sx + 0.5) * step - 0.5 - half) / half;
          const py = (row + (sy + 0.5) * step - 0.5 - half) / half;
          if (px * px + py * py <= 1) hits++;
        }
      }
      out[row * size + col] = hits / (SUPERSAMPLE * SUPERSAMPLE);
    }
  }
  return out;
}
