# Spline Merge — Flow mode ("liquid" union)

Date: 2026-07-12 · Devlist #177 · Status: spec agreed, not yet implemented

## What & why

Spline Merge today is a discrete CPU boolean (polygon-clipping): every frame
it computes the *exact* union of the input's subpaths. When two shapes start
or stop overlapping, the silhouette topology changes in a single frame —
contours pop together, necks appear/vanish instantly.

Flow mode makes the silhouette behave like a liquid surface. The merged
region becomes a persistent simulated field that *chases* the current union
shape: as shapes approach, a bridge swells and snaps together; as they
separate, the neck stretches, thins, and pinches off. Continuous adaptive
flow instead of a discrete jump.

Decisions from the design Q&A (owner, 2026-07-12):

1. **Spline stays the primary output** (feeds Rasterize Spline stroke
   workflows), even though that means a GPU→CPU readback per frame.
2. **Same node** — a `flow` toggle on Spline Merge, not a new node. Exact
   mode's contract is untouched; flow off = today's behavior bit-for-bit.
3. **Separation "holds on"** — viscous/gooey pinch-off, with an `adhesion`
   param controlling how hard it clings.
4. **Backward time jumps snap** — scrub back / loop restart resets the sim
   to the instantaneous target (no flow-in after a jump).

## Architectural insight

Simulate a **field, not the curve**. A polyline/spring simulation of the
contour itself is brutally hard exactly at the interesting moments (two
loops merging into one, one splitting into two). An implicit field handles
topology changes for free: keep a persistent scalar field `F` (texture),
build the *target* field `T` from the current input silhouette each frame,
and relax `F` toward `T` over time. The silhouette is the iso-crossing
of `F`. Everything is ping-pong fragment passes — **no compute shader, no
WebGPU** (the WebGL↔WebGPU hop is CPU-mediated anyway; staying in WebGL2 is
strictly better here).

Field representation, v1: **blurred coverage** in [0,1], iso at 0.5 — not a
true SDF. Rasterize the union coverage, separable-blur it by the `blend`
radius. The blur band is exactly where the dynamics live (necks, bridges),
gradients are smooth there, and it's 2 passes instead of JFA's ~9 + seed.
`blend` doubles as the metaball pre-touch bridging distance (near-contact
shapes' blurred fields overlap and lift past iso — the classic gooey-filter
trick). If we later want wide-band reach or iso offsetting, upgrading `T` to
a JFA signed distance is a drop-in change (precedents: Text's JFA, SDF From
Image); the sim step doesn't care which field it relaxes.

## Node & params

All new params default to legacy behavior; no schema bump, type string
unchanged — saved projects load and behave identically.

- `flow` (bool, default **false**) — "Flow". Gates everything below via
  `visibleIf`; existing `resolution` (curve flattening for the exact
  boolean) hides when flow is on (flow rasterizes true beziers via Path2D,
  no flattening).
- `flow_speed` (scalar 0–1, default 0.5) — how fast the silhouette chases
  the target. Mapped internally to a per-second relaxation rate (time
  constant), so it's fps-independent. High = snappy, low = drifty.
- `tension` (scalar 0–1, default 0.35) — surface tension: mean-curvature
  flow strength. This is what makes necks thin and pinch off physically
  instead of cross-fading.
- `adhesion` (scalar 0–1, default 0.5) — how much separation holds on.
  Implemented as asymmetric relaxation: where the target says *leave*
  (shrink), the rate is scaled by `(1 − 0.85·adhesion)`; joining stays at
  full rate. Optionally also boosts tension on shrinking regions for
  stringier necks (tuning call in M2).
- `blend` (scalar 0–0.25 normalized, default 0.06) — spatial goo radius
  (target blur). Bridges shapes before contact.
- `detail` (scalar 128–768, softMax 512, default 320) — field resolution
  (longest axis; other axis follows canvas aspect). Quality/perf dial;
  features thinner than ~2 field texels can drop out (documented, raise
  detail).

`operation` interacts with flow: the target coverage is rasterized per op —
**union** = Path2D fill `"nonzero"` (one fill), **exclude** = `"evenodd"`
(one fill), **intersect** = per-subpath `source-in` compositing (N draws;
rare with many subpaths, acceptable). Same caveat as exact union: nonzero
treats every subpath as solid, so intended holes fill in.

## Per-eval pipeline (flow on)

State key `spline-merge:${nodeId}` grows a flow block: 2D scratch canvas,
leased field textures (`F` ping-pong pair + `T`), lastTick, last input
signature, last readback, settled flag, cached result spline.

