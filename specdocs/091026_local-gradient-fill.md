# Local gradient fill on Rasterize Spline (spec, 2026-09-10)

`fill_source: gradient` — each subpath fills with the ramp laid out as a
gradient inside its own frame, so Circle → Copy to Points → Rasterize
Spline gives every copy its own linear / radial / conic gradient instead
of one solid swatch per copy (`ramp`) or one gradient over the whole
canvas (a wired Gradient image with `fill_fit`).

## Problem

Ramp mode resolves one color per subpath (spline-color-source.ts). The
only way to get a gradient *inside* each copy today is to bake the
gradient before Copy to Points (image mode, which flattens) or to iterate
the instance. Both give up the living-geometry advantage the 071826
copy-identity spec relies on: splines survive CTP, so styling should
happen once, downstream, per copy.

## Decision (design Q&A, 2026-09-10)

Option 1 of three considered (CPU CanvasGradient per subpath; a GPU
local-UV layer that also fits any wired image per copy; and Copy to
Points stamping the copy's transform). Chosen because it drops into the
existing per-subpath fill loop, needs no new data on the subpath, and
works in every existing branch (flatten / layered / holes islands /
image-drives-stroke precolored fill). The local-UV layer stays open as a
follow-up and can reuse the frame helper this adds.

**Frame without new data.** Copy to Points does not record a copy's
rotation or scale on the subpath (only `driver` + gathered named point
attrs), so the frame is derived from the geometry, which is consistent
across copies because every copy is a transform of one instance:

- origin = mean of the subpath's anchors (affine-covariant; the same
  centroid `ramp_by: position` uses);
- `gradient_frame: shape` — the direction from the origin to the first
  anchor is "up", so `gradient_angle` 0 reads left→right on an unrotated
  Circle (its first anchor is the top) and the gradient rotates and
  mirrors with each copy; `gradient_frame: canvas` — the angle is in
  canvas space (every copy lit from the same direction);
- extent = min/max projection of the subpath's sampled outline (8 samples
  per cubic, closed for fill) on the axis, so the ramp's ends land on the
  shape's edge for any angle; radial uses the max distance from the
  origin; `gradient_scale` stretches the span about its middle (canvas
  pads beyond the ends).

**Ramp → CanvasGradient.** Stops come from `fill_ramp` and honor
`ramp_interp`: linear maps onto `addColorStop` at the stop positions,
`constant` doubles stops at each boundary (hard steps), `ease` subdivides
each interval (piecewise-linear smoothstep). `gradient_offset` slides the
ramp phase with the shared `offsetRampT` wrap (same as the stroke ramp
offset: a non-zero offset loops, and a ramp whose ends differ shows the
seam). Colors are sampled through `sampleColorRamp`, so the per-subpath
swatch and the gradient agree exactly at the stops.

**Per-copy variation reuses the driver vocabulary.** `gradient_vary`
(none / index / random / group / position / driver) × `gradient_vary_amount`
adds a per-subpath phase shift via `makeSubpathDriverFn`, reusing
`ramp_seed`, `ramp_angle` (relabelled "Position axis") and `driver_attr`.

Holes islands take the outer contour's frame. Gradient mode, like ramp,
always fills per subpath, so `stack_subpaths` / `fill_rule` hide.

Not covered: per-anchor color (a mesh gradient — triangulation + GPU) and
an explicit frame stamped by Copy to Points (add `copy_rot` / `copy_scale`
named attrs behind a toggle if a graph ever needs a frame the geometry
cannot give).

## Params (Rasterize Spline, visible when `fill_source = gradient`)

| param | type | default | notes |
| --- | --- | --- | --- |
| `gradient_kind` | enum linear / radial / conic | linear | |
| `gradient_frame` | enum shape / canvas | shape | rotation reference |
| `gradient_angle` | scalar −180..180 | 0 | linear axis / conic start; hidden for radial |
| `gradient_scale` | scalar 0.1..4 | 1 | span multiplier; hidden for conic |
| `gradient_offset` | scalar −1..1 | 0 | ramp phase, wraps |
| `gradient_vary` | enum none / index / random / group / position / driver | none | per-subpath phase |
| `gradient_vary_amount` | scalar 0..1 | 0.5 | phase shift × driver t |

Shared with ramp mode: `fill_ramp`, `ramp_interp`, `ramp_seed`,
`ramp_angle`, `driver_attr`.

## Code

- [engine/spline-gradient-fill.ts](../src/engine/spline-gradient-fill.ts) —
  `subpathGradientFrame` (origin / axis / extent / radius), `rampToGradientStops`,
  `makeSubpathGradientFn` (returns a `CanvasGradient` per subpath, or a
  solid `rgba()` string when the frame is degenerate). Engine-side so the
  export bundle keeps it (invariant #1).
- [rasterize-spline.ts](../src/nodes/effect/rasterize-spline.ts) —
  `makeFillStyleFn` wraps flat / ramp / gradient into one
  `string | CanvasGradient` resolver consumed by `drawSplineFlat`; the
  gradient params join both raster signatures under `fill_source = gradient`.
- [scripts/check-gradient-fill.mts](../scripts/check-gradient-fill.mts) —
  frame covariance (rotate / scale / mirror a shape and the frame follows),
  extent lands on the outline, stop conversion per interp + wrap seam,
  degenerate fallback, param declarations. In `npm run check`.

## Milestones

- **M1 — gradient fill source.** ✅ (2026-09-10) Everything above.
- **M2 (open) — local-UV layer.** `fill_fit: each` fits any wired image
  into every subpath's frame; the same frame helper feeds the UV bake.
