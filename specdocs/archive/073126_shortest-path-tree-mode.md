# Shortest Path — tree mode (2026-07-31)

Status: **implemented 2026-07-31** (M1–M3 in one pass; typecheck + lint +
full `npm run check` green, plus a standalone tree-builder smoke test —
SPT depth = manhattan distance on a grid, MST < SPT total wire under
jittered costs, caps/limits/determinism/unreached all verified). **Needs
an in-browser pass** (M2/M3 temporal behavior especially). Deviations:
none structural. One addition beyond the spec text: an *unreached* point
parks its displayed glide position at itself, so a later connection grows
out of the point instead of flying in from stale data. One documented
greedy consequence: very low `max_children` (especially 1 = single
chain) can strand points once the chain boxes itself in — the
budget-starved case, by design.

A third `mode` on the Shortest Path node: pick ONE root point by index
slider and fan out to every reachable point as a **rooted tree** — paths
split but never re-join (a tree has exactly one route between any two
vertices, so re-intersection is impossible by construction). Shape
sliders morph the branching character; an update mode locks the topology
at frame 0 (edges stretch as points animate) or rebuilds live (with an
optional glide through reconfigurations).

## Motivation

- Points mode routes one A→B path, and picking endpoints by X/Y sliders
  + nearest-point snap is fiddly — the design intent here is an *easy
  mode*: one int slider, whole cloud connected, instant structure.
- The look this unlocks — veins / lightning / mycelium / circuit
  fan-outs growing from a source — currently requires stacking many
  Shortest Path nodes and never guarantees non-crossing routes.
- Temporal control is the other half: a web that *stretches* as its
  points drift (locked) vs. one that *rewires* as they move (live),
  with a glide option so rewires read as motion instead of popping.

## Node interface

`mode` enum grows `"tree"` (header control: `points | spline | tree`).
Existing modes untouched — saves back-compat, no schema bump (new params
fill from defaults).

`resolveInputs` (tree): `points` (points, required) only. The root is a
param, not a socket — params are exposable, so wiring a scalar into
`root_index` comes for free.

`resolveAuxOutputs` (tree): `points` aux (see Emission).

### Params (all `visibleIf` mode === "tree" unless noted)

| name | type | range | default | notes |
|---|---|---|---|---|
| `root_index` | scalar (int) | 0–10000, softMax 99 | 0 | clamped to count−1 (Select by Index clamp semantics) |
| `max_distance` | scalar | existing param | 0.1 | visibleIf extends: points OR tree — same hop-graph meaning |
| `wander` | scalar | 0–1 | 0.5 | 0 = direct (shortest-path tree: radial, lightning) ↔ 1 = minimal (spanning tree: least total wire, meandering veins) |
| `jitter` | scalar | 0–1 | 0 | seeded random inflation of edge costs — breaks geometric regularity into organic wobble |
| `seed` | scalar (int) | existing param | 0 | visibleIf extends: spline-random OR tree |
| `max_children` | scalar (int) | 0–12 | 0 | max branches splitting off any one point (root included); 0 = unlimited. Low values force long winding chains |
| `depth_limit` | scalar (int) | 0–200, softMax 50 | 0 | max hops from root; points beyond stay unconnected; 0 = off |
| `emit` | enum | `branches \| segments` | branches | subpath structure, see Emission |
| `update` | enum | `locked \| live` | locked | see Update modes |
| `smooth` | scalar | 0–2 s, softMax 1 | 0 | visibleIf update === "live". Glide time-constant; 0 = snap |

## Algorithm

New exported helper in [spline-graph.ts](../../src/engine/spline-graph.ts)
next to `shortestPathInGraph` (sharing its flat binary heap):

```
buildTreeInGraph(graph, root, { alpha, maxChildren, depthLimit, edgeCost })
  → { parent: Int32Array, depth: Int32Array, order: number[] }
```

- **Generalized Prim/Dijkstra** — one pass, one knob. Label `d[v]`,
  root 0; relaxation candidate over edge (u,v):
  `cand = alpha · d[u] + edgeCost(u,v)`. `alpha = 1 − wander`:
  alpha 1 ⇒ Dijkstra ⇒ shortest-path tree; alpha 0 ⇒ Prim ⇒ minimum
  spanning tree; between ⇒ a continuous morph of the two looks.
  Settle via the min-heap, record `parent`/`depth`/settle `order`.
- **Jitter** as `edgeCost = length · mul(i, j)` where `mul` is a
  deterministic bounded multiplier > 0 hashed from the *unordered
  point-index pair* (rand01-family hash on seed + pair) — NOT the edge's
  array index, so the wobble is stable frame-to-frame in live mode while
  point indices are stable (no shimmer).
- **max_children**: child budget charged at settle time. If a popped
  vertex's recorded parent has exhausted its budget, the vertex is
  re-relaxed through its settled neighbors with remaining budget and
  re-pushed; if none exists it stays unconnected. Deterministic
  (settle order is deterministic).
- **depth_limit**: no relaxation out of a vertex at the limit.
- `parent[root] = −1`; unreached vertices −2. Unreached points (out of
  hop range, over depth limit, budget-starved) simply don't emit.

