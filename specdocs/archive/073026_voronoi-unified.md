# Voronoi unified — spline outputs + Fracture merge (2026-07-30)

Status: **implemented** (all milestones, 2026-07-30). Deviations from the
original spec are marked ⚠ inline; the headline one: geometry is always
emitted (signature-cached) instead of consumption-gated, because gating
requires the Text-node `stable:false` pattern, which would invalidate
every downstream node per eval — the opposite of what lattice users have
today. Bonus fixes shipped with the merge: Fracture's aux geometry was
emitted Y-flipped (readback space, not spline space), and its shader
aspect-corrected the sample but not the feature points — both gone with
the shared canonical metric spaces.

One Voronoi node with three point sources (procedural lattice, seeded
scatter, external points input) and true geometry outputs (cell polygons,
edges, vertices, centers, neighbor graph) that exactly match the rendered
image. Fracture becomes a hidden legacy registration of the same def.

## Motivation

- The Voronoi node is pure Worley noise — cells exist only implicitly,
  per-pixel, in the shader. Users can't stroke, round, offset, shatter,
  or per-cell-animate what they see.
- Fracture already proved the architecture: CPU point set as the single
  source of truth, uploaded to the GPU for rendering AND fed to
  d3-delaunay for `edges`/`vertices` aux outputs that match
  pixel-for-pixel.
- The two nodes deliberately share param names (`mode`, `metric`,
  `minkowski_n`, `seed`, `falloff`, `contrast`, `invert`, `color_a/b`,
  `alpha`) and downstream ergonomics. Once the lattice mode grows a CPU
  point set for geometry, they converge on the same node. Merge them.

## Load-bearing constraint: the sin-hash doesn't round-trip

`fract(sin(dot(p,K)) * 43758.5453)` cannot be mirrored on the CPU. The
hash feeds `sin()` arguments in the tens of thousands to millions, where
GPU precision is implementation-defined, and the ×43758 amplification
makes divergence chaotic — a CPU mirror produces a *different* cell
layout, killing the overlay guarantee. (Corollary: today's pattern
already differs across GPUs for the same seed.)

**Fix: swap `hash22`/`hash23` to an integer hash (pcg2d/pcg3d).** GLSL
300 es has uint ops; TS mirrors it bit-exactly with `Math.imul`/`>>>`.
No data textures, the O(9) lattice search is untouched, and the pattern
becomes identical across GPUs *and* CPU. Accepted cost: existing saves
re-roll their cell layout for a given seed (it was never actually
stable across devices).

## Node interface

New param `source` (enum, header-worthy):

- **`lattice`** — current Voronoi behavior. Infinite hashed lattice,
  `scale` / `jitter` / `offset_x/y` / `w` + evolution, `warp` + `uv_in`
  inputs. 3×3-search shader (`voronoi/fs`).
- **`scatter`** — current Fracture behavior. `count` / `placement`
  (image density | uniform | random) / `density_gamma` / `density_floor`
  / `relax` (Lloyd), optional `density` image input. Points-texture
  brute-force shader (`fracture/main`).
- **`points`** — NEW. External `points` input becomes the feature
  points (from Scatter Points, Cursor Trail, Hand Tracker, particle
  sims…). Same points-texture shader. Count clamped to MAX_POINTS
  (1024) with a console note when truncated.

`resolveInputs` keys the input list off `source`: lattice shows
`uv_in` + `warp`; scatter shows `density`; points shows `points`.
`visibleIf` gates the params the same way.

`mode` becomes the union: `f1`, `f2-f1`, `f2`, `cells`, `mask`,
`position`. Voronoi's strings stay canonical; Fracture's `edges` value
normalizes to `f2-f1` in `migrateLoadedParams` (no schema bump — param
rewrite only). `mask` (with `edge_width`) is now available in lattice
mode too. `f2` in the points shader is a trivial addition to the
brute-force loop.

### Registration / back-compat

The blessed alias pattern (cf. `perlin-noise`, `uv-coords` in
[index.ts](../../src/nodes/index.ts)):

```ts
registerNode(voronoiUnifiedNode);                       // type "voronoi", source default "lattice"
registerNode({ ...voronoiUnifiedNode, type: "fracture", // hidden legacy
  hidden: true, params: withSourceDefault("scatter") });
```

