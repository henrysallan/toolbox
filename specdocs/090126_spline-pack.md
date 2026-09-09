# Spline Pack — greedy collision-packing of spline fragments (090126)

Port of the Blender Geometry Nodes "Splines Packing" preset as one spline
modifier node. Input: a dense bundle of overlapping splines (warped grid,
flow lines — generated upstream). Output: a subset of fragments of those
splines, each with a constant width, packed so no two overlap. The
staggered brickwork, mixed widths, and gaps all emerge from
collision-cutting — no dashes, no offset curves.

Adapted from the generic spec against this repo's actual architecture.
Everything below names the real files, helpers, and conventions to use.

## Where it lives

- `src/nodes/effect/spline-pack.ts` exporting `splinePackNode:
  NodeDefinition` — same shelf as [spline-merge.ts](../src/nodes/effect/spline-merge.ts)
  and [spline-boolean.ts](../src/nodes/effect/spline-boolean.ts), which are
  the layout/caching templates to copy.
- Register in [src/nodes/index.ts](../src/nodes/index.ts).
- `type: "spline-pack"`, `name: "Spline Pack"`, `category: "spline"`,
  `subcategory: "modifier"`, `backend: "webgl2"` (CPU compute; the field is
  required and every spline modifier declares webgl2).
- Geometry-only, like Spline Merge: no stroke/fill raster here, no
  `OPACITY_PARAM`. The description should say "wire into Stroke /
  Rasterize Spline to draw" — the rendering recipe is below.
- Engine helpers, if any are extracted, go under `src/engine/` (invariant
  #1: nothing in `src/nodes/` may import from `src/lib/` or components —
  the export bundle copies the engine subtree verbatim).

## Answers to the generic spec's "before writing code" questions

1. **Spline representation** (`src/engine/types.ts`): `SplineValue =
   { kind: "spline", subpaths: SplineSubpath[] }`. A subpath is cubic
   bezier `anchors` (`pos`, optional `inHandle`/`outHandle`, both relative
   offsets; missing handles ⇒ straight segment) + `closed`. There is no
   separate polyline type — a polyline is corner anchors with no handles.
2. **Flattening**: there is NO reusable flatten-at-px-spacing helper.
   [spline-flatten.ts](../src/engine/spline-flatten.ts) exists but is the
   SDF segment packer — fixed parametric subdivision, flat `Float32Array`
   for texture upload, no per-subpath structure, no arc length. Don't
   bend it to this. Build the sampler from the real ingredients:
   `subpathToCurves` ([spline-math.ts](../src/engine/spline-math.ts))
   gives bezier-js `Bezier[]` per subpath, and the px-space mapping from
   [spline-width.ts](../src/engine/spline-width.ts) (map ABSOLUTE control
   points through `[x·W, aspectCorrectY(y, W/H)·H]` — the mapping is
   affine per axis, so the mapped cubic is exact). Then arc-length-sample
   each px-space curve at `spacing` px via bezier-js `length()`/`get()`.
3. **Per-spline attributes**: fully supported — better than the generic
   spec hoped. `SplineSubpath` carries `groupIndex` (discrete identity),
   `driver` (producer-authored scalar in [0,1], consumed by the shared
   subpath-driver system in spline-color-source.ts), and `attrs`
   (named per-subpath channels, 081326_point-attributes.md M3). The
   generic spec's "attribute fallback" section is dead — see Output.
4. **Memoization**: the evaluator fingerprint-caches whole nodes
   (type + params + input fingerprints), so compute doesn't even run when
   nothing changed. When `count` changes the fingerprint busts and compute
   runs — the node keeps its own `ctx.state["spline-pack:<nodeId>"]`
   signature cache that EXCLUDES `count` (the exact spline-boolean /
   spline-merge pattern), so scrubbing the reveal is a cheap array slice,
   never a repack. No `fingerprintExtras`, no `stable: false`, not a
   `simulation` — this is a pure function of inputs.

## Coordinate space — the part the generic spec couldn't know

