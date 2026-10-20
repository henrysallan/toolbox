---
title: Merge → precomp layers, blend modes, track mattes
type: merge
class: layer
---

- Each Merge input becomes a layer in a precomp, stacked in Merge's order,
  with its blend mode and opacity (`layer_opacity:<id>` keys carry over).
- A per-layer `mask:<id>` becomes a track matte by reference: Luma when
  the mask is an image (luma × alpha), Alpha when it's a spline.
  `maskInvert` makes it the Inverted type. The matte source layer is
  hidden, as AE does for mattes.
- 24 of the 29 blend modes map by name. Average, Negation, Reflect, Glow
  and Phoenix have no AE mode: that Merge becomes a shader region (or a
  bake without the plug-in).
- Toolbox composites straight alpha, AE premultiplied: fills and mattes
  match, anti-aliased edges of blended layers can differ sub-pixel.
