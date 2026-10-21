---
title: 3D Scene → AE 3-D precomp (Advanced 3D)
type: scene-render
class: layer
---

- Native when every object is an Import 3D model (optionally under
  Transform 3D chains) or a Light, and the camera is a Camera node or none.
  The result is a precomp on the Advanced 3D renderer with an AE camera,
  lights, 3-D nulls and model layers, placed as one 2-D precomp layer.
- No camera wired: Scene Render's default (FOV 45°, from (2.4, 1.8, 2.4) at
  the origin). No light wired: the 0.4 ambient light toolbox adds.
- Solid background: a 2-D solid at the bottom of the precomp (a comp-sized
  rectangle when its color is keyed). Transparent stays transparent.
- Bakes (look-exact): fog, environment `room`, a camera with depth of field,
  any primitive / material / modeling node, an STL model, an Import 3D that
  picks one object (`top:<i>`), or a non-Camera camera source.
- Framing matches within 0.06 px; lighting is approx (see light-3d).
