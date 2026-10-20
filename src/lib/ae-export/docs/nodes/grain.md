---
title: Grain → Add Grain (statistics match)
type: grain
class: effect
---

- Maps to **Add Grain** (`VISINF Grain Implant`).
  - Fixed: Viewing Mode Final Output, Blending Mode 5 (toolbox's overlay
    response), Monochromatic, Size 1, Softness 0.
  - Intensity = 8.67 · luminance. Random Seed = seed. Animation Speed 1, or
    0 for static grain.
- Grain is noise, so the match is statistical: the std of (out − in) per
  luminance band is within 4% of toolbox's, and both are white at 1 px. The
  random field itself differs.
- Only the default look maps: custom preset, `fine` model, 1-px cells,
  overlay at full mix, no chroma / tint / response / smoothing / drift, and
  project-rate or static motion. Anything else → shader.
