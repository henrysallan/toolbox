---
title: LFO → expression (all shapes, wired clock)
type: lfo
class: expression
---

- Sine, triangle, sawtooth and square on the layer's toolbox clock; phase
  wraps `((t·f + phase) % 1 + 1) % 1` as the node does, so negative clocks
  and phases match.
- A wired `clock` replaces the playhead (seconds, or frames ÷ fps), and
  wired frequency / phase / amplitude / offset compile with it.
- A keyed param on the LFO itself keeps it sampled (AE has no inline form
  of toolbox's eases yet).
