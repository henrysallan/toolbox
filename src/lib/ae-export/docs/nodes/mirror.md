---
title: Mirror → Mirror (bisect)
type: mirror
class: effect
---

- `bisect` maps to **Mirror** (`ADBE Mirror`).
  - Reflection Center is the line's point in px.
  - Reflection Angle depends on the kept side: −x 0°, −y 90°, x 180°,
    y 270°.
- Measured: mean ≤ 0.006, worst 0.07 (resampling along the line).
- **Falls back to shader** for:
  - `x` / `y` / `both` / `radial`, which composite reflected copies over the
    source (an opaque frame becomes its mirror image);
  - Keep source off.
- **On points or a spline** the Mirror is not an image effect: the plan reads
  the sockets as wired (its resting `source` socket says image), so the
  mirrored points export as instance positions and a mirrored spline as its
  evaluated path, like any other point / spline node.
