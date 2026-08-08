# Behavioral Growth (spec, 2026-08-02)

Status: **M1-M5 implemented 2026-08-03.** All four modes, both timeline
arms, trails and the deposit aux. Typecheck + lint + full `npm run check`
green, plus a standalone smoke test of the real compute against a stubbed
RenderContext (66 checks: every mode finite/in-bounds/moving, each
steering behaviour verified by its own effect, force clamping, neighbour
cap, predator/prey separation, Vicsek order/disorder transition, physarum
field structure and decay bounds, chemotaxis gradient climb, advance gate,
wrap reset, integrate determinism and caching, count migration, trails and
wrap-splitting, attribute passthrough, dispose). **Needs an in-browser
pass.** M6 (docs page, devlist) outstanding. Deviations in §9.

Survey: [080226_growth-systems-survey.md](080226_growth-systems-survey.md).
Shared conventions in [080226_accretive-growth.md](080226_accretive-growth.md) §2.

Family C: *fixed population, positions evolve, output is current state.*
This is the "boids" half of the original intuition — and structurally it is
**Advect Points with a neighbour term**, which is why it inherits that
node's field sampler, trail ring buffer, timeline enum, and reset rules
almost verbatim.

```
type:        "behavioral-growth"
name:        "Behavioral Growth"
file:        src/nodes/effect/behavioral-growth.ts
category:    "point"       subcategory: "modifier"
backend:     "webgl2"      (field readback / deposit upload; compute is CPU)
headerControl: { paramName: "mode" }
```

---

## 1. Modes

| mode | rule | look |
|---|---|---|
| `steering` | weighted stack of Reynolds behaviours (§3) | flocking, schooling, crowds, murmuration |
| `vicsek` | alignment + angular noise, nothing else | order/disorder phase transition on one knob |
| `physarum` | 3-sensor trail following + deposit (Jones 2010) | **self-optimising vein networks** |
| `chemotaxis` | gradient ascent + stochastic tumble | bacterial run-and-tumble, plume seeking |

### On "goals and rewards"

Recorded from the design Q&A: **no reinforcement learning.** Learned
policies are nondeterministic, slow to converge, and un-art-directable —
the opposite of what a scrubbable timeline needs. The two framings that
*feel* like goals and stay deterministic are `steering` (utility weights,
sliders map to visible behaviour) and `physarum` (the "reward" is a
decaying field the agents both write and read — optimisation emerges,
and the field is renderable, which is what makes it art rather than a
black box).

---

## 2. Sockets

| socket | type | required | meaning |
|---|---|---|---|
| `points` | points | **yes** | the agents (seed positions; count = population) |
| `field` | mask | no | `physarum`/`chemotaxis`: the scalar field. `steering`: flow-field-follow source |
| `targets` | points | no | `steering`: seek/flee/pursue targets |
| `obstacles` | mask | no | avoidance |

Primary output: **points** — current agent positions, `rotations` = heading
(so Copy to Points orients instances along motion for free), `scales` and
`groupIndices` re-read per frame from the current seed input by index
(Advect Points' rule — animated upstream attributes keep flowing while
only positions come from state).

Aux outputs:

- **`trails`** (spline) — per-agent ring-buffer history, oldest→current.
  Consumption-gated in `accumulate` mode (the ring only fills when
  something is wired), built unconditionally in `integrate` — the exact
  divergence Advect Points documented, and for the same reason: a
  cacheable node reused verbatim on a fingerprint hit would otherwise hand
  a later consumer a permanently stale empty spline.
- **`deposit`** (image) — `physarum` only: the trail field the agents are
  writing. **This is usually the thing you actually render.**

---

## 3. `steering` — a weighted behaviour stack

Reynolds' catalogue is ~14 behaviours, not 3. Each is a weight slider
(0 = off, so the panel stays legible) plus its own radius where relevant:

| behaviour | params | notes |
|---|---|---|
| separation | `w_separation`, `r_separation` | |
| alignment | `w_alignment`, `r_alignment` | |
| cohesion | `w_cohesion`, `r_cohesion` | the classic three |
| seek / flee | `w_seek`, `w_flee` | toward/away from `targets` |
| arrive | `w_arrive`, `arrive_radius` | decelerates into the target instead of orbiting it |
| wander | `w_wander`, `wander_rate` | steady-state heading noise |
| flow follow | `w_flow` | `field` as an angle map |
| obstacle avoid | `w_avoid`, `avoid_lookahead` | `obstacles` SDF gradient |
| containment | `w_contain` | region bounds |

Plus the kinematics: `max_speed`, `max_force`, `mass`. Steering is
accumulated as a force, clamped to `max_force`, integrated into velocity,
clamped to `max_speed` — Reynolds' standard model, and the clamping is what
makes the weights behave predictably instead of exploding.

