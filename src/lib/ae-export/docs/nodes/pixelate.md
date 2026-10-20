---
title: Pixelate → Mosaic
type: pixelate
class: effect
---

- Maps to **Mosaic** (`ADBE Mosaic`), Sharp Colors off.
  - Horizontal Blocks = W / (size · aspect).
  - Vertical Blocks = H / size.
- Approximate: AE averages each block, while toolbox samples the cell centre.
  - Measured on noise: mean 0.022 at size 16, 0.035 at size 32.
  - Colour sweep at size 8: mean 0.0007.
  - Sharp Colors on picks each block's bottom-right pixel, which is further
    from toolbox's centre sample.
- **Falls back to shader** when:
  - the cells don't divide the comp (toolbox's grid starts bottom-left with
    partial cells, Mosaic spreads whole blocks over the layer);
  - the cells are circles.
