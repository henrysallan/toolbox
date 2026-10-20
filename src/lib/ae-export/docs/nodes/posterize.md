---
title: Posterize → Levels + Posterize (exact)
type: posterize
class: effect
---

- Two effects: **Levels** (`ADBE Easy Levels2`) with output range
  [0.5/L, (L − 0.5)/L], then **Posterize** with Level = L.
- Why the Levels: AE's Posterize bins at floor(v · L) / (L − 1), while
  toolbox rounds to round(v · (L − 1)) / (L − 1). The Levels makes AE's floor
  land on toolbox's rounding.
- Exact on a ramp and on noise, L 2–32: max 0.0004 at 16 bpc, 0.002 at 8 bpc.
- **Falls back to shader** for gamma ≠ 1 and for luma mode.