Pure CPU, deterministic, no Math.random — same contract as the rest of
the node.

## Emission

- **`branches`** (default): one open subpath per tree *leaf*, running
  root → leaf along parent links. Subpaths overlap on shared trunks —
  intentional: Trim Path with a common trim animates the whole tree
  growing outward from the root, branches splitting naturally.
  `groupIndex` = branch index (leaf settle order) for per-branch
  styling / Select by Group. Anchors are handle-less polylines (house
  pattern — chain Set Spline Type to smooth).
- **`segments`**: one 2-anchor subpath per reachable non-root vertex
  (`[parentEnd, ownPos]`) — every edge drawn exactly once (clean under
  stroke opacity). `groupIndex` = the child's depth (depth-ring
  styling).
- **aux `points`**: the reachable points in settle order (≈ distance-
  from-root order — staggered Copy to Points cascades for free),
  original attributes intact (same contract as points mode's aux).

## Update modes

### `locked` (default) — topology captured, edges stretch

Per-node state `ctx.state["shortest-path:<nodeId>"]` stores
`{ parents, depths, order, captureKey }`. `captureKey` = stable string
of the topology inputs: resolved `root_index`, `max_distance`, `wander`,
`jitter`, `seed`, `max_children`, `depth_limit`, and the point *count*
(`emit`/`smooth` excluded — assembly-only). Recapture when: state
absent, captureKey mismatch, or **`ctx.tick === 0`**.

Every compute emits from the *stored parent indices* at the points'
**current positions** — connections persist, edge lengths stretch.

Consequences (all intended):

- Loop restart / playhead at frame 0 re-locks from frame-0 positions —
  deterministic per loop, matches "initialized at frame 0".
- Editing any topology param recaptures immediately at the playhead
  (locked feels live while authoring) and re-locks next pass through 0.
  Corollary: *animating* a topology param in locked mode degenerates to
  per-frame recapture — animate the root in live mode instead.
- Index stability is the contract: a count change forces recapture;
  sources that reshuffle point indices per frame belong in live mode.
- No `fingerprintExtras` needed: state only changes when params/count
  change (already fingerprinted) or at tick 0, where recapture is a
  no-op unless upstream changed (also fingerprinted). Scrubbing away
  from 0 and back with static points is cache-hit-sound.
- `dispose` deletes the state key.

### `live` — rebuild per compute

`smooth === 0`: pure function of inputs+params, no state, normal
caching. The tree rewires instantly as points move.

`smooth > 0` — **parent glide**: each non-root point owns exactly one
connection (to its parent), which makes transition correspondence
trivial. State keeps a *displayed* parent-end position `P̃(v)` per
point (+ `lastTime` for dt). Each compute, after the rebuild:

```
P̃(v) += (pos(parent(v)) − P̃(v)) · (1 − exp(−dt / smooth))
```

frame-rate-independent exponential glide; within a small ε of target ⇒
snapped converged. New/renumbered points initialize at target (snap in,
no flight from origin). Root change glides every edge at once.

- `fingerprintExtras` returns `ctx.time` **only while any glide is in
  flight** (state flag) — the node re-evaluates per frame during a
  transition and goes fully cacheable again at rest.
- `segments` + glide: the far anchor is `P̃(v)`. Trivially correct.
- `branches` + glide: chain assembly *breaks at any in-flight edge* —
  the gliding edge and its subtree emit as their own subpaths (rooted
  at the glide stub) until converged, then re-fuse into full
  root→leaf paths. Visual: a reconfiguring branch momentarily detaches,
  its stub glides to the new junction, and the tree heals. Subpath
  count varies during transitions — documented; for rock-stable Trim
  Path draw-ons use `locked` or `smooth 0`.

## Later / deferred

- Position-snap root (optional vec2 input like points mode's `start`)
  for cursor-driven roots without a Select-by-Index dance.
- Depth → groupIndex toggle on the aux points (depth-ring stamping).
- Tree-over-spline-network: the same rooted-tree growth on
  `buildSplineGraph` vertices (walk a wired network's own curved
  segments outward from a root group) — spline mode's counterpart.

## Milestones

- **M1 — Tree core (live-snap).** `buildTreeInGraph` in
  spline-graph.ts (alpha blend, jitter, max_children, depth_limit) +
  tree mode in shortest-path.ts: resolvers, params, branches/segments
  emission, aux points. Pure, stateless (`update` locked to live-snap
  behavior until M2 — ship the param disabled or defaulted to live).
  Verify in browser: Scatter → Shortest Path (tree) → Trim Path grow;
  wander/jitter/children/depth sweeps.
- **M2 — Locked update mode.** State capture + recapture rules +
  dispose; `update` default flips to locked. Verify: animate point
  positions (noise/Point Expression), topology persists + stretches,
  re-locks at frame 0, param edits recapture, count change recaptures.
- **M3 — Glide.** Displayed parent-end state, in-flight
  `fingerprintExtras`, segments glide + branches detach/re-fuse
  assembly. Verify: animated count/seed in live mode — transitions
  glide, converge, and the node stops re-evaluating at rest.
- **M4 — Bookkeeping.** Node `description` text, docs page sanity
  pass, devlist #203 DONE note, devguide touch if any invariant moved.
