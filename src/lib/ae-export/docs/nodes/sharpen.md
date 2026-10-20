---
title: Sharpen → Sharpen / Unsharp Mask
type: sharpen
class: effect
---

- `box` maps to **Sharpen**, Sharpen Amount = 50 · amount.
  - Matches away from the frame edge: mean 0.003, worst 0.023 with a 2-px
    border excluded.
  - The outermost pixels differ (worst 0.62), as AE pads differently.
- `unsharp` maps to **Unsharp Mask**: Radius 0.5, Threshold 0,
  Amount = 100 · amount.
  - Exact: worst 0.0009 at 16 bpc, 0.007 at 8.
  - Toolbox's unsharp is original + amount · (original − binomial 3×3).
- **Falls back to shader** for `diamond` and `cross`, whose kernels Sharpen
  doesn't have.
