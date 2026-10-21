---
title: SDF consumers → one shape layer (hard chains) or shader
type: sdf-rasterize
class: vector
aliases: sdf-to-mask, sdf-to-spline, sdf-shade, sdf-bevel, sdf-to-distance-image
---

- A **hard** chain (`sdf-chain.ts`; the leaves, booleans, offsets and folds
  in `ae-nodes/sdf-circle`, `sdf-union`, `sdf-translate`) under these three
  consumers exports as one editable shape layer. The plan says per graph
  which chains are native and, for the rest, which node stopped them.
- **`sdf-rasterize`** →
  - the tree as Merge Paths, filled with `foreground` at `fg_alpha`
    (a single material / painted colour wins when it paints every leaf;
    different colours per shape keep the shader route — toolbox colours each
    pixel by its nearest shape);
  - `contour` → a centred Stroke 2 · `contour_width` px wide (Round join),
    over the fill;
  - `background` / `bg_alpha` → a comp-sized Rect under it. With
    `fg_alpha` < 1 the background is knocked out under the shape: toolbox
    mixes the two, it does not composite.
  - **Edge softness.** Toolbox's edge is a smoothstep across ±max(softness,
    0.5) px of the distance; AE anti-aliases by coverage (a 1-px box).
    From softness ≈ 0.75 px up the fill layer gets a **Gaussian Blur 2**,
    Blurriness = √(soft²/5 − 1/12) / 0.2858, and the background moves to its
    own layer underneath (so the blur's linear-light mixing never touches
    the fill / background mix). See specdocs/ae-m4/sdf.md for the measured
    edge error.
  - `aspect_correct` off → a group Scale of H/W on y (exact geometry; the
    edge and contour widths stay round in AE).
- **`sdf-to-mask`** → white shapes on a black comp Rect (`invert` swaps
  them); `threshold` offsets every leaf. Where it masks, it is a luma matte.
- **`sdf-to-spline`** → no layer of its own: the tree's exact outline is the
  geometry its Fill / Stroke / mask consumer uses (`iso` offsets every leaf).
  Toolbox traces the contour on a resolution² grid of the [0, 1]² SDF
  square, so AE's outline is the smooth version of the same curve, clipped
  to that square. As a mask it is an ALPHA track matte (Merge Paths cannot be
  a mask path).
- **Shader route**: `sdf-shade`, `sdf-bevel`, `sdf-to-distance-image` always
  (they shade the distance field, not just its contour), and any consumer
  whose chain is not hard. Under `sdf-to-spline` a soft chain bakes.
