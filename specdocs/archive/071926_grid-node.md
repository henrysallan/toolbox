# Grid node (spec, 2026-07-19)

A points-generator source node: a rectangular X×Y grid of points. The
missing sibling of Point (one point) for feeding Copy to Points, Connect
Points, point-labels, iterate zones, etc. — today the only ways to get a
regular grid of *points* are Shape Cells detours or scattering, and the
Array node grids *instances*, not a points value.

## Design

`type: "grid"`, category `point` / `generator`, primary output `points`.
Pure CPU compute (`makePoints` typed-array fill), no inputs, stable.

Params:

- `countX` / `countY` — points per axis, 1..64, step 1, default 5.
  Chain-locked pair (like Array's counts).
- `spacingMode` — enum `fit | step` (same vocabulary as Array's
  `sizeMode`), the "2 options for how the spacing works":
  - **fit** (default): the grid spans a fixed `width` × `height`
    rectangle; spacing is derived (`width/(countX-1)`). Adding points
    packs them tighter; overall footprint stays put.
  - **step**: explicit `spacingX` / `spacingY` between neighbors; the
    footprint grows with the counts.
- `width` / `height` — fit-mode extents in normalized units, default
  0.8, visible only in fit mode. Chain-locked pair.
- `spacingX` / `spacingY` — step-mode gap in normalized units, default
  0.1, visible only in step mode. Chain-locked pair.
- `x` / `y` — grid center, default (0.5, 0.5). Both modes center on it,
  so mode-switching keeps the grid in place.

A 1-count axis collapses to the center line in both modes (span 0 —
no divide-by-zero on `count-1`). Points are emitted row-major (y outer,
x inner), positions only — no scale/rotation/group attributes, so
downstream defaults apply and the value stays lean.

## Non-goals

Jitter, index-flow direction, per-point attributes — Point Expression /
Modulate Points / Random already cover those downstream.
