---
title: Stagger → per-copy keys
type: stagger
class: instances
---

- Stagger writes a per-point `phase` channel. It has no AE object of its
  own: what it drives is exported.
- Phases that drive Copy to Points copies (through Modulate Points' scale /
  rotate attributes, Map Attribute, a pick, tint or opacity) are evaluated
  at every frame of the layer's window. Each exploded copy gets keys only
  where its motion bends: linear stretches merge, so a hold → ramp → hold
  copy has about 3 keys. Exact at frames.
- A pick driven by a phase (attribute pick) becomes one layer per variant,
  switched by HOLD opacity keys.
- Phases that drive geometry directly (a spline built from the points)
  become path keys per frame. That needs a constant vertex count.
- The Stagger node is pure, so a Time Offset or a clip window retimes it
  exactly; the keys land on the comp clock.
