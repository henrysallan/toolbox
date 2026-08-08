# Loop Weave node (+ Cursor Trail Points source)

Status: IMPLEMENTED — rev 4, 2026-07-20 (all milestones M0–M3; rev 3 =
owner feedback after first browser pass: auto reveal is timeline-locked
— plays only with the timeline, resets on rewind — and offline export
now renders it; rev 4 = shape/connector extensions, owner-picked: all
four families from the design Q&A — connector sliders, spiral + lobes,
wobble, adaptive radius — see § Shape & connector modulation). Owner Q&A resolved: three outputs
(weave + orbits + skipped arcs), both animation modes (deterministic
progress + stateful auto-reveal), index order default with optional
nearest-neighbor, and the Cursor Trail Points companion source ships
with the feature. Rev 2 notes where implementation diverged from rev 1
— the connector construction (Hermite bridges — overlapping orbits are
the COMMON case, a straight tangent line often doesn't exist), the
auto-reveal model (a constant-rate pen, not per-point landing clocks),
per-unit bezier fitting (the append-stability invariant forced it),
and `loops` rounding semantics.

Reference: the owner's two screenshots — a black spline that visits a
scatter of points in order, orbiting each one in an ellipse and
crossing over itself between them; solid gray ellipses mark each
point's orbit; dashed arcs show the untraveled guide geometry. The
feature reproduces that look live, updating as points are added.

## What it is

**Loop Weave** (`loop-weave`, category `spline` / `generator` — the
fancy sibling of Points to Spline) takes a `points` input and emits a
single open spline that travels the points in order, wrapping each one
in an elliptical loop-de-loop and connecting consecutive loops with
common-tangent runs. Direction handedness per loop decides the look:
opposite-handed neighbors connect with a *crossing* (internal) tangent
— the weave "X" between points in the reference — while same-handed
neighbors connect with an outside (external) tangent, the cursive-
script look. All randomness is hashed on point index (triple32, the
Point Expression `rand` primitive) so **appending a point extends the
path without reshuffling anything already drawn** — this is what makes
the live cursor demo work.

**Cursor Trail Points** (`cursor-trail-points`, category `point` /
`generator`) is the companion source: it drops seeded, jittered points
along the pointer's path while drawing. Cursor Trail Points → Loop
Weave → Stroke is the whole demo graph.

## Loop Weave — sockets & params

Inputs:

- `points` (points, required). Everything that emits points works:
  Cursor Trail Points, Scatter Points, Points on Path, Grid, sim
  zones. < 2 points ⇒ empty outputs.

Primary output: `spline` (the weave path — ONE open subpath).
Aux outputs (all `spline`):

- `orbits` — the full orbit ellipse of every point, one closed subpath
  per point, `groupIndex` = point index. Style gray downstream
  (Stroke), Merge under the weave = the reference's solid guides.
- `skipped` — the untraveled complement arc of each orbit, open
  subpaths, `groupIndex` = point index. Empty for a loop with
  `loops ≥ 1` (whole ellipse traveled). Stroke's dash = the
  reference's dashed arcs.

Params (groups in panel order):

Tour:

- `order`: enum `index | nearest`, default `index`. Index = input
  order (draw order — append-stable). Nearest = greedy nearest-
  neighbor tour from point 0 for unordered scatters; documented
  caveat: a new point may reroute the tour mid-animation.

Loops:

- `radius`: scalar, canvas-width fraction (spline-repeat's distance
  unit), default 0.06, softMax 0.25. Orbit construction happens in
  canvas px space so orbits stay round on non-square canvases
  (aspect invariant).
- `radius_jitter`: scalar 0..1, default 0.35 — per-point ±fraction of
  `radius`, hashed on index.
- `use_point_scale`: boolean, default true — multiply rx/ry by the
  point's scale attribute when present (Modulate Points upstream then
  drives orbit size for free).
