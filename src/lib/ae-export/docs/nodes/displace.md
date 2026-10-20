---
title: Displace → Displacement Map
type: displace
class: effect
---

- Maps to **Displacement Map** (`ADBE Displacement Map`).
  - The `displacement` input becomes a hidden layer the effect references.
  - Map Behavior: Stretch Map to Fit; Wrap off; Expand Output off.
- Units:
  - Max Horizontal Displacement = amountX · W / 2 px.
  - Max Vertical Displacement = −amountY · H / 2 px (toolbox's Y is up).
  - Use For: r → Red, g → Green, b → Blue, a → Alpha, luminance → Luminance.
- Measured: mean ≤ 0.008; the luminance channel's worst is 0.10, since AE's
  luminance weights differ.
- Edge: AE leaves pixels pushed past the frame transparent. Toolbox's
  default `clamp` repeats the edge instead, so an alpha band appears there
  (α mean 0.016 at amount 0.05, 0.06 at 0.2). `transparent` matches.
- AE reads the map layer's **source**: if the map has effects, it must be a
  precomp.
- **Falls back to shader** for midlevel ≠ 0.5, rotate, and mirror edges.
