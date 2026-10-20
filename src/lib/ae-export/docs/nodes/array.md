---
title: Array (image mode) → Motion Tile
type: array
class: instances
---

- Image mode maps to **Motion Tile** (`ADBE Tile`).
  - Tile Width = 100 / countX %, Tile Height = 100 / countY % (or 100 ·
    sizeW / sizeH in step mode).
  - Tile Center is the centre of toolbox's bottom-left tile; Motion Tile
    repeats from any tile.
  - Output 100%, no mirror edges.
- Measured: mean ≤ 0.013 (resampling: toolbox samples without mipmaps); 2×2
  is exact.
- Spline / point mode is a Repeater, not this.
- **Falls back** (exploded layers or shader) when:
  - a step grid doesn't cover the frame (toolbox leaves the rest
    transparent, Motion Tile tiles on);
  - there are pattern offsets, per-copy offsets, rotation or scale;
  - a modulator input is wired.
