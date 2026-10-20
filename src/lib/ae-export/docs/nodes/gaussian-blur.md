---
title: Gaussian Blur (legacy) → Gaussian Blur
type: gaussian-blur
class: effect
---

- The same map as `blur`: Blurriness = 1.7464 · radius.
- Legacy saves load with `linearize: off`, which Gaussian Blur 2 cannot do,
  so most legacy nodes fall back to shader.
