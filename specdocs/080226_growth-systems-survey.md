# Growth systems — survey & brainstorm (2026-08-02)

Status: **survey only.** No spec, no milestones. Input to a design Q&A.

Premise (owner): *"create points, give them rules, play timeline"* — and a
hunch that this splits into **boids** (points with goals/rewards/rules) and
**growth** (a system evolving under rules), possibly the same node.

This doc surveys the algorithm space, then argues the split is real but
cuts in a different place than boids-vs-growth.

---

## 1. The axis that actually matters

Not "agents vs. growth." The load-bearing distinction is **what the
timeline does to the population**, because that determines the data
contract, the emission code, and the caching strategy:

| Family | Population over time | Output is | Timeline = |
|---|---|---|---|
| **A. Accretive** | grows; elements never move once placed | the **accumulated record** (a tree/network) | reveal of a fixed trace |
| **B. Differential** | grows by *subdividing* an existing curve | one evolving curve, whole-cloth | genuine simulation |
| **C. Behavioral** | fixed; elements move | **current state** (+ optional trail history) | genuine simulation |
| **D. Field/CA** | no discrete elements | an image | genuine simulation |

A and C are the two the owner intuited, but they are *further* apart than
they look: an accretive system's output at frame N **contains** its output
at frame N−1 (monotone, sliceable, cacheable end-to-end), while a
behavioral system's does not. That single property is why A can use the
Space Fill trick (simulate once, `progress` slices) and C cannot.

B is a third thing nobody named — fixed topology, exploding geometry — and
it is the family with **zero coverage in the current library** and the most
distinctive look per unit of code.

---

## 2. Family A — Accretive / branching growth

The shape: *a frontier advances; new elements attach to old ones; nothing
ever moves again.* Every algorithm below produces the same data structure —
`parent: Int32Array` + positions + birth order — which is **exactly what
`buildTreeInGraph` already emits**, so they can all share Shortest Path's
`branches | segments` emission and its aux points output.

### A1. Space Colonization (Runions et al. 2005) ★

Scatter attractors in a region; each frontier tip steps toward the mean
direction of attractors within `influence_radius`; attractors within
`kill_distance` are consumed. Repeat.

- **Look:** trees, veins, leaf venation, river deltas, coral fans, lungs.
- **Knobs:** influence radius, kill distance, step length, attractor
  count/seed, initial tip direction, tropism vector (gravity/light bend).
- **Why it's the strongest candidate:** the attractor cloud *is* a points
  socket and the region *is* a mask socket — so "grow a tree into this text
  silhouette / into this photo's dark areas" is free. Art-direction is
  spatial, not numerical, which suits the app.
- **Open vs. closed venation** (same paper): open = each attractor
  consumed by its nearest tip → strict tree. Closed = attractor shared by
  all tips within reach → branches **fuse**, producing reticulate loops
  (real leaf veins, mycelium anastomosis). One boolean, two completely
  different structural characters. Note: closed mode breaks the tree
  invariant, so emission needs the segments path, not branches.
- **Cost:** O(attractors × tips) per step, trivially gridded. Cheap.

### A2. DLA — Diffusion-Limited Aggregation (Witten & Sander 1981)

Random walkers released far away stick on contact with the cluster.

- **Look:** frost, lichen, copper electrodeposition, dust bunnies, coral.
- **Knobs:** stick probability (<1 ⇒ walkers probe deeper ⇒ denser, less
  wispy), walker drift/bias (wind-swept, directional frost), seed geometry
  (point ⇒ radial blob; line ⇒ frost creeping off a window edge; **mask
  boundary ⇒ growth off any silhouette**), multiple seeds.
- **Off-lattice** (continuous positions, radius contact) reads far more
  organic than grid DLA and costs nothing extra.
- **Cost:** naïve is brutally slow; the standard fixes (spawn walkers on a
  circle just outside the current cluster radius, kill past an outer
  radius, large steps when far from the cluster, uniform grid for contact)
  make it fine at 10k–50k particles.

