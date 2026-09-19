---
title: Blur — separable filter, approximated in one pass
type: blur
class: multipass
---

Blur is a **multipass** node: it builds a separable plan (horizontal then
vertical, per component) and runs it in **premultiplied linear light**
(`src/engine/convolve/`). A one-pass fused form is an approximation. Say
which one you used.

## What the node does

- `radius` is **pixels at render resolution** (`facts.space`), so one
  pixel is `1.0 / u_res`.
- `mode = gaussian`: `sigma = radius / 2`, `ceil(3σ)` taps per side, capped
  at 64. `radius ≤ 1e-4` is a plain copy.
- `mode = bokeh` / `convolve`: complex-phasor circular kernels or a
  low-rank SVD of a kernel image — do not attempt these in one pass; keep
  the node and take its output as a frontier sampler.
- Boundary: input is converted with `rgb = linearize ? srgbToLinear(rgb) :
  rgb; rgb *= a` (premultiplied), the kernel runs, and the output
  un-premultiplies (`a = max(a, 0)`, `rgb = a > 1e-5 ? max(rgb, 0)/a : 0`)
  and converts back. Port `TRANSFER_GLSL` from
  `src/engine/convolve/boundary.ts` for exact curves.

## Cost — read this before fusing

The node's cost is `2 × (2h+1)` taps. A one-pass fused form is `(2h+1)²`.
At the node's cap (h = 64) that is 16 641 upstream evaluations per pixel,
which is why the snippet caps `h` at 12 (625 taps) and why a blur of a
fused **gather** should almost never be fused. When `radius` is large or
the upstream is itself expensive, leave Blur as a node.

## Param → channel

| param | channel | note |
|---|---|---|
| `radius` | `ch(…, 0, 200)` | pixels |
| `linearize` | `toggle` | default true |
| `mode`, `shape`, `components`, `rank`, `rotation`, `ring`, `normalize` | — | only `gaussian` translates |

## Fused form (gaussian, fixed tap budget)

```glsl-body
// ch("radius", 12.0, 0.0, 200.0)
// toggle("linearize", true)
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
// Replace with the fused upstream helper when the plan fused it.
vec4 source(vec2 uv) { return texture(u_a, uv); }
// Premultiplied, optionally linear — the convolve boundary's IN pass.
vec4 sourcePremul(vec2 uv) {
  vec4 c = source(uv);
  vec3 rgb = linearize ? srgbToLinear(c.rgb) : c.rgb;
  return vec4(rgb * c.a, c.a);
}
vec4 blur_node(vec2 uv) {
  if (radius <= 1e-4) return source(uv);
  float sigma = radius * 0.5;
  // Fixed budget: the node uses up to 64 taps per side; 12 keeps the fused
  // form under 625 evaluations. Widen only when the upstream is cheap.
  int ht = int(min(12.0, max(1.0, ceil(sigma * 3.0))));
  vec2 px = 1.0 / u_res;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int y = -12; y <= 12; y++) {
    if (abs(y) > ht) continue;
    for (int x = -12; x <= 12; x++) {
      if (abs(x) > ht) continue;
      float w = exp(-float(x * x + y * y) / (2.0 * sigma * sigma));
      acc += sourcePremul(uv + vec2(float(x), float(y)) * px) * w;
      wsum += w;
    }
  }
  acc /= max(wsum, 1e-6);
  // The boundary's OUT pass: clamp negative coverage, un-premultiply.
  float a = max(acc.a, 0.0);
  vec3 rgb = a > 1e-5 ? max(acc.rgb, vec3(0.0)) / a : vec3(0.0);
  if (linearize) rgb = linearToSrgb(rgb);
  return vec4(rgb, a);
}
fragColor = blur_node(v_uv);
```

## Gotchas in translation

- Blurring **straight** RGB darkens transparent edges; the premultiply
  boundary above is what the node does and what the diff will show if you
  skip it (dark fringes → parity doc).
- Blurring in sRGB instead of linear shifts mid-tones; if `linearize` is
  on in the original, keep it on.
- A fused blur of a **hashed** upstream (noise, dither) reads `close`, not
  `match`: the taps land between the original's separable samples.
