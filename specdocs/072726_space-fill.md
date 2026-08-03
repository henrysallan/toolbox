# Space Fill — packed self-avoiding walk spline generator (spec, 2026-07-27)

A new spline generator, **Space Fill** (`space-fill`): port of the owner's
p5.js "flo" sketch — a **straight-seeking self-avoiding walk** over a pixel
occupancy grid. A walker draws a line step by step, always choosing the free
cell closest to "dead ahead"; every step stamps a fat neighborhood of the
grid occupied, so later lines pack tightly against earlier ones. When the
walker jams (or hits its step budget) a new line starts nearby with fresh
per-line character (step reach, weight, palette identity). The emergent
result is the reference look: dense maze-like packing, long parallel runs,
45°/90° kinks, nested-frame illusions — none of it modeled explicitly, all
emergent from the packing.

Spline-native by design: each line is one open polyline subpath (anchors at
turns only), tagged with a `groupIndex` from a selectable **ID mode** so the
existing downstream group-ramp styling (Rasterize Spline fill, Stroke color
+ per-subpath thickness) colors it. The node emits pure geometry — no
styling code of its own.

Design decisions locked with the owner (Q&A 2026-07-27):

- **Faithful port of the sketch's live mechanics** (the owner supplied the
  source; see the mapping table below for live vs dormant branches).
- **Canvas + optional region input** — full canvas (minus margin) by
  default; a wired mask/spline confines the walk.
- **Pure spline output** — styling stays downstream (Rasterize/Stroke group
  ramps). No baked raster.
- **ID modes**: cluster / order / random / size (+ per-line), landing on
  `SplineSubpath.groupIndex`.
- **Progress param, sim-state** — keyframable reveal; the deterministic
  trace is cached in `ctx.state` and progress just slices it (scrub-anywhere,
  backward included, no re-sim).
- **Coverage + line cap** as the fill budget.
- **Per-line weight only** — carried on a new generic per-subpath `driver`
  scalar consumed by the shared subpath-driver system (M3).

## Node surface

