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

## ExtendScript

- AE 26.5's ExtendScript reads `a ? x : b ? y : z` as
  `(a ? x : b) ? y : z` (*measured*). Never nest ternaries in `.jsx`.

## 3-D

- A 3D Scene (`scene-render`) rebuilds natively when every object is an
  Import 3D model (optionally under Transform 3D) or a light, and the camera
  is a Camera node or none. It becomes a 3-D precomp on the Advanced 3D
  renderer, placed as one 2-D layer where the render was. Otherwise the whole
  render bakes, and the report says why: fog, the room environment, depth of
  field, primitives or materials, an STL, or a picked file object.
- Units (*measured*): an AE model layer draws 512 px per glTF / toolbox
  world unit, and glTF `(x, y, z)` becomes AE `(x, −y, −z)`. The world origin
  sits at the comp centre. Rotations map per axis: X = rot_x, Y = −rot_y,
  Z = −rot_z. AE's rotation is Rx·Ry·Rz like three's 'XYZ' Euler, so this is
  exact.
- Camera: Position = the camera position, Point of Interest = its target,
  Zoom = (H/2)/tan(fov/2). Framing matches toolbox within 0.06 px
  (*measured*). AE has no orthographic camera: one 2·10⁵ px away with a
  matching zoom stands in (approx).
- Lights (approx): directional → Parallel, point → Point, spot → Spot
  (Cone Angle = 2·angle, Feather = 100·penumbra), ambient → Ambient. Advanced
  3D lights in the encoded working space (*measured*): AE is linear in N·L,
  toolbox goes through the sRGB encode, so no intensity matches everywhere.
  Intensity is the least-squares match (100 · 1.16 · encode(I/π)). Point and
  spot lights use Inverse Square Clamped with Radius 512 px, matched at the
  camera target's distance.
- Materials: AE renders the model file's own PBR materials. Toolbox's plain
  Import 3D shows three's default white material today.
- Keyed TRS, camera and light params become keys (separated X / Y / Z
  position where the axes key apart). FOV and intensity keys are sampled per
  frame, because their maps are not affine.
- Headless builds: a project saved right after importing a model can keep a
  broken model item (it renders transparent). The builder pauses before saving
  (*measured*).
- The startup project may be OCIO-managed (AE's sticky last-project
  setting), which refuses 16 bpc. The builder switches it to Adobe colour
  management first (`colorManagementSystem` 0).