Splines on the wire are **authored [0,1]² Y-DOWN, and anisotropic on
non-square canvases** (devguide § coordinate conventions — "this exact bug
has been fixed five times"). A radius is only a circle in px space. So:

- Flatten INTO canvas px space using the spline-width.ts mapping
  (`aspectCorrectY` from [aspect.ts](../src/engine/aspect.ts) with
  `aspect = ctx.width / ctx.height`).
- Run the ENTIRE algorithm — distances, thresholds, `min_length`, radii —
  in px.
- Map output points back through the inverse (`x/W`,
  `aspectUncorrectY(y/H, aspect)`) so the output socket carries authored
  space, always. Every renderer aspect-corrects on its way to pixels;
  emitting canvas UV here would double-correct downstream.
- Because packing runs in px, `ctx.width`/`ctx.height` belong in the
  internal cache signature — a canvas resize must repack.

Metric params (`min_width`, `max_width`, `gap`, `min_length`, `spacing`)
resolve through `resolveStrokePx` with a shared `strokeUnitsParam("units")`
toggle ([stroke-units.ts](../src/engine/stroke-units.ts)) — px default,
`%`-of-canvas-width opt-in, matching Stroke. That keeps pack widths and
the Stroke thickness that renders them in the same unit system (#174).

## Node interface

```
inputs:        [{ name: "path", type: "spline", required: true }]
primaryOutput: "spline"
auxOutputs:    []
```

Params (snake_case, house ParamDef conventions — sliders need min/max,
`softMax` for escape-hatch range, `step`):

| name              | type    | default | range (softMax)   | notes |
|-------------------|---------|---------|-------------------|-------|
| `min_width`       | scalar  | 4       | 0.5–500 (60)      | step 0.5. `rMin = min_width/2` |
| `max_width`       | scalar  | 24      | 0.5–500 (60)      | step 0.5. Clamped `≥ min_width` in compute. Declare `linkedPairs` with `min_width` if the chain-lock UI reads well; otherwise just clamp. |
| `randomize_width` | boolean | true    |                   | false ⇒ every target is `max_width` |
| `gap`             | scalar  | 0       | 0–100 (20)        | step 0.5. Extra clearance on every collision threshold. Blender fakes this with an outline stroke; a real param is better. |
| `min_length`      | scalar  | 20      | 0–2000 (300)      | step 1. Fragments shorter than this are discarded. |
| `spacing`         | scalar  | 2       | 0.5–20 (8)        | step 0.5, label "Sample spacing". Deliberately NOT named `resolution` — in this repo `resolution` on spline nodes means segments-per-curve (Spline Boolean/Merge, 3–96); this is a px arc-length spacing and the name should say so. |
| `units`           | enum    | px      | px \| %           | `strokeUnitsParam("units")`, applies to the five metrics above. |
| `seed`            | scalar  | 0       | 0–9999            | step 1 (the scatter-points/stroke seed convention). |
| `count`           | scalar  | -1      | -1–2000 (300)     | step 1. -1 = all pieces; else the first `count` placed pieces — the reveal animation. Scalar params are keyframable for free. |

No `validateParams` needed — nothing here can produce a broken recipe that
clamping doesn't fix.

## Algorithm

Greedy sequential packing, all in px space:

1. Flatten every input subpath to a polyline at `spacing` px with
   cumulative arc length per sample. Closed subpaths include the closing
   segment; once cut they become open fragments (a subpath that survives
   completely uncut stays closed).
2. Seeded PRNG: copy the `mulberry32` from
   [scatter-points.ts](../src/nodes/effect/scatter-points.ts) (nodes
   inline it by precedent — space-fill, voronoi, l-system all carry their
   own). Never `Math.random`. Draw each input's `rTarget =
   rMin + rand·(rMax − rMin)` in input order BEFORE any placement draws,
   so results are stable under everything except the seed.
3. Place a random fragment at its `rTarget`; cut all pending fragments
   against it at threshold `placed.r + rMin + gap`; drop cut pieces
   shorter than `min_length`.
4. Loop until pending is empty: pick a random pending fragment, shrink
   `r = min(rTarget, distToEachPlaced − placed.r − gap)`; skip if
   `r < rMin`; re-cut its ends against the placed set at the FINAL radius
   (`placed.r + r + gap`, keep the longest surviving run — Blender skips
   this, which is why its round caps overlap); place it; cut all pending
   against only the new piece.

Cut mechanics: keep-mask per sample by point-to-polyline distance, split
into runs, linearly interpolate the boundary samples to land exactly at
`dist == threshold` (no ragged ends snapping to sample spacing), drop runs
under `min_length`. Distance is symmetric for fit
(`min(frag→piece, piece→frag)`) — both directions matter at sparse
sampling.

Data layout: house style favors typed arrays for hot geometry
(`PointsValue` is SoA) — keep each fragment's samples as an interleaved
`Float32Array` rather than `Vec2[]` if it falls out naturally, but don't
contort; a few hundred splines at spacing 2 is small. Naive
O(placed × pending × samples²) first. If profiling (`npm run bench:nodes`)
says otherwise, uniform-grid-bucket the placed segments (cell ≈
`max_width + gap`) and AABB-prefilter — not before.

The whole pack runs once per (geometry, params-minus-count, canvas size)
signature and is replayed from `ctx.state` otherwise. Note the editor
evaluates on state change while paused and per-rAF during playback — a
cached pack costs nothing either way, and offline export (`ctx.offline`)
is deterministic for free since nothing here defers async work.

## Output

Convert each placed piece back to a subpath, in `packIndex` order, mapped
back to authored space:

- **Geometry**: corner anchors (no handles) at the sample points, run
  through `simplifyPolyline` (spline-math.ts) with a ~0.25 px tolerance
  first — at spacing 2 a raw piece carries an anchor every 2 px, which is
  pointless weight for every downstream consumer. Keep the interpolated
  endpoints exact (simplify never moves endpoints). Don't bezier-fit
  (`fitSplineToPolyline`) in v1 — corner anchors render identically
  through Stroke and stay honest about what the algorithm produced; Set
  Spline Type / Resample exist downstream for anyone who wants smooth.
- **`driver`** = `finalWidth / max_width` — this is the rendering hook
  (below).
- **`attrs`** = `{ width: <final px width>, packIndex, sourceIndex }` —
  the proper M3 channels, visible in the spreadsheet panel and available
  to any attribute-aware downstream.
- **`groupIndex`** = `sourceIndex`. This buys the existing group
  machinery: Stroke/Rasterize color ramp `by: "group"` colors pieces by
  the source spline they were cut from, while `by: "index"` colors by
  placement order (emission is packIndex-ordered, so ordinal == packIndex).
  Filter Splines / Select-by-index work on pieces for free.
- Apply `count` as the final filter: `packIndex < count` (all if -1), a
  slice of the cached piece list.
- Input per-anchor data (width profiles, anchor `attrs`, live corners) do
  NOT survive — flattening discards them, same as the boolean nodes.
  `cornerRadius` is already baked by Spline Draw before it reaches us.

### Rendering recipe (docs/description material, not this node)

Stroke node: `thickness = max_width` (same units), `cap: butt`,
`thickness_source: vary`, `thickness_by: driver`, `thickness_lo: 0`,
`thickness_hi: 1`. Rendered width = `max_width · driver` = the piece's
exact packed width. Outline/depth: a second Stroke of the same spline
underneath at `thickness_hi` slightly above 1, darker color — the ramp
and per-subpath machinery already handle color-by-group/index.

## Verification

Per TESTING.md — and note its warning: offline node tests must push
inputs through `coerceValue`, not hand values straight to `compute`.

`scripts/check-spline-pack.mts`, modeled on
[check-points-to-spline.mts](../scripts/check-points-to-spline.mts)
(stubbed `RenderContext` with fixed width/height, PASS/FAIL lines,
non-zero exit on failure), wired into `npm run check` in package.json:

- Determinism: same input + seed ⇒ `JSON.stringify`-identical output,
  across two fresh compute calls AND across a `count` scrub (pack once,
  filter twice).
- Non-overlap: for every output pair, symmetric polyline distance in px
  ≥ `ra + rb + gap − ε` (radii recovered from `attrs.width`).
- Every piece's px arc length ≥ `min_length`.
- `count = k` output is exactly the first k subpaths of `count = -1`.
- Attributes: `driver == attrs.width / max_width`, `groupIndex ==
  attrs.sourceIndex`, packIndex contiguous from 0.
- Aspect: pack the same geometry on a 1000×1000 and a 2000×1000 stub
  canvas — clearances must hold in each canvas's own px space (guards the
  aspect-correct mapping).
- Sanity recipe (eyeball, not scripted): ~60 sine-warped horizontal lines,
  `min_width 6, max_width 30, min_length 40, gap 2` → brick-like
  staggering, mixed widths, no gap wider than a piece.

Gates: `npm run typecheck`, `npm run check`, `npm run lint:ratchet`.
Nothing here touches shaders.

## Milestones

- **M1** — node + algorithm + attributes, registered, cached, correct in
  the app against the sanity recipe.
- **M2** — `check-spline-pack.mts` in the check chain; confirm the docs
  page renders the description sanely.

## Follow-ups (not this PR)

- Per-subpath `min/max_width` from an input attribute; priority attribute
  to bias placement order.
- An upstream "flow bundle" recipe/preset (warped grid / streamlines →
  Spline Pack → Stroke).
- Map the Blender "Splines Packing" preset → `spline-pack` in the
  blender-to-toolbox skill's node-map
  (`.claude/skills/blender-to-toolbox/references/node-map.md`) and
  regenerate the catalog facts.
