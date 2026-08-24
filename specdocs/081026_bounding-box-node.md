# Bounding Box node (2026-08-10)

Measure the axis-aligned bounding box of anything wired in — image, mask,
spline, or points — and expose the box every way downstream work wants it:
individual scalar edges, midpoint/corner point sockets, the rectangle as a
spline, and optional full-canvas guide lines.

## Design

- **Type / placement:** `bounding-box`, name "Bounding Box", category
  `utility`, file `src/nodes/effect/bounding-box.ts`. `noMaskInput` (no
  image output).
- **Input:** single polymorphic `source` socket, resting type `image`,
  retyped from `connectedTypes` via `resolveInputs` — the Transform /
  Displace pattern. `editorCanCoerce` gets the matching exception so
  spline/points wires land on the resting-image socket (mask already
  coerces to image in the type table, so it validates without one).
- **Space:** the box is computed and emitted in **authored [0,1]² Y-down**
  space, matching every `points`/`spline` socket. Consequences:
  - spline input: min/max over the flattened curve (`flattenSpline`, 24
    subdivisions — follows bezier bulge, not just anchors) **plus** raw
    anchor positions (covers 1-anchor subpaths, which flatten drops). No
    degenerate rejection: a horizontal line legitimately has h = 0 (this is
    why `splineBbox` in spline-fill.ts, which rejects zero-extent axes,
    is NOT reused).
  - points input: min/max over the typed `positions` array.
  - image input: `alphaBoundingBox` (element.ts — ≤256px proxy + one
    readback, WeakMap-cached per ImageValue identity, ~1/256 precision).
    Its `UvRegion` is canvas UV **Y-up**; converted to authored via
    `y = aspectUncorrectY(1 − v, aspect)`.
  - mask input: same proxy measure but thresholding the **r** channel
    (node-local helper + WeakMap cache). Deliberately NOT the mask→image
    coercion path: that shader writes alpha = 1 everywhere, so an alpha
    bbox of a coerced mask is always the full canvas.
  - A fully transparent image / empty spline / zero points → **empty
    outputs** (empty spline/points values, scalars 0, size (0,0)), not a
    full-canvas fallback.
- **Guides toggle:** `guides` (boolean, "Canvas Guides", default off)
  reveals two aux spline outputs via `resolveAuxOutputs`. Vertical guides
  run the full canvas **height** — authored y from `aspectUncorrectY(0)`
  to `aspectUncorrectY(1)`, NOT 0..1, which on a non-square canvas is
  wrong — at x = left and x = right. Horizontal guides run the full
  canvas **width** (x 0..1) at y = top and y = bottom.

## Sockets

Primary: `box` (spline) — the rectangle as one closed 4-anchor subpath
(TL → TR → BR → BL).

Aux, in display order (grouped by ordering + labels):

| group | name | type | value |
|---|---|---|---|
| edges | `left` `right` `top` `bottom` | scalar | authored edge coordinates (left/right = x, top/bottom = y) |
| edge midpoints | `mid_left` `mid_right` `mid_top` `mid_bottom` | points | single-point values (Point-node convention) |
| corners | `corner_tl` `corner_tr` `corner_bl` `corner_br` | points | single-point values |
| extras | `center` | points | box center |
| extras | `size` | vec2 | (width, height) in authored units |
| guides (toggle) | `guides_v` `guides_h` | spline | two full-canvas-height vertical / full-canvas-width horizontal open lines |

No `gatesOutputs`: once the bbox is measured (the only real cost, and only
for texture inputs), every output is a handful of CPU allocations, so all
sockets build every compute.

## Cost note

Texture inputs pay one ≤256px proxy render + sync readback per *new*
upstream value (cached per value identity, like Auto Layout's trim). An
animated/video upstream re-measures every frame — the same cost profile
Auto Layout trim already has.

## Milestones

M1 (this doc, shipped in one pass): node def + registration +
`editorCanCoerce` exception + spec. Verified with `npm run typecheck` +
`npm run check` (no new GLSL — the proxy render reuses element.ts's
existing region shader).
