# Points to Spline · Set Spline Type · Relax · Shortest Path — spec (2026-07-10)

Devlist #171 ("Relax node (for points and splines)"), #173 ("points to
spline, shortest path (select two spline groups or select random groups by
size) Set spline type (makes a spline bezier/cubic/linear)"), #74
("shortest path node").

Four pure-CPU geometry nodes. No GL work, no per-frame state, no
`stable:false` — every one is a deterministic function of inputs + params,
so the fingerprint cache handles them like any static modifier. All logic
stays engine-side (`src/engine/`) or node-local per invariant #1.

## Decisions (from design Q&A)

1. **Shortest Path is points-first** (second Q&A round): the node the
   owner imagined takes a POINT SET and routes from a start point to an
   end point or end group — the network is implicit (hops between points
   within a max distance, Connect Points semantics). Endpoints are
   position inputs that snap to the nearest point (wireable vec2s —
   Point node, Cursor, gizmos), with an `end_mode` toggle to target a
   group instead. The spline-network walking built first stays as a
   `spline` mode behind the mode header control: `select` enum `groups`
   (start-group / end-group index params) or `random` (`count` + `seed`
   pick N endpoint pairs, each path tagged with its own `groupIndex`).
2. **Spline-mode connectivity — coincident anchors only.** The owner is
   imagining *branching networks where nothing crosses over* (Connect
   Points output, organic branch structures). Vertices weld where anchor
   positions coincide within a tolerance; we do NOT split segments at
   mid-segment crossings (a planarize toggle can come later if grids/
   crossing-line networks turn out to matter).
3. **Relax on points = push apart / even out** (Houdini-style): points
   within a radius repel a little each iteration, evening out clumps
   after Scatter. Not neighborhood-average blurring.
4. **Set Spline Type = Linear + Smooth.** "bezier/cubic" collapse to one
   thing in this engine (anchors + cubic handles); the useful pair is
   `linear` (strip handles → polyline) and `smooth` (catmull-rom auto
   handles, with a tension slider).

## Shared infrastructure

- `autoSmoothHandles(anchors, closed, tension)` — new export in
  [spline-math.ts](../../src/engine/spline-math.ts): rewrites in/out handles
  on existing anchor positions using the catmull-rom rule
  (±tension·(Pᵢ₊₁ − Pᵢ₋₁)/6, one-sided at open endpoints, wraps when
  closed). `catmullRomSubpath` is refactored to call it (tension = 1) —
  behavior-identical for Spiral / Sine Wave.
- `src/engine/spline-graph.ts` — new engine file for Shortest Path's
  graph build + Dijkstra (testable pure math, same placement rationale as
  the other `spline-*.ts` domain files).
- Group semantics follow Select by Index (group-pick.ts): missing
  `groupIndex` ⇒ bucket 0; requested indices index into the *sorted
  distinct* groupIndex values and clamp.

## Node 1 — Points to Spline (`points-to-spline`)

Spline → Generator (the missing inverse of Points on Path / the sibling
of Connect Points).

```
inputs:  points (points, required)
params:  curve   enum [linear, smooth]   default linear
         closed  boolean                 default false
output:  spline
```

- Points are chained **in index order**, split by `groupIndex`: each
  distinct group becomes one subpath (tagged with that groupIndex);
  wholly untagged input becomes one untagged subpath. Groups with < 2
  points emit nothing.
- `linear` → corner anchors (no handles). `smooth` →
  `catmullRomSubpath(pts, closed)`.
- Reads typed arrays directly (`positions`/`groupIndices`) — no
  `ensurePointArray` needed.

## Node 2 — Set Spline Type (`set-spline-type`)

Spline → Modifier. Rewrites handles; anchor positions, closed flags, and
groupIndex tags are untouched.

```
inputs:  path (spline, required)
params:  spline_type enum [linear, smooth]  default smooth
         tension     scalar 0–2 step 0.01   default 1   (visibleIf smooth)
output:  spline
```

- `linear` strips every in/out handle. `smooth` recomputes all handles
  via `autoSmoothHandles` — deliberately destructive to hand-authored
  bezier handles (that's the node's job). `tension` 0 ≈ linear, 1 =
  catmull-rom, > 1 overshoots.
- Headline combo: Points to Spline (linear) → Set Spline Type (smooth),
  or smoothing Connect Points' 2-anchor segments — 2-anchor open
  subpaths get straight one-sided handles and stay visually straight,
  which is correct.

## Node 3 — Relax (`relax`)

Utility (cross-type polymorphic convention, like Displace/old Jitter).
`mode` header control, mode-anchored `resolveInputs`/`resolvePrimaryOutput`
(the group-pick pattern — safe with the UI socket-refresh path).

```
inputs:  in (points | spline, per mode)
params:  mode        enum [points, spline]        default points
         iterations  scalar 1–100 softMax 20 step 1  default 5
         mix         scalar 0–1                      default 1
         radius      scalar 0–1 softMax 0.25 step 0.001 default 0.05
                     (visibleIf points)
output:  points | spline (per mode)
```

- **Points**: per iteration, bucket into a spatial hash (cell = radius —
  the connect-points pattern); every pair with d < radius contributes a
  push-apart displacement of ((radius − d)/2)·axis to each side.
  Displacements accumulate Jacobi-style (sum per point, apply once per
  iteration, damped 0.5) so results don't depend on point order.
  Coincident pairs (d ≈ 0) separate along a deterministic per-index
  hashed angle — no Math.random anywhere. Positions are NOT clamped to
  [0,1]² (same as other positional modifiers). `scales`/`rotations`/
  `groupIndices` pass through untouched.