Old saves of BOTH types load with zero migration (identical param
names; the per-registration `source` default routes them to the right
behavior) and both *gain* every new output. Fracture's existing
`edges`/`vertices` aux handles keep their names, so old wires survive.
Fracture disappears from the add menu; its docs page redirects to
Voronoi's.

## Geometry outputs (aux, all source modes)

Shared module **`engine/voronoi-geometry.ts`** — Fracture's
`deriveGeometry` extracted and extended. All coordinates are emitted in
**authored spline/points space** (engine/aspect.ts): normalized Y-DOWN,
y in width-units centered on the canvas — the space Rasterize/Stroke/
Copy-to-Points apply `y_canvas = 0.5 + (y − 0.5)·aspect` to at render
time. Identity on square canvases; emitting raw canvas uv here draws
into a centered band `aspect` tall on portrait (the 9:16 bug found in
testing). The points-input source converts incoming authored positions
→ canvas uv before packing/deriving, for the same reason in reverse.

- **`cells`** (spline) — one closed subpath per cell
  (`voronoi.cellPolygon`, clipped), `groupIndex` = stable cell id.
  The headline output: Group Pick / Modulate Splines / Round Corners /
  Offset Path / Copy to Points all get per-cell behavior.
- **`edges`** (spline) — deduped 2-anchor open segments (existing
  Fracture convention, quantized-endpoint dedup).
- **`vertices`** (points) — cell corners incl. bbox clip points
  (existing Fracture convention).
- **`centers`** (points) — NEW. The feature points themselves.
  `groupIndices` = stable cell id (matches `cells`); `scales` =
  per-cell polygon area, mean-normalized to 1 — Copy to Points sizes
  instances by cell area with zero new machinery.
- **`neighbors`** (spline) — NEW. Delaunay dual: segments connecting
  adjacent cell centers. Free (d3 computes the triangulation first);
  plexus/mesh looks, feeds String Art / Shortest Path / Connect Points.

**⚠ No consumption gating (deviation):** `consumedOutputs` gating only
works from a `stable:false` compute that re-runs every eval (Text's
pattern) — a `stable:true` node that skipped an aux would serve a stale
cache-hit when the aux is newly wired, and `stable:false` folds ctx.time
into the fingerprint, invalidating every downstream node per eval.
Instead the node stays `stable:true` and always emits geometry, with a
signature cache in ctx.state (geometry-affecting params + density
content hash / points-input identity + aspect + bow) so color-only
edits reuse the SAME aux value objects — which also keeps downstream
identity-keyed caches (spline→mask rasterization) hot. Cost: unconsumed
geometry is built when geometry params change (sub-ms at default scale,
a few ms at extremes; hard-capped at 20k lattice cells, beyond which
geometry is skipped and the image still renders).

### Lattice-mode point enumeration

The shader measures distance in aspect-corrected p-space:
`p = (uv−0.5)·scale; p.y /= aspect; p += offset + seedOffset + animOffset`.
The CPU mirror must work in the same space:

1. Map the canvas rect [0,1]² → p-space (affine ⇒ still an axis-aligned
   rect). Enumerate integer lattice cells overlapping it +1 ring.
2. Feature point per cell via the shared integer hash + `jitter`.
3. Delaunay/Voronoi **in p-space** (that's where distance is measured),
   clip to the canvas rect in p-space, inverse-map vertices → uv.

~scale²/aspect cells (≈500 at softMax 30, ≈6.4k at hard max 80) —
d3-delaunay territory, and cached (see Caching).

### Stable identity

- Lattice: cell id = integer hash of lattice coords (+ W slice), NOT
  enumeration order — panning `offset` or scrubbing must not reshuffle
  `groupIndex`, or downstream per-cell animation flickers. Same hash
  feeds the `cells`-mode color in the shader, so a cell's spline
  identity matches its rendered color.
- Scatter: id = generation index (seeded RNG ⇒ stable per seed).
- Points input: id = incoming point index (or incoming `groupIndices`
  if present — pass through).

## Feature interactions (documented constraints)

- **Metrics:** geometry is always the *euclidean* diagram
  (d3-delaunay). Under manhattan/chebyshev/minkowski the image and the
  splines won't overlay exactly (those cell walls aren't straight
  lines). Documented on the node; outputs stay useful.
