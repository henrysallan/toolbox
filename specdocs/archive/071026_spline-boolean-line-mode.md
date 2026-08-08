# Spline Boolean — "Treat A as line" mode (2026-07-10)

Owner request (no devlist entry): subtracting a circle from a closed
wobbly loop always yields circular CUTOUTS, because Spline Boolean
interprets both inputs as filled regions. Sometimes the wanted result is
GAPS in the spline itself — erase the parts of A's curve that B covers.

## Decision (design Q&A)

A **`treat_a` segmented toggle: `shape | line`**, shown only when the
operation is `subtract` or `intersect` (union/exclude need two regions —
no line meaning). Default `shape` = the pre-param behavior, so old saves
are untouched (invariant #2: a missing param resolves to its default).
The alternative considered — new `cut`/`crop` entries in the op enum —
was rejected in favor of keeping region-vs-line orthogonal to the op.

- `subtract` + line → keep A's curve **outside** B: gaps in the stroke.
- `intersect` + line → keep A's curve **inside** B: only the covered arcs.

## Engine: `clipSplineByRegion` (spline-boolean.ts)

`clipSplineByRegion(subject, cutter, keep: "outside"|"inside", steps)`

- The cutter goes through the existing `splineToGeom` (flatten → XOR
  self-clean → MultiPolygon, scaled coords) — so even-odd holes, open
  subpaths auto-closed, exactly what the region path subtracts.
- Crossings: each subject cubic is flattened to a `steps` LUT (same
  resolution param as the region path) and its sub-segments intersected
  against the cutter's boundary edges (cubic-level AABB quick-reject).
  Hits become global params g = cubicIndex + t; near-duplicates dedupe
  at 1e-3 (a hit at a LUT vertex or shared ring vertex registers twice).
- Pieces: spans between consecutive cuts. **Closed subpaths wrap** — the
  last span continues through the seam into the first, so the arc
  crossing a loop's start anchor stays ONE continuous piece (the same
  stitch semantics as Trim Path's offset). Open subpaths get plain
  head/tail spans.
- Classification: each piece's own midpoint is tested even-odd against
  the cutter region — parity of crossings is never relied on, so
  tangential grazes and merged near-cuts degrade gracefully.
- Output: **true bezier** — the ORIGINAL cubics are split at the span
  ends (bezier-js `split`, reconstructed via spline-trim's
  `cubicsToSubpath`, now exported); whole cubics pass verbatim; subpaths
  with no crossings pass **by reference** (closed flag + handles
  intact). groupIndex tags survive onto every piece. No
  polygonalization anywhere the cutter didn't touch — unlike the region
  path, which flattens everything.
- Empty cutter: `outside` → subject returned unchanged (same object);
  `inside` → empty.

## Node changes

- `treat_a` param (enum shape|line, segmented, visibleIf subtract/
  intersect), folded into the existing `boolSig` recompute cache.
- Line mode routes to `clipSplineByRegion` (`subtract`→outside,
  `intersect`→inside); shape mode is byte-for-byte the old path.
- Raster aux unchanged: stroke is the natural pairing for line output;
  fill still auto-closes open pieces (same as Spline Draw) — documented,
  not special-cased.

## Verification

tsx harness (spline-clip-check): line/loop × subtract/intersect piece
counts and boundary landings, seam wrap-stitch through a loop's start
corner, by-reference passthrough, ring-cutter (hole) even-odd, bezier
handles preserved on cut pieces, node-level routing + default-param
back-compat. Typecheck + eslint clean. Manual editor pass: wobbly loop
(Spline Draw) − Circle, treat_a=line, stroke on — expect gaps sliding
with the circle; chain Trim Path offset for draw-on over the gapped run.
