# Accretive Growth (spec, 2026-08-02)

Status: **M1-M4 implemented 2026-08-02.** M1 = spine +
`space_colonization`; M2 = `dla`, `percolation`, `boundary` emission,
mode-dependent sockets, `headerControl`; M3 = `laplacian` (DBM); M4 =
`crack` + `hyphal` network modes and closed venation. Typecheck + lint + full
`npm run check` green, plus a standalone smoke test of the real compute
against a stubbed RenderContext (118 checks: prefix invariant,
determinism, slicing, all four emissions, id modes, wired inputs, param
interactions, DLA tangency/non-overlap/density, percolation adjacency and
compactness, Laplacian eta monotonicity and cell adjacency, boundary
closure, network extra-edge integrity and emission fallback, closed
venation, socket resolution, dispose). M5-M6 not started.
**Needs an in-browser pass.** Deviations from the spec text are recorded
in §8.

Survey: [080226_growth-systems-survey.md](080226_growth-systems-survey.md).

One of four growth nodes. This one is the **spine** — it defines the
shared conventions (§2) the other three reference, and it is the one that
forces the reusable machinery into existence.

Family A from the survey: *a frontier advances; new elements attach to
existing ones; nothing ever moves again.* The defining property is that
the structure at frame N **contains** the structure at frame N−1, which is
what makes it sliceable, scrub-safe, and cacheable end-to-end.

```
type:        "accretive-growth"
name:        "Accretive Growth"
file:        src/nodes/source/accretive-growth.ts
category:    "spline"      subcategory: "generator"
backend:     "webgl2"      (mask/field readback only; compute is CPU)
headerControl: { paramName: "mode" }
```

Placement follows **Space Fill** (`src/nodes/source/space-fill.ts`,
spline/generator): with nothing wired it still produces output
(self-seeded, self-scattered), so it is a generator that *accepts*
guidance rather than a modifier that requires input.

---

## 1. Modes

Seven, all sharing one frontier loop, one trace format, one emitter:

| mode | rule | look |
|---|---|---|
| `space_colonization` | tips step toward mean direction of nearby attractors; attractors consumed | trees, veins, deltas, coral fans |
| `dla` | random walkers stick on contact | frost, lichen, electrodeposition |
| `laplacian` | grow into boundary cell with p ∝ \|∇φ\|^η | **blob → coral → lightning** on one slider |
| `percolation` | grow into lowest-resistance frontier neighbour (`invasion`) or a uniformly random one (`eden`) | dendritic channels / spreading stains |
| `l_system` | string rewriting + turtle | botanical, fractal curves |
| `crack` | tips advance under stress, **terminate on hit** | mud crack, craquelure, shattered glass |
| `hyphal` | wandering tips, stochastic branching, **fuse on contact** | mycelium, neurites, creeping networks |

`crack` and `hyphal` produce networks, not trees (Q3) — see §5.

**Snowflake CA is deliberately NOT here.** Its rule is a diffusion field
over the whole grid, not a frontier attachment, and it has no meaningful
parent structure. It lives in Field/CA Growth. The `boundary` emission
option (§5) makes the two nodes' output spaces overlap on purpose.

---

## 2. Shared conventions (referenced by the other three specs)

### 2.1 Determinism

