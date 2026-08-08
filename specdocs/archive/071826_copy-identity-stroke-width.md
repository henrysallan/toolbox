# Per-copy identity + per-subpath stroke width (spec, 2026-07-18)

The "right side" half of per-copy variation for Copy to Points. Companion
spec: [071826_iterate-node.md](071826_iterate-node.md) (the "left side" —
bounded variants of a subgraph for generator-param randomization).

## The two-sided model (context)

Where per-copy variation can happen depends on where the instance gets
rasterized relative to Copy to Points:

- **Images** are baked *before* CTP and flattened *by* it — variation must
  happen upstream (variants → the Iterate node spec) or at stamp time (the
  existing shader modulation block).
- **Splines / points** survive CTP as living geometry. Every copy persists
  until Stroke / Fill / Rasterize Spline, so variation can happen
  *downstream*, per copy, continuously (no variant-count bound), cheaply
  (CPU spline math). The pieces already converging on this: Modulate
  Splines (per-subpath transforms via fields — its header literally names
  the drop-after-CTP pattern) and spline-color-source (per-subpath color
  by `index | random | group | position` at raster time).

What's missing downstream is **identity**: nothing records which copy a
subpath came from.

## Problem: one tag, two meanings

`SplineSubpath.groupIndex` / `Point.groupIndex` is the only per-item
identity channel. CTP currently *preserves the instance's* tags on its
output. Copy a 3-subpath instance (body/torso/head tagged 0/1/2) to 5
points and the 15 output subpaths read `0 1 2 0 1 2 …` — they answer
"which part is this?", never "which copy is this?". Downstream "by group"
styling stripes by part when the user wanted per-snowman variation. Only
the lucky single-subpath-instance case works today (subpath i *is* copy
i, so `by: index` coincidentally keys by copy).

## Design

### 1. `output_tag` on Copy to Points (spline + point modes)

One enum param, no type-system changes:

- **instance groups** (default) — today's behavior verbatim: preserve the
  instance's groupIndex. Missing param on old saves resolves here, so
  back-compat is automatic; no schema bump.
- **copy index** — every subpath/point emitted for target point `i` gets
  `groupIndex = i`. "By group" downstream now literally means "by copy".
  Keyed on the target point's own index (not emission order), matching
  the pick machinery's convention — draw-order changes never reshuffle
  identity.
- **target group** — copies inherit the *target point's* groupIndex.
  Scatter onto grouped points (e.g. two Combined scatters) and copies
  carry the group of the point they landed on.

Deliberately **not** a second `copyIndex` field on Subpath/Point: a new
field would need every downstream consumer to grow a "by copy" mode,
while retagging makes all existing groupIndex machinery (spline-color-
source `group`, Select by Index, Count Indices, Group Pick, Modulate
Splines) work unchanged. Revisit a second field only if a real graph
needs "part within copy" *and* "copy" simultaneously.

Inherited attributes beyond identity (the target point's position, a
field sampled at it) are intentionally NOT stored: a copy's centroid ≈
its target point position, and the existing centroid-keyed drivers
(`position` mode, Modulate Splines' field sampling) already recover them
downstream to visual accuracy.

### 2. Per-subpath stroke width (`thickness_source: vary`)

Stroke gains the same per-subpath sourcing its color just got, applied to
thickness. Param block mirrors the color block:

- `thickness_source`: `uniform | vary` (segmented; default `uniform` =
  legacy).
- `thickness_by`: `index | random | group | position` (default `random`).
- `thickness_seed` (random), `thickness_angle` (position) — same
  visibility rules as the color block.
- `thickness_lo` / `thickness_hi`: multipliers on the base `thickness`,
  driver t maps linearly lo→hi. Defaults 0.5 / 1.5 (the house convention
  — CTP's scale_field lo/hi use the same balanced range).

Engine side: extract the driver-t resolution out of `makeSubpathColorFn`
into a shared `makeSubpathDriverFn(subpaths, {by, seed, angleDeg})` in
[spline-color-source.ts](../../src/engine/spline-color-source.ts) — one
resolver for color, width, and any future per-subpath channel.
`makeSubpathColorFn`'s API is unchanged (uses the driver internally).

Node side: `vary` forces the per-subpath stroke loop (the per-ring
`subPaths` Path2D list already exists for per-subpath color); Canvas
`lineWidth` is set per subpath, `≤ 0` skips (Canvas ignores lineWidth 0).
Composes with Repeats: per-subpath multiplier stacks on the per-ring
thickness curve. Dotted style inherits it as per-subpath dot size. The
raster signature cache gains the five params (gated on `vary`, same
pattern as the color entries).

### The composed recipe this unlocks

Circle → Copy to Points (`output_tag: copy index`) → Stroke
(`color_source: ramp by group`, `thickness_source: vary by random`):
every copy its own color *and* its own stroke weight — continuous,
seeded, no variants, no upstream re-evaluation.

## Out of scope (future)

- **`field` driver mode** (sample an image at the subpath centroid) for
  color/width — the driver fn would take an optional sampler; the nodes
  would grow a conditional image input. Modulate Splines covers
  field-driven *transforms* today.
- **Fill side**: Rasterize Spline's fill already shares the color source;
  it has no width. Nothing to do.
- Per-copy identity for image mode — impossible by construction (copies
  are flattened); that's the Iterate spec's territory.

## Milestones

1. **Retag.** `output_tag` on CTP (spline + point modes). Verify: snowman
   instance to 5 points, Stroke ramp `by: group` → 5 solid-colored
   snowmen with `copy index`, striped parts with `instance groups`.
2. **Width.** Driver extraction + Stroke thickness block. Verify: vary by
   random reshuffles with seed; lo=hi=1 is pixel-identical to uniform;
   works with Repeats and dotted.
