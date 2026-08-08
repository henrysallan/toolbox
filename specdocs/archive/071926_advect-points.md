# Advect Points node (devlist #42)

Status: IMPLEMENTED — rev 2, 2026-07-19
(src/nodes/effect/advect-points.ts). Owner Q&A resolved: both modes
(integrate + accumulate), all four field interpretations, trails aux
output, points-only input. Typecheck + lint clean; compute logic
smoke-tested with a stubbed RenderContext (27 checks: field modes,
boundaries, trails, accumulate advance/reset). In-browser verification
pending.

**Implementation divergence from rev 1:** integrate-mode trails are
built UNCONDITIONALLY, not consumedOutputs-gated. The node is cacheable
and the evaluator reuses a cached NodeOutput verbatim on fingerprint
hit — a consumer wired to the aux later would read a stale empty spline
forever (Text can gate its SDF only because it's `stable:false`).
The integration loop dominates cost either way. Accumulate mode
recomputes every frame, so its trail HISTORY ring stays
consumption-gated as spec'd.

## What it is

**Advect Points** (`advect-points`, category `point` / `modifier`) moves
points through a velocity field derived from an image. Unlike Displace
(one sample, one push), advection **re-samples the field at every
step** — points follow the field's curves like leaves in a stream.

Two modes (header dropdown, like Simulation's `kind`):

- **integrate** — stateless. Every eval, the input points are seeds and
  the node integrates `steps × step_size` from scratch. Deterministic:
  scrub-safe, cache-friendly, offline-export exact. This is the
  flow-field art mode — noise → Advect → `trails` aux → Stroke gives
  classic streamline line art as a still; keyframing `steps` 0→N is a
  draw-on reveal; animating the field morphs the whole pattern.
- **accumulate** — stateful. The node keeps persistent positions in
  `ctx.state` and advances `substeps` steps once per **frame**. Points
  drift indefinitely and respond to the field as it animates ("dust in
  wind") without needing a Simulation Zone around it. Playback-order
  dependent by nature (same caveat as the Sim Zone); resets on scene
  loop or seed-count change. Wrapping Advect-integrate in a Sim Zone
  remains a valid power-user pattern, but is never *required*.

## Sockets & params

Inputs (fixed — no polymorphic retyping, so no
`CONNECTED_TYPE_RETYPE_NODES` entry):

- `points` (points, required) — the seeds.
- `field` (image, required) — the velocity field. Everything useful
  coerces in: noise, gradients, spline→mask, SDF rasters, video.
- `speed` (image, optional) — luminance multiplies step length,
  sampled per step at the point's current position. (Modulate Points'
  `scale_field` precedent.)

Primary output: `points`. Aux output: `trails` (spline) — see below.

Params:

- `mode`: enum `integrate | accumulate`, default `integrate`,
  `headerControl`.
- `field_mode`: enum `angle | vector | gradient | contour`, default
  `angle`.
  - **angle** — luminance → heading: θ = (luma × `angle_turns` +
    `angle_offset`) × 2π, unit speed. The Perlin flow-field classic.
  - **vector** — v = 2·(R − `midlevel`), 2·(G − `midlevel`). Signed
    RG map, matching Displace's channel convention.
  - **gradient** — central-difference ∇luminance, normalized to unit
    length; points flow toward bright. Zero-gradient regions stall
    (|∇| < ε ⇒ zero velocity) — semantically right, a point on a
    plateau has nowhere to go.
  - **contour** — gradient rotated 90° ((−gy, gx)): points orbit along
    level sets of the field. Feed an SDF/text/shape raster and points
    trace its contours.
- `steps`: int 1..1000 (softMax 200), default 100. `visibleIf`
  mode=integrate.
- `substeps`: int 1..16, default 1. `visibleIf` mode=accumulate —
  per-frame sub-stepping for faster flow without larger (curve-cutting)
  steps.
- `step_size`: scalar 0..0.02 softMax (max 0.1), step 0.0001, default
  0.002. Distance per step as a **canvas-width fraction** (stroke-units
  convention).
- `invert`: boolean, default false — negates velocity in any field mode
  (flow toward dark / reverse orbit / upstream).
- `angle_turns` (default 1, 0..4 softMax 2) + `angle_offset` (turns,
  −1..1, default 0): `visibleIf` field_mode=angle.
- `midlevel`: 0..1 default 0.5, `visibleIf` field_mode=vector.
- `boundary`: enum `clamp | wrap | kill`, default `clamp`. clamp =
  stick at the edge; wrap = torus (trail subpaths break at the seam);
  kill = point culled from the output (count shrinks, Point Expression
  `keep` precedent).
- `speed_jitter`: 0..1 default 0 + `seed`: int — per-point speed
  factor `1 − jitter × rand01(seed, index)` (triple32 index hash, like
  Point Expression's `rand`). Breaks up the lockstep look.
- `align_rotation`: boolean default false — write each point's final
  heading into its `rotation` (radians, atan2 of last step). Copy to
  Points then orients instances along the flow (arrows, dashes).
- `trail_stride`: int 1..10 default 1, `visibleIf` mode=integrate —
  record every Nth step position in trails (anchor-count relief for
  high step counts).
- `trail_length`: int 2..240 softMax 120, default 24, `visibleIf`
  mode=accumulate — history frames kept per point.

Attribute passthrough: `scales`, `rotations` (unless `align_rotation`),
`groupIndices` ride through untouched. In accumulate mode attributes are
re-read from the **current** seed input by index each frame (animated
upstream scales/rotations keep flowing); only positions come from state.

## Field sampling (engine details)

- One `ctx.readImagePixels(field, S, S)` at `FIELD_SIZE = 256` —
  GPU-downsampled RGBA8, row 0 = top, so Y-DOWN point UVs index with no
  flip (Displace/Jitter precedent). Cached in the node's `ctx.state`
  keyed by the **ImageValue object identity** (devguide-blessed
  "upstream recomputed" signal): a static field costs one 256KB
  readback ever; an animated field costs one per frame. Same machinery
  for `speed`.
- Sampling is **bilinear** (new small helper, local to the node).
  Displace's nearest-neighbor is fine for one push; 200 iterated steps
  through a nearest-sampled field produce visible grid banding.
- Gradient/contour: central differences of bilinear luma at ±1/S.
- Aspect correctness (invariant #4, decided explicitly): velocity is
  computed in square space and the y step is scaled by `aspect = w/h`
  when applied to normalized coords — `x += vx·s`, `y += vy·s·aspect` —
  so speed is isotropic in pixels and orbits stay round on non-square
  canvases.
- Per step: `p += v̂ · step_size · speedLuma(p) · jitterFactor(i)`.

## Trails aux (`trails`, spline)

Built only when `consumedOutputs.has("aux:trails")` — unwired it costs
nothing.

- **integrate**: one open polyline subpath per surviving point —
  handle-less anchors (linear) at the seed + every `trail_stride`-th
  step + the final position. `groupIndex` = the source point's
  groupIndex (untagged stays untagged). Anchor budget is
  `count × (steps/stride + 1)`; the docs page notes the cost and points
  at `trail_stride` / Resample.
- **accumulate**: per-point ring buffer (Float32Array,
  `count × trail_length × 2`) appended once per frame advance, emitted
  oldest→current. History starts when the output is first consumed.
- `boundary: wrap` splits a trail wherever consecutive positions jump
  > 0.5 in either axis (the seam); `kill` ends the trail at the death
  position. Subpaths shorter than 2 anchors are dropped.

## Accumulate-mode state & reset

`ctx.state["advect-points:<nodeId>"]`:

```
{ positions: Float32Array(count×2), count, alive?: Uint8Array,
  initialized, lastTime, trail?: {buf, head, len} }
```

- **Advance gate**: step only when `ctx.time !== state.lastTime`.
  Paused param-tweak re-evals re-emit current state instead of
  advancing — a deliberate improvement over the Sim Zone (which steps
  on every eval while paused).
- **Reset** (re-seed positions from the current `points` input, clear
  trails): first eval; scene-time wrap (`lastTime > 0.05 && time <
  0.05`, Sim Start's rule); mode switched back from integrate.
  Backwards scrubbing without a wrap leaves state as-is (Sim Zone
  parity, documented). Seed identity churn alone must NOT reset —
  animated upstreams produce a fresh PointsValue every frame.
- **Seed-count changes MIGRATE, never reset** (rev 3, owner request):
  growth keeps every existing point's evolved position and seeds the
  new indices from the current input — an animated Scatter/Grid count
  streams points into the running flow; shrink truncates from the top
  (index-aligned upstreams keep survivors intact; an upstream that
  reorders indices on shrink is inherently ambiguous and gets the
  index-aligned interpretation). The trail ring reallocates with
  history preserved for surviving indices; joining points backfill
  their history with the seed position so their trail starts as a dot,
  not a line from garbage.
- **kill** marks `alive[i] = 0`; the slot stays (index alignment with
  seeds for attribute re-read) and dead points are culled at emit.
- Caching: no `stable` flag; `fingerprintExtras` returns
  `t:<time>|m:accumulate` only in accumulate mode, so integrate mode
  keeps full fingerprint caching (a static 200-step × 10k-point
  integration computes once) while accumulate busts per frame.
  `dispose` deletes the state key.
- Zone interactions: inside an **Iterate** zone or a nested eval the
  accumulate state is shared per nodeId like any `ctx.state` — fine for
  v1 (Iterate's nested evals skip the state sweep); the docs note
  accumulate + Iterate is unsupported territory.

## What this deliberately doesn't do

- No image mode — Trails (velocity feedback), Datamosh (flow), and
  Watercolor Ink already cover image advection.
- No spline-anchor input — resample to points upstream (Points on
  Path / Resample), or revisit later behind Displace-style retyping.
- No GPU path — this is the CPU points pipeline; "millions of
  particles in wind" stays the particle simulator's job.
- No `uv`-socket velocity input in v1 — `vector` field mode covers
  authored maps; a `uv` coercion can come later without schema impact.

## Milestones

1. **Core integrate** — node file + registration; angle + vector field
   modes; bilinear sampler + identity-cached 256² readback; boundary
   clamp/wrap/kill; attribute passthrough; aspect-correct stepping.
2. **Field & feel** — gradient + contour modes; `speed` input;
   `speed_jitter`/`seed`; `align_rotation`; `invert`.
3. **Trails** — integrate-mode aux spline, consumedOutputs-gated,
   stride, wrap/kill splitting.
4. **Accumulate** — state blob, advance gate, reset rules, per-frame
   fingerprint, accumulate trails ring buffer, dispose.
5. **Polish** — docs page copy, devlist #42 annotation, devguide node
   list touch-up if needed.

No schema bump (new node type only). Back-compat untouched.
