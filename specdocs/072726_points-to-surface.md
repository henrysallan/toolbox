# Points to Surface — particle "meshing" (surfacing)

Shipped 2026-07-27 (code; needs in-browser pass). Companion to the
Matter Simulator (072726_matter-simulator.md) but a fully general
points node: `points-to-surface`
([points-to-surface.ts](../src/nodes/effect/points-to-surface.ts)),
point/modifier, points in → spline out.

## What it is

Surface extraction around particle clumps — build a scalar field from
the points cloud, trace its iso-contour with the engine's existing
marching squares (`engine/marching-squares.ts`, the spline-flow / Text
outline machinery), emit a multi-subpath spline. Two canonical
algorithms behind a segmented toggle (owner asked for the competing
tried-and-true options):

- **zhu-bridson** (default) — Zhu & Bridson 2005, the standard SPH
  surfacing: φ(x) = |x − x̄| − r̄ with x̄ the kernel-weighted average of
  nearby particle positions and r̄ = threshold·radius. Flat resting
  surfaces, calm concave regions — the liquid look.
- **metaballs** — Blinn blobbies: Σ(1 − q²)³ thresholded. Bulgy
  lava-lamp merging.

Both share one CPU evaluation: pixel-square sample grid (`detail`+1
across the width, aspect-matched vertically), counting-sort spatial
binning at the influence radius, field from the 3×3 bin neighborhood,
marching squares at iso 0 (negative-inside grids: ZB's φ directly,
`threshold − Σw` for metaballs), min-area speck cull (shoelace, canvas-
area fraction — uv shoelace IS area fraction since both axes are
normalized), then 0–6 passes of circular neighbor-average smoothing.
Pure function of inputs — cacheable, scrub-safe, offline-exact, no
state. Cost at defaults: ~15k samples × ~dozens of kernel taps ≈ a few
ms; `detail` is the budget dial.

Output subpaths carry `groupIndex` = blob index (per-blob ramp colors
in Rasterize Spline, Group Pick isolation). The spline output rides
spline→mask coercion, so it wires straight into any mask/image socket
as a filled silhouette.

## Recipes

- Matter Simulator points aux → Points to Surface → Rasterize Spline
  (fill + stroke): liquid with a skin instead of dots.
- → the Fluid/Watercolor `deposit` input: MPM splashes deposit ink.
- Same surface spline → Stroke with Repeats: contour-line liquid.
- Scatter Points (animated density) → metaballs: classic blob morph.

## In-browser verification (owner pass)

- [ ] ZB on resting MPM liquid: flat-ish top surface, no lumps;
      metaballs comparison visibly blobbier.
- [ ] radius/threshold sweeps: blobs merge/split sensibly; threshold
      near 1 tightens ZB to per-particle dots.
- [ ] Specks culled during splashes (min blob); smoothing 0 vs 1.
- [ ] 131k-point stress: interactive at detail ≤ 200 (drop detail, not
      radius, when slow).
- [x] Gates: typecheck / lint:ratchet green for the new files
      (2026-07-27; an unrelated pre-existing `folder_id` type error in
      the owner's in-flight supabase/projects.ts edit is NOT from this
      work).

## Negative space downstream (owner-found, fixed 2026-07-27)

Interior contours (air pockets) rasterized SOLID through Rasterize
Spline — its per-subpath fills (stacking default / ramp / layered)
can't punch nested contours; only flat + stack-off + flatten collapsed
to one even-odd fill. Same failure on text-outline counters. Fix lives
on Rasterize Spline: the **`holes`** param (default off — legacy saves
identical) groups subpaths into containment islands and fills each as
one even-odd path. Turn it ON when rasterizing this node's output.
(The spline→mask coercion was always even-odd — masks were never
affected.)

## Follow-ups

- GPU field + screen-space rendering path for a soft-shaded liquid
  look (vs this node's vector outline) — the "rendering is half the
  art direction" item from the survey.
- Anisotropic kernels (weighted-PCA stretch) for sharper thin streams.
