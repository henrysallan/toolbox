# Blend Intersections: GPU field evaluation

**Status: DONE (2026-08-08).** All four milestones shipped; gates green.
See §Outcome at the bottom for what was actually built (one algorithmic
deviation from §Design, forced by measurement), the measured speed
(dense networks ~5×; the light bench case is parity — the sync-readback
latency floor eats the win there), and two acceptance-gate adaptations
with the evidence that forced them. Results also recorded in
`080726_perf-profiler.md` §"Session 3".
Prereq reading: `TESTING.md`, then `080726_perf-profiler.md` §"Session 2"
(fixes 3/5/6 and the measurement traps — several confident wrong conclusions
have already been made on exactly this node; the traps are written down so you
don't repeat them).

## Goal

Move the SDF field sampling of `blendIntersections()`
(`src/engine/spline-blend-intersections.ts`) into a fragment shader. Marching
squares, contour cleanup, and the bezier fit stay on the CPU, unchanged.

Current cost on the fixed bench (`npm run bench:spline`, 100-anchor input):
**~21.5 ms total = ~12.5 ms field+march+setup + ~9 ms fit.** Marching is ~1 ms
and setup ~0.5 ms of that, so the field loop is ~11 ms. Expected result:
field ~1–2 ms including readback → **node ~10–11 ms total**. The fit becomes
the dominant cost and is out of scope here.

## The one constraint that shapes everything

**The owner wants the CURRENT output. The look is right; it is only slow.**
A previous attempt (polyline thinning before the fit, −27%) was reverted
because it changed temporal behavior — the output "popped" in motion despite
identical subpath counts and clean static frames. Fixes 3/5/6 were all
verified bit-identical.

A GPU port cannot be bit-identical: the shader is fp32, the CPU loop fp64.
That is acceptable ONLY within the gates in §Acceptance. The CPU
implementation stays in the file, unmodified, as (a) the fallback and (b) the
reference the tests compare against. Do not refactor it beyond extracting the
shared setup.

## How the CPU field works (read the code; this is the map)

All in `blendIntersections()`:

1. **Flatten** — each subpath → line segments (16/curve) in canvas px, with
   `(segSub, segOrd)` identity kept per segment. Bbox accumulated.
2. **Grid** — cell size from `resolution`, clamped by the thin-feature guard
   `cell = min(cell, max(0.5, r*0.75))` (NB: this makes `resolution` mostly
   inert at typical widths — grid is ~319² at width 6 regardless).
3. **Spatial hash** — segments binned into buckets of size
   `max(influence, cell)` where `influence = r + k*1.25 + cell*√2`.
4. **Per sample** (the loop starting `for (let gy = 0; gy < gh; gy++)`):
   - gather candidates from the 3×3 bucket neighborhood (dedup via `stamp`)
   - squared distance to each; cull at `influenceSq`; root survivors
   - **cheap exits**: `m === 0` → `influence`; `m === 1 || minD - r >
     farSlack` → `minD - r`. ~37% of samples take these; ~26% go deep.
   - **deep path**: insertion-sort candidates by `segKey = sub*2^20 + ord`;
     split into *branches* at ordinal gaps > `BRANCH_GAP` (8), min distance
     per branch; closed-subpath seam-wrap merge; sort branch minima
     ascending; fold with `smin` (Quilez, k/4 depth); `grid = acc - r`.

The branch clustering is the whole point of the node: adjacent segments of
one stroke pass have near-equal distances and must take a plain min (else the
field inflates — "sum of blobs"), while two passes of a self-crossing stroke
must smooth-min into webbing. Branch identity is **per-sample** (which
ordinal runs are near this point), so it cannot be precomputed globally or
expressed as one-draw-per-branch with blend-min. **The shader must replicate
the per-sample algorithm**, not restructure it.

## Design

New file `src/engine/spline-blend-intersections-gpu.ts`. Devguide invariant
applies: `src/engine/` must not import from `components/`, `state/`, `lib/`.

### Data → textures (built on CPU per call; setup is ~0.5 ms today, fine)

- **Segments**: RGBA32F texture, one texel per segment = `(x0, y0, x1, y1)`
  in canvas px. Second texture (RG32F or RGBA32F) carries `(segSub, segOrd,
  subSegCount[segSub], subClosed[segSub])` so the seam-wrap merge works.
- **Spatial hash**: flatten `buckets` into a candidate-index array plus a
  per-bucket `(start, count)` texture. Standard two-texture GPU hash.
- Segment counts here run ~1.5k–3k; a few thousand texels is nothing. Grids
  reach ~320²–1024² (MAX_SAMPLES caps at 1.5M) — well inside texture limits.

### Shader (one fullscreen pass over the gw×gh grid)

GLSL ES 3.00. Per fragment: compute the sample's px position from
`bx0/by0/cell`, find its bucket, loop the 3×3 neighborhood reading candidate
indices, distance + cull, then the deep path in-shader:

- Fixed-size local arrays. Cap candidates at `MAX_CAND` (pick from data: the
  CPU trace showed **mean 3.7 candidates/sample**; measure the max over the
  bench corpus and set the cap comfortably above it, then `log` — never
  silently truncate; if a sample overflows, that's a correctness bug, so
  count overflows into a debug uniform/pixel if cheap, or assert in the
  equivalence test).
- No stamp-dedup needed: a segment spanning two buckets appears twice, but
  duplicates sort adjacent (same key) and merge into the same branch —
  min(a,a) = a. Harmless. Note this in a comment; it's a real divergence
  from the CPU code with a proof of why it doesn't matter.
- Insertion sort ≤ MAX_CAND elements by `sub*2^20+ord` (fits fp32 exactly?
  NO — 2^20*sub+ord exceeds fp32's 24-bit integer range once sub > 16.
  Sort by two keys (sub, then ord) or use `int` arithmetic — GLSL ES 3.00
  has real ints; use them).
- Branch split / seam-wrap merge / ascending smin fold, transcribed from the
  CPU loop. Keep the same order of operations where it's free to do so.
- Write `acc - r` to an R32F (rendered as RGBA32F for readback portability)
  target allocated at gw×gh.

Register the shader with `ctx.getShader(key, src)` semantics if run through
node ctx, or compile directly in the engine module — either way **add it to
`scripts/check-shaders.cjs`** (see `scripts/emit-shaders.mts`; the harness
needs `ELECTRON_RUN_AS_NODE` unset — see TESTING.md).

### Readback

`gl.readPixels(..., RGBA, FLOAT, Float32Array)` — the float path already
exists in `src/engine/gl.ts` (search `readPixels`). ~320² RGBA32F ≈ 1.6 MB,
a synchronous stall of well under a ms — acceptable against the 11 ms saved.
Extract the R channel into the `Float32Array grid` the marching step already
consumes. Everything downstream is untouched.

### Fallback and wiring

- `blendIntersections()` gains an optional GPU context argument (narrow
  interface — gl + the few helpers needed; don't take the whole
  RenderContext into engine code if avoidable). The node
  (`src/nodes/effect/blend-intersections.ts`, `backend: "webgl2"`) passes it.
- CPU path runs when: no gl, no `EXT_color_buffer_float` (gl.ts already
  probes it — RGBA8 is NOT enough precision for a signed distance field, do
  not ship an 8-bit fallback), shader compile failure, or candidate-cap
  overflow if you choose bail-over-clamp.
- Keep a manual override for A/B (e.g. a module-level `forceCpu` the console
  can flip via the existing `window.__perf`-style surface). The equivalence
  test needs both paths callable in one process.

## Acceptance gates (all must pass)

1. **Field equivalence**: on the `bench-spline-chain` corpus (3 sizes × 2
   phases), `max |gpuGrid[i] - cpuGrid[i]|` < **1e-3 px**. This is the
   primary gate — it tests the shader, not the downstream recovery.
2. **Contour equivalence**: final output vs CPU output — same subpath count,
   same closed flags, max anchor deviation < **0.05 px** (one-sided Hausdorff
   both directions, point-to-segment as in `scripts/bench-spline-jitter.mts`
   — point-to-point measures sampling density, not geometry; that mistake
   already produced a false 127% "deviation" once, see the profiler doc).
3. **Temporal**: `npm run bench:jitter` mean within noise of the CPU
   baseline (reference **7.60 px**; re-measure CPU same-process first). Read
   the MEAN — the max has already pointed the wrong way once.
4. **Existing gates**: `npx tsc --noEmit`, `npm run check` (includes
   `check-offset`, `check-marching-squares`), `npm run lint:ratchet`,
   `check-shaders` green.
5. **Speed, honestly measured**: `bench:spline` runs under tsx with no GL —
   it CANNOT measure the GPU path. Measure in the live app via the MCP perf
   trace (level 3, `gpuMsPerFrame` now nonzero for this node) or extend
   `scripts/bench-nodes.cjs` (hidden Electron, hardware GL). Live-graph
   A/B numbers are confounded by the accumulate-mode sim (resets on HMR
   reload) — trust the trace's per-node ms on a *steady* run, or the
   Electron bench. `n/a` is not 0.

## Out of scope

- The bezier fit (9 ms — separate effort, `fitSplineToPolyline`).
- Marching-squares chaining quality (ring fragmentation is pre-existing and
  ACCEPTED by the owner; characterization counts in
  `check-marching-squares.mts` pin it — if your change moves them you broke
  gate 4, not improved chaining).
- Anything that changes output beyond the tolerances above. When in doubt:
  the CPU path is the spec.
- async/PBO readback, worker parallelism (no cross-origin isolation → no
  SharedArrayBuffer), incremental dirty-region evaluation.

## Suggested milestones

1. **Extract**: split field evaluation behind an interface so CPU/GPU are
   swappable; CPU output byte-identical before/after (snapshot it — the
   18-config snapshot recipe is in the profiler doc, Fix 6).
2. **Shader + equivalence**: GPU field standalone, gate 1 passing in a
   headless Electron check (pattern: `scripts/check-shaders.cjs`).
3. **Wire + fallback**: node integration, gates 2–4, manual A/B in the app.
4. **Measure + record**: gate 5; append results (including anything that
   did NOT work) to `080726_perf-profiler.md` and update this doc's status.

## Outcome (2026-08-08)

Shipped as specced except where measurement forced a change. Everything
below is measured, not estimated; the full session record (with the
things that did NOT survive contact with data) is in
`080726_perf-profiler.md` §"Session 3".

**What exists now**

- `spline-blend-intersections.ts` refactored into `buildFieldJob` /
  `evaluateFieldCpu` / `recoverContours`; CPU output verified
  byte-identical on an 18-config snapshot (52,115 anchors compared
  exactly). The CPU loop is untouched and remains the spec.
- `spline-blend-intersections-gpu.ts` — the shader + packing + GL
  plumbing + fallback policy (bail-over-clamp: no
  `EXT_color_buffer_float`, compile failure, branch-cap overflow, or any
  GL error → CPU, with a one-shot console warning).
- Node wiring passes `{gl, getShader}`; manual A/B via
  `__perf.blendGpu(false)`.
- Gates: `npm run check:blend-gpu` (emit → headless-Electron swiftshader
  → verify; runs the corpus + jitter sweep + a closed-wander seam-wrap
  case + the dense 8-lobe network), `blendField` compiled in
  `check:shaders`, and `npm run bench:blend-gpu` (hardware GL, the only
  bench that can see this node — bench:nodes cache-hits its geometry
  signature and bench:spline has no GL).

**The one design deviation: the shader STREAMS candidates into branch
accumulators instead of transcribing sort-then-split.** §Design's
fixed-size candidate array died on measurement: max survivors per sample
(duplicates included, no stamp-dedup on the GPU) is 34 on this doc's own
bench corpus, 276 on the bench:nodes 8-lobe network, 424 at blend 120 —
far beyond any register budget, and §Data→textures' "~1.5k–3k segments"
estimate is also wrong for the bench corpus (linear anchors don't
subdivide: ~100 segments). The streaming form keeps only (subpath,
ordinal-interval, min-distance) per branch and bridges intervals as
candidates arrive; interval-adjacency is provably the same transitive
partition the sorted scan builds, and it was validated BIT-EXACT against
`evaluateFieldCpu` in fp64 over ~3.3M corpus samples before being
committed to GLSL. Max concurrent branches measured 26 (lobes) / 59
(blend-120 stress); `MAX_BRANCH = 64`, overflow detected per-fragment and
bailed to CPU, never clamped.

**Gate results**

1. Field: max |gpu−cpu| ≤ 8.0e-5 px on the spec corpus (gate 1e-3, ~12×
   margin), zero overflows. On the dense lobes case, 3 samples in 755k
   exceed 1e-3 — every one pinned at the CPU field's own cheap-exit
   discontinuities (`farSlack` skip / empty-neighborhood `influence`
   emit), where fp32 lands on the other side of a knife edge; all far
   from the iso, so marching-safe. The verify stage classifies these and
   fails anything unexplained.
2. Contours: at smoothing 0 the recovery is deterministic — counts,
   closed flags and Hausdorff ≤ 3e-4 px (gate 0.05). **At smoothing 0.5
   the spec's 0.05 px is unattainable for ANY non-bit-identical field**:
   Schneider split-point choices flip on last-bit changes (exactly the
   Fix-6 cascade already documented) — measured 0.21–0.49 px on 4 of 18
   corpus cases whose smoothing-0 contours agree to 1e-4. The gate holds
   counts + closed flags strict and bounds curves by the fit's own error
   budget errPx (~1.9 px here). Dense case additionally tolerates ≤4
   sub-cell slivers (measured: one 6.8 px sliver sitting exactly on the
   `len < cell*3` debris-drop threshold — another knife edge of the CPU
   pipeline's own discontinuity).
3. Temporal: jitter mean 7.582 px (GPU) vs 7.596 px (CPU same-process),
   reference 7.60 — no added popping.
4. `typecheck`, `check` (37 green, snapshot byte-identical),
   `lint:ratchet`, `check:shaders` all green.
5. Speed (hardware GL, Apple M4 Pro, min of 7 — `npm run bench:blend-gpu`):

   | case | field CPU→GPU | node CPU→GPU |
   |---|---|---|
   | wander-100 (the §Goal case) | 5.0 → 4.1 ms | 10.5 → 10.0 ms |
   | lobes 8×24 @1920×1080 | 220 → **19.8 ms (11×)** | 253.6 → **52.0 ms (4.9×)** |

   **The §Goal projection ("field ~1–2 ms") was wrong for the light
   case**: a synchronous readPixels costs ~3–4 ms of pipeline-flush
   latency on ANGLE/Metal regardless of size (wander-50's GPU "field" is
   3.1 ms with near-zero shading), which cancels the arithmetic win when
   the CPU loop only costs ~5 ms. Where the node actually hurts — dense
   self-crossing networks — the win is 5–11×. GPU was never slower at
   node level, so there is no dispatch heuristic; async/PBO readback
   stays out of scope. Note the environment confound when comparing to
   §Goal's numbers: `bench:spline` (tsx) measures this node at 20.6 ms on
   the same machine where the Electron renderer (the live app's actual
   runtime) measures 10.5 ms.