1. **Time step.** `dtTicks = ctx.tick − state.lastTick`.
   - `> 0` → integrate the sim (one or a few substeps).
   - `< 0` (scrub back / loop restart) → reset, seed `F := T` (decision #4).
   - `== 0` (paused re-eval, including paused geometry edits) → **snap
     `F := T`** and extract. Paused preview shows the fully-settled
     silhouette, deterministic in the current geometry alone — no
     drag-path accumulation (the earlier "step once per paused edit" idea
     was non-deterministic: dragging a point through N positions
     integrated N times, so the result depended on the drag path). The
     temporal flow — necking, pinch-lag — is a *playback* phenomenon;
     hitting play integrates forward from the settled state.

   Large forward skips clamp to a few substeps.
2. **Target coverage.** `buildPath2D` (spline-raster.ts — already
   aspect-corrects Y, caller picks fill rule) → fill onto the scratch
   canvas at field res → upload to `T`'s texture.
3. **Blur.** Two separable passes, radius `blend · detail`, → target field
   `T` in [0,1], iso 0.5.
4. **Sim step** (one fragment pass per substep, ping-pong):
   `F += k(x)·(T−F)·dt + σ·κ·|∇F|·dt`, clamp [0,1], where `k` is the
   adhesion-asymmetric rate and `κ = div(∇F/|∇F|)` from central
   differences. Explicit Euler stability: `σ·dt ≤ h²/4` enforced
   internally by clamping σ per substep given field res — tension slider
   maps to a safe range, never to instability.
5. **Extract.** `ctx.readImageToFloat32(F)` → `marchingSquares(grid, w, h,
   {iso: 0.5})` → subpaths → primary `SplineValue`. This readback is the
   cost of spline-primary (decision #1): ~0.5–1ms at 320². Contours are
   dense polylines — same guidance as SDF To Spline: follow with Smooth
   Path / Resample downstream if needed.
6. **Aux `mask` output** (via `resolveAuxOutputs`, only when flow is on):
   one fullscreen smoothstep pass from `F` to a canvas-sized AA mask. Built
   **only when consumed** (`consumedOutputs`, Text precedent) — it's free
   quality for users who just want the silhouette matte without the
   spline hop.

## Caching, determinism, lifecycle

- **Fingerprint.** Def stays `stable` (default); add
  `fingerprintExtras: (params, ctx) => flow ? \`flow:\${ctx.tick}\` : ""`.
  Exact mode keeps full caching. M3 optimization: when **settled** (input
  signature unchanged AND max|ΔF| between consecutive readbacks < ε), return
  a stable token instead of the tick so *downstream* caches stop busting;
  compute meanwhile skips the sim + readback and reuses the cached spline.
  (fingerprintExtras reading per-node state is sanctioned — Segment
  Anything precedent. The one-frame lag on the settled flag is
  conservative-safe.)
- **Determinism / export.** Fixed dt per tick; offline export frame-steps
  sequentially from the start frame, so the sim evolves identically. All
  GL work is synchronous — no offline-settle registration needed.
- **Resets / snaps** (`F := T`): first flow eval, tick jumped backward,
  **paused re-eval (dt == 0)**, `detail` or canvas aspect changed
  (realloc), flow toggled on.
- **Texture discipline.** Field textures are pool-leased and held in
  `ctx.state`, released in `dispose` (Audio Spectral precedent). The node
  releases its own intermediates per pass; never touches input textures.
- **Engine self-containment** (invariant #1): sim pipeline lives in a new
  `src/engine/spline-flow.ts`; `src/nodes/effect/spline-merge.ts` stays a
  thin def. No imports from components/state/lib.

## Performance budget

At `detail` 320, per frame: Path2D fill (CPU canvas, cheap) + upload + 2
blur passes + 1–2 sim passes at 320² + one 320² RGBA16F readback + marching
squares on 320² CPU floats. Everything here already exists at similar cost
elsewhere (SDF To Spline reads 256² per change; Text runs JFA + MS when
consumed). Comfortably real-time; `detail` is the escape valve. Settle
freeze (M3) makes the static case cost ~zero.

## Milestones

- **M1 — Flow core.** Params + visibleIf gating, coverage rasterization
  (nonzero/evenodd), blur target, symmetric relaxation step, MS readback →
  spline primary, resets, dispose, tick fingerprint bust. Verify in browser:
  Copy to Points → circles → Spline Merge (flow) → Rasterize Spline, drag
  points and scrub.
- **M2 — Feel.** Curvature/tension term (with stability clamp), adhesion
  asymmetry, intersect coverage, default tuning against the "approach →
  bridge → separate → pinch" scenario. (Paused-snap lands in M1's time-step
  logic, not here.)
- **M3 — Perf & outputs.** Settle freeze + stable settled fingerprint, aux
  mask output gated on consumedOutputs, detail/aspect realloc edges.
- **M4 — Ship.** Node description + docs page, devlist #177 annotation,
  devguide update (sharp edges: field-res vs thin features; flow-mode cost
  profile), typecheck + lint ratchet.

## Risks / notes

- MS polyline density: strokes look great, but users hand-editing the
  output spline will see many anchors — Smooth Path/Resample is the
  documented answer (same as SDF To Spline).
- `exclude` + flow on fast-moving overlaps produces parity regions that
  appear/disappear; blur + temporal relaxation keeps it coherent, but it's
  inherently blinky content — fine, it's what XOR means.
- Blur-band field limits `blend` reach to the blur radius; JFA upgrade path
  documented above if wider metaball reach is ever wanted.
- `flow_speed`=max should approach exact-merge behavior (near-instant
  chase) but the contour is still the MS approximation of the *field*, not
  the exact boolean — switching flow off is the exact answer; don't try to
  blend between them (visible pop between contour families).
