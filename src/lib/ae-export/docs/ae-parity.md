---
title: Reading After Effects parity diffs
---

`compare_ae_renders` renders the built `.aep` with aerender at the plan's
frames and compares each with toolbox's own render at the same tick:
`A | B | heat` grid plus metrics, the same oracle as `compare_renders`.
Numbers first, diff shape second, the picture last.

## Fix the highest-ranked cause first

1. **A unit mismatch** — the diff is everywhere, shaped like the content
   (blur too soft or too sharp, a stroke too thick, a shape the wrong
   size). Usually an effect param's unit map (blur radius ↔ Blurriness),
   a `%` stroke width, or a width-relative radius. A param edit.
2. **A premultiplication fringe** — dark or light halos only on
   anti-aliased edges. aerender's TIFF output is premultiplied; the
   compare must unpremultiply. If it already does, it's a reader or
   plug-in bug: report it, don't edit the shader.
3. **A Y flip** — the shader region is mirrored top↔bottom. `v_uv` is
   Y-up in both places; a flip is a plug-in bug: report it.
4. **A gamma / working-space shift** — a uniform brightness or saturation
   offset across the whole frame, worst in midtones. Check the project's
   bit depth, working space and linear blending against what the report
   says the builder set.
5. **Color interpolation** — differences only mid-tween on keyed colors.
   That's OKLab vs RGB: switch that track's color policy to expression or
   dense keys.
6. **Easing shape** — position or value off mid-segment, exact on the
   keys. Editable fits are within 0.3%; use the Exact policy.
7. **Hash noise** — speckled differences in noise built from
   `fract(sin(x)·43758.5…)`. Both sides compile with fast math, so this
   should be near zero; if it isn't, check the installed plug-in is the
   fast-math build (`tbxshader-check --json` reports its version).
8. **LUT precision / edge fetches** — ≤ ~5e-4 on ramp channels, or a
   one-pixel border difference from `texelFetch` clamping.
9. **Text** — glyph positions shift with the font AE has installed. Text is
   `approx`; offer outlines when it must match.
10. **Blend modes at 8 / 16 bpc** — soft-light variants and clamping;
    32 bpc removes the clamping.

## Stop rules

- Stop on a match, after 4 rounds, or when a round doesn't improve any
  frame — and say which.
- Never call a bake a port: baked footage keeps the look and loses
  editability.
- Report approximations with the metric they settled at.