- `squash`: scalar 0..1, default 0.25 — ellipse eccentricity
  (ry = rx·(1−squash)).
- `orient`: enum `travel | fixed | random | point`, default `travel` —
  major-axis orientation: incoming→outgoing travel direction, a fixed
  `orient_angle` (visibleIf), hashed-random, or the point's rotation
  attribute.
- `loops`: scalar, default 1.0, min 0, softMax 3 — windings per point,
  ROUNDED per point (a smooth exit needs whole extra turns; the base
  entry→exit sweep supplies the fractional wrap). `loops_jitter`
  dithers the rounding across points. 0 = swing past tangentially, no
  loop — the slalom.
- `loops_jitter`: scalar 0..1, default 0 — per-point winding
  variation, hashed on index.
- `direction`: enum `alternate | cw | ccw | random`, default
  `alternate`. Alternate = classic weave (every connector crosses);
  cw/ccw = cursive same-handed loops (outside tangents); random =
  hashed per index.
- `seed`: scalar int, default 0 — folds into every per-index hash.

Shape:

- `ends`: enum `center | orbit`, default `center` — start/end the path
  AT the first/last point (short spiral lead-in/out, radius ramping
  0→r over a quarter turn, like the reference's tail landing on the
  cursor) vs starting on the first orbit directly.
- `smoothness`: scalar 0..1, default 0.5 — mapped to the
  `fitSplineToPolyline` error tolerance (px). Low = tight fit, more
  anchors; high = looser, breezier line.

Shape & connector modulation (rev 4):

- `adaptive_radius` 0..1 — blend orbit size toward 0.45 × the nearest
  tour neighbor's distance: isolated points get big lassos, clusters
  tight curls. Only the previous LAST orbit re-sizes when a point
  lands (it gains a neighbor) — the same tail-only instability as
  travel orientation, disclosed not prevented.
- `spiral` −1..1 — radius factor per winding (±1 = halve/double):
  multi-turn loops spiral inward/outward instead of retracing, and an
  inward spiral EXITS from inside its own coils (the connector
  re-anchors on the modulated exit point) — the telephone doodle.
- `lobes` 0..8 + `lobe_depth` — r(θ) petal modulation with hashed
  phase: flower/cloud/star loops.
- `wobble` 0..1 — two non-harmonic cosine octaves on arc progress
  (not θ, so successive windings differ): hand-tremor.
- `tension` 0.2..3 — multiplies both connector Hermite handles: taut
  wire-pulled runs → fat swooping curls. The most character-defining
  single knob.
- `swing` −1..1 — exit-vs-entry handle asymmetry (leave fast/arrive
  lazy and vice versa).
- `sag` −1..1 — bows connector runs toward screen-down/up via a
  (t(1−t))² bump on the samples: zero value AND slope at the ends, so
  end tangents and G1 joins are exact (moving the control points off
  the tangent line would kink).

Engineering shape: all three radius mods fold into ONE scale function
of arc progress (analytic base, central-difference tangents at the
connector endpoints), and the connector anchors on the MODULATED
entry/exit points — that single decision is what keeps every
combination G1 (smoke-tested: 648-combo modulation sweep finite, zero
kinks on a fully-modulated build, append stability exact with all
mods on). Guides (`orbits`/`skipped` aux) deliberately stay the CLEAN
base ellipses — idealized construction geometry the wandering ink
deviates from, matching the reference.

Animation:

- `progress`: scalar 0..1, default 1, keyframable/exposable — the
  deterministic draw-on. Domain is the POINT TOUR, not arc length:
  `progress × N` reveals whole orbits 0..k plus a fraction of orbit
  k+1's arc+connector. Point-indexed so live-appended points never
  shift already-revealed geometry (an arc-length Trim Path would
  re-normalize; it remains available downstream for length trims).