**Predator/prey for free:** agents carry `groupIndex` from upstream, and a
`group_role` param maps group N to prey/predator, with predators seeking
and prey fleeing. Murmuration-under-attack falls out with no extra machinery.

`buildSpatialHash` makes all the radius queries O(n); population targets
are 2k–50k agents.

---

## 4. `physarum` (Jones 2010)

Each agent samples the trail field at three points — ahead, ahead-left,
ahead-right at `sensor_distance` and ±`sensor_angle` — rotates by
`turn_rate` toward the strongest, steps `step_size`, and **deposits**
`deposit_amount` into the field. The field then diffuses and decays.

| param | range | default |
|---|---|---|
| `sensor_angle` | 5–90° | 22.5 |
| `sensor_distance` | 0.002–0.1 | 0.012 |
| `turn_rate` | 5–180° | 45 |
| `step_size` | 0.0005–0.02 | 0.002 |
| `deposit_amount` | 0–1 | 0.2 |
| `decay` | 0–1 | 0.08 |
| `diffuse_radius` | 0–5 px | 1 |
| `field_resolution` | 128–1024 | 512 |

**The field lives on the CPU** in v1: a `Float32Array(res²)` in state,
with deposit (scatter-add), a separable box blur, and a multiply-decay —
all trivially cheap at 512² = 262k cells, and it avoids the GPU readback
round-trip that a hybrid CPU-agent/GPU-field design would need *every
frame*. The `deposit` aux is produced by writing the grid into an
`ImageData` on a 2D canvas and uploading with
`gl.texImage2D(..., canvas)` — the same path `engine/coerce.ts` and
`engine/spline-flow.ts` already use — into a `ctx.allocImage()` target.

A fully-GPU physarum (agents in a transform-feedback buffer, field in
ping-pong RGBA32F à la `watercolor-ink.ts`) is the obvious later upgrade
and is noted in §8, not built now.

---

## 5. `vicsek` and `chemotaxis`

- **`vicsek`** — heading ← mean heading of neighbours within `r_align`,
  plus uniform noise of magnitude `noise`. Constant speed. `noise` alone
  drives a real order/disorder transition: swirls → chaos. Two params.
- **`chemotaxis`** — gradient ascent on `field` (Advect Points' `gradient`
  field mode is the deterministic version of this) plus a `tumble_rate`
  probability of random reorientation per step, and `run_bias` making
  tumbles less likely while the field is improving. That last term is what
  makes it read as *searching* rather than sliding.

---

## 6. Timeline — `integrate | accumulate` (Advect Points verbatim)

| mode | behaviour |
|---|---|
| `integrate` | stateless. Seeds are the input points; run `steps` iterations from scratch every eval. Deterministic, scrub-safe, cache-friendly, export-exact. The still-image mode — `trails` gives streamline art, keyframing `steps` is a draw-on reveal |
| `accumulate` | stateful. Persistent positions in `ctx.state`, advanced `substeps` per **frame**. The living-system mode |

`integrate` is not available for `physarum` — the deposit field is
inherently path-dependent, so that mode forces `accumulate` (the param
row is `visibleIf mode !== "physarum"` and the code treats physarum as
accumulate unconditionally).

State, keyed `ctx.state["behavioral-growth:<nodeId>"]`:

```ts
{ pos: Float32Array, vel: Float32Array, count: number,
  field?: Float32Array, fieldRes?: number,
  trail?: { buf: Float32Array, head: number, len: number },
  initialized: boolean, lastTime: number,
  hash?: SpatialHash, maps: Record<string, MapCacheEntry | undefined> }
```

Reset and migration rules are Advect Points' **exactly**, and should be
lifted rather than re-derived:

- Advance gate on `ctx.time !== lastTime`.
- Reset on first eval, scene-time wrap, or mode switch back from
  `integrate`. Seed *identity* churn alone must NOT reset (an animated
  upstream mints a fresh PointsValue every frame).
- **Count changes migrate, never reset** — growth keeps every existing
  agent's evolved position and seeds new indices from the current input;
  shrink truncates from the top. The trail ring reallocates with history
  preserved for surviving indices, and joining agents backfill history
  with their seed position so their trail starts as a dot rather than a
  line from garbage.
- `fingerprintExtras` returns `t:<time>|m:accumulate` only in accumulate
  mode, so `integrate` keeps full fingerprint caching. `dispose` deletes
  the key.

---

## 7. Milestones

1. **M1 — Core + steering.** Node + registration; state blob, advance
   gate, reset/migration; `buildSpatialHash` neighbour queries;
   separation/alignment/cohesion/wander/containment; force→velocity
   clamping; `integrate` and `accumulate`. Verify: 5k agents flock at
   interactive rates; the three classic weights behave independently.
