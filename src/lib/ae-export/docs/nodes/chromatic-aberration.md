---
title: Chromatic Aberration → shader
type: chromatic-aberration
class: shader
---

- AE has no flat-image chromatic aberration.
  - VR Chromatic Aberrations (`Mettle SkyBox Chromatic Aberrat`) is a 360°
    effect for equirectangular frames: field of view, frame layout, a point
    of interest on the sphere.
  - It is not toolbox's radial / directional channel offset (measured mean
    0.019 at its defaults, p95 0.094).
- Exports as a Toolbox Shader region (3-tap gather).
