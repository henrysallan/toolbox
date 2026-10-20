---
title: LUT → bake
type: lut
class: bake
---

- **Apply Color LUT cannot be built by a script.**
  - Adding the effect opens a file dialog: measured headless, the dialog
    hangs aerender's render core.
  - Its LUT file is not a scriptable property.
- The GLSL table classes `lut` as opaque (the .cube lives in a param), so it
  is not a shader region either: the node's output bakes.
- Hand-off option for a designer: apply the same .cube in AE by hand.
