---
title: Float Curve → its monotone cubic, inlined
type: float-curve
class: expression
---

- The curve's points (sanitized as the editor does: clamped, sorted) and
  Fritsch–Carlson tangents are computed at export; the expression holds one
  cubic per segment and picks the first segment whose right end is ≥ x —
  the editor's loop — so it matches at every value, flat and zero-width
  segments included.
- Inputs outside the curve hold its end values.
- A wired or keyed `curve` keeps the driver sampled. The `curve` aux (a
  float_curve wire) is not a value.