```
Space Fill  (spline / generator; CPU compute, webgl2 backend for the
             region/obstacle readback only)
inputs:
  region    mask, optional — walkable area (≥0.5 = walkable). Splines coerce
            in as their filled silhouette, images as luminance × alpha.
            Unwired → full canvas minus margin.
  obstacles mask, optional — blocked cells carved OUT of the walkable area
            (≥0.5 = blocked). The sketch's pre-seeded blocker stripes
            (lzs/sqs), generalized.
  (+ universal mask input — pure source, so it MATTES the output raster
   downstream as usual. + universal opacity param is N/A: spline primary.)
params:
  — fill —
  progress   scalar 0..1, default 1 — keyframable reveal. 1 = the full
             trace; scrubbing slices the cached trace (cheap both ways).
             THE animation input.
  coverage   scalar 0..1, default 0.85 — stop tracing when this fraction of
             walkable cells is occupied
  max_lines  scalar int 1..2000 softMax 500, default 250 — safety cap
  seed       scalar int, default 0 — everything: starts, steps, weights, ids
  margin     scalar 0..0.25, default 0.02 — border buffer, canvas-min-dim
             fraction (bufferx/y)
  — walk —
  step_min   scalar int 1..8, default 1 — walker reach lower bound (px cells)
  step_max   scalar int 1..8, default 4 — upper bound; each line drifts its
             reach ±1 within [step_min, step_max] (sizeChoice random walk)
  metric     enum straight | farthest | manhattan | weighted,
             default straight — candidate scoring. straight = the sketch's
             angle metric (closest to dead-ahead); farthest/manhattan = the
             l2/l1 "jump as far from the previous point as possible" modes;
             weighted = the evolving-weight lm metric (chaotic).
  wobble     scalar 0..1, default 1 [visibleIf metric = straight] — per-step
             exponent jitter on the angle metric (the sketch's powtol). 0 =
             rigid straight runs; 1 = full kink character.
  wander     scalar 0..1, default 0.1 [visibleIf metric = weighted] — how
             fast the lm weight (alm) drifts per step (mmult scaled)
  spacing    scalar int -1..8, default -1 — occupancy stamp radius (fatness).
             -1 = auto (step − 1, the sketch's tie); explicit values loosen/
             tighten packing independent of reach.
  line_steps scalar int 16..20000 softMax 5000, default 3000 — per-line step
             budget before a forced restart (nlim, made deterministic)
  — starts —
  start_mode enum near-previous | anywhere, default near-previous — new
             lines try to spawn beside the previous line's end (the sketch's
             stay-on-track behavior), falling back to random; anywhere =
             always random (drawra)
  start_area scalar 0..1, default 1 — confine line STARTS to a centered
             sub-window of the walkable bbox (fraction per axis; the
             sketch's useaddx inner window — walks may still wander out,
             which is what makes the composition edges organic)
  — weight —
  weight_min scalar 0..1, default 0.6 — per-line weight, drawn uniformly in
  weight_max scalar 0..1, default 0.9   [weight_min, weight_max] (seeded);
             written to the subpath's driver channel, mapped to px downstream
             by Stroke's thickness lo/hi (sketch equivalence: sw saturates to
             ~0.85 · step within a few steps — see mapping table)
  — ids —
  id_mode    enum line | random | cluster | order | size, default cluster
  id_groups  scalar int 2..32, default 6 [visibleIf id_mode ∈ random|order|size]
  cluster_grid scalar int 2..16, default 4 [visibleIf id_mode = cluster]
  id_seed    scalar int, default 0 [visibleIf id_mode = random]
outputs:
  primary  spline — one open subpath per line, anchors at direction changes
           only, groupIndex per id_mode, driver = per-line weight
  aux      points ("tips") — one point per line drawn so far, at its current
           tip; rotation = tip direction, scale = (weight, weight),
           groupIndex = the line's groupIndex. During growth these are the
           active drawing tips (wire sparks/particles onto them).
```

## The walk (CPU, deterministic)

All randomness through a seeded PRNG (mulberry32; `hash01` conventions where
per-item hashes fit better). The trace is a pure function of (structural
params, region/obstacle content, canvas dims) — same seed, same picture.

1. **Grid** — occupancy `Uint8Array`, 1 cell = 1 px (canvas resolution; px
   space so geometry is isotropic — normalize per-axis only at emit).
   Walkable = region ≥ 0.5 (unwired: all) AND NOT obstacle ≥ 0.5 AND inside
   the margin border. Region/obstacles read back once per content change via
   the shared `readDriver` (engine/driver-reduce.ts) at cell resolution.
2. **Line lifecycle** — start cell: `start_mode` near-previous tries a
   seeded offset beside the previous line's end (± step+2 cells, as the
   sketch), rejection-falls-back to a random walkable cell inside the
   `start_area` window (K tries, then linear scan; total jam = trace done).
   Per line: step reach drifts ±1 within [step_min, step_max]; weight drawn
   in [weight_min, weight_max]; metric params refreshed (plm ≈ 1 jitter).
3. **Step** — scan candidates `(s,t) ∈ [-reach, reach]²` that are free +
   walkable; score by `metric`:
   - *straight*: `prev = past − cur` (backward vector), `rat = cos(prev,
     cand)` clamped; `Len = acos(rat) ^ clamp(plm, 1−u, 1+u)` with `u =
     rand() · wobble` per step; pick the candidate minimizing `|Len − π|`.
     Integer-vector angle quantization is what yields the axis/45° runs.
   - *farthest / manhattan*: maximize l2 / l1 distance from the previous
     position.
   - *weighted*: the lm metric with `alm` drifting per step by `wander`.
   Move there, stamp the `(2·spacing+1)²` neighborhood occupied (clipped to
   walkable), record the cell. No candidate → line ends (jam); `line_steps`
   exceeded → line ends.
