---
title: Threshold → Channel Mixer + Threshold
type: threshold
class: effect
---

- Two effects: **Channel Mixer**, monochrome with Rec.709 weights (21.26 /
  71.52 / 7.22), then **Threshold** (`ADBE Threshold2`) with Level =
  threshold (0–1, not 0–255).
- Why the Channel Mixer: AE's Threshold reads Rec.601 luma, toolbox's
  Rec.709. On saturated colours that flips up to 7% of pixels; the mixer
  hands Threshold 709 grey.
- Exact except pixels lying on the threshold itself: ≤ 0.5% of
  pixels.
- **Falls back to shader** for softness > 0 and for invert.
