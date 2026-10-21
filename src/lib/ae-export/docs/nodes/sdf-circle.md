---
title: SDF primitives → Ellipse / Rect / Polystar / Path
type: sdf-circle
class: vector
aliases: sdf-rectangle, sdf-polygon, sdf-star, sdf-triangle, sdf-line-segment, sdf-spline, sdf-from-image
---

- **SDF space is Y-up**: `X = x·W`, `Y = H/2 − (y − 0.5)·W`, lengths `·W`
  (aspect-corrected consumers) — the `sdf01` space in toolbox's facts
  (*measured*).
- **circle** → Ellipse, size 2·(radius + offsets)·W.
- **rectangle** → Rect, size (width, height)·W + 2·offset, Roundness =
  corner_radius·W (+ offset when growing; max(r − δ, 0) when shrinking — the
  exact erosion of a rounded box).
- **line segment** → a capsule: a Rect |b − a| + 2·thickness long and
  2·thickness tall, Roundness = thickness, turned to the segment's angle about
  its midpoint (segSdf − r is exactly a stadium).
- **polygon** → Polystar polygon, rotation 0 (polySdf puts a vertex at 12
  o'clock in SDF space, as Polystar does). Its SDF is the distance to the
  edge *lines*, so an offset keeps the corners sharp: circumradius
  r + δ / cos(π/n). Exact.
- **star** → Polystar star, rotation 0, outer radius r, inner radius
  r · sin(π/m − π/n) / sin(π/m) (m = sharpness clamped to [2, points]).
  starSdf is exact, so an offset rounds the turns-away (tips when growing,
  the inner corners when shrinking): Offset Paths, Round join.
- **triangle** → a Path of its three vertices; an offset → Offset Paths,
  Round join (exact SDF, same reasoning).
- A wired `center` / `size` / `radius` socket is sampled per frame; a keyed
  param converts its keys exactly when it is the only animated value behind
  the AE property.
- Fall back to **shader**: a polygon `sides_field` (per-pixel sides), a
  fractional or keyed side / point count, `paint` colours that differ between
  shapes under a rasterize. **sdf-spline** and **sdf-from-image** are always
  shader / bake: their distances are textures computed per eval.
