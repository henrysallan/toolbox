---
title: Switch → the picked input, inlined
type: switch
class: expression
---

- Scalar / vector Switch with a **constant** index: the index is rounded and
  clamped as the node does, and only the picked input's graph goes into the
  expression (coerced to the switch's type: a scalar broadcasts, a vec2
  widens with z = 0, w = 1).
- A **wired** index, or a pick of an empty slot (the node outputs nothing),
  keeps the driver sampled.
