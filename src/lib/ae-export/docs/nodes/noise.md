---
title: Noise → Toolbox Shader effect (its own shader)
type: noise
class: shader
---

- Alone in its shader region (the plan marks it `kernel: "node"`), Noise
  exports as a Toolbox Shader effect running **Noise's own fragment
  shader** — no fused GLSL Expression, no "Convert with Claude" step.
- The effect's controls are Noise's params, labelled as in toolbox:
  Scale, Octaves, Persistence, Lacunarity, Offset X / Y, Seed, W
  (Evolution), Animated, Start / End (frame), Rate, Contrast, Color A / B,
  Alpha, plus Flow Time (flow) or Frequency / Orientation (deg) /
  Isotropy (phasor). A keyed param keeps its keys; a wired one becomes an
  expression or per-frame keys.
- `type` is baked into the shader (the plug-in has no popups). A keyed or
  wired `type` bakes the region instead.
- The looping evolution runs inside the shader from the plug-in's frame
  (`u_frame`, the layer's own clock), so Animated / Start / End / Rate stay
  live in AE.
- The node's mask becomes the layer's mask or track matte; its Opacity is
  the layer's Opacity.
- A wired UV input becomes Layer A. A value wired into UV (the
  constant-UV mode) bakes.
- In a larger region (Noise → Color Ramp → Displace) the region still
  needs a fused GLSL Expression (`opts.fused`), or it bakes.
- Fractal Noise is a look-alike, not a port.
