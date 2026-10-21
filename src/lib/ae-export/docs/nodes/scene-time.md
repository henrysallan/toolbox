---
title: Scene Time → expression (every unit and mode)
type: scene-time
class: expression
---

- Linear, ping-pong, sawtooth and stepped, in seconds or frames, on the
  layer's toolbox clock: fractional frames are `tick / 1000`, as the node
  reads them.
- Every easing compiles, the custom curve included (its points inlined),
  with `ease_intensity` blended as the editor does.
- A wired `easing_curve` keeps the driver sampled.
