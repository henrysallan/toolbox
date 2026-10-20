---
title: After Effects conventions — units, time, alpha, color
---

What a toolbox value becomes in After Effects. All of it is already done
for you by the exporter (`src/lib/ae-export/convert/`); read this to
explain a mismatch, not to redo the math. Numbers marked *measured* were
read back from AE 26.5 (spec 091926_after-effects-handoff.md §13).

## Space

- Toolbox authors in canvas01: Y-down, width-relative. AE is Y-down
  pixels. `x_px = x·W`, `y_px = H/2 + (y − 0.5)·W`. Exact.
- Width-relative radii and stroke widths are `·W` px on both axes. Stroke
  `px` units pass through; `%` is `·W/100`.
- `uv01` / `v_uv` (Gradient, GLSL) is **Y-up**: `(x, 1 − y_raster)`. The
  one inversion to watch.
- Angles on the layer transform are degrees, clockwise on a Y-down screen.
  Toolbox `sample-along-path` angles and `copy-to-points` rotations are
  radians.

## Transforms

- A Transform node is an AE layer transform: `anchorPoint = pivot_px`,
  `position = pivot_px + translate_px`, `scale = [sx, sy]·100`,
  `rotation = degrees`. Same operation order as toolbox, so non-uniform
  scale under rotation matches.
- `space=local` pivots resolve against the geometry's bounding box. If that
  box animates, the anchor is keyed per frame.
- Gizmos become null layers; a wired transform chain becomes `layer.parent`.
- AE's Scale is a 3-D property even on a 2-D layer (*measured*); the
  builder pads eases and values.
- Independent X / Y tracks export as separated dimensions.

## Time

- Toolbox time is integer ticks, 1000 per frame. AE keys are seconds:
  `t = tick / 1000 / fps`.
- Keys are written in the containing comp's time, even on a layer with a
  non-zero `startTime` (*measured*).
- Layer clip windows become `inPoint` / `outPoint`; the layer-local clock
  offset becomes `startTime`. Several windows become one AE layer each.
- The Toolbox Shader effect's clock is layer time × Time Speed + Time
  Offset (equal to comp time for layers that start at 0).

## Easing

- **Editable** (default): one AE segment per toolbox segment. Exact for
  linear, quad, cubic, back (exact cubics), hold, `customBezier` and
  `cubicBezier`. Best-fit cubics elsewhere: in-out quad 0.30%, in-out
  cubic 0.26%, sine ≤ 0.008%, expo 0.0975% (a floor: `easeOf` jumps by
  2⁻¹⁰ next to the key).
- **Exact**: adds keys — midpoint keys make in-out quad/cubic exact;
  elastic drops to 0.049% with 10 keys.
- Bounce is exact as 5 keys; elastic is 8 keys (0.117%) under Editable.
- Springs become per-frame keys, exact at frames only.
- AE's minimum influence is 0.1%: a `cubicBezier` handle sitting on its key
  costs ~3e-4.

## Color

- Toolbox interpolates keyed colors in **OKLab** (default) or RGB; AE always
  interpolates RGB. A red→blue tween differs badly at the midpoint.
- Policy `auto` (default): an OKLab-lerp **expression** on shape / solid
  colors (exact, two keys, not graph-editable), **dense keys** within
  2/255 elsewhere (red→blue 63 keys, orange→teal 56, black→white 9).
  `rgb` accepts AE's interpolation and reports the worst ΔE.
- An 8-digit hex color's alpha rides a separate opacity track.
- Ramps are sampled into gradient stops within 1/255; `srgb` ramps map 1:1.
- The builder sets the project's color settings explicitly (bit depth,
  sRGB working space, linear blending off) and the report says which.

## Alpha

- Toolbox composites straight alpha. AE hands effects **straight** pixels
  and expects straight ones back (*measured*); its compositing is
  premultiplied internally, so anti-aliased edges of blended layers can
  differ by a sub-pixel amount.
- aerender's "TIFF Sequence with Alpha" writes **premultiplied** pixels.
  Unpremultiply before comparing with toolbox frames.

## Effects, masks, mattes

- Built-in effect params are addressed as `<match>-<4-digit position>`
  (`ADBE Gaussian Blur 2-0001`); third-party params as
  `<match>-<4-digit disk ID>` (`TBX Shader-0020`) (*measured*).
- A layer param (`PF_Param_LAYER`) is set by layer index; AE then follows
  the layer, not the index.
- Merge's per-layer matte is an AE luma track matte set by reference
  (`setTrackMatte`, AE 23+). The universal `mask` input becomes the
  effected layer, matted, over an un-effected copy — exact by construction.
- An effect's Compositing Options mask follows the mask's mode: Add = effect
  inside, Subtract = outside, **None is ignored**, and a referenced mask
  stops masking the layer (*measured*). Effect-only masks are mode Add.
- 24 of toolbox's 29 blend modes exist in AE. Average, Negation, Reflect,
  Glow and Phoenix don't: those regions become shader regions or bakes.

## Gradients

- AE scripting can't set gradient stop colors. The verified route is an
  SVG imported as cropped shape layers (native, editable Gradient Fills);
  a synthesized `.ffx` preset also exists but only applies inside the AE
  app, not headless.
- Animated gradient stops can't be scripted at all: shader region or bake.

## Text

- Text becomes an AE text layer. Fonts are PostScript names and must be
  installed on the AE machine; the report lists them.
- New text layers inherit AE's Character panel settings, so the builder
  sets every attribute explicitly.
- Glyph metrics differ between toolbox's rasterizer and AE, so text is
  `approx`.