- `reveal_mode`: enum `off | auto`, default `off`. Auto = a stateful
  PEN that draws the path at one orbit per `reveal_time` seconds
  (visibleIf, default 0.6) of SCENE time, catching up toward the tail
  as points land. Timeline-locked (rev 3, owner feedback): the pen
  integrates positive scene-time deltas only — it advances while the
  timeline plays (or is scrubbed forward), FREEZES while paused (a
  cursor-move eval no longer plays it), and RESETS to redraw when
  time moves backward: the loop wrap, or a jump back to frame 0.
  Scene-time integration makes it deterministic, so offline export
  renders the reveal (an export played from frame 0 matches the
  preview; rev 2's export-renders-complete rule is gone). (Rev 1's
  per-point landing clocks broke on a pre-existing point set — every
  orbit's clock finished simultaneously and the whole tail popped in
  one frame, because the one-continuous-stroke rule stops drawing at
  the first incomplete orbit. A constant-rate pen sequences correctly
  for live appends and loaded sets both.) Composes with `progress`
  (min of the two per orbit).
- Aux outputs follow the same reveal: an orbit/skipped-arc subpath
  only exists once its point's loop has started drawing.

## Algorithm (engine/spline-weave.ts — new, pure)

All in canvas px space; normalized [0,1]² y-down at the boundary.

1. **Tour** — index order, or greedy NN (O(N²), fine at the point
   counts this targets; Connect Points precedent).
2. **Orbits** — per tour stop: center, rx/ry, orientation, handedness
   d_i, winding w_i from params + hashed jitter.
3. **Tangent points** — consecutive orbits get a common tangent
   consistent with (d_i, d_{i+1}): opposite handedness ⇒ internal
   (crossing) tangent, same ⇒ external. Solved per orbit in its
   affine-normalized frame (tangency is affine-invariant) with 2–3
   fixed-point refinements. An external point inside the orbit
   degrades continuously (acos clamp) to the facing point — no
   explosion when orbits overlap.
4. **Arc spans** — entry angle → exit angle traversed in d_i for
   w_i extra full turns. The complement interval is the `skipped` arc.
5. **Connectors** — Hermite cubics from exit to entry whose end
   tangents are the two orbits' traversal directions. When orbits are
   separated this reproduces the straight common-tangent line exactly
   (tangents ≈ chord ⇒ m/3 handles ⇒ a line). When they OVERLAP —
   the common case at default radius, and constant in the reference
   look — no tangent line exists, the clamped tangent points nearly
   touch, and m/3 handles would hairpin: each handle instead grows
   with the turn its end must make (radius-scaled), so the bridge
   swings a smooth radius-sized curl. Found empirically via the
   smoke test's G1 check — rev 1's "straight connector" was cusping
   at every overlapping join.
