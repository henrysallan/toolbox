// Authored-space ↔ canvas-pixel conversions for tracker positions.
// Positions live in anisotropic-normalized [0,1]² Y-down (the `points`
// convention). The kernel's patch grid is square pixels, so this is just
// `x*W, y*H` — no aspect correction. Overlay / points consumers aspect-
// correct on their way to pixels. Spec: 082226_motion-tracking.md §4.3.

export function authoredToCanvasPx(
  x: number,
  y: number,
  W: number,
  H: number
): [number, number] {
  return [x * W, y * H];
}

export function canvasPxToAuthored(
  px: number,
  py: number,
  W: number,
  H: number
): [number, number] {
  return [W === 0 ? 0 : px / W, H === 0 ? 0 : py / H];
}