### A3. DBM / Laplacian growth (Niemeyer et al. 1984; Kim & Lin 2007) ★

Solve Laplace's equation on a grid with the cluster at potential 0 and a
far boundary at 1; grow into a candidate boundary cell with probability
∝ |∇φ|^η.

- **The η knob is the headline:** η→0 gives compact Eden blobs, η=1 gives
  DLA coral, η≫1 gives sparse jagged **lightning**. One slider morphs
  blob → coral → lightning. Structurally identical to the `wander` slider
  in Shortest Path tree mode (Dijkstra↔Prim), which is a proven UX shape
  in this codebase.
- **Also:** the boundary condition is an image, so an attractor mask pulls
  the bolt toward a target (this is how film lightning is art-directed).
- **Cost:** an iterative Laplace solve per growth step. Warm-started
  Gauss–Seidel/SOR on a 256² grid is acceptable; it's the expensive one in
  this family and would want the pre-sim-once strategy.

### A4. L-systems (Prusinkiewicz & Lindenmayer 1990)

String rewriting + turtle interpretation.

- **Look:** the canonical botanical vocabulary; also tilings, ferns,
  Hilbert/Koch/dragon curves.
- **Variants worth having:** stochastic (multiple rules per symbol with
  weights) to break repetition; parametric (lengths/angles carried in the
  symbol) for tapering; **tropism** (a global bias vector bending every
  segment) which is what makes L-system plants stop looking like clip art.
- **UX problem:** the grammar is a *string*, not sliders. Mitigation: ship
  a preset library (fern, bush, algae, Koch, Hilbert, plant-with-flowers)
  plus numeric overrides for angle, length decay, thickness decay,
  iterations, stochastic jitter, tropism. Expose the raw grammar behind a
  disclosure for the people who want it — the `string` socket already
  exists, and the Expression node is precedent for text-authored rules.
- **Timeline:** `iterations` is integer, but interpolating segment length
  between iteration N and N+1 gives smooth continuous growth for free.

### A5. Eden growth / invasion percolation

Eden: add a uniformly-random cell adjacent to the cluster → compact,
rough-edged blobs (bacterial colonies, lichen patches, spreading stains).
Invasion percolation: always grow into the *lowest-resistance* neighbor of
a random field → fingering, dendritic channels.

- **The hook:** the resistance field is an **image input**. Growth eats
  through dark areas first, stalls at bright ones. That's a photo-driven
  growth mode with a two-line rule.
- Dead cheap (a priority queue over the frontier), and it's the same
  min-heap already sitting in `spline-graph.ts`.

### A6. Crack / fracture propagation

Crack tips advance under a stress field, branch at concentrations, and —
critically — **terminate when they hit an existing crack** (T-junctions,
not Y-junctions).

- **Look:** mud cracks, craquelure, shattered glass, dried paint, parched
  earth. Genuinely distinct from every branching look above precisely
  because of the termination rule.
- The stress field can be an image (directional crack alignment) or
  isotropic. Hierarchical variant: each new crack subdivides a cell,
  producing the classic mud-crack cell-size distribution.

### A7. Snowflake CA (Reiter 2005)

Hex-grid, two-state, three parameters (α diffusion, β background vapor,
γ vapor addition). Produces astonishing real-snowflake variety.

- Tiny, deterministic, and the parameter space *is* the interest. Almost
  a freebie once a hex-grid frontier walker exists.
- Same slot: general **anisotropic dendritic solidification** — growth
  rate modulated by cos(k·θ) gives k-fold dendrites (6 = snow, 4 = metal).

### A8. Hyphal / mycelium / neurite growth

Tip-based: each tip has a heading, wanders under noise, branches
stochastically at a rate, follows a nutrient gradient (image input), and
**anastomoses** — fuses on contact with an existing filament.

- Mechanically it's A1-closed-venation + a wander term, but the *feel* is
  different: no global attractor cloud, everything is local. Good "creeping
  network" look; also the axon-guidance / neuron-dendrite look.

### A9. Packing-as-growth

