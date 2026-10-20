---
title: Copy to Points → Repeater or one layer per copy
type: copy-to-points
class: instances
---

- A static Grid of one plain shape instance becomes two Repeaters (X
  copies, then Y, Grid's row-major order) on the instance's shape layer:
  exact and editable. There is no radial-array form yet.
- Otherwise the instance collapses into one precomp, placed once per point
  with its position, rotation and scale, up to the layer budget (default
  200). Past the budget the planner warns and the node bakes; the export
  window's "Keep procedural" override places every copy anyway, with a
  warning.
- Bakes for now: animated points, per-copy modulation (pick / scale /
  rotate fields), tint and opacity attributes, a `pick_mode` or
  `draw_order` other than the default.
- Point rotation fields are radians in toolbox; AE gets degrees.
