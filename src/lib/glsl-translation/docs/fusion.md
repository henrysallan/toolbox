---
title: Fusing a node chain into one shader
---

The plan hands you a REGION (nodes to fuse, producers first), a FRONTIER
(wires crossing into the region: image samplers `u_a..u_d`, channel
sockets, or manual constants), and per-node docs. This is how to turn that
into one body.

## One helper per node

Write each region node as a file-scope function named after its id and
type, taking the uv it should evaluate at:

```glsl
// functions
vec4 noise_n1(vec2 uv) { … }                       // generator: pure function of uv
vec4 ramp_n2(vec2 uv) { return ink(luma(noise_n1(uv))); }   // pure modifier: compose
vec4 displace_n3(vec2 uv) {                       // gather: sample upstream at another uv
  vec4 d = texture(u_a, uv);                      // frontier input a = the displacement map
  vec2 off = (d.rg - vec2(midlevel)) * vec2(amountX, amountY);
  return ramp_n2(uv + off);                       // re-evaluate upstream at the offset uv
}
// body
fragColor = displace_n3(v_uv);
```

- The region is topological: a helper only calls helpers that appear above
  it. Declaring them in the plan's `region` order guarantees that.
- A **pure** node is `f(upstream(uv), params)`. Compose.
- A **gather** node (displace, sharpen, blur, kuwahara) evaluates its input
  at OTHER uvs. If that input is a fused helper, call the helper at the
  offset uv — the whole upstream chain re-runs per tap. If the input is a
  frontier sampler, `texture(u_x, uvOffset)`.
- An inverse-sampling warp (transform, mirror, polar, pixelate) is a pure
  node whose "upstream at uv′" is the entire trick: compute `uv′` from
  `uv`, return `upstream(uv′)`, and handle out-of-range `uv′` the way the
  node's wrap mode does (transparent / clamp / mirror).
- A node with an interior matte (frontier `matte: true`) wraps its result:
  `mix(firstInput, result, texture(u_m, uv).r)` or `result * m` when it
  has no image input (conventions.md §Mask).

## Cost: gathers multiply

`plan.nodes[].evaluations` is how many times per pixel each helper runs
through the gathers downstream of it. A blur (say 25 taps) of a displace
(1 tap) of a 6-octave noise is 25 noise evaluations per pixel — fine. A
blur of a kuwahara of noise is 25 × 64. The plan warns past 64. When it
does, **do not fuse that upstream**: leave it as a node and take its
output as a frontier sampler. A correct fused shader that costs more than
the graph it replaced is a failure.

## Multipass nodes are approximations — declare the approximation

Separable blur, bloom pyramids, structure tensors and iterated filters
cannot be expressed exactly in one pass. The node doc names the one-pass
form (a fixed-tap gaussian, a few wide taps standing in for a pyramid). Use
it, seed its taps from the node's params, and write the approximation into
your report — "Blur (radius 12) approximated with a 13-tap gaussian along
each axis" — never "ported".

## Frontier wires

- `kind: "image"` → `texture(u_<slot>, uv)`. Sample it where the original
  node sampled it. A `mask`-typed wire carries coverage in `.r`.
- `kind: "channel"` → declare a channel of the matching kind (`ch` for
  scalar, `color` for vec4, `ramp` for color_ramp), seed it from the
  original param, then `add_edge` from `channelEdges[].from` to
  `<glslId>:in:<channelName>` so the producer keeps driving it.
- `kind: "manual"` → a vec2/vec3/other value you must fold. Read its
  current value with `get_node_data` and write constants (or two `ch()`
  channels for a vec2). Say so in the report.

## Values you copy

For every fused node, `paramDefs` lists each settable param with its
CURRENT value and range. Default rule: a param the user is likely to tune
(amounts, radii, colors, ramps, thresholds, modes) becomes a channel seeded
with that value; structural constants (channel-selector ints, wrap modes
that never change) may stay literals. When in doubt, make it a channel —
the parity loop tunes channels, not code.

Unit conversions that recur:

| original param | shader wants | do |
|---|---|---|
| degrees | radians | `radians(x)` in code; keep the channel in degrees |
| canvas01 position `(x, y)` | `p`-space | `vec2(x, 1.0 - y)` after `p = vec2(v_uv.x, (v_uv.y-0.5)/u_aspect+0.5)` |
| width-relative radius | `p`-space | unchanged |
| uv01 offset (Displace amount) | `v_uv` | unchanged, applied to `v_uv` |
| pixel size (Pixelate cell px) | uv | `px / u_res` |
| hex color | vec4 | `color()` channel; straight alpha |
| ramp stops | `t → vec4` | `ramp()` channel then `set_param` the stops |

## Landing the node

Apply `plan.skeleton.ops` with `edit_group` on `skeleton.groupId`. The
`add_node` carries the full `expression` (Sync mints channels), the
`add_edge` ops wire the image frontier into `a..d` and the target's mask
into `mask`. Add `channelEdges` as further `add_edge` ops in the same
batch — they resolve because add_node ran Sync first. Do NOT wire the new
node into Output; it lands beside the originals and the user swaps it.
`tidy({nodes: [glslId]})` afterwards.

Then `get_shader_errors({nodeId})` — before any screenshot.