- **Splines**: per-subpath Laplacian smoothing of anchor positions:
  pᵢ ← pᵢ + 0.5·(avg(pᵢ₋₁, pᵢ₊₁) − pᵢ) per iteration. Open endpoints are
  pinned; closed subpaths wrap. Handles ride along unchanged (they're
  relative offsets); chain Set Spline Type after if re-smoothed handles
  are wanted. `radius` is ignored in this mode.
- `mix` lerps final positions back toward the originals (both modes).

## Node 4 — Shortest Path (`shortest-path`)

Spline → Generator (points in → spline out in its default mode, like
Connect Points). `mode` header control picks the network source; both
modes share the Dijkstra core (spline-graph.ts) and pair with Trim
Path's new `trim_offset` for the animated traversal look.

```
params:  mode          enum [points, spline]     default points
── points mode ──
inputs:  points (points, required)
         start (vec2, optional)    end (vec2, optional, only when end_mode=position)
params:  max_distance  scalar 0–1 softMax 0.3    default 0.1
         start_x/start_y  scalar 0–1             defaults 0.1 / 0.5
         end_mode      enum [position, group]    default position (segmented)
         end_x/end_y   scalar 0–1                defaults 0.9 / 0.5 (visibleIf position)
         end_group     scalar 0–100 step 1       default 1 (visibleIf group; SHARED with spline mode)
output:  spline (the route as an open polyline)
aux:     points (the visited points in path order, original attrs intact)
── spline mode ──
inputs:  network (spline, required)
params:  select        enum [groups, random]     default groups
         start_group   scalar 0–100 step 1       default 0  (visibleIf groups)
         end_group     (shared — see above)                  (visibleIf groups)
         count         scalar 1–100 softMax 10 step 1 default 3 (visibleIf random)
         seed          scalar 0–1000 step 1      default 0  (visibleIf random)
         weld_distance scalar 0–0.05 step 0.0001 default 0.002
output:  spline (path subpaths; random mode tags each path groupIndex 0…N−1)
```

### points mode (the headline)

- **Graph** (`buildPointsGraph`): vertex id == point index; every pair
  within `max_distance` is an edge weighted by euclidean distance
  (Connect Points hop semantics, spatial-hash accelerated).
- **Endpoints**: `start`/`end` vec2 inputs snap to the NEAREST point in
  the cloud — wire a Point node, a gizmo'd position, or the Cursor to
  steer the route live; the X/Y params are the unwired fallback (the
  sdf-rectangle center convention). `end_mode: group` instead routes to
  the nearest member of the chosen groupIndex bucket (multi-target
  Dijkstra).
- **Output**: the route as an open LINEAR polyline through the visited
  point positions (chain Set Spline Type to smooth); the `points` aux
  carries the visited points in path order with scales/rotations/
  groupIndices intact — Copy to Points stamps markers along the route.
- Start and end snapping to the same point, or an unreachable end
  (different hop-component), emit empty outputs.

### spline mode

- **Graph build** (`buildSplineGraph`): every cubic segment between
  consecutive anchors (including a closed subpath's closing segment) is
  an edge weighted by its arc length (`measureSubpath`). Vertices are
  anchor positions welded within `weld_distance` (quantized grid +
  8-neighbor representative lookup, so near-cell-boundary pairs still
  merge). Each vertex remembers the set of groupIndex buckets of its
  incident subpaths.
- **groups select**: multi-source Dijkstra seeded from every vertex of
  the start group (cost 0), settling until the first vertex of the end
  group is reached — i.e. shortest route between ANY vertex of A and ANY
  vertex of B. Same group both sides, touching groups (shared welded
  vertex ⇒ zero-length route), or unreachable ⇒ empty spline.
- **random select**: seeded deterministic PRNG (triple32-style hash, like
  Point Expression's `rand`). Per path: pick a random start vertex, then
  a random end vertex from the SAME connected component (components
  precomputed; components of size < 2 skipped) — every emitted pair is
  guaranteed a path. `count` paths, each an open subpath tagged
  groupIndex = path index for downstream per-index modulation
  (color-ramp fills, staggered trims).
- **Path reconstruction**: walk the winning vertex chain and re-emit the
  traversed ORIGINAL segments — handles preserved; a segment traversed
  backwards swaps its anchors' in/out handle roles (offsets unchanged).
  No resampling, no flattening.

Complexity: Dijkstra + binary heap, O(E log V); fine to a few thousand
edges (same ballpark as Spline Intersections).

## Milestones

1. **M1** — `autoSmoothHandles` (+ catmullRomSubpath refactor), Points to
   Spline, Set Spline Type. Register in nodes/index.ts.
2. **M2** — Relax (points spatial-hash repel + spline Laplacian).
3. **M3** — Shortest Path (`spline-graph.ts`: weld, graph, Dijkstra,
   components; the node: both select modes, path reconstruction).
4. **M4** — devlist annotations, docs-page sanity check, manual editor
   pass (Scatter → Relax → Points to Spline → Set Spline Type;
   Scatter → Shortest Path (points mode, Cursor → start) → Trim Path
   offset → Stroke; Connect Points → Shortest Path (spline mode)).

Verification: tsx harnesses driving the pure geometry directly (the
spline-trim offset pattern) + typecheck/lint; visual pass in the editor
for the UI-facing bits (sockets retype on mode, visibleIf rows, header
control).
