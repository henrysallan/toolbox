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
- Bakes for now: animators, text on a path, a keyed text document
  (content, font, size…) and gradient or image fills. AE animators with
  Range Selectors and Path Options are the next wave.
- Variable-font axes: AE sets them only inside text animators, so the
  named instance is used (approx).
- Glyph metrics differ between toolbox's rasterizer and AE; offer outlines
  when the layout must match exactly.
