# Differential Growth (spec, 2026-08-02)

Status: **M1–M4 implemented 2026-08-02.** Typecheck + lint + full
`npm run check` green, plus a standalone smoke test of the real compute
against a stubbed RenderContext (48 checks: seeding, buckling, anchor-count
convergence and budgets, advance gate, wrap/topology/identity reset rules,
pin_ends, winding-independent pressure, bend stiffness, all four growth
drivers, region confinement, inter-curve repulsion, output channels,
caching contract, dispose). Long-run stability verified to 1500 frames.
**Needs an in-browser pass.** M5 (docs page, devlist) outstanding.
Deviations from the spec text are recorded in §8.

Survey: [080226_growth-systems-survey.md](080226_growth-systems-survey.md).
Shared conventions (determinism, field sampling, attributes) are defined in
[080226_accretive-growth.md](080226_accretive-growth.md) §2 and referenced here.

Family B: *fixed topology, exploding geometry.* A polyline where length is
created faster than the ambient space can absorb it, so the curve **must
buckle**. Brain coral, kelp, ruffled leaf margins, intestines — Nervous
System's *Floraform*, inconvergent's differential line work.

Nothing in the library does this today, and it has the highest
look-per-line ratio in the survey.

```
type:        "differential-growth"
name:        "Differential Growth"
file:        src/nodes/effect/differential-growth.ts
category:    "spline"      subcategory: "modifier"
backend:     "webgl2"      (mask readback only; compute is CPU)
headerControl: { paramName: "mode" }
```

---

## 1. The rule

Per iteration, over every node of every subpath:

1. **Repulsion** — nodes within `repulsion_radius` push apart. Jacobi-style
   (accumulate all pairs, apply once, damped) so the result is independent
   of node order — `relax.ts`'s points-mode precedent exactly, including
   its deterministic hashed-angle handling of coincident pairs.
2. **Attraction** — each node is pulled toward its two chain neighbours,
   which keeps edges from stretching without bound.
3. **Bending** — Laplacian smoothing toward the neighbour midpoint,
   weighted by `bend_stiffness`. This is what separates a smooth ruffle
   from a jagged mess.
4. **Pressure** (closed subpaths) — push along the outward normal. Turns
   loops into inflating blobs; combined with growth it gives cell
   membranes and leaf lamina.
5. **Containment** — `sampleDist` against the `region` mask SDF pushes
   nodes back inside; the same against `obstacles` pushes them out.
6. **Integrate** — apply the accumulated delta scaled by `damping`.

Then the topology step:

7. **Split** — any edge longer than `split_length` inserts a midpoint,
   subject to the mode's eligibility rule (§2). This is where growth
   actually happens.
8. **Collapse** — any edge shorter than `collapse_length` merges its two
   nodes. Not cosmetic: without it, repulsion in tight concavities drives
   the anchor count up without bound and the sim degrades. `collapse_length`
   must stay well below `split_length` or the two fight.

`buildSpatialHash(pos, count, cellSize = repulsion_radius_px, W, H, reuse)`
from `sim-kernel.ts` makes steps 1 and the inter-curve test O(n).

---

## 2. Modes — the growth driver

`mode` decides **which edges are eligible to split**, which is the entire
character of the result:

| mode | eligibility | look |
|---|---|---|
| `uniform` | every over-length edge | isotropic ruffles, brain coral |
| `curvature` | p ∝ local curvature — convex regions grow faster | cauliflower, broccoli, romanesco |
| `field` | p ∝ `growth_field` sampled at the edge midpoint | **art-directed ruffling** — paint where it crinkles |
| `noise` | p ∝ seeded value noise at the midpoint | patchy, organic irregularity |

`curvature` is the one that produces recursive self-similar structure,
because a bulge grows faster, which increases its curvature, which makes it
grow faster still.

---

## 3. Sockets

| socket | type | required | meaning |
|---|---|---|---|
| `spline` | spline | **yes** | the seed curve(s). Open subpaths ⇒ tendrils; closed ⇒ blobs. Multiple subpaths grow simultaneously |
| `region` | mask | no | containment. Unwired ⇒ canvas bounds minus `margin` |
| `obstacles` | mask | no | carved out — the curve ruffles around them |
| `growth_field` | mask | no | `visibleIf mode === "field"` |

