# Rope Simulator node (spec, 2026-07-19)

A 2D string/rope dynamics node: wire splines in, get simulated splines
out. Each input subpath becomes a chain of particles connected by
distance + bending constraints, stepped with Verlet/XPBD, colliding
with the existing collider nodes, other strings, and itself. Per-point
material properties — tear threshold, friction, stickiness,
bounciness, stretchiness — come from base params optionally modulated
by **image maps**, sampled (by default) once at sim reset at each
particle's rest position, so properties are baked into the material
and travel with the string.

Design decisions locked in Q&A (2026-07-19): standalone stateful node
(not Simulation-Zone-based); self-collision + string↔string collision
in v1; maps are baked-at-reset with a per-map live toggle; all four
pinning mechanisms (ends enum, pin map, pin-to-points input, follow
animated input).

Naming: "Rope Simulator" (owner call, 2026-07-19 — "string" collides
with the `string` text socket type in search/docs vocabulary).

## Node definition

`type: "rope-simulator"`, name "Rope Simulator", category `spline`
/ `modifier`, file `src/nodes/effect/rope-simulator.ts` (like
stroke.ts). `backend: "webgl2"` but compute is CPU — GL is only touched
for mask readbacks. `stable: false`; `fingerprintExtras` folds
`ctx.time` (per-tick cache bust, same as Particle Simulator). State
lives in `ctx.state["rope-simulator:<nodeId>"]`, torn down in
`dispose`. Session-only, deliberately not serialized (bake convention).

### Inputs

- `splines` (spline, required) — the strings. Seeded at reset only;
  mid-run input changes are ignored until the next reset (sim-zone
  convention), except pin tracking when `follow_input` is on (below).
- `force1..N` — growable force slots (`forceCount` param, same
  param-backed pattern as Particle Simulator). Consumes the existing
  `ForceDescriptor`s: gravity / drag / point / vortex / wind /
  turbulence, ported from the GLSL `applyForce` to a CPU twin.
  **Dual-purpose confirmed**: force nodes are shared descriptor
  emitters; nothing particle-specific in them.
