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
- Text animators, text on a path, keyed text documents and gradient or
  image fills bake for now.

## SDF chains

- **SDF space is Y-up**, unlike canvas01: the compiled shader samples
  `p = v_uv` with y rescaled about 0.5 (*measured*: a circle at y 0.3 renders
  0.2·W *below* the centre). `X = x·W`, `Y = H/2 − (y − 0.5)·W`, lengths
  `·W`; a positive SDF rotation turns counter-clockwise on screen, so AE's
  rotation is `−degrees`.
- A **hard** chain under `sdf-rasterize`, `sdf-to-mask` or `sdf-to-spline`
  exports as one shape layer (the rules: `sdf-chain.ts`; per-family notes:
  `ae-nodes/sdf-rasterize`, `sdf-circle`, `sdf-union`, `sdf-translate`):
  - primitives → parametric Ellipse / Rect / Polystar (a line segment is a
    capsule Rect; a triangle a Path);
  - union / intersection / subtraction → Merge Paths Add / Intersect /
    Subtract, one group per operand in tree order. Subtract keeps the
    **first** operand in the group and removes the ones after it
    (*measured*);
  - round and onion are offsets, pushed onto the leaves: an offset
    distributes over min / max and flips sign under a subtracted side.
    Circle, rect, capsule and polygon grow parametrically (polySdf is an
    edge-line distance, so its offsets keep sharp corners); star and triangle
    get Offset Paths, Round join; onion(X) = X grown by t minus X shrunk by t;
  - translate / rotate / scale → group transforms (nearest the leaf =
    innermost); mirror → the kept half (an Intersect with the half-plane when
    the shape crosses the line) plus its reflection; repeat → a Repeater per
    axis over the cell (clipped where the shape overflows it; a bounded
    repeat's edge copies keep their overflow); polar → a Repeater turning
    360°/n about the centre over the wedge.
- What keeps the **shader** route: smooth booleans (except at smoothness
  ≤ 0), displace, twist, morph, per-pixel scalar fields (polygon sides,
  rotation angle), repeat jitter, `sdf-spline` / `sdf-from-image`
  (per-eval distance textures), per-shape materials under a rasterize, and
  the shading consumers (`sdf-shade`, `sdf-bevel`, `sdf-to-distance-image`).
  Under `sdf-to-spline` such a chain bakes (its contour is traced on the GPU).
- `sdf-rasterize`: Fill = foreground, a centred Stroke 2·contour_width px =
  the contour, a comp-sized Rect = the background. Toolbox's edge is
  `smoothstep` across ±max(softness, 0.5) px of the distance; AE's
  coverage anti-aliasing is a 1-px box, so a softness ≥ ~0.75 px becomes a
  Gaussian Blur 2 on the fill layer over its own background layer
  (Blurriness = √(soft²/5 − 1/12) / 0.2858).
- Toolbox **replaces** the background under a translucent fill (a mix, not
  an over): with fg_alpha < 1 the background is knocked out under the shape.
- `sdf-to-mask` is white on black (a luma matte where it masks);
  `sdf-to-spline` is its tree's exact outline as geometry — toolbox traces it
  on a resolution² grid of the [0, 1]² SDF square, so the clip to that square
  is kept.

## Instances

- Copy to Points copies are evaluated as toolbox draws them, then exported
  in one of two forms:
  - **Repeaters**: static copies on a regular lattice, identical but for
    position, of one plain shape instance;
  - **exploded**: one precomp per variant, one layer per copy, up to the
    layer budget (default 200).
- Copy layers stack variant-major, then by `draw_order`, as toolbox packs
  them.
- Per copy: position, rotation, scale and opacity on the layer transform.
  `tint_attr` becomes a Fill effect (flat instance) or a Channel Mixer.
- A Repeater carries an opacity ramp only when it is exactly linear along
  each axis (opacities multiply across nested Repeaters). AE's Repeater
  Scale compounds per copy, so a per-copy scale always explodes.
- Animated copies are keyed every frame with linear stretches merged.
  Keyed `scale_mul_default` / `rotate_add_default` keep their eases. A pick
  that changes over time uses HOLD opacity per variant.
- These bake: a changing point count, a draw order that changes over time,
  animated image fields, and points computed from an image upstream.
- Static image fields are sampled at export from the editor's readback.
- Array in spline mode becomes Repeaters; toolbox has no radial array.

## ExtendScript

- AE 26.5's ExtendScript reads `a ? x : b ? y : z` as
  `(a ? x : b) ? y : z` (*measured*). Never nest ternaries in `.jsx`.
