# Testing & performance — agent guide

How to verify a change in this repo, and how to measure performance without
fooling yourself. Written for an agent working here without prior context.

Related: `specdocs/061226_devguide.md` (architecture),
`specdocs/080726_perf-profiler.md` (why the perf tooling exists and what every
number means).

---

## 1. The gates

Run these before claiming a change works. The first three are CI gates.

| Command | Time | Guards |
|---|---|---|
| `npm run typecheck` | ~40s | `tsc --noEmit`. Hard gate. |
| `npm run check` | ~60s | 13 offline `check-*.mts` scripts. Hard gate. |
| `npm run lint:ratchet` | ~90s | Fails only on errors **above** `scripts/lint-baseline.json`. |
| `npm run check:shaders` | ~20s | GLSL compiles/links + blend equivalence. Needs Electron + GL. |
| `npm run check:blend-gpu` | ~2min | Blend Intersections GPU field ≡ CPU reference (field/contour/temporal gates). Needs Electron + GL. |
| `npm run bench:nodes` | ~2min | Per-node cost ranking. Needs Electron + hardware GL. |

**The lint ratchet is not "zero errors."** It fails only when a file gains
errors beyond the committed baseline (pre-existing React-19 hooks errors are
grandfathered). Never re-baseline to make your own new errors pass — fix them.
`npm run lint:ratchet -- --update` is for deliberate moves/renames only.

`npm run check` scripts stub the DOM and GL, so they test pure logic only. If a
change touches shaders or real rendering, they will pass while the app is
broken — use `check:shaders` or the live app.

**Calling `def.compute()` directly bypasses the evaluator's wire coercion.**
In the app every wired value goes through `coerceValue(value, socketType)`
first (evaluator.ts) — a node-level test that hands values straight to
compute can pass while the live node receives `undefined` (this shipped a
"3D Copy to Points renders nothing" bug: 3D points values carry kind
"points" but ride `points3d` sockets, and coerceValue had no routing for
that pair). Offline node tests should push each input through
`coerceValue` with the socket's resolved type.

### Which check guards what

- `check-validator/builder/edit/*-loop`, `check-mcp` — the AI-recipe and MCP
  trust boundary.
- `check-persistence`, `check-graph-ops`, `check-fragment-roundtrip` — save
  format and structural graph edits.
- `check-node-presets` — user node presets ("Save as Preset"): fragment
  round trip + the untrusted-JSON sanitize gate.
- `check-kernel`, `check-sim-preroll` — the vector kernel and simulation
  pre-roll predicate.
- `check-profiler` — the perf collector: ring-buffer wrap, recompute-reason
  classification, GPU results resolving into already-committed frames.
- `check-output-gating` — `NodeDefinition.gatesOutputs`. See §5.
- `check-tracker` — motion-tracking kernel (ZNCC + LK + homography/ESM +
  smoothing/repair) and `track_data` identity-token fingerprinting. See
  specdocs/082226_motion-tracking.md M0.

---

## 2. Adding a node or shader

1. `npm run typecheck && npm run check` — catches registration, params,
   persistence.
2. **If you touched GLSL, run `npm run check:shaders`.** A syntax error or a
   wrong blend formula is invisible to typecheck and to every stubbed check
   script; it only shows up as wrong pixels in someone's project.
3. If the node might be expensive, `npm run bench:nodes` and find it in
   `bench/node-bench.md`. Nodes it cannot measure: Blend
   Intersections (its geometry-signature cache hits on the harness's
   repeated identical input — use `npm run bench:blend-gpu`, which also
   A/Bs its CPU vs GPU field paths on hardware GL), Rasterize Spline
   (same internal-signature pattern; its default params also exercise
   the cheap flat path, not the per-subpath ramp path) — and anything
   else with the same internal-cache pattern.
4. If you touched `spline-blend-intersections*.ts`, run
   `npm run check:blend-gpu` — the GPU field must keep matching the CPU
   reference (field < 1e-3 px, contours, temporal jitter). The CPU loop
   is the spec; `__perf.blendGpu(false)` A/Bs the paths live.

`scripts/check-shaders.cjs` must stay `.cjs` — it is an Electron **main
process** entry loaded by the Electron binary, not Node's ESM loader. As
`.mjs` it fails on `require` and headless Electron sits on the load error
instead of exiting, which looks exactly like a hang.

---

## 3. Profiling the live app

Capture is **off** by default and costs nothing until armed.

**In the UI:** switch any panel to **Performance** via its kind chip
(top-left), pick a level, press play. The panel records **only while the
timeline is playing** (`playingOnly` capture), and **seeking to frame 0
clears the trace** — rewind-and-play is how a fresh benchmark run starts.

**Over MCP** (tools: `set_perf_capture`, `get_perf`, `get_perf_frame`):
these arm WITHOUT `playingOnly`, so paused interactions (a `set_param`, a
scrub) ARE recorded — the agent workflow depends on that. Two consequences:
arming from either side replaces the other's mode (and clears), and the
frame-0 auto-clear applies to MCP captures too — a `transport` seek to
frame 0 wipes whatever you had accumulated, so read the trace first.

