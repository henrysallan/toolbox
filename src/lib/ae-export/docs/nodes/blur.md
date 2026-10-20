---
title: Blur → Gaussian Blur (calibrated)
type: blur
class: effect
---

- Maps to **Gaussian Blur** (`ADBE Gaussian Blur 2`): Blur Dimensions
  horizontal and vertical, Repeat Edge Pixels on.
- **Blurriness = 1.7464 · radius.** AE's kernel is σ = Blurriness / 3.50 in
  linear light and toolbox's is σ = radius / 2 (R² 0.999999996, radius 2–42).
  A keyed radius converts key by key.
- AE 26.5's Gaussian Blur always blurs in **linear light**: it decodes with a
  pure 2.404 power, convolves, and re-encodes. It stands in for toolbox's
  default `linearize: on`; `linearize: off` (gamma space) has no AE twin.
- Measured on a disc, a 1-px grid, noise and a transparent disc (radius
  1–42, 8 and 16 bpc): mean ≤ 0.033, p95 ≤ 0.051.
  - The worst case is the 1-px grid. Toolbox decodes piecewise sRGB, AE a
    pure power, so mixed fine detail sits up to 0.033 brighter in AE.
  - Noise and soft content: ≤ 0.002 mean.
  - Alpha matches: both blur premultiplied.
- **Falls back to shader** for:
  - mode bokeh or convolve;
  - `linearize: off`;
  - radius above 42.67, toolbox's 64-tap cap (AE's kernel keeps growing).
- Never in a linearized working space: Gaussian Blur 2 then linearizes twice
  (γ ≈ 5.4). The builder keeps `linearizeWorkingSpace` off.