4. **Termination** — coverage target reached (occupied/walkable counted
   incrementally), `max_lines`, or J consecutive zero-step lines (grid jam;
   J = 8).
5. **Anchor merge** — on line close, collapse collinear runs: successive
   steps with the same direction (dx,dy reduced by gcd) merge; anchors land
   only at turns, handle-less (sharp polyline — the aesthetic). Store per
   anchor its cumulative step index (for progress slicing). Lines shorter
   than 2 anchors are dropped from output (but their stamps remain — the
   sketch also darkens the grid on failed starts).

**Cost** — 1080p ≈ 2M cells; a full fill is on the order of 100–300k steps
× a ≤(2·8+1)² candidate scan ⇒ a few hundred ms worst-case, once. Per-frame
cost after the trace exists is just slicing (below). Structural param edits
retrace (acceptable hitch, same class as Text re-raster); `progress`,
`id_*`, and weight-range edits do NOT retrace.

## Trace cache + progress slicing (the sim-state model)

`ctx.state["space-fill:<nodeId>"]` holds `{ signature, lines }` where
`lines[i] = { anchorsPx, stepOfAnchor, startCell, lengthSteps, weight01 }`
plus grid totals. `signature` = stableStringify of the structural params
(everything except progress / id_* / weight range) + region/obstacle
value-object identity + canvas dims. Compute: signature match ⇒ reuse
trace; else rebuild fully (to coverage/caps).

`progress` maps to a global step count `k = round(progress · totalSteps)`;
binary-search the line containing k, emit all earlier lines whole and that
line's anchor prefix (`stepOfAnchor ≤ k`, plus an interpolated tip anchor at
the exact step so growth is smooth, not per-turn). Backward scrubbing is the
same slice — no re-sim ever. IDs and weights are assigned from the FULL
trace (stable during growth; a line's color never changes as it draws).

The node caches normally (no `stable:false`) — progress/param changes
fingerprint-miss into a cheap slice; animated region/obstacle inputs retrace
per frame (same video-driver caveat as Bento Slice; workaround: static
maps).

## ID modes (→ groupIndex)

- **line** — `lineIndex` (unique per line; Select by Index / per-line ops).
- **random** — `hash01(lineIndex, id_seed) · id_groups` floored. The
  sketch's random palette pick. (Its every-10th-line complement accent is a
  color-space trick — recreate downstream by placing complementary stops in
  the ramp.)
