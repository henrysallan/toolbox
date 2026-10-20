---
title: Copy to Points → Repeater or one layer per copy
type: copy-to-points
class: instances
---

- A regular grid or radial array source becomes one Repeater (exact).
- Otherwise each point becomes its own layer or shape group with its
  position, rotation, scale and tint, up to the layer budget (default 200).
  Past the budget the planner warns and the node bakes; the export window's
  "Keep procedural" override keeps the layers anyway.
- Animated point clouds become per-frame keys on every copy, or a bake.
- Point rotation fields are radians in toolbox; AE gets degrees.
