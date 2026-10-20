---
title: Trails (feedback) → Echo
type: trails
class: effect
---

- `feedback` maps to **Echo** (`ADBE Echo`).
  - Echo Time = −1/fps, Decay = decay, Starting Intensity 1.
  - Operator: Composite In Back (the current frame over its echoes).
  - Echoes until decay^n < 0.5/255: n = ⌈ln(0.5/255) / ln decay⌉, at most
    255 (75 at decay 0.92).
- Measured on a disc moving over 16 frames (decay 0.5 / 0.8 / 0.92): colours
  exact at 16 bpc, alpha mean ≤ 0.019.
- Echo reads the layer's **source** frames and ignores effects before it:
  the trails input must be a precomp.
- Toolbox's trail depends on evaluating every frame in order; the offline
  export does.
- `ring` (a stop-motion hold) and `velocity` modes have no Echo form: bake.