No `Math.random`. One seeded PRNG per trace, drawn in a fixed order
(Space Fill's `rng` precedent). Same params + same inputs ⇒ byte-identical
trace, which is what makes offline export exact.

### 2.2 Trace-and-slice (the timeline model, Q4)

Space Fill's pattern, generalised. The full growth run is simulated
**once** into a flat trace cached in `ctx.state`; the keyframable
`progress` param slices it. Scrubbing either direction is free, backwards
included, and nothing re-simulates.

```ts
interface GrowthTrace {
  count: number;             // elements placed
  pos: Float32Array;         // count*2, normalized [0,1]² Y-DOWN
  parent: Int32Array;        // count; -1 = root
  depth: Int32Array;         // count; hops from root
  birth: Float32Array;       // count; 0..1 normalized placement order
  thickness: Float32Array;   // count; Da Vinci, see 2.4
  heading: Float32Array;     // count; radians, direction of arrival
  root: Int32Array;          // count; which seed this element descends from
  extraEdges: Int32Array;    // pairs (i,j) — fusions/T-joins, network modes
  occupancy?: Float32Array;  // grid modes only, for `boundary` emission
  gridW?: number; gridH?: number;
}
```

State blob, keyed `ctx.state["accretive-growth:<nodeId>"]`:

```ts
{ trace: GrowthTrace | null, traceSig: string,
  emitTrace: GrowthTrace | null, emitSig: string, emitted: NodeOutput | null,
  maps: Record<string, MapCacheEntry | undefined> }
```

- **`traceSig`** — stable string over every *structural* input: mode, seed,
  all mode params, `max_elements`, plus a content signature for each wired
  map (the `MapCacheEntry.src` object identity, which is the
  devguide-blessed "upstream recomputed" signal). Excludes `progress`,
  `emit`, and styling params — those only affect the slice.
- **`emitSig`** — memo of the last emitted slice (`progress` + `emit` +
  id/width params). Re-emit only when it changes or the trace was rebuilt.
- `dispose` deletes the state key.

`timeline` enum, default `cached`:

- **`cached`** — retrace only when `traceSig` changes. A static setup
  traces once, ever.
- **`live`** — `traceSig` gains a per-frame token, so the whole trace
  rebuilds every frame. This is what you want when the attractor cloud or
  region mask is *animated during* the growth. Expensive by construction;
  the docs page says so plainly.

`fingerprintExtras` returns `ctx.time` only in `live` mode, so `cached`
keeps full fingerprint caching.

### 2.3 Field & mask sampling — reuse, don't rebuild

`src/engine/sim-kernel.ts` already exports exactly what's needed:

- `readMapBuffer(ctx, cache, name, val) → MapBuffer | null` — identity-
  cached single-channel float readback of a mask/image socket. A static
  field costs one readback ever; an animated one costs one per frame.
- `sampleMap(buf, u, v)` — bilinear.
- `buildMaskField(data, w, h, threshold) → MaskBuffer` +
  `sampleDist(buf, x, y)` — signed distance to a mask, for region
  containment and obstacle push-out.
- `buildSpatialHash(pos, count, cellSize, W, H, reuse) → SpatialHash` —
  counting-sort uniform grid, for attractor queries, contact tests, and
  fusion detection.

No new sampling infrastructure. Growth nodes are rules on top of these.

### 2.4 Attributes — Stage 0 (Q1)

Generic per-point attributes are a separate foundational spec. Growth
ships on the channels that already propagate:

| quantity | rides on | downstream |
|---|---|---|
| branch thickness | `PointsValue.scales` | Copy to Points instance size |
| arrival heading | `PointsValue.rotations` | oriented instances |
| branch id / depth ring / root id | `PointsValue.groupIndices` | group ramps, Select by Group |
| **birth time** | `SplineSubpath.driver` | existing `by: "driver"` colour source — age-ramped strokes, free |

**Thickness (Q2)** is Da Vinci's rule: `t(parent)² = Σ t(child)²`, computed
in one reverse pass over the trace after it completes, leaves seeded at
`tip_width`. Written into `scales` on the aux points and into `driver`'s
sibling channel on subpaths where the emitter supports per-subpath width.

### 2.5 Emission ownership

The emitter is **new code in
`src/engine/growth-emit.ts`**, not a refactor of `shortest-path.ts`.
Shortest Path's tree mode shipped 2026-07-31 and still needs its
in-browser pass; extracting its inline emitter now risks regressing a node
that isn't yet verified. The consolidation (Shortest Path tree mode
adopting `growth-emit.ts`) is a **later, separate** change — noted in
§9 Deferred.

---

## 3. Sockets

`resolveInputs` switches on `mode` (the `shortest-path` precedent — mode is
a `headerControl`, so socket churn on mode change needs the mode-anchored
group-pick pattern from `relax.ts`).