```
set_perf_capture({ level: 3, frames: 400 })
transport({ action: "play" })      // …wait several seconds…
transport({ action: "pause" })
get_perf({ top: 10 })
```

**In the console:** `__perf.start(3)` → drive → `__perf.report()`.

### Levels

- **1** — per-node CPU time + why each node recomputed.
- **2** — adds data volume, texture churn, fingerprint size.
- **3** — adds per-node **GPU** time. **Use this for anything rendering-related.**

### Traps that will waste your time

- **A backgrounded editor window suspends `requestAnimationFrame` entirely.**
  Zero frames get captured and the playhead does not advance — including for
  `seek`. If a capture comes back empty, this is why. The window must be
  foregrounded.
- **CPU time is usually not the answer.** This project's frames are GPU-bound:
  a Merge chain at 4K measured 0.02 ms of CPU and 2.5 ms of GPU. Ranking by
  CPU points confidently at the wrong node. Always reach for level 3.
- **GPU timings resolve 1–3 frames late.** Drive the workload for several
  seconds before reading, and check `gpu.coverage`. A missing GPU number is
  reported as absent, never as 0.
- **The editor evaluates only on playback, a param edit, or a graph change.**
  An idle editor records nothing — that is correct, not a broken capture.
- **Level 3 inflates the CPU cost of nodes that make sync GL calls.** The
  GPU timer queries serialize around readbacks/fences: sdf-to-spline read
  ~9 ms/eval at level 3 and ~3 ms at level 1, same conditions. Before
  attributing CPU time to a node that calls readPixels / getBufferSubData /
  clientWaitSync, re-measure it at level 1.
- **A loop's sections are not interchangeable.** Content-dependent nodes
  (marching, boolean, per-subpath rasters) can cost 3× more in a dense
  section of the timeline than a sparse one — an A/B whose two runs covered
  different loop spans compares content, not code. Cover the same span, or
  full loops.

### Reading the output

- `poisonRoots` ranks uncacheable nodes by how much **downstream** recompute
  they force. **Animated roots are normal** — an animated graph is supposed to
  recompute. This says who owns the cost, not what is broken. A 0% cache hit
  rate on an animated graph is expected; do not "fix" it.
- `triggers` counts what caused each eval (`raf` / `state` / `bump` / `seek` /
  `export`). Use it to tell "the app is busy" from "the user is interacting".
- Phase buckets and the node table are two decompositions of the same frame,
  **not addends**. Phases charge nested (Iterate) work to the bucket it
  happened in; depth-0 node samples charge it to the enclosing shell.
- `blit` is measured outside `evaluateGraph` and is not part of `total`.

---

## 4. The per-node bench

`npm run bench:nodes` → `bench/node-bench.md` (worklist) and `.json`
(diffable). Calls each `def.compute()` directly with synthesized inputs — same
inputs, same canvas, no caching, no graph.

Interpret with these limits in mind:

- **Default params only.** A node whose expensive path is behind a non-default
  toggle is under-measured. A low number is not proof a node is fast.
- **One input size** (8×24-anchor self-intersecting spline, 2000 points,
  1920×1080). The ranking is relative, not a frame budget.
- **`n/a` ≠ 0.** `n/a` means the GPU timing did not resolve; that row's total
  is CPU-only and an under-estimate.
- Nodes needing real upstream state (audio, particles, SDF, element sockets)
  and I/O or model-inference nodes are skipped by design.

Geometry is **self-intersecting on purpose**: Blend Intersections, Boolean,
Offset Resolve and Shortest Path all cost in proportion to how often the input
crosses itself. Fed simple circles they measure ~0 and look free.

---

## 5. `gatesOutputs` — read before skipping an output

A def may skip building outputs nobody consumes via
`ComputeArgs.consumedOutputs` (Bloom skips its full-canvas `bloom_only`; Text
skips its JFA SDF).

**If the def is cacheable, it MUST also declare `gatesOutputs: true`.** The
fingerprint knows nothing about which outputs were requested, so without it,
wiring a previously-unbuilt aux hits the cache and returns a texture that was
never rendered. It presents as "the node is broken", not as a stale cache, and
only at the moment someone connects that output.

`stable: false` defs (Text) do not need it — they never hit the cache.

Guarded by `scripts/check-output-gating.mts`.

---

## 6. Reporting results honestly

- A number you did not measure is not zero. Say `n/a`.
- State the input size and canvas size with any timing.
- Before attributing a measurement to your change, rule out the confounds in
  §3 — a backgrounded window, a user interacting mid-capture, GPU timings that
  had not resolved yet. Every one of those has produced a confident wrong
  conclusion in this repo already.
- `npm run check` exiting 0 means the offline logic gates passed. It does not
  mean the app renders correctly.
