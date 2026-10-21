---
title: Transform 3D → 3-D null (parent)
type: transform-3d
class: transform
---

- Over Import 3D models in a native 3D Scene: a 3-D null the model (or the
  next Transform 3D) is parented to. Its TRS maps like Import 3D's
  (512 px per unit, Y and Z flipped, X / Y / Z Rotation = rot_x / −rot_y /
  −rot_z).
- AE parenting composes the full matrices. Toolbox decomposes back to TRS,
  dropping shear, so the two differ only for a rotation over a non-uniformly
  scaled child (reported).
- Over instances, primitives or other geometry: bakes with its Scene Render.