| socket | type | modes | meaning |
|---|---|---|---|
| `seeds` | points, optional | all | growth origins. Unwired ⇒ mode default (canvas centre, or region edge for `dla`) |
| `attractors` | points, optional | `space_colonization` | targets. Unwired ⇒ internally scattered at `attractor_count` |
| `region` | mask, optional | all | growth confined here. Splines coerce as filled silhouette. Unwired ⇒ full canvas minus `margin` |
| `obstacles` | mask, optional | all | carved out of the walkable region |
| `field` | mask, optional | `percolation` `laplacian` `crack` `hyphal` | mode-dependent scalar: resistance / attractor potential / stress magnitude / nutrient |

Primary output: **spline**. Aux output: **`points`** — the placed elements
in birth order, with the §2.4 attributes.

---

## 4. Params

### Universal

| name | type | range | default | notes |
|---|---|---|---|---|
| `mode` | enum | §1 | `space_colonization` | headerControl |
| `progress` | scalar | 0–1 | 1 | **the animation input**; slices the trace |
| `seed` | scalar int | — | 0 | every random draw |
| `max_elements` | scalar int | 100–200000, softMax 20000 | 5000 | hard budget (Q6) |
| `margin` | scalar | 0–0.25 | 0.02 | border buffer when `region` unwired |
| `timeline` | enum | `cached \| live` | `cached` | §2.2 |
| `emit` | enum | `branches \| segments \| boundary` | `branches` | §5 |
| `tip_width` | scalar | 0–1 | 0.1 | leaf thickness, Da Vinci seed |
| `id_mode` | enum | `branch \| depth \| root \| birth` | `branch` | what lands in `groupIndex` |

### `space_colonization` (Runions et al. 2005)

| name | range | default | notes |
|---|---|---|---|
| `attractor_count` | 10–20000 | 2000 | only when `attractors` unwired |
| `influence_radius` | 0–0.5 | 0.08 | tips see attractors within this |
| `kill_distance` | 0–0.2 | 0.015 | attractor consumed at this range |
| `step_length` | 0.001–0.05 | 0.006 | segment length per iteration |
| `venation` | `open \| closed` | `open` | open ⇒ nearest tip consumes (strict tree). **closed ⇒ shared, branches fuse into reticulate loops** — real leaf veins. Forces `segments` emission |
| `tropism_angle` | −180–180° | 90 | global bend direction (gravity/light) |
| `tropism_strength` | 0–1 | 0 | how hard |

### `dla` (Witten & Sander 1981)

Off-lattice (continuous positions, radius contact) — reads far more organic
than grid DLA at no extra cost.

| name | range | default | notes |
|---|---|---|---|
| `particles` | 100–100000 | 8000 | walkers released |
| `stick_probability` | 0.01–1 | 1 | <1 ⇒ walkers probe deeper ⇒ denser, less wispy |
| `contact_radius` | 0.001–0.05 | 0.004 | element radius |
| `drift_angle` / `drift_strength` | −180–180° / 0–1 | 0 / 0 | wind-swept, directional frost |
| `seed_shape` | `point \| region_edge \| seeds` | `point` | line/edge seeding ⇒ frost creeping off a silhouette |