- **cluster** — the line's start cell quantized to a `cluster_grid ×
  cluster_grid` window over the walkable bbox ⇒ spatially clustered palette
  neighborhoods (the reference's regional color blocks).
- **order** — `floor(lineIndex / lineCount · id_groups)`: early lines are
  the long structural runs, late lines the small infill — depth-like
  banding.
- **size** — rank lines by `lengthSteps`, bucket ranks into `id_groups`
  quantiles: long arteries vs short detail get distinct roles.

## Per-subpath driver channel (small engine extension, M3)

`SplineSubpath` gains an optional **`driver?: number`** (0..1) — the
continuous sibling of the discrete `groupIndex`, the generic "producer-
authored per-subpath scalar". `makeSubpathDriverFn` (spline-color-source.ts)
gains mode `"driver"` (`sub.driver ?? 0.5`), surfaced as one new option in
the existing dropdowns: Rasterize Spline `ramp_by`, Stroke `ramp_by` +
`thickness_by` (label "Driver (from node)"). Per the shared-driver note in
spline-color-source.ts, any future per-subpath channel keys off this one
function — this is that future arriving.

Space Fill writes each line's weight there ⇒ **Stroke: Thickness source =
vary, Vary by = driver** maps weights onto px via the existing lo/hi
multipliers. Color may also key off it (weight-graded ramps for free).

Runtime-only value field — no serialization, no schema bump. Collect's merge
currently rebuilds subpath records; verify it spreads unknown fields (or add
`driver` alongside its `groupIndex` handling) so driver survives collection.

## Source-script → param mapping (fidelity audit)

Live mechanics, ported:

| sketch | node |
| --- | --- |
| `myArray` occupancy + buffers | grid + `margin` |
| `sizeChoice` walk in [min,max], ±1 per line | `step_min`/`step_max` + drift |
| `fatness = sizeChoice − 1` | `spacing` auto tie (−1) |
| angle metric, `plm≈1`, per-step `powtol` | `metric: straight` + `wobble` |
| `l1/l2/lm` metrics + `alm` evolution | `farthest`/`manhattan`/`weighted` + `wander` |
| `nlim` step budget | `line_steps` |
| stay-on-track restart, else random; `useaddx` inner start window | `start_mode`, `start_area` |
| per-line palette pick / `divCol` complement | `id_mode: random` + ramp authoring |
| `sw` walk in [0.1·sc, ~0.85·sc] | per-line `weight_min/max` → driver (see note) |

Weight note: the sketch's within-line `sw` walk saturates to its max within
a few steps (the `rv2` branch adds `max(rand(−ns,ns), mins) ≥ mins` ≈ 42–60%
of steps) — effectively per-line constant weight, so per-line-only is
faithful, not a simplification.

Dormant in the supplied version, deliberately dropped: `track` echo lines
(`track=0` — recreate downstream: duplicate → Transform offset → second
Stroke in the complement color), `zzm/uum` pre-seeded blocker stripes
(`zzm=0` — the `obstacles` input generalizes it), the `randomVar ≥ cutofff`
mid-line teleport (`random(−2,5)` can never reach 200+ — dead code), `bw`
black-and-white mode (downstream ramp's business), background complement
fill (downstream: Fill node under a Merge).

## Conventions & hygiene

- Anchors emit normalized [0,1]², y-down (px ÷ canvas dims per axis — the
  px-space walk keeps geometry isotropic on non-square canvases).
- Points aux built with `makePoints(count, {withScales, withRotations,
  withGroupIndices})`, **unconditionally** (loop-weave/consumedOutputs
  lesson).
- Missing/empty walkable area → empty spline (`{kind:"spline",
  subpaths:[]}`) + `EMPTY_POINTS`.
- Driver readbacks: pool leases released before return (readDriver
  discipline); walk state lives in `ctx.state`, dropped in `dispose`.
- Degenerate clamps: `step_min ≤ step_max`, `weight_min ≤ weight_max`
  (linkedPairs candidates), margin can't exceed the canvas (walkable-empty
  guard), `coverage` vs jam always terminates (J-consecutive-jams backstop).
- No schema bump — new node type, plain JSON params, runtime-only `driver`
  field.
- Engine self-containment (invariant #1): everything node-side or in
  engine/ (spline-color-source extension).

## Future work (non-blocking)

- **Track echo** param (auto complement offset echo) if the downstream
  recipe proves popular.
- Mask-driven per-region step size (a `detail` driver input modulating reach
  spatially — Adaptive Pixelate's driver convention).
- Per-anchor width (needs a spline-wide variable-width model — out of
  scope; the tips points output is the experimental escape hatch today).
- Curved emit option (Catmull-Rom through turn anchors) for a softer look.

## Milestones

- **M1 — trace core + node**: node file + registration; grid + region/
  obstacle readback via driver-reduce; seeded walk (straight metric),
  line lifecycle, coverage/max_lines/jam termination; collinear merge;
  trace cache + progress slicing; spline output with id modes line/random;
  `driver` field written (no consumers yet). Browser check: fills like the
  sketch, progress scrubs both ways, seed reshuffles.
- **M2 — full control surface**: farthest/manhattan/weighted metrics +
  wobble/wander; step drift, spacing override, start_mode/start_area;
  cluster/order/size id modes; tips points aux.
- **M3 — downstream driver mode + ship**: spline-color-source `"driver"`
  mode + Rasterize `ramp_by` + Stroke `ramp_by`/`thickness_by` options;
  docs descriptions; devguide + devlist updates; `npm run typecheck` +
  `npm run check` + lint ratchet.
