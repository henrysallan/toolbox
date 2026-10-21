---
title: SDF booleans and offsets → Merge Paths
type: sdf-union
class: vector
aliases: sdf-intersection, sdf-subtraction, sdf-smooth-union, sdf-smooth-intersection, sdf-smooth-subtraction, sdf-round, sdf-onion, sdf-material, sdf-morph, sdf-displace
---

- **union** (any number of slots) → one group per operand, then Merge Paths
  **Add**. **intersection** → Merge Paths **Intersect**. **subtraction** →
  the `a` group, the `b` group, Merge Paths **Subtract**: AE keeps the first
  operand in the group and removes the ones after it (*measured*).
- **round** (d − r) and **onion** (|d| − t) are offsets. An offset
  distributes over min / max (max(a, b) − r = max(a − r, b − r)) and flips
  sign under the subtracted side, so it lands on every leaf below it (see
  `ae-nodes/sdf-circle` for each leaf's exact offset). onion(X) = X offset by
  +t minus X offset by −t (Merge Paths Subtract) — exact for any tree,
  including booleans, where a plain centred stroke is not (the stroke's band
  follows the true distance, toolbox's its min / max).
- A ring thickness or offset that crosses zero inside the layer's window
  (the shape appears / vanishes) bakes.
- The **smooth** booleans are hard only at smoothness ≤ 0 (smin(a, b, 0) =
  min); any blend keeps the shader route. **morph** and **displace** always
  do. **material** is colour only: ignored by `sdf-to-mask` /
  `sdf-to-spline`; under a rasterize it is the fill when it paints every leaf.