- **Warp / uv_in (lattice):** per-pixel remapping — geometry ignores
  them, documented. Fracture-style density is the sanctioned "density"
  answer, now one dropdown away.
- **W evolution (lattice):** mid-blend the *image* is a lerp of two
  distance fields, not a Voronoi of any point set. Geometry instead
  lerps lattice-matched feature points between the two slices — a true
  Voronoi every frame, exact image match at integer W, smooth spline
  morph in between (slight image↔spline drift mid-blend; accepted).
- **Devlist #167:** while touching evolution — `animated` should drive
  W itself along a seamless closed path (e.g. ping-pong/sine over the
  anim window) instead of the current XY-offset pan, so the toggle
  actually evolves the pattern. Fold the fix into M1.

## Edge bow

`edge_bow` scalar (−1..1, default 0, keyframable): converts each
straight cell-polygon edge to a bezier bowing inward (pebble/stone
mosaic) or outward (bubble packing) by setting handles perpendicular to
the edge, magnitude ∝ edge length. Applies to `cells` and `edges`
outputs; 0 keeps pure 2-anchor/polygon output (cheapest downstream).
Spline-only — the image render is unaffected (documented).

## Caching (as shipped)

- The unified node is `stable:true`. Fracture's `stable:false` was
  unnecessary — the standard fingerprint folds input fingerprints, so a
  changing density/points upstream (itself `stable:false` or animated)
  already propagates. Downstream chains now cache when the node is
  static, for scatter graphs too (an improvement over old Fracture,
  which invalidated everything per eval).
- `fingerprintExtras` returns `anim:<tick>` only for lattice + Animated.
- Geometry (and the scatter point set + upload) sits behind the
  ctx.state signature cache described above; the density readback runs
  per compute (compute only fires on fingerprint change) and its
  content hash feeds the signature.

## Milestones

- **M1 — lattice geometry.** Integer-hash swap (shader + TS mirror),
  `engine/voronoi-geometry.ts` (extract Fracture's deriveGeometry,
  add cells/centers/neighbors + stable ids + area scales), lattice
  point enumeration, five aux outputs on Voronoi, consumption gating,
  W point-lerp + devlist #167 evolution fix. Fracture untouched.
- **M2 — the merge.** `source` enum + `resolveInputs`/`visibleIf`
  plumbing, mode union + `edges`→`f2-f1` normalization in
  `migrateLoadedParams`, dual registration (`fracture` hidden),
  Fracture's compute folded into the shared def (both shaders owned by
  one def), signature-cache/stable review. Fracture node gains
  cells/centers/neighbors via the shared module.
- **M3 — points input.** `source: points`, upload path reuse, count
  clamp + note, groupIndices passthrough, `f2` in the points shader.
- **M4 — edge bow** + docs pages (recipes: mortar gaps via Offset
  Path, rounded cells via Round Corners, draw-on via Trim Path,
  plexus via neighbors + Stroke).

Follow-ons (separate specs): per-group Spline Boolean mode (cells ∩
any shape ⇒ shatter → rigid-body/matter sims); Rasterize Spline
per-group fill color from a points color source (mosaic fill).

## Open questions (resolved at implementation)

- Fracture is hidden immediately — saves load unchanged via the legacy
  registration + `migrateLoadedParams` (`source: "scatter"` injected,
  mode `"edges"` → `"f2-f1"`).
- `neighbors` emits raw Delaunay segments, filtered to those with at
  least one endpoint inside the canvas rect (drops the off-canvas halo
  from the lattice ring without clipping the graph).
- Lattice `groupIndex` is DENSE (sequential in lattice order) so
  pickers get contiguous 0..N-1; indices reindex at the border when
  panning. The per-cell `driver` random IS lattice-hash-keyed, so it
  stays stable under panning — use driver for pan-stable per-cell
  variation, groupIndex for picking.
- Per-cell `driver` on cells subpaths shipped as a bonus (feeds the
  spline-color-source driver system: per-cell ramp colors on
  Rasterize/Stroke).