Primary output: **spline** — one subpath per evolving curve, `groupIndex`
passed through from the input subpath, `driver` = **growth ratio** (current
length ÷ initial length), so a `by: "driver"` stroke colours by how much
each curve has grown.

Aux output: **`points`** — the nodes, `rotations` = local tangent,
`scales` = local edge density (a legible proxy for growth pressure).

---

## 4. Params

| name | type | range | default | notes |
|---|---|---|---|---|
| `mode` | enum | §2 | `uniform` | headerControl |
| `split_length` | scalar | 0.002–0.1 | 0.012 | edge length that triggers insertion |
| `collapse_length` | scalar | 0–0.05 | 0.004 | **keep ≪ split_length** |
| `growth_rate` | scalar | 0–1 | 1 | fraction of eligible edges that actually split per frame — the speed knob |
| `repulsion_radius` | scalar | 0.002–0.2 | 0.02 | |
| `repulsion_strength` | scalar | 0–2 | 1 | |
| `attraction_strength` | scalar | 0–2 | 0.6 | |
| `bend_stiffness` | scalar | 0–1 | 0.3 | smooth ruffle ↔ jagged |
| `pressure` | scalar | −1–1 | 0 | closed subpaths only; negative deflates |
| `damping` | scalar | 0.01–1 | 0.5 | |
| `iterations` | scalar int | 1–20 | 3 | relaxation passes per frame |
| `inter_curve` | boolean | — | true | subpaths repel *each other* ⇒ packed colony look |
| `pin_ends` | boolean | — | false | open subpaths: anchor the endpoints |
| `containment` | scalar | 0–2 | 1 | region push-back strength |
| `max_anchors` | scalar int | 500–100000, softMax 20000 | 8000 | hard budget (Q6) |
| `seed` | scalar int | — | 0 | `noise` mode + coincident-pair angles |

---

## 5. Timeline — stateful only

**This node is not sliceable.** The geometry at frame N does not contain
frame N−1 (nodes move, edges merge), so there is no trace to slice and no
`progress` param. Accretive Growth's trace-and-slice model does not apply
here, and pretending otherwise would be a lie in the UI.

State, keyed `ctx.state["differential-growth:<nodeId>"]`:

```ts
{ curves: { pos: Float32Array, count: number, closed: boolean,
            groupIndex: number, initialLength: number }[],
  initialized: boolean, lastTime: number,
  inputSig: string, hash?: SpatialHash,
  maps: Record<string, MapCacheEntry | undefined> }
```