Circle packing / random sequential adsorption / ballistic deposition —
elements accrete by *placement* rather than by extension. Timeline =
insertion order, optionally with each element inflating from 0 to its final
radius. Partially adjacent to existing Stipple/Voronoi/Scatter, so lower
priority, but "circles grow until they touch" is a real and separate look.

---

## 3. Family B — Differential growth ★★

**Nothing in the library does this, and it is the highest look-per-line
ratio in the survey.**

The rule, on a polyline (open tendril or closed loop):

1. every node repels neighbors within `repulsion_radius` (spatial hash),
2. every node is attracted along the curve to its two chain neighbors,
3. an edge longer than `split_length` gets a **new node inserted**,
4. optional: bending stiffness, internal pressure, containment mask.

Because length is created faster than the ambient space can absorb it, the
curve **must buckle**. Out falls: brain coral, kelp, ruffled leaf margins,
intestines, Nervous System's *Floraform*, inconvergent's differential line
work.

- **Growth bias is where the modes live:** uniform (isotropic ruffles),
  curvature-driven (convex regions grow faster ⇒ cauliflower/broccoli),
  **mask-driven** (insert only where an image is bright ⇒ art-directed
  ruffling), noise-driven, or per-group.
- **Fit is excellent:** spline in → spline out. `relax` already does
  Jacobi-style pairwise push-apart with deterministic coincident handling;
  `sim-kernel` already has a spatial hash; Set Spline Type already re-fits
  handles on a growing polyline. Closed loops give blobs, open give
  tendrils, and multiple subpaths that repel *each other* give the packed
  colony look.
