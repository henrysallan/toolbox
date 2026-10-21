---
title: Light → AE light
type: light-3d
class: layer
---

- directional → Parallel (Position + Point of Interest = target), point →
  Point (Inverse Square Clamped, Radius 512 px), spot → Spot (Cone Angle =
  2·angle, Feather = 100·penumbra), ambient → Ambient. Color hex → 0–1 RGB.
- Approx lighting (measured): Advanced 3D shades in the encoded working
  space. AE's response is linear in N·L; toolbox's goes through the sRGB
  encode. Intensity % = 100 · 1.16 · encode(I/π), the least-squares match
  (ambient: 100 · encode(I/π), exact). Point / spot are matched at the
  camera target's distance at frame 0.
- Round trip (GLB, key + point + ambient): mean |Δ| 0.04–0.09 inside the
  model. AE is darker toward the terminator and hotter where light hits
  head-on.
- A spot's `distance` cutoff has no AE form. Shadows stay off on both sides.
