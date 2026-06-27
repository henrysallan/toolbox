# More spline primitives (spec)

Snapshot 2026-06-25. Owner-requested: a batch of new spline-primitive source
nodes, siblings of the existing **Circle** / **Rectangle**. Each follows the
established primitive recipe — a `make…Subpath()` geometry function plus a small
`NodeDefinition` that bundles `SPLINE_RASTER_PARAMS` / `SPLINE_FILL_INPUT` and
the shared `rasterizeSplineAux` / `buildSplineElement` helpers
([spline-raster-aux.ts](../src/nodes/source/spline-raster-aux.ts)). So every one
gets a `spline` primary output, a viewable `image` aux, and an Auto-Layout
`element` aux for free.

## Primitives (7)

Requested: **Spiral**, **Cross**, **Polygon**. Plus (owner-selected): **Star**,
**Arc**, **Sine Wave**, **Arrow**.

All geometry is authored in normalized `[0,1]²` Y-DOWN. The rasterizer maps BOTH
axes at the canvas-width pixel scale (Y aspect-correction, see
`buildSplineElement` notes), so a shape authored with a uniform normalized
radius renders regular/round on any aspect — same as Circle. Radial shapes use
`centerX` / `centerY` (Circle's convention). Rotations are stored in **degrees**.

| type | shape | key params | path |
|------|-------|-----------|------|
| `spiral`  | Archimedean spiral | center, turns, inner/outer radius, points-per-turn, direction | open, smooth |
| `cross`   | crosshair / registration mark | center, length, start offset, rotation | 4 open arms |
| `polygon` | regular N-gon | center, radius, sides (3–64), rotation | closed, corners |
| `star`    | N-point star | center, points (3–32), outer/inner radius, rotation | closed, corners |
| `arc`     | circle slice | center, radius, start/end angle, mode (open/pie/chord) | open or closed |
| `wave`    | sine wave | center, width, amplitude, cycles, phase (×π), resolution | open, smooth |
| `arrow`   | arrow outline | tail (x,y), tip (x,y), shaft thickness, head length/width | closed, corners |

Notes per shape:

- **Spiral** — `r(t) = inner + (outer−inner)·t`, `θ = ±t·2π·turns`, sampled at
  `round(turns · pointsPerTurn)` segments; `direction` flips the sign. Smooth
  open curve via `catmullRomSubpath`. (Logarithmic mode is a possible later add.)
- **Cross** — four 2-anchor open subpaths along ±X / ±Y (rotated). Each arm runs
  from `center + dir·offset` to `center + dir·(offset+length)`, so `start offset`
  is the central gap (0 = arms meet). Stroke-only by nature.
- **Polygon** / **Star** — vertices on a circle, first vertex at 12 o'clock
  (`−90°` + rotation). Sharp corner anchors, `closed: true`. Star alternates
  outer/inner radius over `2·points` vertices.
- **Arc** — exact circular-arc bézier (per-segment handle = `r·(4/3)·tan(Δθ/4)`
  along the tangent), segmented at ≤90°. `mode`: `open` (just the arc),
  `pie` (wedge closed through the center), `chord` (arc closed by a straight
  chord).
- **Sine Wave** — `y = centerY + amplitude·sin(2π·cycles·t + phase·π)` for x
  spanning `width` about `centerX`; smooth open curve. Phase in ×π units
  (matches Lissajous) so π/2, π read as 0.5, 1.
- **Arrow** — 7-point outline (shaft rectangle + triangular head) along the
  tail→tip axis. Fillable; stroke by default like the others.

## Shared helper (`src/engine/spline-math.ts`)

`catmullRomSubpath(points, closed)` — build a smooth interpolating subpath
through sample points via a uniform Catmull-Rom → Bézier conversion (per-anchor
handle = `(P[i+1] − P[i−1]) / 6`, symmetric; open endpoints get a one-sided
tangent). Pure, engine-side; used by Spiral and Sine Wave. Arc uses its own
exact arc-to-bézier (local to the node).

## Registration / back-compat

- One file per node in `src/nodes/source/`, registered in
  [index.ts](../src/nodes/index.ts) after `rectangleNode`. `category: "spline"`,
  `subcategory: "generator"` → grouped with Circle/Rectangle in the browser.
- New `type` strings (`spiral`/`cross`/`polygon`/`star`/`arc`/`wave`/`arrow`) are
  immutable once shipped (invariant #2). No schema bump — these only emit the
  existing `spline` socket + the standard raster aux.

## Out of scope (for now)

- Polygon/Star corner rounding (Rectangle-style); logarithmic spiral; on-canvas
  gizmos (param sliders only, like Circle/Rectangle); Blob / Heart / Gear /
  Squircle (easy follow-ups on the same template).
