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

## Expressions

- A value graph wired into a property (Constant, Math, Clamp, Lerp, Remap,
  Compare, Logic, Switch with a constant index, Float Curve, LFO, Scene
  Time, Random, Split / Combine Vec2, the Vec / Color literals, the
  Expression node) becomes **one AE expression** on that property, live.
  It is the editor's arithmetic operation for operation, checked against
  toolbox at every frame of the layer before it is used; AE 26.5 computes
  the same doubles (*measured*: bit-identical but for the last bit of an
  occasional `sin` / `cos` / `log` / `pow`). Policy
  `drivers: "keys"` samples every driver to per-frame keys instead.
- The expression's clock is the layer's toolbox clock: `tick = time · fps
  · 1000` (snapped to the tick within 1e-6), minus the layer's clip
  offset when the layer sits in the main comp. Inside a precomp, `time` is
  already the precomp's.
- Random, **seeded** (the default): the editor's own hash of seed and
  frame — the same numbers. **Frame** mode re-rolls `Math.random()` every
  evaluation in the editor, so AE gets `seedRandom(seed, false);
  random()`: the same distribution, other numbers, stable across renders.
- The Expression node's `random()` is its own seeded mulberry32 per frame,
  as in the editor. Sources outside the math subset (strings, objects,
  loops, `Math.random()`, unknown names) are refused.
- Exposed knobs and group inputs inside the graph are their current value.
- Stays **per-frame keys** (the report says why): stateful nodes (Smooth,
  Accumulator, Sample & Hold, Trigger Envelope), audio analysis, anything
  reading geometry, images or points, a param keyed inside the graph, a
  wired Switch index, Math in uv mode, effect params whose map isn't
  linear, and a property that also reads a keyed param of its own.
- A graph that is constant over the layer exports as a static value. The
  expression text starts `// toolbox value graph` and names the nodes it
  came from; editing it in AE is fine.

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

## Controls

Exposed knobs become controls an AE user edits. There are two kinds of
knob: a Control-toggled param (the live-link / exported-app panel) and a
group or layer input promoted to its shell.

- Each knob is one Expression Control: scalar → Slider (Angle when the param
  is in degrees), boolean → Checkbox, enum → Dropdown Menu, color → Color,
  vec2 → Point. The control holds the **toolbox** value, the number toolbox's
  panel shows. The expression on each driven AE property converts it: ×W
  for px, ×100 for %, the pivot offset for Position, and so on. At rest the
  expression gives the property's own value.
- **Control-toggled knobs** go on one null named `Controls`, at the top of
  the main comp. Expressions in precomps read it as
  `comp("<main>").layer("Controls")`.
- **Promoted inputs** of a node-group or toolbox layer render that group as
  a precomp of its own. The precomp has its own `Controls` null, and those
  controls are in its Essential Graphics. So each precomp layer shows them
  under **Essential Properties**, and an override on one layer changes only
  that instance. All of this works headless (*measured*). A group that
  doesn't become a precomp (its output is a spline, say) puts its knobs on
  the main `Controls` null, named `<group> · <input>`.
- A param wired straight from a Constant knob reads that Constant's value
  (snapped to its step, as toolbox does). Other wires win over a knob.
- Only consumers that map natively link: shape geometry, fills and strokes,
  transforms (rotation, scale, anchor, position), a layer's opacity,
  calibrated effect params (affine maps; enums through a Dropdown), and
  Toolbox Shader sliders. A knob inside baked footage keeps the frames'
  value. A knob feeding a value graph is sampled. Structural params (a
  stroke on or off, gradient stops) don't link. The report says where each
  knob landed and why.
- A keyed knob keeps its keys and eases on the control. The driven property
  is static, plus the expression.
- The Dropdown Menu Control renames its match name when its menu is set, so
  its value is addressed `#1` (*measured*).
- AE's Color Control has no alpha: a knob's alpha stays on the driven
  opacity.
- Essential Properties can't see into a nested precomp. A promoted knob
  read deeper than the group's own precomp follows that comp's value, not a
  layer's override; the report says so.

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
- Toolbox and AE both centre (or right-align) a line without the letter
  spacing after its last glyph, so the box needs no shift. (Before
  2026-10-21 toolbox's plain text kept that gap and the builder shifted it.)
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
