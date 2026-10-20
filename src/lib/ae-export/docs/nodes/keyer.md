---
title: Keyer (color) → Linear Color Key
type: keyer
class: effect
---

- `color` mode maps to **Linear Color Key** (`ADBE Linear Color Key2`),
  Match Colors Using RGB, Key Colors.
  - Key Color = key_color.
  - Matching Tolerance = 100 · tolerance.
  - Matching Softness = 150 · ((tol + soft)² − tol²).
- AE keys on toolbox's own distance (|ΔRGB| / √3). Its matte is linear in d²
  from tol², (d² − tol²) / (softness% / 150), where toolbox smoothsteps in d.
  The softness above makes both reach 1 at tol + soft.
- Measured on a colour sweep: α mean ≤ 0.027 (the largest softness is
  worst), exact for a hard key.
- **Falls back to shader** for:
  - `chroma` (AE's chroma metric isn't toolbox's CbCr distance);
  - `luma` (Extract measured off, α 0.035);
  - `sample` mode;
  - spill > 0.
