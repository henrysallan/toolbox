---
title: Engine conventions for a fused GLSL Expression
---

Read this before writing a single line. Every translation failure this
engine has seen came from an agent that knew GLSL and skipped one of these.

## The template you are writing into

The node owns everything outside `main()`'s body. You write the BODY plus
optional file-scope helpers (hoisted automatically, or fenced with
`// functions` … `// body`). Never write `#version`, `precision`, `main()`,
or your own `uniform` lines — channels are declared as comments (below).

```glsl
// owned by the node — for reference only, do not paste
#version 300 es
precision highp float;
in vec2 v_uv;            // Y-UP canvas UV: (0,0) bottom-left, (1,1) top-right
out vec4 fragColor;      // STRAIGHT alpha — never premultiply
uniform sampler2D u_a, u_b, u_c, u_d;   // wired image inputs; unwired = 1×1 transparent
uniform vec2  u_res;     // output size in pixels
uniform float u_time;    // seconds
uniform float u_frame;   // frames (float)
uniform float u_aspect;  // u_res.x / u_res.y
// <one uniform / function per channel you declared>
// <your hoisted helpers>
void main() { <your body> }
```

Identifiers starting with `u_` or `gl_`, or containing `__`, are reserved.
`fragColor` must be written on every path.

## Coordinates — the one that bites every time

Two spaces coexist and they disagree on Y:

| space | who uses it | origin | units |
|---|---|---|---|
| `v_uv` / uv01 | every image node's shader, Gradient, texture-coordinate | bottom-left, **Y-UP** | per-axis fraction of the raster, NOT aspect-corrected |
| canvas01 | every spline / point node's params and outputs (Circle center, Copy to Points, get_node_data) | top-left, **Y-DOWN** | width units: y is scaled about 0.5 by W/H so radii are width-relative |

To work in the same aspect-corrected, width-unit, Y-up space the SDF compiler
uses (round things stay round):

```glsl
vec2 p = vec2(v_uv.x, (v_uv.y - 0.5) / u_aspect + 0.5);
```

In that `p` space an authored canvas01 point `(x, y)` sits at
`vec2(x, 1.0 - y)` and an authored radius `r` is just `r`. Distances measured
in `p` are width-relative exactly like the geometry nodes' params.

Consequences:

- A `Displace` amount is a **uv01** offset (per-axis fractions), so it is
  applied to `v_uv` directly, not to `p`.
- A `Transform`/`Mirror`/`Polar Coords` node inverse-samples: it computes the
  source uv from the output uv and reads the input there. "Positive angle is
  clockwise on screen" holds in `v_uv` without negating anything.
- If a diff image looks like a vertical mirror of the original, you flipped Y
  once too often or too few.

## Alpha and range

- **Straight alpha in, straight alpha out.** `texture(u_a, uv)` returns
  straight RGBA; write straight RGBA. Compositing "over" in straight alpha is
  `a_out = s.a + d.a*(1-s.a); rgb_out = (s.rgb*s.a + d.rgb*d.a*(1-s.a)) / max(a_out, 1e-6)`.
- **Targets are RGBA16F.** Values run past 1.0 between nodes (noise contrast,
  add blends, bloom). Do not clamp unless the node you are porting clamps.
- **Transparent black is the empty value** — an unwired sampler reads
  `vec4(0)`, and a cleared target is `vec4(0)`.

## Mask and opacity are the evaluator's, not the node's

Every image node gets a universal `mask` input and an `opacity` param applied
AFTER `compute()` by the evaluator, with these exact rules:

```glsl
// mask (engine MASK_APPLY_FS): m = texture(mask, v_uv).r
//   node has an image input  →  out = mix(firstImageInput, effect, m)
//   node has none            →  out = vec4(effect.rgb * m, effect.a * m)
// opacity (engine OPACITY_FS):
//   out = vec4(c.rgb, c.a * opacity)
```

- Your fused node's OWN mask socket and opacity behave this way for free —
  do not re-implement them for the final output. The plan wires the
  target's mask producer into your node's `mask` socket (`targetMask`).
- An **interior** node's mask (a matte on a node you are fusing away) is
  not free: apply the rule above inside your helper, sampling the matte as
  one of `u_a..u_d`. The plan lists these with `matte: true`.
