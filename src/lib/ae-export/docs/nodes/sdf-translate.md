---
title: SDF position chain → group transforms, mirror halves, Repeaters
type: sdf-translate
class: vector
aliases: sdf-rotate, sdf-scale, sdf-mirror, sdf-repeat, sdf-polar, sdf-twist
---

- A shape's position chain transforms the SAMPLE point, so the node wired
  into the shape is the innermost AE group and the one nearest canvas UV the
  outermost.
- **translate** (tx, ty) → a group Position (tx·W, −ty·W) — y flips (SDF
  space is Y-up). Keys convert exactly.
- **rotate** (degrees; the `angle` socket is radians) → a group Rotation
  **−degrees** about the pivot (counter-clockwise in SDF space). An
  `angle_field` (per-pixel angle) keeps the shader route.
- **scale** (sx, sy) → a group Scale (100·sx, 100·sy) about its center.
  Toolbox does not rescale the distance, so round / onion / contour widths
  below it scale with it — exactly what an AE group does to its contents. A
  scale ≤ 0 bakes (toolbox clamps it to 1e-4).
- **mirror** (x / y / both) → only the half on the + side of the center is
  sampled: the kept half (an Intersect with the half-plane when the shape
  crosses the line; nothing when it lies wholly on the other side) plus its
  reflection (a group Scale −100 about the center), Merge Paths Add.
- **repeat** → a Repeater per axis (Copies, Offset = the first cell, Position
  = spacing·W, −spacing·W on y). Unbounded: the cells the canvas shows.
  Bounded: −limit … +limit. A shape that overflows its cell is clipped to it
  (toolbox folds every pixel into one cell); a bounded repeat's outermost
  copies keep their overflow (their cells are half-open), so they are runs of
  their own. Jitter (per-cell random offsets) and fractional limits keep the
  shader route; the `cell_id` output is not a coordinate fold.
- **polar** (whole segments n) → a Repeater of n copies turning 360°/n about
  the center (Position 0, Anchor = the center); a shape that crosses its
  2π/n wedge is clipped to it first. Fractional or keyed segment counts keep
  the shader route.
- **twist** always keeps the shader route (a non-affine fold).
