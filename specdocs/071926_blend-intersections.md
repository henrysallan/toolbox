# Blend Intersections node (devlist #49 — spline-network metaballs)

Owner Q&A settled 2026-07-19: whole-network output · proximity blending ·
CPU implicit field · name **Blend Intersections**.

## What it is

A spline→spline modifier that converts a network of (possibly open,
possibly self-crossing) splines into ONE closed outline shape: thin
stroke bodies that swell into webbed ink-pools wherever strokes cross or
come within a blend radius — the "blend intersections" look (reference:
crossing hand-drawn strokes whose junctions pool into star-shaped blobs
with smooth concave fillets).

This is the implicit-surface fusion deferred from devlist #71's
resolution note ("pure metaball blobbing … is still a separate idea —
see #49"), scoped to stroke networks. Proximity Join/Merge stays the
topological tool; this is the *visual* one.

Geometry-only, like Spline Merge: the node emits a spline silhouette —
wire it into Rasterize Spline (fill it, or stroke its outline) to draw.

## Why an implicit field (and not vectors or the GPU)

The look **is** an SDF smooth-union: each stroke is a distance field,
`smin` combines them, the iso-contour at stroke-radius is the outline.
The concave webbing at crossings falls out of `smin` for free, `blend`
(the smin `k`) is the one honest knob for it, and the approach is
indifferent to how many strokes cross, tangent crossings, and
self-intersections — exactly where a vector offset+union+fillet pipeline
gets fragile. A GPU raster (stroke → blur → threshold → readback) ties
field resolution to canvas size and pays a GPU→CPU readback per
recompute; the CPU field samples only the network's bounding box at a
user-set resolution and reuses proven pieces end-to-end:
`flattenSpline` → spatial-hashed point/segment distance → `smin` →
`marchingSquares` → `fitSplineToPolyline`.

## Algorithm (engine/spline-blend-intersections.ts, pure)

1. **Flatten** each subpath to line segments (`flattenSpline`, one
   subpath at a time so every segment keeps `(subpath index, ordinal)`),
   scaled into **canvas-pixel space** — distances must be isotropic on
   non-square canvases (same rule as multi-stroke's px-space offsets).
2. **Grid** over the segments' bbox expanded by `r + k/4 + cells` margin
   (`r` = width/2 px, `k` = blend px). `resolution` = samples across the
   larger bbox span, with a **thin-feature clamp**: cell ≤ 0.75·r so the
   stroke tube always spans ≥ ~3 cells — coarser than that, marching
   squares hits saddle-heavy topology along the tube (speckle + broken
   chains; observed, not theoretical). Field never touches canvas areas
   the network doesn't reach.
3. **Spatial hash** bins segments (bucket = influence radius
   `R = r + 1.25k + cellDiag`); the gathered 3×3 candidate list is
   **cached per bucket** (identical for every sample inside one), and
   the per-sample hot loop is allocation-free (insertion sort on scratch
   arrays, `sqrt` not `hypot`). Two fast paths skip branch folding:
   single candidate, and nearest distance beyond `r + k/4 + 2·cell`
   (where smooth-min deepening provably can't move the iso).
4. **Branches, not subpaths.** Gathered segments group by subpath, then
   split into contiguous-ordinal runs (gap > GAP segments → new branch;
   closed subpaths compare ordinals modulo n so runs across the seam
   stay one branch). Per-branch distance = min over its segments. This
   is what makes a stroke crossing ITSELF web up — the two passes of the
   loop are far apart in arc-length, so they land in separate branches
   and blend, while adjacent segments of one pass collapse into one
   branch and can't inflate the field (the classic sum-of-blobs artifact
   of naive per-segment metaballs).
5. **Field** = fold the branch distances (sorted ascending for
   deterministic folding) with polynomial smooth-min
   `smin(a,b) = min(a,b) − k·h²/4, h = max(k−|a−b|, 0)/k`, minus `r`.
   `k = 0` degenerates to a plain union of stroked bodies. Samples with
   no gathered segments read `+R` (far outside).
6. **Contour**: `marchingSquares(grid, …, { iso: 0, uvOrigin, uvSize })`
   maps straight back into canvas-UV, then a cleanup pass: contours
   shorter than 3 cells are dropped (saddle debris at thin/tangent
   features) and open chains whose endpoints sit within 1.5 cells are
   re-closed (saddle-split rings).
7. **Smoothing**: `smoothing > 0` refits each contour with
   `fitSplineToPolyline` (error ∝ smoothing × cell size, in px space,
   anchors+handles divided back into UV). Closed contours append their
   seam point before fitting and re-merge the duplicate anchor after
   (seam tangent continuity is approximate; error is sub-cell).
   `smoothing = 0` returns the raw marching-squares polygons (Text's
   contour output precedent).

## Node (nodes/effect/blend-intersections.ts)

- `type: "blend-intersections"`, name **Blend Intersections**, category
  `spline` / `modifier`. Input `path` (spline, required — Collect
  combines multiple sources upstream, same convention as Spline Merge).
  Primary output `spline`. No aux outputs in v1.
- Params:
  - `width` — stroke body thickness (diameter), default 6, min 0.5,
    softMax 64. Shares the px/`%` **units** toggle
    (`strokeUnitsParam` / `resolveStrokePx`, % = canvas-width fraction).
  - `blend` — webbing radius (smin k), same units, default 24, min 0
    (0 = plain union), softMax 120.
  - `resolution` — field samples across the network bbox's larger span,
    64…768 (softMax 512), default 288. Quality/perf dial.
  - `smoothing` — 0…1 bezier-fit tolerance, default 0.5
    (0 = raw polygons).
- Caching: pure function of inputs+params, so the evaluator fingerprint
  cache applies; an internal `ctx.state` signature cache
  (`splineGeomHash` + params, Spline Merge's pattern) guards against
  fingerprint churn from `stable:false` upstreams whose geometry didn't
  actually change. `dispose` deletes the state.
- Not `stable:false`; universal mask/opacity conventions untouched
  (spline output — same posture as Spline Merge).

## Cost model

Measured (headless tsx, M-class): a 3-stroke near-fullscreen network on
1024×768 at width 6 / blend 24 / resolution 288 ≈ **27ms warm** (~106k
samples after the thin-feature clamp; was 86ms before the bucket cache +
allocation-free hot loop). Recomputed only on geometry/param change (the
sig cache absorbs `stable:false` upstream churn); dense networks scale
with occupied bbox, not canvas size, and `resolution` is the dial.
BRANCH_GAP (8) and curve-flatten subdivisions (16) are internal
constants until proven otherwise.

Naming note: **Spline Intersections** (existing, category point) emits a
point at each crossing; **Blend Intersections** outputs the blended
outline. Complementary, not overlapping.

## Milestones

1. **Engine**: `src/engine/spline-blend-intersections.ts` —
   `blendIntersections(spline, canvasW, canvasH, opts): SplineValue`,
   pure (testable when a runner lands). ✅
2. **Node**: def + registration in nodes/index.ts + description for the
   docs page. ✅
3. **Verify**: typecheck + lint ratchet + manual browser pass (crossing
   open strokes, a self-crossing loop, blend=0, non-square canvas,
   animated upstream). Devlist #49 annotated.

## Future (out of scope v1)

- Aux `points` output of junction centers (local field minima) for
  Copy-to-Points accents.
- Crossings-only gate (mask the blend to disks around true bezier
  intersections) if proximity pooling proves too eager in practice.
- Per-subpath width from upstream attributes if splines ever carry them.