- Interior `opacity` values ≠ 1 must be multiplied into that helper's alpha.
  The target's own `opacity` is reported as `targetOpacity` — multiply it
  into `fragColor.a` (glsl-expression has no opacity param of its own).
- A `mask` wire carries coverage in `.r`. Image→mask coercion is
  `luma * alpha` (`dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) * c.a`); a
  spline→mask is the filled silhouette. When a fused node consumed a mask
  that the evaluator coerced from an image, reproduce the coercion.

## Channels — how params become tunables

Declare each tunable as a one-line comment; Sync (which `add_node` and
`set_param expression` both run) mints a row on the node and the template
exposes it by name:

```glsl
// ch("radius", 0.24, 0.0, 1.0)         → uniform float radius     (slider + scalar socket)
// toggle("invert", false)               → uniform bool invert      (pill + scalar socket)
// pick("mode", "soft", "hard")          → uniform int mode; const int mode_soft=0, mode_hard=1
// color("tint", "#ff8800")              → uniform vec4 tint        (straight alpha; vec4 socket)
// ramp("ink", "#000000", "#ffffff")     → vec4 ink(float t)        (gradient editor; color_ramp socket)
// curve("falloff", 1.0, 0.0)            → float falloff(float x)   (curve editor)
```

Rules that matter for translation:

- **Seed every channel with the ORIGINAL node's current value** (the plan's
  `paramDefs[].value`), and its `min`/`max` when present. That is what makes
  the two sides comparable knob for knob during the parity loop.
- Keep the original param names where they are legal identifiers so
  `set_param(glslId, "radius", …)` reads like the original.
- Angles: params are degrees, shaders want radians. Seed the channel in
  degrees (matches the original slider) and convert in code.
- Enum params → `pick()` with the original option strings; options
  sanitize to `<name>_<option>` constants.
- `color_ramp` params (Color Ramp stops, Rasterize fills) → `ramp()`
  seeded with the stop hexes; then `set_param(glslId, "ink", stops)` copies
  the exact stops (positions included) in one call — do that rather than
  hand-typing positions.
- Wired scalar / vec4 / color_ramp inputs on a fused node become channel
  sockets: declare the channel, then `add_edge` from the same producer to
  `<glslId>:in:<channelName>` (the plan's `skeleton.channelEdges`). The
  producer keeps driving it at eval time.
- Keyframed params: a channel cannot hold keyframes. Either leave the
  keyframes on the original node and drive the channel from a wired
  scalar (a `constant` or `animated-value` node carrying the same track),
  or state that the animation was not carried over.
- Cap: 12 ramp/curve channels per node (units 4+ on a 16-unit device).
- Sync is add-only. To change a channel's value use `set_param` with the
  channel NAME; rewriting the expression never resets tuned rows.

## Time

`u_time` is seconds, `u_frame` is frames; `fps` and `loopFrames` come from
`get_status` (the plan echoes them). A node that says it loops (Perlin's
`loop` window) closes the loop by walking a **circle** in noise space
(`offset = rate * (cos θ, sin θ)`, θ = 2π·phase), not by wrapping time —
copy that idiom or the seam shows at the loop point. Time enters the cache
fingerprint only when `u_time`/`u_frame` appear literally in your source;
time reached through a channel does not invalidate the cache.

## Inputs

Four samplers, period. The plan assigns `u_a..u_d` to distinct producers
(`frontier[].slot`); the same producer feeding two fused nodes is one slot.
Sample inputs at the uv the ORIGINAL node sampled them (usually the pixel's
own `v_uv`; gathers sample at offsets). `texture()` on an unwired slot is
`vec4(0)` — do not branch on "is it wired", the original node did not.

## Output

One `vec4` image. Aux outputs of the original (a Bloom's `bloom_only`, a
Color Ramp's `ramp`) are not reproduced; if the graph consumed one, the plan
excludes that consumer and says so.

## What a compile error looks like

Passthrough or transparent, plus a `shaderError` on `get_graph`/`screenshot`
and the info log on `get_shader_errors`. The plan sets `on_error:
"transparent"` so a broken shader looks broken. Info-log line numbers count
the template prelude — subtract `shaderPreludeLines`. **Always run
`get_shader_errors` before the first screenshot.**