- **Timeline:** genuine per-frame simulation (Family B is not sliceable —
  the geometry at frame N doesn't contain frame N−1). Sim-Zone-style
  stateful advance, or advect-points' `accumulate` precedent.
- **Cost:** O(n) with the hash; anchor count is the real budget (a good
  ruffle is 2k–20k anchors), so it needs an anchor cap + a decimation story.

---

## 4. Family C — Behavioral / agent systems

Fixed population, positions evolve, output is current state (+ trails).
This is the "boids" half of the owner's intuition. Note how much of it is
**Advect Points with a neighbor term added** — same field sampling, same
trail ring buffer, same accumulate/reset semantics.

### C1. Steering behaviors (Reynolds 1987, 1999)

Boids' separation/alignment/cohesion is three entries in a much longer
catalog: seek, flee, arrive, pursue, evade, wander, obstacle avoidance,
wall following, containment, path following, flow-field following,
unaligned collision avoidance, leader following, queuing.

- **Design shape:** a *weighted stack* of behaviors rather than one
  algorithm — each with a weight slider and optional socket. That is the
  honest, art-directable answer to the owner's "goals and rewards."
- Predator/prey as a second tagged population (via `groupIndex`) gives
  murmuration-under-attack for almost nothing.

### C2. Vicsek / active matter (1995)

Alignment + angular noise, nothing else. One knob (noise) drives a genuine
order/disorder phase transition — swirls to chaos. Minimal and elegant.

### C3. Physarum / slime mold (Jones 2010) ★

Agents sense a trail field at three points (ahead, ahead-left,
ahead-right), rotate toward the strongest, step, and **deposit** into the
field; the field diffuses and decays.

- **Straddles A and C exactly**: fixed-population moving agents (C), but
  the *visible output is the deposited field* (A-like accumulation).
- **Look:** the self-optimizing vein/transport network that has become the
  signature generative-art image of the last decade.
- **Fit is unusually good here:** the trail map is an image (they already
  have blur/decay infrastructure), the agents are points, and Advect Points
  already samples images at point positions. The missing piece is the
  agents *writing back* into an image — which the Sim Zone's image
  ping-pong already supports.
- Knobs: sensor angle, sensor distance, turn rate, step size, deposit
  amount, decay rate, diffusion radius, population.

### C4. Stigmergic optimization — ACO & Tero et al. (2010)

Same deposit-and-reinforce idea, but on a *graph*: pipes carrying flow
thicken, unused pipes atrophy. Tero's *Science* paper reproduced the Tokyo
rail network from slime mold. Given `spline-graph.ts` already exists, this
would be "point cloud + sources/sinks → an evolving efficient network,"
a natural companion to Shortest Path's tree mode.

### C5. Chemotaxis / run-and-tumble

Gradient ascent with stochastic reorientation. Advect Points' `gradient`
field mode is already the deterministic version of this; adding tumble
noise is a small delta.

### On "goals and rewards"

Worth stating plainly before it gets specced: **don't build reinforcement
learning.** Learned policies are nondeterministic, slow to converge, and
fundamentally un-art-directable — the opposite of what a scrubbable
timeline needs. The two tractable framings that *feel* like goals:

- **Utility/steering weights** (C1) — deterministic, immediate, sliders
  map to visible behavior.
- **Stigmergy** (C3/C4) — the "reward" is a decaying field the agents both
  write and read. Optimization emerges, stays deterministic, and is
  *visible* (the field is renderable), which is the property that makes it
  art rather than a black box.

---

## 5. Family D — Field automata

Already partly covered by `reaction-diffusion` and `watercolor-ink`. Listed
for completeness; each is an image→image rule and would belong grouped with
RD, not with a growth node.

- **Cyclic CA** (rock-paper-scissors, k states) — spiral waves, extremely
  distinctive, ~20 lines.
- **Lenia** (Chan 2019) — continuous-space/time/state CA; emergent
  self-organizing "creatures." Novel, and nobody has it in a motion tool.
- **SmoothLife**, **Larger-than-Life** — continuous Game of Life.
- **Excitable media** (FitzHugh–Nagumo / BZ) — target patterns, spirals.
- **Abelian sandpile** — deterministic, fractal, unlike anything else.
- **Langton's ant / turmites** — agents on a grid; trivially cheap.
- **Wolfram 1D CA scrolled down the canvas** — the timeline *is* the
  spatial axis, which is a cute fit for a motion tool.

---

## 6. What already exists that these reuse

This is the argument for why a growth node is mostly *rules*, not plumbing:

- **`shortest-path` tree mode** — `parent: Int32Array` + depth + settle
  order, and the `branches | segments` emission built on top (root→leaf
  subpaths for Trim Path draw-ons; per-edge 2-anchor subpaths for clean
  stroking). **Every Family A algorithm produces exactly this structure.**
- **`space-fill`** — deterministic trace cached in `ctx.state`, `progress`
  param slices it. Scrub anywhere including backwards, export-exact,
  cache-friendly. This is the correct default timeline model for Family A.
- **`advect-points`** — the `integrate | accumulate` mode duality (pure &
  cacheable vs. stateful per-frame), the reset rules (scene wrap,
  count migration), the identity-cached 256² image readback + bilinear
  sampler, and the trail ring buffer. Directly reusable for C.
- **Sim Zone** — image ping-pong for anything writing back into a field
  (Physarum, CA).
- **`relax`** (pairwise push-apart, deterministic) and `sim-kernel`'s
  spatial hash — the two pieces Family B needs.
- **`spline-graph.ts`** min-heap — invasion percolation, ACO, Tero.
- **Region masks everywhere** — `space-fill` already takes region +
  obstacle masks; growth wants exactly the same two sockets.

---

## 7. So: one node, or several? → **four, specced separately**

Split by output topology. Names are the owner's (2026-08-02); each node
has its own spec:

| Node | Spec | Family | Emits | Timeline model |
|---|---|---|---|---|
| **Accretive Growth** | [080226_accretive-growth.md](080226_accretive-growth.md) | A | tree/network (parent array) + region boundary | trace once + `progress` slice (Space Fill), `live` for animated inputs |
| **Differential Growth** | [080226_differential-growth.md](080226_differential-growth.md) | B | one evolving spline | stateful per-frame — **not sliceable** |
| **Behavioral Growth** | [080226_behavioral-growth.md](080226_behavioral-growth.md) | C | points + trails + deposit field | `integrate \| accumulate` (Advect Points) |
| **Field/CA Growth** | [080226_field-ca-growth.md](080226_field-ca-growth.md) | D | image + boundary spline | stateful per-frame — **not sliceable** |

Accretive Growth is the **spine**: its §2 defines the conventions
(determinism, trace-and-slice, field sampling, attribute channels,
emission ownership) the other three reference rather than restate.

One mode moved during speccing: **snowflake CA belongs to Family D, not
A** (§A7 above notwithstanding) — its rule is a whole-grid diffusion with
no frontier-attachment step and no parent structure, so it has nothing to
emit as branches. It ships in Field/CA Growth. The two nodes meet at the
silhouette instead: Accretive gains a `boundary` emission and Field/CA a
`boundary` aux, both via `engine/marching-squares.ts`.

The reason not to fuse A and C into one node is not conceptual purity — it
is that their **cache semantics are incompatible**. A is monotone and
sliceable, so it can be a pure function of `(params, progress)` and stay
fully cacheable. C is path-dependent and must bust the fingerprint every
frame. Cramming both behind one `mode` enum means the node is
worst-case-stateful always, and Family A loses scrub-anywhere — the single
best property it has.

**Grow** is then the big one, and its modes are all Family A sharing one
frontier-advance loop and one emission path:

```
mode: space_colonization | dla | laplacian | percolation | l_system
      | crack | hyphal | snowflake
```

...with shared sockets (`region` mask, `attractors`/`seeds` points,
`field` image, `obstacles` mask) and shared params (`progress`, `seed`,
`max_elements`, `emit: branches|segments`, `thickness_mode`).

---

## 8. Q&A — resolved 2026-08-02

**Structure (owner):** four nodes, one per family, each with modes; every
algorithm in §2–§5 becomes a mode with its own param set.

### Q1 — per-element attributes → **staged; not a blocker**

Correction to the premise: **`pscale` already exists.** `PointsValue`
carries `scales: Float32Array` (length `count*2`), Copy to Points already
packs it per-instance into its transform texture
(`row 2k = posX, posY, rotation, scaleX`), and Point Expression already
reads/writes it as `sx0`/`sy0`. Same for `rotations` and `groupIndices`.

So the ask isn't pscale — it's the attributes pscale *can't* express:
`age` / `birth_time`, `depth`, `id`, `parent`. That is a generic named
attribute bag, and it's a foundational refactor, not a growth-node detail.
Two stages:

**Stage 0 — ship growth on the existing channels (no engine change).**
The three channels that already propagate cover more than they look like
they do:

| Growth quantity | Rides on | Downstream payoff |
|---|---|---|
| branch thickness (Da Vinci, Q2) | `scales` | Copy to Points instance size |
| tip heading | `rotations` | oriented instances along the branch |
| branch id **or** depth ring | `groupIndices` | group-ramp color, Select by Group |
| **birth time** | `SplineSubpath.driver` | existing subpath-driver colour-source (`by: "driver"`) — age-ramped strokes, free |

That is thickness-by-depth, colour-by-branch, and colour-by-age with zero
engine work. Growth nodes are **not blocked** on the refactor.

**Stage 1 — generic attributes (its own spec, own timing).**
`attributes?: Record<string, Float32Array>` on `PointsValue`, each of
length `count`. The work is not the field — it's **propagation**: 37 files
construct points today, and each class needs a rule:

- pure transforms (`transform`, `jitter`, `displace`, `set-position`,
  `mirror`, `relax`, `modulate-points`) — copy through by index;
- filters (`filter-points`, Point Expression's `keep`) — compact by the
  same survivor mask;
- combiners (`collect`, `proximity-merge`, `merge`) — union the key sets
  and decide the fill value for a key one side lacks;
- resamplers (`points-on-path`, `spline-to-points`, `scatter-points`) —
  nothing to carry, they mint fresh points.

The failure mode to design against: a node that forgets to carry
attributes drops them **silently**. Mitigation is a shared
`carryAttributes(src, dst, indexMap?)` helper plus a one-pass audit, and
the consumer side is where the value actually lands — Point Expression
reading/writing named attrs, Filter Points predicating on them, Color Ramp
driving off them. That consumer set is worth more than growth alone, which
is the argument for speccing it separately rather than smuggling it in.

### Q2 — branch thickness → **yes, Da Vinci's rule**

`parent² = Σ children²`, written into `scales`. One line, and it's the
difference between "a tree" and "some lines."

### Q3 — network (non-tree) emission → **yes, worth building**

Closed venation, hyphal anastomosis, and cracks all fuse or T-terminate,
breaking the tree invariant that `branches` emission depends on. Those
modes emit `segments` only (one 2-anchor subpath per edge), which is
already the clean-stroking path. Tree-only modes keep both.

### Q4 — timeline model → **copy the Advect Points enum, per node**

Only two of the four families can offer the duality:

| Node | Timeline |
|---|---|
| Accretive | `progress`-slices-cached-trace **default** (Space Fill) + a live/stateful mode for animated inputs |
| Differential | stateful per-frame only (not sliceable) |
| Behavioral | `integrate \| accumulate` (Advect Points verbatim) |
| Field/CA | stateful per-frame only |

### Q5 — Physarum → **answered by the structure**

It's a **Behavioral mode with an image aux output** (the deposit/trail
field). The agents are the primary points output; the field it writes is
the aux. No standalone node needed.

### Q6 — budgets → **caps + decimation + honest docs cost notes**

---

## 8b. Structural concerns with the four-node plan

1. **Naming.** "Behavioral Growth" and "Field/CA Growth" are a stretch —
   boids don't grow, and calling them that hurts node-search
   discoverability. Suggest honest names (**Grow**, **Differential
   Growth**, **Flock**, **Cellular**) with the family relationship
   expressed through the shared `category` / search keywords rather than
   through the name.
2. **Reaction Diffusion and Watercolor Ink already exist** and are Family
   D. Absorbing them as modes of a new Cellular node is a migration tax on
   saved projects for no user gain. Recommendation: leave both standalone,
   ship Cellular with the modes they *don't* cover (cyclic CA, Lenia,
   sandpile, excitable media, snowflake), revisit consolidation later if
   ever.
