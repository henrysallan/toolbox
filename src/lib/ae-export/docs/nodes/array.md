---
title: Array → Repeaters (spline / point) or Motion Tile (image)
type: array
class: instances
---

- **Spline mode** becomes Repeaters on the fill's / stroke's shape layer.
  - The instance path sits in a group whose transform is the per-copy TRS:
    anchor = the canvas centre, position = the first cell's centre + Copy
    X / Y, rotation = Copy Rotate, scale = Copy Scale × 100.
  - One Repeater per axis: `flow-rows` steps X inside, `flow-columns` Y
    inside. Steps are `1/count` (fit) or Cell W / H (step), × W px.
  - Exact. Keyed or wired array params fall back to the evaluated copies
    (path keys per frame).
- **Point mode** outputs a lattice of points. Copy to Points maps a lattice
  to Repeaters on its instance's shape layer, the array's per-copy rotation
  and scale included.
- **Image mode** maps to **Motion Tile** (`ADBE Tile`).
  - Tile Width = 100 / countX %, Tile Height = 100 / countY % (or 100 ·
    sizeW / sizeH in step mode).
  - Tile Center is the centre of toolbox's bottom-left tile; Motion Tile
    repeats from any tile.
  - Output 100%, no mirror edges.
  - Measured: mean ≤ 0.013 (resampling: toolbox samples without mipmaps);
    2×2 is exact.
  - **Falls back** (exploded layers or shader) when:
    - a step grid doesn't cover the frame (toolbox leaves the rest
      transparent, Motion Tile tiles on);
    - there are pattern offsets, per-copy offsets, rotation or scale;
    - a modulator input is wired.
