---
title: Camera → AE camera
type: camera-3d
class: layer
---

- Exact framing (measured within 0.06 px): Position = O + 512·(x, −y, −z),
  Point of Interest = the target, Zoom = (comp height / 2) / tan(fov / 2).
  AE's Point-of-Interest camera has three's lookAt basis.
- Keyed position axes on their own timing → separated X / Y / Z position.
  A keyed target → one spatial Point of Interest (per-frame keys when its
  axes key apart). A keyed FOV → per-frame zoom keys.
- Orthographic → approx: an AE camera 2·10⁵ px from the target along the
  same direction, zoom = D·H / (512·ortho_height). Silhouette IoU 0.997; a
  point 1.65 units deep moves ≤ 0.9 px. Farther cameras lose AE's depth
  precision.
- Depth of field bakes the scene (BokehPass has no calibrated AE blur).
  Near / far do not clip in AE.