3. **Per-mode socket sets.** Space colonization wants `attractors`
   (points), DLA wants `seeds` (points), Laplacian wants an attractor
   image, percolation wants a resistance image. `resolveInputs` switching
   on mode is exactly what `shortest-path` already does — precedent
   exists, but it means the mode enum is a `headerControl` and socket
   churn on mode change needs the mode-anchored group-pick pattern
   (`relax`'s precedent).
4. **Build the spine before the modes.** Four nodes × ~8 modes is a large
   surface. Each node should ship with **one** mode first — the one that
   forces the shared machinery into existence (frontier loop + emission +
   timeline for Accretive) — after which every further mode is an
   incremental rule swap against a proven frame. Space colonization is the
   right first mode for exactly this reason.

---

## 9. Shortlist, ranked

1. **Grow — space colonization mode first.** Best look-to-effort ratio,
   mask-driven art direction, and it lands on emission code that already
   exists. Everything else in Family A then plugs into the same frame.
2. **Differential Growth.** No coverage today, a look nothing else in the
   library approaches, and `relax` + the spatial hash are already there.
3. **Physarum.** The signature image of contemporary generative art; sits
   on Sim Zone ping-pong + Advect Points' sampler.
4. **Grow — DLA + Laplacian/η.** The η slider (blob → coral → lightning)
   is the same "one knob morphs the family" UX that tree mode's `wander`
   proved.
5. **Flock / steering stack.** Fun and familiar, but the *least*
   differentiated — every tool has boids, and Advect Points already covers
   the field-driven half of the appeal.
6. **Cellular expansion (cyclic CA, Lenia, sandpile).** Cheap adds
   alongside Reaction Diffusion whenever that node gets revisited.
