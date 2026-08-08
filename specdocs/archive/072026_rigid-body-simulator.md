# Rigid Body Simulator node (spec, 2026-07-20)

2D rigid body dynamics for splines: wire splines in, each subpath
becomes one rigid body that falls, tumbles, stacks, and collides —
with colliders, the canvas bounds, and **other bodies** — then comes
back out as a live spline. Built as **shape matching** (Müller-style
meshless deformation) over the Rope Simulator's particle machinery:
particles + a per-body best-fit rigid transform constraint, instead
of the rope's chain of distance constraints. Works for **closed
subpaths** (shapes, colliding as boundary shells — containers work)
and **open subpaths** (rigid bent wires) with one code path. Where
the rope tears, this **glues**: bodies that touch while glue > 0
bond, and bonds snap past a strain threshold.

Design decisions locked in Q&A (2026-07-20):

- **Shape matching over the rope's particle machinery**, not analytic
  Box2D-style bodies. Rationale: reuses the force/collider CPU ports,
  spatial hash, property maps, and pinning verbatim; open splines work
  automatically; torque is emergent (per-particle forces); glue rides
  the existing constraint vocabulary; art-directable and
  unconditionally stable beats physically exact for a motion tool.
- **Body↔body collision quality is the headline priority** (owner
  call): particle↔particle AND particle↔edge-capsule contacts, with
  contact projection interleaved into the constraint iteration loop
  (not a single end-of-substep pass) so stacks settle solid.
- **Rigidity slider** 0..1 (default 1). At 1.0 the output is the
  ORIGINAL bezier subpath transformed by the fitted rotation +
  translation — perfect curve fidelity, zero resampling artifacts.
  Below 1.0 the shape genuinely deforms (jelly) and output rebuilds
  from particles like the rope. The switch is automatic.
- **Glue = on-contact bonds + glue map + base param.** Pre-glued-at-
  seed compound bodies (the shatter workflow) are explicitly v2 — see
  Non-goals.
- Closed shapes collide as **boundary shells** — a ball rests INSIDE
  a bowl outline; nothing is "filled". Per-body SDF solid interiors
  are the v2 upgrade if heavy stacks demand it.

## Node definition

`type: "rigid-body-simulator"`, name "Rigid Body Simulator", category
`spline` / `modifier`, file `src/nodes/effect/rigid-body-simulator.ts`.
`backend: "webgl2"` but compute is CPU — GL only for mask/map
readbacks. `stable: false`; `fingerprintExtras` folds `ctx.time`.
State in `ctx.state["rigid-body-simulator:<nodeId>"]`, torn down in
`dispose`. Session-only (bake convention), same as the rope.

**Shared kernel (milestone 0):** the rope sim's reusable pieces move
to `src/engine/sim-kernel.ts` and both nodes import them —
`applyForceCpu` + curl noise, `resolveCollidersCpu` + `PackedCollider`
packing + `buildMaskField`/`sampleDist`, `resolveBoundsCpu`,
`MapBuffer`/`readMapBuffer`/`sampleMap`/`fillAttrFromMap`,
`evenPolylinePoints`/`samplePolylineAt`/`scaleSubpath`, and the
counting-sort spatial-hash scaffolding. Pure extraction, zero behavior
change to the rope — this is what keeps the two sims from drifting
(a collider must feel identical against a rope and a rigid body).

Coordinate conventions are the rope's verbatim: solver in canvas-px
Y-down; force/collider/bounds response in UV per particle per substep.

### Inputs

- `splines` (spline, required) — one body per subpath. Seeded at
  reset; mid-run changes ignored except `follow_input` pin tracking.
- `force1..N` / `collider1..N` — growable slots, same descriptors and
  CPU ports as the rope/particle sims (kernel imports).
- `pins` (points, optional) — puppet pins, rope semantics.
- Property maps (mask-typed, optional): `friction_map`, `bounce_map`,
  `glue_map`, `pin_map`. Baked at reset at rest positions by default;
  friction/bounce/glue get a `<prop>_map_live` toggle (world-space
  field); `pin_map` baked-only. No stretch/tear/stick maps — that's
  the rope's material vocabulary, not this node's.

### Params

Solver group:

- `segment_px` (default 8, min 2), `max_points` (default 2000,
  softMax 8000) — seeding identical to the rope (even-arc-length
  resample, budget in subpath order).
- `substeps` (default **6**, 1..16) and `iterations` (default **6**,
  1..16) — higher defaults than the rope: contact-heavy scenes are
  the point of this node, and substeps are the tunneling lever.
