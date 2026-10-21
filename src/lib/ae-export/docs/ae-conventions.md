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
  offset becomes `startTime`. Windows on one clock emit straight into the
  main comp; windows on different clocks become one precomp, placed once
  per window with that window's start time.
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
- Position, color and path keys have one ease for all dimensions, and AE
  never plays them past their keys: a negative speed is stored as 0 and an
  over-long handle is shortened (*measured*). Back and elastic on those
  become per-frame keys. Per-dimension eases overshoot freely.

## Color

- Toolbox interpolates keyed colors in **OKLab** (default) or RGB; AE always
  interpolates RGB. A red→blue tween differs badly at the midpoint.
- Policy `auto` (default): an OKLab-lerp **expression** on shape / solid
  colors (exact; it sits on the track's own keys, which stay editable),
  **dense keys** within 2/255 elsewhere (red→blue 63 keys, orange→teal 56,
  black→white 9). `rgb` accepts AE's interpolation and reports the worst
  ΔE; a segment AE can't play within tolerance (an in-out cubic, whose fit
  dips below 0) still goes dense.
- AE solids can't key their color, so a keyed solid color becomes a
  comp-sized rectangle shape layer.
- One-ease color speed is in 0–255 units per second (*measured*).
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

- Effect params are addressed as `<match>-<4-digit param ID>`: the ID, not
  the param's position in Effect Controls, for built-ins
  (`ADBE Gaussian Blur 2-0001`) and third-party effects alike
  (`TBX Shader-0020`) (*measured*).
- AE hands a shape or text layer's effects a buffer cropped to its content;
  toolbox filters frame-sized images. Effects therefore go on a comp-sized
  precomp of the layer.
- Echo and Displacement Map read their layer's source frames and ignore
  effects earlier on the layer, so their inputs are precomposed.
- Some nodes are two AE effects on one layer (Posterize = Levels, then
  Posterize; Threshold = a Channel Mixer, then Threshold). The per-node docs
  (`ae-nodes/<type>`) give each map and its measured error.
- A layer param (`PF_Param_LAYER`) is set by layer index; AE then follows
  the layer, not the index.
- Merge's per-layer matte is a track matte set by reference
  (`setTrackMatte`, AE 23+): Luma when the mask is an image (luma × alpha),
  Alpha when it's a spline; `maskInvert` gives the Inverted type.
- The universal `mask` input: a spline mask on an AE effect becomes that
  effect's Compositing Options mask, on one layer. An image mask makes the
  effected layer, luma-matted, over an un-effected copy — exact by
  construction.
- An effect's Compositing Options mask follows the mask's mode: Add = effect
  inside, Subtract = outside, **None is ignored**, and a referenced mask
  stops masking the layer (*measured*). Effect-only masks are mode Add.
- 24 of toolbox's 29 blend modes exist in AE. Average, Negation, Reflect,
  Glow and Phoenix don't: those regions become shader regions or bakes.

## Gradients

- AE scripting can't set gradient stop colors directly. The route depends
  on the gradient's structure; both are verified in AE 26.5:
  - **SVG seed** (default): gradient groups at the top of a shape layer,
    holding only static paths with flat or gradient fills and plain
    strokes, move into an SVG imported as cropped shape layers: native,
    editable Gradient Fills. The rest of the layer stays native underneath.
    Works headless and in the app.
  - **`.ffx` preset**: gradients in composed contents (modifiers, group
    transforms, keys, dashes). A synthesized preset is applied to the
    gradient's Colors; stops land within 2/255 (*measured*). Needs the AE
    app build: aerender hangs on `applyPreset`, so a headless build shows
    AE's default gradient and the report says so.
- A Gradient node (2-stop linear or radial) is Gradient Ramp on a solid.
- Animated gradient stops can't be scripted at all: shader region or bake.

## Text

- Text becomes an AE text layer. Fonts are PostScript names and must be
  installed on the AE machine; the report lists them.
- New text layers inherit AE's Character panel settings, so the builder
  sets every attribute explicitly.
- Glyph metrics differ between toolbox's rasterizer and AE, so text is
  `approx`.
- A document's tracking must be an integer in −1000…1000: AE refuses
  anything else (*measured*). Letter spacing past that rides a px Tracking
  animator. An animator's Tracking Amount is **px**, not 1/1000 em.
- Plain toolbox text centres a line *with* its trailing letter spacing; AE
  and toolbox's per-glyph (animated) text centre it without. The builder
  shifts plain text by that much.
- Keyed size, spacing, leading, weight or box → Source Text hold keys, one
  per frame while a number moves (AE can't tween a TextDocument). A keyed
  colour → a Fill Color animator carrying the colour track.
- Text animators → AE text animators, one per toolbox animator (plus a
  constant "base" animator when min is not the property's rest). AE stacks
  them *measurably*: Position, Anchor Point, Rotation and Tracking add;
  Scale multiplies; Opacity, Fill Opacity and colours move from the value
  so far toward the animator's by the selection. Opacity × Fill Opacity
  multiply, so Type On is Opacity and the Opacity animator is Fill (+
  Stroke) Opacity.
- The selector (*measured*: AE's Range Selector is lottie's model — ramps
  sampled at each unit's centre, Ease High / Low a bezier on the ramp):
  - a linear cascade is a Range Selector, exactly. Forward / backward is one
    Ramp; center / edges are two combined by Min / Max. Units are index (no
    ±100 % limit), and the amount keys go on Offset.
  - an eased cascade uses Ease High / Low when the fit is within 0.5 %
    (smoothstep exactly; sine and circ ≈ 0.04 %). Otherwise it's an
    Expression Selector replaying toolbox's formula exactly, with the amount
    keys on its own Amount (read as `value`).
  - `random` is always an Expression Selector: AE's Randomize Order permutes
    the units, toolbox hashes each one.
  - Tracking by word is an Expression Selector over characters that reads
    toolbox's words from the layer's text: AE's Words leave the spaces out,
    and toolbox's word owns the space after it (*measured*).
  - field drivers bake.
- Vertical metrics are per font (*measured*): toolbox's canvas "middle"
  sits 0.26–0.32 em above the baseline (not the hhea midpoint), and AE's
  first box-text baseline sits at about the typo ascender below the box top.
  Measured fonts: Arial, Helvetica, Times New Roman, Courier New, Georgia and
  Menlo; others use Inter's values.
- Toolbox scales and rotates a glyph about its middle; AE uses its baseline.
  A "Pivot" animator sets Anchor Point and Position to the same offset
  (an Anchor Point alone moves the glyph). Word-based ones set Anchor Point
  Grouping to Word.
- Text on a path → the spline as a mask (mode None) + Path Options:
  start / center / end → left / centre / right, offset × arc length →
  First Margin (Last for end), flip → Reverse Path, side → baseline shift
  (toolbox centres the glyph's middle on the path, AE its baseline). Past a
  path end toolbox stacks glyphs on the end point; AE continues straight.
- Gradient or image fills, variable axes driven by a mask, and text on a
  multi-subpath spline bake.

## ExtendScript

- AE 26.5's ExtendScript reads `a ? x : b ? y : z` as
  `(a ? x : b) ? y : z` (*measured*). Never nest ternaries in `.jsx`.
