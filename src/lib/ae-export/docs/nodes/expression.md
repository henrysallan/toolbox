---
title: Expression → AE expression (the math subset)
type: expression
class: expression
---

- The source is parsed, never evaluated (the Skia exporter's subset:
  numbers, the node's variables and globals, `Math.<fn>`, operators,
  `?:`, an array as the whole result) and re-emitted for AE's ES2018 engine.
  The globals (`t`, `time`, `frame`, `fps`, `u` = 0, `PI`, `TAU`, `E`,
  `mod`, `fract`, `clamp`, `saturate`, `lerp`, `mix`, `step`, `smoothstep`)
  are helpers or the clock, exactly as `makeEnv` defines them.
- `random()` is the node's own mulberry32 seeded by its id and the frame:
  the editor's numbers, in the editor's draw order.
- Refused (the property stays per-frame keys, with the reason):
  `Math.random()`, strings and template literals, objects, assignment,
  loops, unknown names, `out_type: curve`, a wired or keyed source.
- Output vec2 / vec3 / vec4 fill the AE property's components; a scalar
  result broadcasts, as the node does.
