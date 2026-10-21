---
title: Copy to Points → Repeaters or one layer per copy
type: copy-to-points
class: instances
---

The exporter evaluates every copy the way the node draws it (the point ×
the modulation, the tint and opacity attributes, the variant pick, the draw
order) and then picks a form.

- **Repeaters** (one shape layer, editable) when all of these hold:
  - the copies are static and sit on a lattice: a Grid, an Array in point
    mode, or any points that step regularly, row- or column-major, along
    any two step vectors (a tilted lattice works);
  - every copy has the same rotation and scale, and there is one variant
    and no tint;
  - the instance renders as one plain shape layer.

  The copy transform (point rotation / scale × `scale_mul` /
  `rotate_add`) becomes the instance group's transform, with one Repeater
  per axis, fast axis inside and later copies on top. An opacity that is
  exactly linear along each axis (`inner(col) · outer(row)`) rides the
  Repeaters' Start / End Opacity. AE's Repeater Scale compounds per copy
  about a fixed point, so a per-copy scale is never a Repeater.
- **Exploded** otherwise. Each variant collapses into one precomp, and each
  copy is one layer of it:
  - anchor = the variant's anchor. For an image instance, `custom` is a
    fraction of the instance image; `content center` uses the spline's
    bounds, which is approx (toolbox reads alpha bounds at ≤ 128 px).
  - position = the point;
  - rotation / scale = the point's × the modulation;
  - opacity = `opacity_attr` × 100;
  - `tint_attr`: a **Fill** effect (its colour × the tint) on a
    flat-coloured instance, else a **Channel Mixer** (R-R / G-G / B-B =
    100 · tint).
- **Stacking** is toolbox's order: variant-major (all of variant 1, then
  2…), then `draw_order` (points order, by y, shuffled).
- **Variants** come from a Combine (`collect`) in image mode, one precomp
  per item. Every pick mode is replayed with the node's own code: all,
  random, cycle, by index, target group, attribute, and image with a static
  pick field. Another image group as the instance bakes.
- The **layer budget** (default 200) counts copy layers. Past it the node
  bakes; "Keep procedural" explodes anyway, with a warning.
- **Time**:
  - keyed `scale_mul_default` / `rotate_add_default` over static points →
    each copy's Scale / Rotation keys, converted from the track (the
    authored eases);
  - anything else animated (the points, Stagger phases, a timed Point
    Expression, wired modulation, attributes) → each copy's values at every
    frame, with linear stretches merged (exact at frames);
  - a pick that changes over time → one layer per variant a point uses,
    shown by HOLD opacity keys;
  - a point count or draw order that changes over time **bakes**, because
    AE can't reorder layers over time.
- **Fields**: a static `scale_field` / `rotate_field` / image pick is
  sampled per copy at export from the editor's readback
  (`AeSceneOptions.fieldPixels`). Image mode uses the shader's bilinear R
  sample; spline mode runs the node's own compute on that readback. An
  animated field, or no readback, bakes. `driver_field` does nothing in
  image mode; in spline mode it bakes.
- Points computed from an image upstream bake, because the walk's evaluator
  has no pixels. Examples: Scatter density, Set Named Attribute from an
  image.
- Spline mode copies are paths: Repeaters on the same lattice rule, else
  the evaluated geometry.
- Point rotation fields are radians in toolbox; AE gets degrees. Toolbox
  has no radial point generator.
