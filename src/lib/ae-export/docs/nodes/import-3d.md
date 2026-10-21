---
title: Import 3D → AE 3D model layer
type: import-3d
class: layer
---

- In a native 3D Scene the same file (GLB, glTF or OBJ) is copied to
  `footage/` and imported as an AE 3D model layer (`ThreeDModelLayer`,
  Advanced 3D). AE 24.1+; measured headless in 26.5.
- 512 AE px per model unit, `(x, y, z)` → `(x, −y, −z)`, the file's origin at
  the layer anchor. The node's TRS becomes the layer transform: Position
  around the comp centre (or in its Transform 3D parent's space), Scale ·100 %,
  X / Y / Z Rotation = rot_x / −rot_y / −rot_z.
- AE renders the file's own PBR materials. Toolbox's plain Import 3D shows
  three's default material today, so colors differ for colored models.
- `.gltf` copies one file: its buffers and textures must be embedded (or
  use `.glb`). STL and a picked object (`top:<i>`) bake.
- No file loaded (after a reload, re-pick it): it exports nothing, as toolbox
  renders it.
