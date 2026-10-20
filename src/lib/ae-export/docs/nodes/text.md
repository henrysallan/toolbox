---
title: Text → AE text layer
type: text
class: text
---

- Approximate. Font (PostScript name), size, tracking, leading, case,
  alignment and box map to a TextDocument; px at the working resolution
  are AE px.
- The AE machine needs the fonts installed; the report lists them.
- New text layers inherit AE's Character panel settings, so every
  attribute is set explicitly by the builder.
- Text on a path becomes Path Options with a mask path.
- Animators (type-on, opacity, position, scale, rotation, tracking, color)
  map to AE animators with a Range Selector; `field` drivers have no
  selector form and bake.
- Glyph metrics differ between toolbox's rasterizer and AE; offer outlines
  when the layout must match exactly.
