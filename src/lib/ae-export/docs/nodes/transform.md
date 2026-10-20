---
title: Transform → AE layer transform
type: transform
class: transform
---

- Exact. `anchorPoint = pivot_px`, `position = pivot_px + translate_px`,
  `scale ·100 %`, `rotation` in degrees (clockwise on screen).
- On a shape chain it becomes the shape group's transform; ending a layer
  it becomes the layer's own transform; mid-chain on an image it also
  becomes a layer transform, on a precomp when the layer's own transform
  is already taken.
- Bakes for now: `tile` (Motion Tile), `legacySkew`, and an image
  Transform driven by a wired transform.
- `space=local` pivots come from the incoming geometry's bounding box. If
  the box animates, the anchor is keyed per frame and the report says so.
- Independent translate X / Y tracks export as separated dimensions, each
  with its own keys and eases.
- Scale is clamped ≥ 0.0001 in toolbox, so a "negative scale" flip is a
  rotation plus mirror, not a negative AE scale.
