---
title: Noise — port the one algorithm `type` selects
type: noise
class: pure
---

Noise is a pure generator, but `NOISE_FS` (`src/nodes/source/perlin-noise.ts`)
holds **eleven** algorithms behind `u_type`. Port only the branch the
node's `type` param selects — `get_node_source("noise")` and copy that
function (plus its hash/permutation helpers) verbatim. The snippet below
gives the FRAME around it with a stand-in value noise that compiles; swap
`sampleNoise` for the ported branch.

## What the node does

```
uv = wired uv input ? texture(u_uvIn, v_uv).rg : v_uv
p  = (uv − 0.5) × scale;  p.y /= aspect        // cells stay square
p += offset + seedOffset + animOffset           // seedOffset = seed × (127.1, 311.7)
n  = fbm(p)   ∈ [−1, 1]  (W slice-blend, see below)
t  = clamp(0.5 + (n × 0.5 + 0.5 − 0.5) × contrast, 0, 1)
out = vec4(mix(colorA, colorB, t), alpha)
```

- `type = curl` is the exception: it outputs a signed vec2 packed as
  `v × 0.5 + 0.5` in RG (B = 0) — the map Displace reads with
  `midlevel 0.5`.
- fBm: up to 8 octaves, `amp *= persistence`, `freq *= lacunarity`,
  normalised by the amplitude sum.
- **W** (`w` param) is not 4D noise: integer slices are hashed to far-away
  XY offsets (`hashOffset(wi)`, `hashOffset(0) = 0`) and consecutive slices
  are smoothstep-blended. Two fBm evaluations when `w` is fractional.
- **Animated loop** (`animated`, `anim_start`, `anim_end`, `anim_rate`):
  `phase = ((frame − start)/(end − start)) mod 1`, `θ = 2π·phase`,
  `animOffset = rate × (cos θ, sin θ)` — a circle in noise space, so the
  loop closes exactly. `type = flow` sweeps `flow_time = θ` instead.
  `w` is forced to 0 while animated.
- The `uv` input (a `uv` socket) replaces `v_uv` — a frontier sampler in
  the fused node; read `.rg`.

## Param → channel

| param | channel |
|---|---|
| `type` | none — it selects the code you port |
| `scale` | `ch(…, 0.1, 64)` |
| `octaves` | `ch(…, 1, 8)` (float; compare with `float(i) >= octaves`) |
| `persistence`, `lacunarity` | `ch` |
| `offset_x`, `offset_y`, `seed`, `w`, `contrast`, `alpha` | `ch` |
| `color_a`, `color_b` | `color()` — use `.rgb` |
| `animated` | `toggle`; `anim_start`, `anim_end`, `anim_rate` → `ch` |
| `flow_time`, `phasor_*` | `ch`, only for those types (`phasor_orientation` is degrees → radians) |

## Fused form (frame + stand-in)

```glsl-body
// ch("scale", 4.0, 0.1, 64.0)
// ch("octaves", 4.0, 1.0, 8.0)
// ch("persistence", 0.5, 0.0, 1.0)
// ch("lacunarity", 2.0, 1.0, 4.0)
// ch("offset_x", 0.0, -10.0, 10.0)
// ch("offset_y", 0.0, -10.0, 10.0)
// ch("seed", 0.0, 0.0, 100.0)
// ch("w", 0.0, 0.0, 10.0)
// ch("contrast", 1.0, 0.0, 4.0)
// color("color_a", "#000000")
// color("color_b", "#ffffff")
// ch("alpha", 1.0, 0.0, 1.0)
// toggle("animated", false)
// ch("anim_start", 0.0, 0.0, 600.0)
// ch("anim_end", 120.0, 1.0, 600.0)
// ch("anim_rate", 1.0, 0.0, 10.0)
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
// STAND-IN value noise in [-1, 1]. Replace with the branch NOISE_FS
// selects for the node's `type` (cnoise / snoise / vnoise / os* / …).
float sampleNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}
vec2 hashOffset(float wi) {
  if (wi == 0.0) return vec2(0.0);
  return vec2(fract(sin(wi * 12.9898) * 43758.5453), fract(sin(wi * 78.2330) * 43758.5453)) * 1000.0;
}
float fbmAt(vec2 p) {
  float total = 0.0, amp = 1.0, freq = 1.0, maxAmp = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= octaves) break;
    total += sampleNoise(p * freq) * amp;
    maxAmp += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return total / max(maxAmp, 0.0001);
}
float fbm(vec2 p, float wv) {
  float wi = floor(wv), wf = wv - wi;
  wf = wf * wf * (3.0 - 2.0 * wf);
  vec2 o0 = hashOffset(wi);
  if (wf == 0.0) return fbmAt(p + o0);
  return mix(fbmAt(p + o0), fbmAt(p + hashOffset(wi + 1.0)), wf);
}
vec4 noise_node(vec2 uv) {
  vec2 seedOffset = vec2(seed * 127.1, seed * 311.7);
  vec2 animOffset = vec2(0.0);
  float wv = w;
  if (animated) {
    float period = max(anim_end - anim_start, 1.0);
    float phase = fract((u_frame - anim_start) / period);
    float theta = phase * 6.28318530718;
    animOffset = anim_rate * vec2(cos(theta), sin(theta));
    wv = 0.0;
  }
  vec2 p = (uv - 0.5) * scale;
  p.y /= u_aspect;
  p += vec2(offset_x, offset_y) + seedOffset + animOffset;
  float n = fbm(p, wv);
  float t = clamp(0.5 + (n * 0.5) * contrast, 0.0, 1.0);
  return vec4(mix(color_a.rgb, color_b.rgb, t), alpha);
}
fragColor = noise_node(v_uv);
```

## Gotchas in translation

- The aspect divide is on `p.y`, in `v_uv` space — this is NOT the
  `p`-space formula from the conventions doc (no 0.5 recentre); copy it as
  written or cells stretch.
- Seed and offset are added AFTER scaling, so changing `scale` slides the
  pattern; match the order.
- A stand-in algorithm will read `off` against the original no matter how
  well the frame is ported. Port the real branch before comparing.
- Hashed noise ported exactly still lands at `close` when the original ran
  through a later gather (taps fall between samples); alone it should
  `match`.