2. **M2 — Full steering catalogue.** `targets` socket (seek/flee/arrive),
   obstacle avoidance via the mask SDF, flow-field follow, predator/prey
   via `group_role`. Verify: a moving target is pursued; agents route
   around an obstacle mask; predators split a flock.
3. **M3 — Physarum.** CPU trail field, 3-sensor steering, deposit +
   diffuse + decay, `deposit` image aux with the canvas upload path.
   Verify: the vein network forms and self-optimises; `field_resolution`
   and `decay` sweep cleanly; the aux image is what renders.
4. **M4 — Vicsek + chemotaxis.** Both are small deltas on M1's loop.
   Verify: Vicsek's `noise` sweep shows the phase transition.
5. **M5 — Trails.** Ring buffer (accumulate) + per-step polyline
   (integrate), consumption gating per the Advect Points divergence note,
   `trail_stride` / `trail_length`. Verify: streamline stills in
   `integrate`; motion trails in `accumulate`.
6. **M6 — Bookkeeping.** `description`, docs page, cost notes, devlist,
   devguide.

---

## 8. Deliberately not doing / deferred

- **No reinforcement learning** — §1.
- **No GPU agent path.** "Millions of particles" stays the particle
  simulator's job; this is the CPU points pipeline where per-agent
  neighbour rules and art-directable counts matter more than raw scale.
- ~~**Deferred: GPU physarum**~~ — **SHIPPED 2026-08-02 as its own node**,
  `physarum` (spec: [080226_physarum.md](080226_physarum.md)). RGBA32F
  ping-pong agents + an additive `gl.POINTS` deposit, millions of agents,
  all 24 of mxsage's Points. It is a separate node rather than this one's
  mode because the population is 10²–10³× larger than any `points` value
  should be and the output is the *field*, not the positions. This node's
  CPU `physarum` mode is still worth building for the cases where agent
  positions must leave as a `points` value.
- **Deferred: stigmergy on a graph** (ACO / Tero et al. 2010 network
  adaptation). It wants `spline-graph.ts` and a sources/sinks socket pair,
  and is arguably a Shortest Path companion rather than a mode here.


---

## 9. Implementation deviations

### 9.1 Interaction is topological, not metric

§3 specced per-behaviour radii and left it there. A fixed radius makes the
neighbour count grow with density, so the simulation is **O(n²)** however
good the spatial hash is: measured 2k = 7ms, 10k = 137ms, 50k = 1872ms.

Each agent now considers at most `max_neighbors` others (default 24) and
stops scanning. That is not just a budget — it is the better model.
Starlings track ~7 neighbours regardless of how dense the flock is
(Ballerini et al. 2008), which is exactly a topological rather than metric
rule. Verified that a tightly capped flock (6 neighbours) still orders
itself, so the cap buys cost without costing behaviour.

Combined with inlining the neighbour walk — the per-pair closure call was
costing more than the arithmetic inside it — the result is near-linear:

| population | before | after |
|---|---|---|
| 2k | 7.4ms | 1.2ms |
| 10k | 136.9ms | 7.8ms |
| 50k | 1872.2ms | 71.1ms |

Vicsek 10k went 53.9 → 7.2ms and `integrate` (2k × 100 steps) 631.8 →
142.8ms by the same two changes.

### 9.2 Radii live in canvas pixels, not the normalized square

Scaling both axes by width is isotropic in normalized space and renders as
a vertically squashed ellipse on any non-square canvas. Physics runs in
true canvas pixels (`x = u*W, y = v*H`) so a separation radius is a circle
on screen. **The same bug was found and fixed in Differential Growth**,
where a square test canvas had hidden it; that node now has an explicit
16:9 regression test.

### 9.3 Merged and dropped params

- `w_flee` folded into `w_seek` as its negative half — one slider, both
  directions.
- Three neighbour radii collapsed to two (`r_separation` for the repulsive
  term, `r_neighbor` shared by alignment and cohesion). The look is
  governed by the weights; three radii was surface without payoff.
- `mass` dropped — `max_force` already sets how sharply an agent can turn.

### 9.4 Measured cost

1920×1080, per frame: steering 10k ≈ 8ms / 50k ≈ 71ms, vicsek 10k ≈ 7ms,
physarum 10k ≈ 4ms / 50k at field 512 ≈ 13ms. Trails roughly double the
steering cost at 10k (18ms) and are consumption-gated, so they cost
nothing unwired.

Physarum was checked for the thing that actually matters — whether it
forms *networks* rather than smearing deposit evenly. Coefficient of
variation of the trail field is **3.41** against **0.46** for the same
agents with sensing disabled: the deposit concentrates into filaments
rather than spreading.
