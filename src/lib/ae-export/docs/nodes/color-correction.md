---
title: Color Correction → Brightness & Contrast + Hue/Saturation
type: color-correction
class: effect
---

- Two effects, in toolbox's order:
  1. **Brightness & Contrast**, Use Legacy on.
     - Brightness = 255 · b.
     - Contrast = 100 · (1 − 1/k) for k ≥ 1, 100 · (k − 1) below. Legacy
       contrast scales about 0.5 by 1/(1 − c/100) or 1 + c/100.
  2. **Hue/Saturation**: Master Hue = hue °.
- Measured: mean ≤ 0.009 (hue, brightness + contrast, all three together).
- **Falls back to shader** for:
  - saturation ≠ 1 (toolbox scales HSV saturation, AE's Master Saturation is
    HSL-based; measured off);
  - the lift / gamma / gain / offset wheels, temp / tint, pivot ≠ 0.5,
    midtone detail, black offset;
  - the RGB curves (Curves is CUSTOM_VALUE: not scriptable).