6. **Sample** — arcs adaptively by length (~3px steps) + connectors
   by their true curve length, kept as PER-UNIT polylines (unit k =
   arriving connector + orbit k's arc); `progress`/reveal cut units
   here, cheap, before fitting.
7. **Fit** — `fitSplineToPolyline` (spline-math.ts) runs PER UNIT and
   the anchor chains stitch (shared boundary anchor merges, G1 by
   the tangent construction). Fitting the whole path at once would
   let an appended point redistribute anchors along already-drawn ink
   — the least-squares fit is global over its input — which the smoke
   test caught as ~4px prefix drift; per-unit fitting makes the
   prefix byte-stable. Full orbit ellipses skip fitting entirely
   (exact 4-anchor kappa rings).

Caching: pure function of (points value, params) — the default
fingerprint covers it, EXCEPT auto-reveal. The node is `stable`, so
scene time is not in its base fingerprint; while the pen is mid-stroke
`fingerprintExtras` keys on `ctx.tick`, which advances during playback
and offline frame-stepping but NOT in a paused editor — so paused
cursor-move evals stay cache hits and the pen stays frozen (this
replaced rev 2's pipeline-bump wall-clock loop, which animated the
reveal on any eval). A backward time jump returns a distinct reset key
even when the pen is idle, or the rewind would never reach compute
through the cache. No textures — CPU spline math only, nothing to
release.

## Cursor Trail Points — sockets & params

Source, no inputs, `stable: false` (external cursor state), state in
`ctx.state["cursor-trail:<id>"]`, cleared in `dispose`.

- `emit`: enum `press | hover`, default `press` — drop points while
  the pointer button is held over the preview (the drawing gesture)
  or whenever the pointer moves over it. **Requires a new
  `pressed: boolean` on `CursorState`** (EffectsApp pointerdown/up
  mirror next to the existing pointermove tracking; additive field,
  no ripple — CursorState isn't a SocketType).
- `spacing`: scalar, canvas-width fraction, default 0.04 — minimum
  travel between drops.
- `scatter`: scalar, canvas-width fraction, default 0.02 — radial
  jitter around the raw cursor position, hashed on drop index (drops
  don't teleport on re-eval).
- `seed`: scalar int, default 0.
- `max_points`: scalar int, default 200 — cap; `overflow`: enum
  `stop | ring`, default `stop` (ring = oldest drop expires, FIFO).
- `lifetime`: scalar seconds, default 0 (= forever) — drops expire.
- `clear_on_loop`: boolean, default true — reset the trail when scene
  time wraps (sim-zone convention).

Output: `points`, positions in y-DOWN normalized space — **note the
flip**: `ctx.cursor` stores Y-UP canvas UV (devguide convention), CPU
points are y-down. `groupIndex` = the drop's MONOTONIC id (not array
index), so ring-mode expiry never re-keys surviving points' hashes.

Implementation notes: fast swipes interpolate drops along the pen
segment so spacing holds (not one drop per frame); the node is
`stable:false` but its `fingerprintExtras` keys downstream caches on
the drop set (nextId + count + oldest id) so an idle cursor doesn't
recompute the graph; an active `lifetime` decay dispatches
pipeline-bump so trails keep dissolving while playback is paused.

## Milestones — all shipped 2026-07-20

- **M0** — `engine/spline-weave.ts` (pure: tour, orbits, tangents,
  sampling, fit) + Loop Weave node (`src/nodes/effect/loop-weave.ts`)
  with Tour/Loops/Shape params and the primary weave output.
- **M1** — `orbits` + `skipped` aux outputs with groupIndex tags,
  gated on `consumedOutputs`.
- **M2** — `progress` (deterministic, keyframable) + `reveal_mode:
  auto` (constant-rate pen in ctx.state; rev 3 made it scene-time
  integrated — plays with the timeline, freezes when paused, resets
  on rewind/loop-wrap, and offline export renders it).
- **M3** — Cursor Trail Points (`src/nodes/source/cursor-trail-
  points.ts`) + `CursorState.pressed` (optional field; tracked
  capture-phase in EffectsApp AND LiveViewer so /live and exported
  apps draw too; presses count only when they START inside the
  preview box, so panel drags never scatter points).

Verified by a pure-math smoke suite (22 checks: append stability =
exact-zero prefix drift, progress monotonicity, orbitLimit gating,
G1 at every interior anchor, 384-combo param sweep for NaN, degenerate
inputs incl. all-coincident points) + typecheck + lint ratchet.
Manual browser pass on the real demo graph is the remaining step.

## Invariants & caveats

- Per-point randomness is hashed on (index, seed) — never on count,
  never `Math.random()` — or live appends reshuffle the drawn path.
- Orbit geometry builds in px space (aspect invariant #4); positions
  cross the boundary as normalized y-down.
- `loops = 0` + `direction: alternate` degrades gracefully to a
  slalom through the points (still tangent-smooth) — worth keeping
  correct, it's a good look on its own.
- NN ordering + live appends legitimately reroutes; that's disclosed
  in the param description rather than prevented.
- Back-compat: new node types only, no schema bump.
