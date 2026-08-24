0. 3D update wave 2 — geometry type, points3d, scatter/copy/filter, face
   extrude, materials + texture projection. Spec (design agreed, not yet
   implemented): 081026_3d-geometry-points-materials.md. Bevel + spline
   extrude deferred to its backlog §8.
1. Depth of field
2. GLB, OBJ, FBX import — GLB scene autoparse to a node group (per-object
   meshes + lights + cameras as group sockets), spec:
   081626_glb-scene-import.md. FBX still backlog.
3. EXR import (single/multilayer/sequences, layer picker) + color pipeline (CST node, HDR LUT) — spec: archive/070926_exr-color-pipeline.md