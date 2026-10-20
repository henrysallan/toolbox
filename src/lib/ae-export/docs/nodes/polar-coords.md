---
title: Polar Coordinates → shader
type: polar-coords
class: shader
---

- Not exported through AE's Polar Coordinates, whose conventions are fixed:
  - the source's top row maps to the centre;
  - angle 0 is at 12 o'clock;
  - the source height spans the inscribed circle;
  - everything outside that circle is transparent.
- Toolbox's defaults differ on every one of those: the bottom row at the
  centre, angle 0 at 3 o'clock, radius scale 1, clamped edges.
  - The best toolbox settings still measure mean 0.19 (rect → polar) and
    0.28 (polar → rect).
  - Matching would need a flip, a scale and a wrap-around offset in front.
- Exports as a Toolbox Shader region (the node is `pure` in the GLSL table).