- **Advance gate** — step only when `ctx.time !== state.lastTime`.
  Paused param tweaks re-emit current state instead of advancing
  (Advect Points' deliberate improvement over the Sim Zone).
- **Reset** — re-seed from the current `spline` input on: first eval;
  scene-time wrap (`lastTime > 0.05 && time < 0.05`, Sim Start's rule);
  `inputSig` change, where `inputSig` covers subpath count and anchor
  counts, **not** anchor positions (an animated upstream mints a fresh
  SplineValue every frame and must not reset the sim).
- Backwards scrubbing without a wrap leaves state as-is — Sim Zone parity,
  documented.
- `fingerprintExtras` returns `ctx.time` always; `dispose` deletes the key.
- `stable` is left unset — the node genuinely changes every frame.

---

## 6. Milestones

1. **M1 — Core.** Node + registration; state blob, advance gate, reset
   rules; repulsion (hash-accelerated, Jacobi, `relax.ts` pattern),
   attraction, split, collapse; open + closed subpaths; `uniform` mode;
   `max_anchors` cap. Verify: a circle input ruffles into brain coral and
   the anchor count converges rather than exploding.
2. **M2 — Shape control.** `bend_stiffness`, `pressure`, `damping`,
   `pin_ends`, `inter_curve` repulsion. Verify: stiffness sweep goes
   smooth→jagged; pressure inflates closed loops; several seed circles
   pack against each other without interpenetrating.
3. **M3 — Drivers + confinement.** `curvature` / `field` / `noise` modes;
   `region` containment and `obstacles` push-out via `buildMaskField` +
   `sampleDist`. Verify: curvature mode produces recursive cauliflower
   lobes; a painted `growth_field` ruffles only where painted; growth
   fills a text silhouette and stops at its edge.
4. **M4 — Output polish.** `driver` growth-ratio, aux points with tangent
   /density attributes, `groupIndex` passthrough. Verify: Stroke coloured
   `by: "driver"`; Set Spline Type smooths the polyline cleanly.
5. **M5 — Bookkeeping.** `description`, docs page with an honest anchor-
   budget cost note, devlist entry, devguide touch.

---

## 7. Deliberately not doing

- **No 3D / surface growth.** Floraform's surface version is a different
  data structure and a different node.
- **No self-intersection *resolution*.** Repulsion prevents crossings
  statistically, not provably; at low `repulsion_strength` with high
  `growth_rate` curves will cross. Documented as a tuning relationship
  rather than solved.
- **No trace/slice or `progress`.** §5.

---

## 8. Implementation deviations

### 8.1 Growth is rate-driven; the length threshold is a cap, not the trigger

§1 step 7 says an edge splits "when longer than `split_length`". Taken
literally the simulation **cannot start**. Seed a circle at that spacing
and it sits in perfect equilibrium — every node's two chain neighbours
repel it equally and cancel — so no edge ever stretches, so nothing ever
splits, forever.

Insertion has to be the thing that *drives* growth; the local crowding it
creates is what repulsion then relieves by buckling. An edge now splits if
it exceeds `split_length` (mandatory, so spacing can never run away) **or**
at probability `growth_rate × SPLIT_RATE × driver-weight` once its halves
would survive a collapse. `growth_rate` is therefore the speed knob it
reads as.

### 8.2 Attraction and bending must not share a target

The first cut aimed attraction at the neighbour midpoint — which is
exactly what bending does, so the two sliders were the same control at
different weights and neither governed chain tautness. Measured: mean turn
angle 0.497 vs 0.501 across the full stiffness range.

They are now genuinely different forces. **Bending** is Laplacian
smoothing toward the neighbour midpoint and affects shape only (for an
evenly-spaced node the midpoint is where it already is, so it never
changes edge lengths). **Attraction** is a one-sided spring toward each
neighbour, active only past a rest length — pull only, since repulsion
owns the pushing.

### 8.3 The three lengths are not independent

`repulsion_radius` sets the equilibrium edge spacing, which settles at
roughly **0.6–0.8× the radius**. That forces an ordering:

```
2 × collapse  <  equilibrium (~0.7 × repulsion)  <  split
```

Both violations fail *silently*, which is why the bounds are enforced in
code rather than left to the sliders:

- **equilibrium above `split`** — every edge permanently exceeds the
  mandatory-split threshold, so the curve subdivides without bound every
  frame until it hits the anchor cap. This produced NaN and a collapse to
  3 nodes before it was found.
- **equilibrium below `2 × collapse`** — no edge is ever long enough for
  its halves to survive a merge, so nothing splits and the curve never
  grows at all.

`collapse` is clamped against **repulsion**, not against `split`.
Anchoring it to `split` looked right and left a fine-split configuration
with its eligibility threshold at 6.7px against an equilibrium of 6.65px:
growth stopped dead while every slider still read as sane, and the same
setup at the default split length grew 63 → 8000. A 100× swing from one
slider was the symptom that exposed it.

### 8.4 Containment refuses the move rather than pushing along a gradient

§1 step 5 proposed `sampleDist` against a mask SDF. A binary mask has no
usable gradient more than a texel from its boundary, so a gradient push
does nothing for a node that has already strayed well outside. A node
whose step would leave the region instead has that step scaled back by
`containment` — a hard constraint at 1, free at 0.

### 8.5 Measured cost

1920×1080, per frame including relaxation, retopology and emission:
8000 anchors ≈ 6ms, 20000 anchors ≈ 17ms. Finite and converged at 1500
frames in every configuration tested.