Performance is the whole game: spawn walkers on a circle just outside the
current cluster radius, kill past an outer radius, take large steps when
far from the cluster (distance from the hash's nearest occupied cell), and
use `buildSpatialHash` for contact. Without these it is unusable; with
them 50k particles is fine.

### `laplacian` (DBM — Niemeyer et al. 1984; Kim & Lin 2007)

| name | range | default | notes |
|---|---|---|---|
| `eta` | 0–6, softMax 4 | 1 | **the headline knob**: →0 compact Eden blob, 1 = DLA coral, ≫1 = sparse lightning |
| `grid` | 64–512 | 256 | Laplace solve resolution |
| `relax_iters` | 1–200 | 20 | warm-started Gauss–Seidel/SOR sweeps per growth step |
| `attractor_bias` | 0–1 | 0 | how hard the `field` input pulls the discharge (art-directed lightning) |

Warm-start each step from the previous potential — the boundary barely
moves, so ~20 sweeps suffice after the first solve. This is the expensive
mode; it is also the one that most benefits from `cached`.

### `percolation`

| name | range | default | notes |
|---|---|---|---|
| `variant` | `invasion \| eden` | `invasion` | lowest-resistance frontier vs. uniform random frontier |
| `grid` | 64–1024 | 384 | |
| `resistance_contrast` | 0–1 | 1 | how much `field` biases growth; 0 ⇒ pure Eden regardless of variant |

Frontier is a min-heap — the same flat binary heap already in
`spline-graph.ts`. When `field` is unwired, resistance is seeded noise.
The hook: **growth eats through dark areas first and stalls at bright
ones**, so any image drives the shape.

### `l_system` (Prusinkiewicz & Lindenmayer 1990)

| name | type | default | notes |
|---|---|---|---|
| `preset` | enum | `fern` | fern / bush / algae / tree / koch / hilbert / dragon / **custom** |
| `axiom` | string | preset | `visibleIf preset === custom` |
| `rules` | string | preset | one `A=FB[+A]` per line; stochastic via `A=0.7:F[+A] \| 0.3:F[-A]` |
| `iterations` | scalar | 4 | fractional values interpolate segment length between N and N+1 ⇒ **smooth continuous growth** |
| `angle` | scalar | 25° | turtle turn |
| `length` / `length_decay` | scalar | 0.05 / 0.9 | per-depth taper |
| `angle_jitter` | 0–1 | 0 | stochastic wobble |
| `tropism_angle` / `tropism_strength` | — | 90° / 0 | the thing that stops L-system plants looking like clip art |

The grammar is a `string` param, exposable as a socket (the String node
already emits `string`; Expression node is precedent for text-authored
rules). Presets mean the sliders alone are a complete experience.

### `crack`

| name | range | default | notes |
|---|---|---|---|
| `crack_count` | 1–500 | 12 | independent initial cracks |
| `step_length` | 0.001–0.05 | 0.005 | |
| `branch_probability` | 0–0.5 | 0.02 | per step |
| `wander` | 0–1 | 0.15 | heading noise |
| `stress_alignment` | 0–1 | 0 | how hard `field`'s gradient orients propagation |
| `hit_radius` | 0.001–0.05 | 0.006 | terminate when this close to an existing crack |

The **T-junction termination** is what makes this look like cracked mud
rather than a tree — cracks stop dead on contact instead of continuing.

### `hyphal`

| name | range | default | notes |
|---|---|---|---|
| `tips` | 1–2000 | 40 | initial growing tips |
| `step_length` | 0.001–0.05 | 0.004 | |
| `branch_rate` | 0–0.2 | 0.02 | bifurcation probability per step |
| `wander` | 0–1 | 0.3 | |
| `nutrient_strength` | 0–1 | 0 | gradient ascent on `field` |
| `anastomosis` | boolean | true | fuse on contact ⇒ network, not tree |
| `fuse_radius` | 0.001–0.05 | 0.005 | |

---

## 5. Emission

New module `src/engine/growth-emit.ts`, three strategies over a sliced
trace (elements with `birth ≤ progress`):

- **`limbs`** (default, added in M1 — see §8.1) — one open subpath per
  branch id: the maximal chain between two junctions, prefixed by its
  junction anchor so limbs connect. Continuous polylines, so width
  profiles / Offset Path / Along Path all behave, at **linear** anchor
  count (`elements + limbs`). Branch ids come from the full trace, so a
  limb keeps its identity — and its colour — as `progress` grows the tree.
- **`branches`** — one open subpath per leaf, running root → leaf along
  parent links. Subpaths overlap on shared trunks, which is intentional:
  a common Trim Path animates the whole structure growing outward.
  `groupIndex` per `id_mode`; `driver` = the leaf's birth time.
  **Tree modes only** — rejected (falls back to `segments`) when
  `extraEdges` is non-empty. Costs `Σ depth(leaf)` anchors — measured at
  1.57M for a 15k-element tree (47ms per slice) against `limbs`' 22.9k
  (2.8ms), which is why it is no longer the default.
- **`segments`** — one 2-anchor subpath per edge, parent links *and*
  `extraEdges`. Every edge drawn exactly once, clean under stroke opacity.
  `groupIndex` per `id_mode`; `driver` = the child's birth time. **This is
  the only valid emission for `crack`, `hyphal` with anastomosis, and
  `space_colonization` closed venation** (Q3).
- **`boundary`** — `marchingSquares(occupancy, gridW, gridH, { iso: 0.5 })`
  from `engine/marching-squares.ts`, giving the silhouette of the occupied
  set as closed subpaths. Only meaningful for the grid modes (`dla`,
  `laplacian`, `percolation`); hidden otherwise via `visibleIf`. This is
  how Eden blobs and DLA clusters become fillable shapes.

Anchors are handle-less polylines throughout (the house pattern) — chain
**Set Spline Type** to smooth them.

---

## 6. Milestones

1. **M1 — Spine + space colonization.** `growth-emit.ts` (`branches` /
   `segments`), the `GrowthTrace` format, trace/slice state + `traceSig` /
   `emitSig` memoing, `dispose`, region/obstacle handling via
   `buildMaskField`, Da Vinci thickness pass, aux points with §2.4
   attributes, and `space_colonization` (open venation only). Verify:
   Text → coerce to mask → `region`, Scatter → `attractors`; `progress`
   keyframe grows the tree; Stroke coloured `by: "driver"` shows age.
2. **M2 — Grid modes.** Occupancy grid + frontier min-heap shared by
   `dla` and `percolation`; `boundary` emission via `marchingSquares`;
   DLA's spawn-ring / kill-radius / large-step optimisations and
   `buildSpatialHash` contact. Verify: 50k-particle DLA is interactive;
   `percolation` with a photo on `field` grows through the dark.
3. **M3 — Laplacian.** Warm-started SOR solve, `eta`, `attractor_bias`.
   Verify: the eta sweep morphs blob → coral → lightning; a wired
   attractor mask steers the bolt.
4. **M4 — Network modes.** `extraEdges` + fusion detection via the spatial
   hash; `crack` (T-termination) and `hyphal` (anastomosis);
   `space_colonization` closed venation. Verify: `branches` correctly
   falls back to `segments`; no duplicate edges.
5. **M5 — L-systems.** Parser (axiom + rules + stochastic weights),
   turtle with a bracket stack, presets, fractional `iterations`
   interpolation, tropism. Verify: each preset; a custom grammar via a
   wired String node.
6. **M6 — Polish.** `description` copy, docs page, cost notes for DLA /
   Laplacian / anchor budgets (Q6), devlist entry, devguide node-list
   touch.

---

## 7. Deliberately not doing

- **No GPU path.** This is the CPU structure pipeline; the trace-once model
  means a single build cost amortised over the whole timeline.
- **No per-frame agent simulation.** Elements never move after placement —
  that's Behavioral Growth's job, and it's what buys sliceability here.
- **No generic point attributes** in v1 — §2.4 Stage 0 covers the payoff;
  Stage 1 is its own spec.

## 8. M1 implementation deviations

### 8.1 `limbs` emission added, and made the default

Measured during M1: `branches` costs `Σ depth(leaf)` anchors, which on a
bushy tree is near-quadratic — 202k anchors for 5k elements, 1.57M for
15k, at 47ms per `progress` change. That is unusable for the keyframed
reveal this node exists to serve.

`branches` earns that cost in Shortest Path because tree mode has no
timeline of its own and must delegate the reveal to Trim Path. **This node
owns `progress`**, so the overlapping-chains trick buys nothing here.
`limbs` keeps continuous per-branch paths at linear size and is now the
default; `branches` remains for Trim-Path-driven setups, with its cost
documented in the node description.

### 8.2 No `timeline: cached | live` param

§2.2 specced an enum whose `live` arm retraced every frame for animated
inputs. It turned out to be unnecessary: a wired points/mask input mints a
fresh value object whenever its upstream recomputes, and the node already
retraces on input-identity change (Space Fill's rule). An animated
attractor cloud therefore re-grows per frame in the default mode, and a
static one traces once, ever — which is exactly what the enum was meant to
select between. Shipping a param with no observable effect would have been
worse than not shipping it.

### 8.3 Stall-reach (not in the spec)

Plain Runions stops dead when no node has an attractor inside its
influence radius — the "seed sits outside the attractor cloud" case, which
presents to the user as a broken node with no feedback. M1 bridges it: on
a stalled pass, the frontier node nearest the nearest surviving attractor
steps toward it, repeating until growth enters influence range. Tropism is
deliberately **not** applied to a bridging step, since a strong tropism
pointing away from the cloud would stall the bridge indefinitely.

### 8.4 Region/obstacles use `readDriver` + a blocked bitmap

§2.3 proposed `buildMaskField` / `sampleDist`. Space colonization only
needs an inside/outside test, not a distance, so M1 uses Space Fill's
proven `readDriver` + thresholded `Uint8Array` path. The SDF becomes
worthwhile in M4 (crack/hyphal push-out) and in Differential Growth, where
containment needs a gradient.

### 8.5 Smaller resolved behaviours

- **`progress` 0 is fully empty, seeds included.** Iteration 0 holds the
  seeds, so a `<=` slice would park a stray dot per seed at the start of
  every draw-on. `progress` is a reveal; 0 reveals nothing.
- **A wired socket is the answer even when empty.** An `attractors` input
  filtered down to zero points grows nothing, rather than silently falling
  back to the internal random scatter. Same for `seeds` and the default
  centre seed. Only an *unwired* socket takes the default.
- **`mode` ships with one option and no `headerControl`.** A single-entry
  header dropdown reads as broken; the header control arrives with M2's
  second mode. Adding enum options later is save-compatible.
  *(Resolved in M2 — three modes, `headerControl` now on.)*

### 8.6 M2 — DLA needed two algorithmic corrections

The textbook description in §4 (`dla`) is right but omits the two things
that decide whether the mode is usable at all. Both were found by
measurement, not by reading.

**Free-space jumps need a LOCAL emptiness certificate.** The standard
trick — jump `d − R_max − 2r` toward safety using the cluster's bounding
radius — is worthless for a fractal aggregate, because most of the area
inside `R_max` is empty fjord. Walkers there crawl one contact radius at a
time through vast voids: 11.6s for a 50k-particle run. Replacing it with
an expanding Chebyshev ring search over the cell grid (`cellGridEmptyRings`,
depth 16) gives a local certificate that is cheap exactly where it
matters — near the cluster the first ring hits immediately; in a void the
scan runs to depth and buys a jump of ~30 contact radii. **11631ms → 401ms,
a 27× speedup.**

**Contact must be a swept ray/disc solve, not a tangent projection.**
Landing a walker tangent to whatever it was *nearest* routinely places it
inside a THIRD particle in a packed cluster (measured minimum separation
1.64r against the required 2r). Rejecting those landings and continuing is
worse still: the walker resumes from inside contact range, re-hits
immediately, and burns its entire step budget without ever sticking.
Solving for the earliest ray/disc entry along the step (`cellGridSweep`)
is both the physically correct first-passage contact point and
overlap-free by construction — the first disc entered along a ray from a
clear position cannot have been reached *through* another disc.

**Escaped walkers re-inject rather than die.** A 2D walk escapes the kill
radius often; discarding those particles wasted most of the budget. At
`r_kill ≫ r_spawn` the return angle is near-uniform, so re-placing on the
spawn ring is the standard first-passage approximation.

Measured after all three (1920×1080, 20k particles): particle radius
0.0015 → 10773 elements in 600ms; 0.012 → 397 elements in 109ms. Element
count against cluster radius tracks DLA's fractal dimension. Every
configuration terminates by **filling the canvas** (bbox 1877×1037 of an
1877×1037 walkable area), which is why raising `particles` past that point
adds nothing — worth a line in the docs page rather than a code change.

### 8.7 M2 — `boundary` filters degenerate contours and pads its grid

Two defects, one pre-existing and one mine:

- **`engine/marching-squares.ts` emits sub-cell open slivers.** A clean
  circle SDF at 256² comes back as 9 subpaths, 8 of them open 2-anchor
  fragments — the iso crossing passes almost exactly through a grid corner,
  the same point is produced by several cells with float noise, and the
  chain walk can't link them. This is **pre-existing and affects every
  caller** (`shape-cells.ts` too). Not fixed here — shared code, and the
  primary contour is correct. `boundary` drops open fragments shorter than
  one cell, which cleared every spurious contour in testing.
- **The grid is padded past the canvas** by more than one stamp radius. An
  unpadded grid clips the silhouette of any cluster reaching the canvas
  edge, leaving open contours that can't be filled. With padding the
  outer ring is provably never stamped, so contours always close —
  verified with `margin: 0`, which puts growth hard against the edge.

### 8.8 M2 — interactive performance pass

Reported after the first browser session: DLA and percolation felt
"extremely slow". They were, and none of it showed up in the one-shot
trace benchmarks — **the cost that matters is a slider drag**, where every
frame retraces *and* re-emits. Five separate problems, all found by
measuring rather than reading:

| fix | before | after |
|---|---|---|
| DLA: saturation guard + cheap failure | 589ms | 22ms |
| Space col: bounding-box reject for out-of-range attractors | 3392ms | 234ms |
| Space col: incremental grid instead of per-iteration hash rebuild | 606ms | 119ms |
| Space col: touched-list instead of O(count) sweeps | 104ms | 86ms |
| Boundary: squared distance, one sqrt per cell | 11.5ms | 4.6ms |

1. **DLA saturates against the canvas or region and then burns the rest of
   the particle budget discovering it.** Every configuration terminates by
   filling the available area, so `particles` past that point buys
   nothing — 40k particles inside a masked region cost 589ms for *two*
   extra elements. A consecutive-failure guard (Space Fill's jam-run
   precedent) ends the run instead. Also measured and rejected: bouncing
   blocked landings instead of abandoning the particle. It sounds
   strictly better and is 12× worse (73ms → 877ms) because a saturated
   walker then bounces for its entire step budget — *and* it yielded
   fewer elements.
2. **An attractor with nothing in range is the expensive case.** The ring
   search must walk its whole neighbourhood to prove emptiness, and at a
   small `influence_radius` that's most attractors on most iterations.
   Distance to the cluster's incrementally-maintained bounding box is a
   sound lower bound, so an O(1) test skips the search entirely. This was
   the single biggest win in the pass: a 14× cliff on a perfectly
   reasonable setting.
3. **The spatial hash was rebuilt every iteration.** `buildSpatialHash` is
   a counting sort — right for a population that moves, pure waste for one
   that only ever appends. At a small influence radius the grid is tens of
   thousands of cells and clearing it dominated everything. Space
   colonization now shares DLA's incremental head/next grid, and
   `SpatialHash` is no longer used by this node at all.
4. **Per-iteration bookkeeping was O(count) when ~5 nodes grow.** Three
   count-length array clears plus a full sweep, ×900 iterations. Replaced
   with a list of the nodes actually influenced that pass.
5. **`boundary` spent 87% of its time in `Math.hypot`.** Accumulating
   squared distance and taking the root once per cell (not once per
   element-cell pair) moves the sqrt out of the hot loop.

Also fixed: the stall bridge re-scanned every attractor against the
frontier on each stalled pass. Having paid for the scan it now walks the
whole way to the chosen attractor.

**Where it stands** (1920×1080, slider drag = retrace + re-emit per
frame): percolation 5–8ms, space colonization ~15–50ms, DLA ~68ms. DLA is
now the slowest and is dominated by honest walk work rather than by any
pathology; if it still feels heavy in practice, the lever is the default
`particles` / `contact_radius` pairing rather than more optimisation.

---

### 8.9 M3 — Laplacian needs a local re-solve, not a global one

The spec's §4 recipe — "warm-started Gauss–Seidel/SOR, ~20 sweeps per
growth step" — is unusably slow taken literally: **12967ms** at the
default grid for 5000 elements, 7190ms at grid 256, and cost rising with
`eta` on top (2880ms at eta 4, because `Math.pow` runs over every
candidate on every step).

The fix follows from the physics the spec already states. Grounding one
more cell perturbs the potential *mostly in its own neighbourhood*; the
far field barely moves. So a full-domain relax per step re-derives an
answer that was already correct almost everywhere. M3 instead:

- converges the field **globally once** before the first pick (opening
  moves made against `phi = 1` everywhere would never recover their
  character),
- relaxes a **±12-cell block around the new site** after each step,
- runs a full-domain pass every **32** steps to keep the far field honest,
- and special-cases integer `eta` (0–4) to multiplication instead of
  `Math.pow`.

Measured: **12967ms → 617ms** at grid 384 / 5000 elements (21×), 7190 →
458ms at grid 256, and the eta sweep flattens from 82–2880ms to 82–145ms.
The η monotonicity test (radius of gyration strictly increasing across
eta 0 → 1 → 4, plus a falling leaf fraction) still passes, which is the
evidence that the approximation preserved the look rather than just the
speed.

Remaining: at the default grid 384 a slider drag is ~617ms. Laplacian
shares the `grid` param with percolation, whose 384 default suits it far
better. Rather than a hidden per-mode clamp, the node description says
plainly that this is the expensive mode and that Grid / Max elements drive
its cost. Worth revisiting if it grates in practice — a dedicated
`lap_grid` defaulting to ~192 is the obvious alternative.

### 8.10 M4 — network modes

`crack` and `hyphal` ship as **one tip-walker engine**. Tips advance under
a heading, wander, branch stochastically, and die on contact with existing
growth, recording an `extraEdges` pair as they go. The mechanics of a
crack T-ing into an older crack and two hyphae anastomosing are identical;
what actually separates the modes is **seeding** — cracks nucleate at
scattered origins each propagating in both directions, hyphae radiate from
their seeds as one connected organism. That is a real structural
difference (many roots vs. one), unlike the parameter defaults, so the two
modes earn their separate names without duplicating an algorithm.

Three bugs worth recording, all found by measurement:

1. **Origins vs. tips.** Minting a node per *tip* rather than per *origin*
   stacks coincident roots: crack got two per nucleation site, and hyphal
   got 24 at a single point — where every tip instantly "contacted" one of
   its 23 co-located siblings and fused on its first step, yielding 92
   elements instead of a network.
2. **Radial siblings need a grace depth.** Even with one shared origin
   node, `n` tips leaving radially sit `2*pi*r/n` apart, so they are inside
   the contact radius until `r > n*hit/(2*pi)`. Contact testing is
   suppressed below that depth — computed from the seeding geometry, not
   guessed.
3. **`limbs` silently dropped every fusion.** Only `branches` had the
   network fallback, so the default emission rendered a network as a plain
   tree (crack: 120 subpaths covering 70 invisible joins). `limbs` now
   appends the extra edges as their own short subpaths, keeping continuous
   limbs *and* drawing the joins. `branches` still falls back to
   `segments` outright, since a root→leaf chain walk genuinely cannot
   represent a graph.

**Closed venation is an approximation, and needs a visual call.** Runions'
closed model decides attractor influence via a relative-neighbourhood
graph; this implements the cheaper proximity rule — a new node fuses with
any non-lineage node within `fuse_radius`. Tightening that radius from
`kill_distance` to a dedicated param barely moved the fusion count
(2477 → 2476 of 5000 nodes), which says these are not marginal contacts:
converging branches genuinely land on top of each other, because space
colonization drives many branches at the same attractor cluster. ~50% of
nodes fusing may well be *right* for leaf venation, which is densely
reticulate — but that is a judgement the browser has to make. `fuse_radius`
is the knob if it wants thinning.

Cost (1920×1080): crack 3–7ms, hyphal 1–2ms, closed venation 43ms at 5k
elements / 355ms at 14k.

---

## 9. Deferred

- **Shortest Path tree mode adopts `growth-emit.ts`.** Two copies of the
  parent-array emitter is the known duplication; consolidate once tree
  mode has had its in-browser pass.
- Attractor **re-seeding** during growth (attractors that respawn) —
  interesting for endless growth, needs a `live` timeline story.
- A `Grow From Spline` seeding mode (growth starting along a curve rather
  than from points).
