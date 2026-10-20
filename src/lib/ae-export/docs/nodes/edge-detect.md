---
title: Edge Detect → shader
type: edge-detect
class: shader
---

- Not Find Edges: AE's Find Edges is not a Sobel / Prewitt magnitude.
  - Measured on noise: mean 0.063 with Invert on, 0.79 without.
  - A hard-edged disc looks close, but only because it is mostly flat.
- Exports as a Toolbox Shader region (9-tap gather).
