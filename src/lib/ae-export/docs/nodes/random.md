---
title: Random → expression (seeded exact, frame approx)
type: random
class: expression
---

- **Seeded** (default): the expression runs the editor's hash of (seed,
  frame) — `tbxHash01` — so AE shows the same numbers at every frame
  (*measured*, uniform and gauss, scalar and vec2). Lo / hi / seed are read
  at the frame's start, as the node caches per frame.
- **Frame** mode draws `Math.random()` on every evaluation in the editor;
  nothing can repeat that. AE gets `seedRandom(<hash of the node id>,
  false); random()` through the same lo / hi / Box-Muller arithmetic: the
  same distribution, different numbers, stable across AE renders. Reported
  approx.
- A keyed lo / hi / seed keeps the driver sampled (per-frame keys).
