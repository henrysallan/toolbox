---
title: Bloom → Glow (look match)
type: bloom
class: effect
---

- Maps to **Glow** (`ADBE Glo2`), based on Color Channels.
  - Glow Threshold = 255 · threshold.
  - Glow Radius = 2^(levels + 1) px.
  - Glow Intensity = 3 · intensity.
- Approximate, a look match: toolbox's mip pyramid, max-channel soft knee
  and unclamped add are not Glow's blur.
  - Measured on a bright disc and dots over dim noise: mean 0.007–0.028,
    p95 up to 0.17 (levels 5 at intensity 2).
  - Toolbox can exceed 1; at 8 / 16 bpc both clamp.
- **Falls back to shader** for tint_amount > 0 and for anamorphic.
