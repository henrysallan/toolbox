// Aspect correction for geometry on non-square canvases.
//
// Engine content is authored in normalized [0,1]² (Y-DOWN). On a non-square
// render target that maps anisotropically to pixels, so a circle would render
// as an ellipse. To keep geometry round WITHOUT changing any stored param,
// we adjust the y coordinate by the canvas aspect at render time — exactly
// what the SDF compiler's `u_aspectCorrect` path does
// (`p.y = (v_uv.y - 0.5) / aspect + 0.5`). Position stays normalized to the
// full canvas (x = 0..1 across the width); only roundness is corrected.
//
// `aspect` is width / height. A square canvas (aspect = 1) is the identity,
// so square projects are completely unaffected.

// Map an authored normalized y to its on-canvas normalized y (shape → pixel).
export function aspectCorrectY(ny: number, aspect: number): number {
  return 0.5 + (ny - 0.5) * aspect;
}

// Inverse: on-canvas normalized y back to authored y (pointer → param).
export function aspectUncorrectY(cy: number, aspect: number): number {
  return 0.5 + (cy - 0.5) / aspect;
}
