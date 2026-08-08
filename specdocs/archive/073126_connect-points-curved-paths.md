# Connect Points + Shortest Path — curved path modes (2026-07-31)

Status: **implemented with this spec**.

A `path` mode enum that replaces straight connection segments with
cubic-bezier curved ones. Seven modes; each one is a different answer
to "what decides the handle vectors" and gives a distinct visual
family. Pure emit-time handle math — connectivity, `groupIndex`
semantics, and aux outputs are untouched, and every anchor keeps its
exact input position (only `inHandle`/`outHandle` are added).

Lives in **engine/segment-shape.ts** (ParamDef factory + handle math
over an edge list of index pairs) and is consumed by two nodes:

- **Connect Points** — every proximity pair is an independent
  2-anchor segment; both ends get one handle each.
- **Shortest Path** (points + tree modes) — emitted routes/branches
  are multi-anchor CHAINS decomposed into consecutive edges; an
  interior anchor takes the in-handle of one edge and the out-handle
  of the next. `network` mode on a chain degenerates to through-point
  smoothing, and at tree junctions branches stay tangent-consistent
  (one shared tangent per point). Tree glide stubs enter the position
  table as synthetic entries while in flight (random keys stay on the
  true parent/child pair — no shimmer). **Spline mode is exempt**: it
  re-emits the wired network's own authored curved segments, which
  shaping would destroy.

## Motivation

- A proximity web of dead-straight chords reads mechanical the moment
  it gets dense. Curvature is the cheapest path to organic looks —
  and because `SplineAnchor` already carries cubic handle offsets, the
  entire feature is choosing two vectors per segment.
- Downstream stays composable: Set Spline Type, Trim Path, Stroke,
  Rasterize all consume the handles for free.

## Node interface

`path` enum, **header control** (like Shortest Path's `mode`):
`straight | curved | sag | flow | network | bundle | attract`.
Default `straight` — old saves load unchanged (additive params, no
schema bump).

### Params (all `visibleIf` on `path` except `max_distance`)

| name | type | range | default | mode | notes |
|---|---|---|---|---|---|
| `max_distance` | scalar | existing | 0.1 | all | unchanged; still measured in raw UV (back-compat: connectivity of existing projects must not change) |
| `curvature` | scalar | −1..1 | 0.5 | curved | signed arc angle θ = curvature·π; ±1 = semicircle either side |
| `s_curve` | scalar | 0..1 | 0 | curved | morphs the B-end tangent from mirrored (circular arc) to parallel (S-curve) |
| `flip` | enum | `none \| alternate \| random` | none | curved | sign of θ per segment; alternate = by emission parity, random = pair-hashed |
| `slack` | scalar | 0..1 | 0.3 | sag | mid-sag depth = slack·L/2 along gravity |
| `gravity_angle` | scalar | 0..360° | 90 | sag | 90° = down (+Y, y-down space) |
| `field_angle` | scalar | 0..360° | 0 | flow | base tangent direction |
| `flow_noise` | scalar | 0..1 | 0.5 | flow | snoise rotates the field ±(noise·180°) per endpoint |
| `noise_scale` | scalar | 0.1..20 | 4 | flow | spatial frequency of the rotation field |
| `handle_length` | scalar | 0..1 | 0.4 | flow | handle length as a fraction of chord |
| `tension` | scalar | 0..2 | 1 | network | handle length = tension·L/3; 0 = straight |
| `bundling` | scalar | 0..1 | 0.5 | bundle | 1 = segment midpoints reach the local bundle center |
| `bundle_radius` | scalar | 0..1, softMax 0.3 | 0.15 | bundle | midpoint neighborhood radius (iso units) |
| `compatibility` | scalar | 0..1 | 0.5 | bundle | how parallel a neighbor must be to attract (sharpens the alignment weight) |
| `attract_strength` | scalar | −1..1 | 0.5 | attract | + bows toward the center (capped at reaching it), − bows away |
| `attract_center` | enum | `centroid \| custom` | centroid | attract | centroid = mean of ALL input points (stable as connectivity changes) |
| `center_x` / `center_y` | scalar | 0..1 | 0.5 | attract+custom | authored normalized space |
| `path_jitter` | scalar | 0..1 | 0 | curved, sag, attract | per-segment ±100% variation of the mode's primary amount (prefixed: host nodes commonly own plain `jitter`/`seed` — Shortest Path's tree mode does) |
| `path_seed` | scalar (int) | 0..9999 | 0 | curved, sag, flow, attract | jitter / random flip / noise domain offset |

On Shortest Path the whole block is `visibleIf` mode ≠ spline and sits
after the tree params (`segmentShapePathParam(gate)` +
`segmentShapeModeParams(gate)`); Connect Points uses `path` as its
header control.

