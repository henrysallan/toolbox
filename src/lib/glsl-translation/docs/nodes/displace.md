---
title: Displace — one offset tap through a map
type: displace
class: gather
---

Image branch only. If the plan lists Displace, its `image` input carried an
image (a spline/points Displace is `opaque` and never reaches you).

## What the node does (DISPLACE_FS, `src/nodes/effect/displace.ts`)

1. Read the **map** at the pixel's own `v_uv`.
2. Pick one channel per axis (`channelX`, `channelY`: r/g/b/a/luminance).
3. `offset = (channel − midlevel) × amount`, in **uv01 units** — per-axis
   fractions of the raster, not aspect-corrected, applied straight to
   `v_uv`. `amountX = 0.05` pushes 5% of the width.
4. Optional `rotate`: spin the sample position about the frame centre by
   `(luma − midlevel) × 2 × rotateAmount` (degrees in the param, radians in
   the shader). Positive is clockwise on screen in `v_uv`; do not negate.
5. Sample the **source** once at `uv + offset`, with the `wrap` rule:
   `transparent` → `vec4(0)` outside [0,1]², `clamp`, or `mirror`
   (`abs(fract(uv*0.5)*2 − 1)`).

Taps: 1 on the source, 1 on the map. Upstream evaluations pass through
unchanged (a gather of taps 1), so fusing the source chain is cheap.

## Param → channel

| param | channel | note |
|---|---|---|
| `amountX`, `amountY` | `ch(…, -1, 1)` | uv01 fractions |
| `midlevel` | `ch(…, 0, 1)` | 0.5 for signed maps (Perlin curl/RG), 0 for unsigned |
| `channelX`, `channelY` | `pick(…, "r","g","b","a","luminance")` | luma weights `0.2126, 0.7152, 0.0722` |
| `wrap` | `pick(…, "transparent","clamp","mirror")` | |
| `rotate` | `toggle` | |
| `rotateAmount` | `ch(…, -360, 360)` | degrees; `radians()` in code |

## Fused form

`source(uv)` is the upstream helper (or `texture(u_a, uv)` when the source
is a frontier sampler). The map is usually a frontier sampler too — noise
feeding a Displace is the one case where fusing the map instead saves a
texture: then `map(uv)` is the noise helper.

```glsl-body
// ch("amountX", 0.05, -1.0, 1.0)
// ch("amountY", 0.05, -1.0, 1.0)
// ch("midlevel", 0.5, 0.0, 1.0)
// pick("channelX", "r", "g", "b", "a", "luminance")
// pick("channelY", "r", "g", "b", "a", "luminance")
// pick("wrap", "transparent", "clamp", "mirror")
// toggle("rotate", false)
// ch("rotateAmount", 45.0, -360.0, 360.0)
float pickCh(vec4 c, int ch) {
  if (ch == channelX_r) return c.r;
  if (ch == channelX_g) return c.g;
  if (ch == channelX_b) return c.b;
  if (ch == channelX_a) return c.a;
  return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
}
vec2 wrapUv(vec2 uv) {
  if (wrap == wrap_clamp) return clamp(uv, 0.0, 1.0);
  if (wrap == wrap_mirror) return abs(fract(uv * 0.5) * 2.0 - 1.0);
  return uv;
}
// Replace these two with the fused upstream helpers when the plan fused them.
vec4 source(vec2 uv) { return texture(u_a, uv); }
vec4 map(vec2 uv) { return texture(u_b, uv); }
vec4 displace_node(vec2 uv) {
  vec4 d = map(uv);
  vec2 off = vec2(
    (pickCh(d, channelX) - midlevel) * amountX,
    (pickCh(d, channelY) - midlevel) * amountY
  );
  vec2 s = uv;
  if (rotate) {
    float luma = dot(d.rgb, vec3(0.2126, 0.7152, 0.0722));
    float ang = (luma - midlevel) * 2.0 * radians(rotateAmount);
    vec2 p = uv - 0.5;
    float c = cos(ang), sn = sin(ang);
    s = vec2(c * p.x - sn * p.y, sn * p.x + c * p.y) + 0.5;
  }
  s += off;
  if (wrap == wrap_transparent && (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0)) return vec4(0.0);
  return source(wrapUv(s));
}
fragColor = displace_node(v_uv);
```

`channelY` reuses the `channelX_*` constants on purpose — both picks have
the same option list, so the indices agree.

## Gotchas in translation

- The offset is in `v_uv` units. Never convert it to `p`-space.
- A map that is itself a fused generator (noise) must be evaluated at the
  pixel's own uv, not at the displaced uv.
- Border strips wrong ⇒ the wrong `wrap` (parity doc).