- `collider1..N` — growable collider slots (`colliderCount`).
  Consumes the existing `ColliderDescriptor`s (circle / line /
  image_mask). Circle + half-plane are closed-form CPU projections.
  `image_mask` reads the mask to CPU via `ctx.readImagePixels`
  (512-cap scaled readback) and builds a **chamfer distance transform**
  of the thresholded alpha — per-texel penetration depth + gradient
  normals. This deliberately diverges from the particle shader's
  alpha-gradient nudge: a rope drapes INTO solids (and can be seeded
  inside one), where the alpha gradient is zero and a fixed-eps nudge
  stalls; the distance field expels any penetration in one exact
  projection. Rebuilt when the mask's `ImageValue` object identity
  (value-object identity = "upstream recomputed", per devguide caching
  rules) or threshold changes, so static masks cost one readback +
  transform and animated masks track. A kill-mode mask acts as a plain
  solid for ropes (a chain can't lose one particle); tear-on-contact
  is a milestone-3+ candidate.
- `pins` (points, optional) — pin-to-points, see Pinning.
- Property map image inputs: `tear_map`, `friction_map`, `stick_map`,
  `bounce_map`, `stretch_map`, `pin_map`. Always declared (optional);
  unwired = base param alone. Mask/spline coerce in for free.

### Params

Solver group:

- `segment_px` — resample spacing in canvas px (default 8, min 2).
  Each subpath resamples to evenly spaced particles: `resampleSubpath`
  at 3× density, then an exact even-arc-length walk over the dense
  polyline (`resampleSubpath` alone maps arc length to bezier t
  linearly per segment, and a handle-less segment travels as
  smoothstep(t) — a straight line would seed ~1.5× sparser mid-span).
  The solver runs in **canvas-pixel space, Y-down**
  (isotropic tolerances on non-square canvases — the
  spline-offset-resolve precedent). Normalized↔px conversion happens at
  seed/output boundaries; collider/force descriptors convert when
  packed each frame.
- `max_points` — total particle cap across all subpaths (default 2000,
  softMax 8000). Subpaths seed in order until the budget runs out;
  clamped seeding logs nothing silently — the docs description states
  the cap.
- `substeps` (default 4, 1..16) and `iterations` (constraint passes
  per substep, default 4, 1..16).
- `fixedDt` — per-eval advance like the Particle Simulator (default
  1/60); each substep integrates `fixedDt / substeps`. Deterministic
  per frame, no wall-clock deltas, so offline export (frame-stepped)
  reproduces preview exactly.
- `gravity` (vec2, default (0, 0.35) px-space-scaled) — built-in
  convenience so a bare node droops without wiring a force node.
- `stiffness` — bending resistance 0..1 (default 0.1): weight of the
  i↔i+2 bending constraints. 0 = thread, 1 = stiff wire.
- `damping` — velocity retention (default 0.02 drag per step).
- `boundsMode` — off / bounce / clamp (canvas edges as a collider;
  subset of the particle sim's enum — wrap/kill make no sense for
  connected chains).

Material group (each property: base scalar param + optional map +
`<prop>_map_live` toggle; effective value = base × map sample):

- `friction` (0..1, default 0.2) — tangential velocity kill on
  contact (colliders, self-contacts, bounds).
- `bounciness` (0..1, default 0.3) — restitution multiplier, composed
  with the collider's own `restitution`.
- `stretchiness` (0..1, default 0) — distance-constraint compliance,
  implemented as REAL XPBD (per-edge λ accumulator, α = s²·1e-3,
  α̃ = α/h²): naive per-iteration softening washes out over
  iterations × substeps (16 passes ≈ rigid again); the λ form reaches
  the true elastic equilibrium and is substep-rate independent.
  0 = inextensible rope (plain PBD projection), 1 = very elastic.
- `tearing` (bool, default off) + `tear_threshold` (strain, default
  0.5) — a distance constraint whose post-solve strain
  `(len−rest)/rest` exceeds its effective threshold breaks: the
  subpath splits at that edge (a torn closed loop opens). The tear
  map is a WEAKNESS field: effective threshold = `tear_threshold ×
  (1 − max(endpoint weakness))` — unwired/black keeps the base
  threshold, white tears at a touch. Bending constraints spanning a
  broken edge die with it.
- `stickiness` (0..1, default 0) — on collider contact, a particle
  with stick > 0 welds: its position AND velocity snap to an anchor on
  the collider each substep (circle: stored center-offset, so animated
  colliders carry stuck strings; line: anchor re-projected onto the
  moving plane; mask: world point). Break rule: if a substep's forces
  + constraints drag the particle more than `stickEff ×
  stick_strength` px off its anchor (stick_strength 0..5, default 1),
  the weld releases — a still-touching particle re-welds at the new
  contact, which reads as stick-slip sliding. String↔string sticking
  is out of v1 (see Non-goals).

Map sampling: **baked** (default) samples each wired map ONCE at
reset, at every particle's rest position (canvas UV), via one
`readImagePixels` per map — attributes are material properties.
The per-map `live` toggle re-samples every frame at the particle's
**current** position — the map becomes a world-space field (sticky
*region*, slippery *zone*). Live maps re-read pixels only when the
map's ImageValue identity changes OR every frame if the upstream is
`stable:false`; readback cost is the user's opt-in. `pin_map` is
baked-only (a pin is a rest-position constraint; the world-space
variant of "pin" is stickiness with a live map).

Pinning group:

- `pin_mode` — enum none / start / end / both (default both): pins
  the first/last particle of every subpath (invMass 0).
- `pin_map` — luminance ≥ 0.5 at a particle's rest position pins it.
- `pins` points input — at reset, each input point captures the
  nearest particle within `pin_radius` px (default 12; unmatched
  points ignored, one particle per point, greedy nearest). Every
  frame the pinned particle is set to the point's CURRENT position —
  points inputs animate, so this is puppet-dragging for free.
  Capture is by index into the seeded particle list, so it survives
  the whole run; a change in the points COUNT re-captures (cheap,
  logged via the reset path).
- `follow_input` (bool, default off) — pinned-by-ends/map particles
  track the live input spline instead of their frozen rest position:
  each pin stores (subpath, arc-length t) and re-samples the incoming
  spline per frame (`sampleSplineAt`). Turns the sim into a
  secondary-motion layer over authored/keyframed spline animation.
  Input topology signature (subpath count + per-subpath anchor count)
  is folded into reset detection: same-topology shape animation flows
  through pins without reset; topology changes reset the sim.

Output group:

- `output_mode` — `smooth` (default): anchors at particle positions
  with auto-smoothed Catmull-Rom-style handles (`autoSmoothHandles` —
  stable anchor count, no per-frame refit flicker) / `polyline`:
  handle-less anchors.

## Collisions

Per substep, after integration + constraint passes:

1. **Colliders** — project penetrating particles to the surface;
   decompose velocity (from Verlet pos−prevPos) into normal/tangent;
   reflect normal × (collider restitution × particle bounciness),
   scale tangent by (1 − friction). Sticky particles weld (above).
2. **Bounds** per `boundsMode`.
3. **Self + string↔string** (v1, per Q&A) — uniform spatial hash over
   all particles (counting sort into flat reusable arrays), cell size
   = `thickness` px (param, default 4 — also the collision diameter;
   `self_collide` bool, default on, is the perf/look escape hatch).
   Each particle tests its 3×3 cell neighborhood; pairs closer than
   `thickness` are pushed apart symmetrically (mass-weighted; pinned =
   immovable), skipping pairs within 2 ring-neighbors of each other on
   the same subpath. Friction damps the pair's relative tangential
   velocity by raising `prev` toward `pos` (velocity change with no
   position change). Cost is O(n) per pass; with the 2k default budget
   this is comfortably real-time on CPU. Tunneling guard: `substeps`
   is the lever (documented, not auto-CCD — see Non-goals).

## Reset & state

Reset = first eval, scene-time wrap (`lastTime > 0.05 && ctx.time <
0.05` — the shared heuristic), input topology change, or a
seeding-relevant param change (`segment_px`, `max_points`,
`pin_mode`, `pin_radius` — folded into a seed signature). On reset:
resample subpaths → particles (pos = prevPos = restPos, invMass from
pins), bake map attributes, capture pin targets. Param edits that
aren't seed-relevant (gravity, friction base, stiffness…) apply live
without reset.

Caveat shared with the Particle Simulator: while paused, a param edit
re-evals and advances the sim one step. Accepted; scrub-to-0 resets.

## Outputs

- primary `spline` — one subpath per (possibly torn) chain,
  `groupIndex` inherited from the seeded subpath (torn halves share
  it, Collect semantics preserved). Positions px→normalized.
- aux `points` — the raw particles as a typed-array `PointsValue`
  (`makePoints`), groupIndices = source subpath index. Free (already
  CPU), gate on `consumedOutputs`.
- aux `tears` — points at constraint-break locations for the CURRENT
  frame (empty most frames): trigger flashes/particles/sound at snap
  points. Gate on `consumedOutputs`.

## Milestones

1. **Core solver** — node + registration; seeding/resample; Verlet +
   distance/bend constraints; gravity + damping + force-descriptor CPU
   port; pin ends; circle/line colliders; bounds; smooth/polyline
   spline output. Verify: hanging rope droops, swings, settles.
2. **Contact response + mask collider** — friction/bounciness base
   params; image_mask collider (readback field + gradient normals).
3. **Property maps + stretch + tear** — friction/bounce/stretch/tear
   maps with baked/live toggles; XPBD compliance; tearing with subpath
   split; pin map; `tears` aux output. (`stick_map` ships with
   milestone 4, where stickiness itself lands — no dead sockets.)
4. **Self-collision + stickiness** — spatial hash, thickness,
   string↔string; sticky welds with break force; `stickiness` +
   `stick_map`.
5. **Pin-to-points + follow-input** — points capture/tracking;
   arc-length pin re-sampling; topology-signature reset. Docs page +
   devguide update.

## Non-goals (v1)

- String↔string *sticking* (welds between strings — clumping); v2
  candidate once stickiness-to-colliders is proven.
- Continuous collision detection; `substeps` is the tunneling answer.
- Collider velocity transfer (a moving collider pushes but doesn't
  drag except via friction-on-contact and sticky welds).
- Per-particle mass map (invMass is 1 or 0-when-pinned); trivially
  added later as a seventh map if wanted.
- GPU port. CPU + typed arrays at the 2k default is real-time; the
  architecture doesn't preclude a WebGPU twin later (the Particle
  Simulator precedent).