## Geometry conventions

- **Iso space.** Normalized [0,1]² is anisotropic on non-square
  canvases, so an arc computed there renders elliptical. All handle
  math runs in iso space (`x' = x·aspect, y' = y`, aspect = w/h — both
  axes then scale by canvas height in px), and the resulting handle
  OFFSETS convert back with `hx/aspect`. Anchor positions are copied
  from the input points directly (no round-trip drift). Angle params
  (gravity, field) are therefore visually true.
- **Determinism.** No `Math.random`. Per-segment randomness
  (jitter, random flip, flow noise offsets) uses the triple32
  `rand01` primitive keyed on the **unordered point-index pair**
  (same rationale as Shortest Path's jitter: stable frame-to-frame
  while points drift in and out of threshold — no shimmer). `alternate`
  flip is by emission index, inherently order-dependent — documented.
- **Quadratic-through-Q pattern.** sag / bundle / attract all bow the
  segment so its curve midpoint hits a target deviation `d`:
  `Q = M + dir·2d`, cubic handles `outH_A = ⅔(Q−A)`,
  `inH_B = ⅔(Q−B)`. `d = 0` degenerates to exact straight (handles
  collapse onto the chord) — no special-casing.

## Per-mode math (segment A→B, chord C, length L, unit u)

- **curved** — circular-arc family. θ = curvature·π · flipSign ·
  jitterMul, |θ| clamped to 1.75π. Tangent at A = rot(u, −θ/2);
  tangent at B = rot(u, +θ/2·(1−2·s_curve)) — s_curve 0 = mirrored
  (true circular arc), 1 = parallel (S). Handle length = the exact
  circle cubic: R = L/(2·sin|θ/2|), d = 4/3·tan(|θ|/4)·R (→ L/3 as
  θ→0). |θ| < ε emits a plain corner segment.
- **sag** — g = (cos, sin)(gravity_angle), d = slack·jitterMul·L/2,
  quadratic-through-Q along g. Hanging-wire look.
- **flow** — per endpoint P: φ = field_angle +
  snoise(P·noise_scale + seedOffset)·flow_noise·π, dir = (cos φ,
  sin φ), sign-corrected to dot(dir, C) ≥ 0 so segments never run
  backward. outH = dir_A·h, inH = −dir_B·h, h = handle_length·L.
- **network** — ONE tangent per point, shared by all its segments:
  accumulate incident edge directions (sign-corrected against the
  point's first edge so opposite arms reinforce instead of cancel),
  normalize. Each segment departs A along ±tangent_A (sign toward B)
  and arrives at B along ±tangent_B, handle = tension·L/3. Points
  with one connection get their own chord as tangent (straight
  departure — natural line-ends). Connections read as continuous
  curves flowing THROUGH points.
- **bundle** — one-shot simplified FDEB. Per edge: midpoint M, unit
  dir. Spatial hash on midpoints (cell = bundle_radius); weighted
  target = Σ w·M_f / Σ w over neighbors within radius,
  w = (1 − dist/r) · |dot(u_e, u_f)|^(1+7·compatibility) (self
  included at w = 1). Bow through Q = M + (target−M)·2·bundling.
  Parallel nearby edges merge into trunks; lone edges stay straight.
- **attract** — center = centroid of all input points (or custom).
  d = attract_strength·jitterMul·L/2 toward the center's direction
  from M; positive d capped at the distance to the center (the bow
  kisses the center, never overshoots past it). Negative repels,
  uncapped.

## Non-goals / decisions

- Bulge is always **proportional to chord length** (scale-free);
  no absolute-units toggle. Revisit only if asked.
- `max_distance` stays raw-UV (not iso) — changing it would silently
  rewire every existing project on non-square canvases.
- Perf: all modes O(E) over the emitted edges except bundle's
  midpoint hash (O(E·k)). Typical N ≈ 50–200 → negligible. Tree
  `branches` emission re-lists trunk edges once per overlapping
  chain; duplicates only re-weight identical directions/midpoints in
  network/bundle sums — harmless, documented.

## Verification (manual, in browser)

Scatter → Connect Points → Rasterize. Per mode: sweep the primary
param through 0 (must degenerate to straight), extremes (loops/deep
sag are legal, no NaN), non-square canvas (arcs stay round), jitter +
seed reroll, flip alternate/random, network on a dense web (curves
flow through points), bundle on parallel-ish structure (trunks form),
attract centroid vs custom + negative strength. Confirm groupIndex
passthrough (Copy to Points / Select by Group downstream) and the
`points` aux still mirror the input.
