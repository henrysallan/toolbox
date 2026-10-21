---
title: Text → AE text layer (+ animators, Path Options)
type: text
class: text
---

- Approximate (glyph metrics). Font (PostScript name), size, tracking,
  leading, case, alignment and box map to a TextDocument; px at the working
  resolution are AE px. The AE machine needs the fonts installed; the report
  lists them.
- Tracking is an integer in −1000…1000 (AE's limit). Letter spacing past it
  becomes a px Tracking animator. Plain text is shifted by toolbox's trailing
  letter spacing (½ of it centred): toolbox's fast path centres with it, AE
  without.
- **Keyed document**: size, spacing, leading, weight, box, stroke width →
  Source Text hold keys at toolbox's keys, or one per frame while a number
  moves. `text` is not keyframable in toolbox. **Keyed colour** → a Fill
  (Stroke) Color animator with the colour track and its OKLab expression.
- **Animators** → one AE text animator each, with a "base" animator when the
  min is not the property's rest. Type On → Opacity 0; Opacity → Fill (+
  Stroke) Opacity, so the two multiply like toolbox's alpha; Position /
  Scale / Rotation / Tracking (px, After) / Fill Color. Based On → characters
  or words.
  - Linear cascade (every direction but random) → a Range Selector in index
    units, the amount on Offset: **exact**. Center / edges use two Range
    Selectors, Min / Max.
  - Eased cascade → Ease High / Low when within 0.5 % (smoothstep exact;
    sine, circ, quad within 0.25 %). Otherwise, and for random order → an
    Expression Selector that replays toolbox's formula: **exact**. Its Amount
    holds the amount keys.
  - Tracking by word → an Expression Selector over characters that reads
    toolbox's words from the text (AE's Words skip the spaces, toolbox's
    word owns the space after it).
  - Uniform driver → a Range Selector over everything, Amount = the drive.
  - Overshooting easings (back, elastic) put the overshoot in the
    property's value, since AE clamps a selection to ±100 %.
  - Field drivers, and a keyed softness / direction / seed / easing, bake.
- **Pivot**: toolbox scales and rotates about the glyph's middle; a "Pivot"
  animator moves AE's baseline anchor there. Word-based ones use Anchor
  Point Grouping: Word. Mixing character- and word-based scale or rotation
  bakes.
- **Text on a path** → mask (mode None) + Path Options: align → justification,
  offset × arc length → First / Last Margin (keyed if either moves), flip →
  Reverse Path, side → baseline shift. A multi-subpath spline bakes. Text
  past a path end: toolbox stacks it on the end, AE continues straight.
- Gradient or image fills, and variable axes driven by a mask, bake.
- Glyph metrics differ between toolbox's rasterizer and AE; offer outlines
  when the layout must match exactly.