- `fixedDt` (default 1/60) — deterministic per-eval advance; offline
  export reproduces preview exactly.
- `gravity_x/y` (default (0, 0.35)) — bodies fall by default.
- `damping` (default 0.02) — per-60fps-frame velocity loss, rope
  formula. (Also the only spin damping; no separate angular term.)
- `rigidity` (0..1, default 1) — the shape-matching pull. 1 = rigid,
  lower = squash/jelly. Applied iteration-independently (below).
- `boundsMode` (off / bounce / clamp) + `boundsRestitution`.

Material group (base × map sample, rope pattern):

- `friction` (0..1, default 0.2), `bounciness` (0..1, default 0.3) —
  used for collider contacts AND body↔body contacts (pair values
  combine: friction averages, restitution multiplies into the
  collider's own, bounciness averages for body pairs).
- `glue` (0..1, default 0) — bond strength scale; 0 disables bonding
  entirely (no discovery cost).
- `glue_break` (px, default 6, softMax 24, visibleIf glue > 0) — the
  pixel-denominated bond break length; see Glue for the exact rule
  (implementation revised this away from the original strain rule —
  rationale there).

Collision group:

- `thickness` (px, default 4) — collision diameter for both contact
  kinds; also the spatial-hash cell size.
- `body_collide` (bool, default **on**) — body↔body contacts. The
  perf escape hatch.
- `self_collide` (bool, default **off**) — same-body contacts (ring
  distance > 2). Only meaningful for soft bodies (rigidity < 1) that
  can fold onto themselves; rigid shapes can't self-intersect their
  rest shape, so default off saves the pairs.

Pinning group (rope mechanisms, one default change):

- `pin_mode` — none / start / end / both, default **none** (a rigid
  body's demo is falling and stacking, not hanging). Applies to open
  subpaths only, like the rope.
- `pin_map` (luminance ≥ 0.5 at rest position pins), `pins` input +
  `pin_radius` (default 12), `follow_input` (pinned particles track
  the live input spline at their arc-length fraction).
- Pinning interacts with shape matching as an anchor on the fit:
  **one pinned particle = a hinge** (the body swings around it,
  pendulum for free), two+ = effectively frozen. Implementation: the
  pinned particle is immovable (invMass 0) and participates in the
  best-fit with a large weight, so the fitted transform rotates
  about it rather than dragging it.

Output group:

- `output_mode` — smooth / polyline (segmented), **visibleIf
  rigidity < 1**. At rigidity 1 the output is always the exact
  transformed original (no resampling to choose between).

## The solver

Seeding: identical to the rope (even-arc-length particles per
subpath, actual seeded distances as rest state). Per body, store rest
positions **relative to the rest centroid** (`q_i`), plus the source
subpath's original anchors for the exact-transform output path.

Per substep:

1. **Integrate** — rope verbatim: Verlet velocity recovery, damping,
   gravity + force descriptors (UV space), advance. Per-particle
   force application is what makes torque emergent — wind catching
   one end of a plank spins it correctly with no torque code.
2. **Contact discovery, once per substep** (see Collisions): build
   the spatial hash, generate a contact-pair list, and (if glue > 0)
   mint new glue bonds from touching pairs.
3. **Iteration loop** (`iterations`×), each pass in order:
   a. **Shape match** per body: mass-weighted best-fit translation +
      rotation of the rest shape onto current particles. 2D makes
      the polar decomposition closed-form: with p′ = pos − centroid,
      q′ = rest − restCentroid, θ = atan2(Σw(p′ₓq′ᵧ − p′ᵧq′ₓ)·−1…,
      Σw(p′·q′)) — i.e. one atan2 over two accumulated sums, no SVD.
      Then `pos ← pos + k·(goal − pos)` with
      `k = 1 − (1 − rigidity)^(1/(iterations × substeps))` so the
      effective stiffness composes to `rigidity` per EVAL and the
      slider is solver-rate independent — at the 6×6 defaults that's
      36 pulls per frame, and a per-substep composition reads as
      rigid at any slider value (found in implementation; the rope's
      XPBD lesson applied one level up). rigidity 1 ⇒ k = 1, a pure
      idempotent projection.
   b. **Glue bond constraints** — plain rigid distance projections
      over the alive-bond list (tear-style flat arrays).
   c. **Contact projection** — re-project every cached contact pair
      (positions only, mass-weighted). Interleaving this with the
      shape match every iteration is the stacking-stability lever
      and the collision-priority decision: matching pulls particles
      back into body shape, contacts push bodies apart, and they
      must converge TOGETHER or stacks breathe and jitter.
4. **Collider + bounds pass, once per substep** — rope verbatim
   (kernel `resolveCollidersCpu` + `resolveBoundsCpu`): positional
   projection + velocity response with friction/bounciness attrs.
5. **Body↔body velocity response, once per substep** — for each
   cached pair still in contact: relative velocity at the contact
   split into normal/tangent; approaching normal component reflects
   scaled by the pair's combined bounciness; tangential relative
   velocity damped by the pair's combined friction (written through
   `prev`, the rope's velocity-without-position trick).
6. **Glue break check** (per eval, after the final fit) — bonds past
   their break length die; break midpoints accumulate into this
   frame's `snaps` output. See Glue for the px-denominated rule.

## Collisions (the headline)

Two contact primitives, one broadphase:

- **Broadphase**: counting-sort spatial hash in px space (kernel),
  cell = `max(thickness, 1)`. Particles insert at their cell; each
  **edge** (alive chain segment between ring-neighbors) inserts into
  every cell its thickness-inflated AABB overlaps — edges are
  ~`segment_px` long, so 2–4 cells each at defaults. Flat reusable
  arrays, rebuilt once per substep.
- **Particle↔particle**: pairs closer than `thickness`, different
  bodies (or same body at ring distance > 2 when `self_collide`).
- **Particle↔edge capsule**: closest point on the segment; contact
  when distance < `thickness`. Different bodies only (same-body
  folding is handled adequately by p↔p). This is what makes a
  coarsely-sampled straight edge SOLID — a particle cannot slip
  between another body's samples — and what makes stacking flat
  shapes on each other stable.
- **Dedupe rule**: per (particle, other body), keep only the single
  deepest contact from either primitive. Without this a particle
  near an edge endpoint gets pushed by the edge AND both endpoint
  particles — triple projection reads as a pop.

Contact records store (indices, kind, barycentric t for edges) and
are **re-projected every iteration** (step 3c): mass-weighted
symmetric push along the current pair normal; the edge side
distributes its share to the two endpoints weighted by (1−t, t) —
standard PBD point–edge contact. Velocity response happens once per
substep (step 5) over the same records.

Semantics notes:

- Closed shapes are **shells**: outside contact keeps things out,
  inside contact keeps things in (containers, bowls, pachinko pins
  drawn as circles — all work). Nothing tests "insideness", so a
  body SEEDED overlapping another interpenetrates until it separates
  — don't start shapes intersecting (same caveat as every PBD shell
  solver; the v2 SDF interior would fix it).
- Tunneling: `substeps` is the lever, documented, no CCD (rope
  precedent).
- Cost: pair generation is O(n) counting-sort + O(contacts);
  re-projection is O(contacts × iterations). At the 2000-particle
  default with 6×6 substep/iterations this is comfortably real-time
  on CPU (the rope already runs 16 constraint passes/frame over the
  same budget).

## Glue

The rope's tear, inverted — bonds are born at contacts and die by
strain:

- **Bonding**: during contact discovery, if `glue > 0` and a contact
  pair's effective glue `glueEff = glue × ½(attrGlue_a + attrGlue_b)`
  exceeds 0.001, and neither particle is already bonded to that
  body with its cap spent (**4 bonds per particle**), mint a bond:
  a distance constraint at **rest = current pair distance** (edge
  contacts bond to the nearer edge endpoint). Flat arrays + alive
  flags, tear-style.
- **Holding**: bonds project rigidly every iteration (3b). A glued
  cluster remains SEPARATE bodies with separate fits — bonds are
  compliant joints, so a glued clump at rigidity 1 has a little give
  at the seams. Accepted for v1; merged-fit compound bodies are the
  v2 pre-glue/shatter feature.
- **Breaking** (revised during implementation): strain is the WRONG
  break signal for shape-matched bodies — bond projection runs last
  in the iteration loop, so a yanked bond stays satisfied (d ≈ rest)
  while it rips its endpoints away from their body's rigid pose
  instead; a strain rule never fires and leaves satisfied bonds
  holding stray corner particles 100px off their bodies. The break
  length is therefore PIXEL-denominated (`breakLen = glue_break ×
  bond strength`, weaker glue breaks sooner) and tested per eval,
  after the final fit, two ways: bond overstretch `(d − rest) >
  breakLen` (catches pinned↔pinned bonds the solver can't satisfy)
  OR either endpoint's displacement from its body's fitted goal
  position exceeding breakLen (the rope's sticky-weld break rule,
  inverted — catches a bond fighting the body). Soft bodies
  (rigidity < 1) legitimately sag off their goals, so glue on jelly
  breaks somewhat earlier — tune `glue_break` up. Break midpoints
  emit as `snaps` points this frame.
- `glue_map` bakes at rest positions (glue-y regions of the shape);
  `glue_map_live` re-samples at current positions (glue-y regions of
  the CANVAS — a sticky floor zone).

## Reset & state

Rope rules verbatim: reset = first eval, scene-time wrap
(`lastTime > 0.05 && time < 0.05`), input topology change
(subpath/anchor-count signature — same-topology shape animation flows
through `follow_input` pins without reset), canvas resize, or a
seed-relevant param change (`segment_px`, `max_points`, `pin_mode`,
`pin_radius`, pins count). Everything else applies live. Paused param
edits advance one step (accepted, scrub-to-0 resets).

## Outputs

- primary `spline` — per body: at rigidity 1, the ORIGINAL subpath's
  anchors + handles transformed by the body's current fitted (R, t)
  (computed once per eval from final positions) — exact authored
  curves, tumbling. At rigidity < 1, rebuild from particles per
  `output_mode` (rope machinery). `groupIndex` inherited; glue never
  merges subpaths.
- aux `bodies` (points) — **one point per body** at its current
  centroid, with `rotations` = fitted angle and `groupIndices` =
  source subpath index (`makePoints(n, {withRotations: true,
  withGroupIndices: true})`). Wire into Copy-to-Points and images
  stamp onto the simulated bodies — spline sim drives raster motion
  for free. Gate on `consumedOutputs`.
- aux `points` — raw particles, rope parity. Gated.
- aux `snaps` (points) — glue-bond break locations for the current
  frame (empty most frames), the `tears` analogue. Gated.

## Milestones

0. **Shared kernel extraction** — move the rope's reusable pieces to
   `src/engine/sim-kernel.ts` (list above); rope-simulator.ts imports
   them. Zero behavior change (verify: rope scenes look identical).
1. **Core body** — node + registration; seeding; shape matching at
   rigidity 1 (fit + projection + pin-anchored fits); gravity /
   forces / damping; pin ends; circle/line colliders + bounds;
   exact-transform spline output. Verify: a square drops, tumbles
   off a line collider, comes to rest; a one-point-pinned shape
   swings as a pendulum; curves stay exactly authored.
2. **Body↔body collisions** — THE feature: edge+particle contact
   discovery, cached pairs, per-iteration interleaved projection,
   dedupe rule, velocity response, `thickness` / `body_collide`.
   Verify: a stack of 5 rectangles settles without jitter or
   poke-through; a ball dropped into a bowl outline stays in the
   bowl; a pile of mixed shapes in a container reaches rest.
3. **Glue + maps** — on-contact bonds, break threshold, `snaps` aux;
   `glue_map` (+ live); friction/bounce maps ride along; mask
   collider (kernel chamfer field, already written). Verify: two
   glued balls swing as a clump then snap apart under a yank; a
   sticky-floor live map catches debris.
4. **Soft bodies** — rigidity < 1 with iteration-independent k;
   particle-rebuilt output modes; `self_collide` for folding
   jellies. Verify: a low-rigidity blob squashes on landing and
   recovers; rigidity 1 output still byte-identical to milestone 1.
5. **Pins completion + bodies output** — pin_map, pin-to-points
   puppet drag, follow_input; `bodies` aux (Copy-to-Points demo:
   images tumbling on simulated shapes). Docs page + devguide
   update.

## Non-goals (v1)

- **Pre-glued compound bodies / shatter** (bodies touching at seed
  weld into one merged-fit compound; breaks split the fit) — the
  natural v2, pairs with Shape Builder faces. Deliberately not
  picked for v1 in Q&A.
- Filled-solid interiors (per-body SDF colliders) — shells only;
  SDF is the v2 answer if deep stacks or seeded-overlap demand it.
- Stickiness to colliders (the rope has it; add here on demand —
  the weld machinery is in the kernel).
- Continuous collision detection; `substeps` is the tunneling answer.
- Rope↔rigid-body interaction (separate sims, separate nodes; a
  shared-world sim zone is a much bigger design).
- Per-particle mass/density map; GPU port. (Rope precedents.)
