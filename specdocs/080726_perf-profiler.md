# Performance profiler — a queryable datastream for eval cost

Spec — 2026-08-07. Status: **design approved** (decisions at the bottom);
implementation not started.

## Why

Spline/points workflows feel slower than they should. The suspicion is that
staying CPU-side in points world is the cost, and that moving the chain onto
the GPU would fix it. That may be partly true — but we cannot currently tell,
because nothing in the app measures the things that would distinguish the
competing explanations:

- **Cache thrash.** 36 node defs declare `stable: false`. Each one recomputes
  every eval *and defeats the fingerprint cache for its entire downstream
  chain* — a Cursor, LFO, Random, Scene Time, or Text anywhere upstream makes
  everything below it recompute per frame no matter how fast the math is. The
  devguide already calls this out for Text. No GPU port fixes it.
- **Fingerprint overhead.** `computeNodeFingerprint`
  ([evaluator.ts:529](../src/engine/evaluator.ts#L529)) builds
  `stableStringify(params) + inputFps.join("|")`, and each input fingerprint
  already contains *its* inputs' fingerprints recursively. String length grows
  with chain depth, so total characters built per eval is roughly O(N²) on a
  deep graph — paid before a single point is touched.
- **Actual arithmetic.** The thing a GPU port would address.
- **Everything outside compute.** `flattenGraph`, topo sort,
  `computeNeededSet`, texture-pool churn, the blit, React's commit. Currently
  invisible.

These have wildly different fixes. Guessing wrong costs weeks. So: measure
first, and make the measurement **queryable by an LLM agent**, not just
legible to a human squinting at a flamegraph — the MCP bridge already exists
and this is the highest-leverage thing to put through it.

### Where the GPU hypothesis actually lands (recorded, so we don't relitigate)

Partly right, with two hard limits worth writing down:

- **The parallel-friendly subset is real and partly already done.**
  `PointsValue` is already SoA `Float32Array`s ([points.ts](../src/engine/points.ts)),
  and Copy to Points' image mode is already one `drawArraysInstanced`
  regardless of point count
  ([copy-to-points.ts:1428](../src/nodes/effect/copy-to-points.ts#L1428)).
  Jitter / Displace / Transform / Modulate / Scatter are genuine candidates.
- **Half of spline world is not parallelizable.** Boolean, offset/overlap-
  resolve, weave, planar, proximity-merge, connect-points, optimize-path are
  topological algorithms with data-dependent output sizes. Porting those is a
  research project, not an optimization.
- **Readback is the trap.** A GPU-resident points buffer has to return to the
  CPU for the spline editor overlay, Point Labels, the inspector, or the next
  topological node. One stall mid-eval can cost more than all the arithmetic
  moved off the CPU. The devguide already flags WebGL↔WebGPU interop as a
  CPU-mediated `Float32Array` hop, sound only to ~1MB.

**Conclusion: the useful unit of GPU work is a fused *run* of nodes that stays
resident and pays one readback at the end — not a node.** You cannot pick
those runs without knowing which chains are hot and which stay inside the
parallel-friendly subset. That is what this profiler is for. Any GPU work is
downstream of it and gets its own spec.

## What exists today

| Piece | Where | Verdict |
|---|---|---|
| Per-node wall clock | `timings: Map<id, ms>` [evaluator.ts:187](../src/engine/evaluator.ts#L187), set at [1350](../src/engine/evaluator.ts#L1350)/[1516](../src/engine/evaluator.ts#L1516) | Keep the measurement point; everything around it is insufficient |
| Transport to UI | `node-timings` CustomEvent, [EffectsApp.tsx:2493](../src/components/effects/EffectsApp.tsx#L2493) | Reuse for the badge; the profiler needs its own path |
| On-node badge | [EffectNode.tsx:161-188](../src/components/effects/EffectNode.tsx#L161-L188), toggle at [MenuBar.tsx:533](../src/components/effects/MenuBar.tsx#L533) | Keep as-is |
| MCP bridge + registry | [src/lib/mcp-bridge/](../src/lib/mcp-bridge/), [mcp-handlers.ts](../src/components/effects/mcp-handlers.ts), [scripts/mcp-server.mjs](../scripts/mcp-server.mjs) | Adding a perf tool is one `registerTool` + one handler |
| Tiled panel system | `PANEL_KINDS` / `PANEL_LABELS` in [layout/model.ts](../src/components/effects/layout/model.ts#L20) | Add a `"perf"` kind |

Gaps, in priority order:

1. **Cache hits are recorded as `0`** ([evaluator.ts:1343](../src/engine/evaluator.ts#L1343))
   — deliberately, so the badge reads "cheap". For a profiler that erases the
   single most valuable signal: *why* a node recomputed.
2. **No GPU timing anywhere.** `EXT_disjoint_timer_query_webgl2` /
   `timestampWrites` appear nowhere in `src/`. Every number is CPU dispatch;
   a "0.3ms" node may be queuing 12ms of fill.
3. **No frame-level accounting.** Everything outside `def.compute` is dark.
4. **No history.** One eval, discarded. No spikes, no sawtooth, no "0ms four
   frames in five".
5. **Not machine-readable.** It is a DOM badge.
6. **Nested evals are opaque.** `evaluateGraph` recurses for Iterate
   interiors ([iterate.ts:308](../src/nodes/group/iterate.ts#L308)) with a
   private cache; today the whole interior bills to one node.

## Design

Three layers, deliberately separable: a **collector** (engine-side, columnar,
allocation-free), a **trace format** (the datastream — the actual deliverable),
and **sinks** (panel, graph heatmap, MCP, bench JSON).

### Constraint: the collector lives engine-side

Invariant #1 in the devguide: nothing under `src/engine/` may import from
`src/components/`, `src/state/`, or `src/lib/`. The evaluator writes samples,
so the collector is **`src/engine/profiler.ts`** — a leaf module with no
imports outside the engine. Sinks pull from it; it never pushes into app code.

### Constraint: the collector must not perturb what it measures

A 200-node graph at 60fps is 12k node samples/sec. Allocating an object per
node per frame would add GC pressure to the exact hot path under study — the
same reason `PointsValue` went columnar. So the ring buffer is columnar:

- interned id/type tables (`Map<string, number>` built once, appended rarely)
- `Float32Array` for `ms`, `Uint8Array` for `reason`, `Int32Array` for node
  index, all in a preallocated growable arena
- object shapes are materialized **only when a sink reads**, never on write

### Trace format (the datastream)

```ts
type RecomputeReason =
  | "hit"        // fingerprint matched — no compute ran
  | "cold"       // no prior cache entry
  | "params"     // this node's own params changed
  | "input"      // an input fingerprint changed  <- the poisoning signal
  | "anim"       // keyframe/animation block advanced
  | "unstable"   // def.stable === false — never cacheable
  | "extras"     // fingerprintExtras changed (Cursor &c.)
  | "bypass" | "gated";

interface NodeSample {
  id: string;
  type: string;              // defType
  ms: number;                // compute + evaluator mask/opacity post-passes
  fpMs?: number;             // fingerprint build       (level 2)
  reason: RecomputeReason;
  depth?: number;            // nested-eval depth: 0 = root, 1 = Iterate interior
  vol?: {                    // volume attribution      (level 2)
    points?: number;
    subpaths?: number;
    anchors?: number;
    allocs?: number;         // textures leased during this compute
    px?: number;             // texels allocated
  };
}

interface FrameSample {
  seq: number;               // monotonic eval counter
  t: number;                 // performance.now() at eval start
  tick: number;              // scene tick
  playing: boolean;
  trigger: "raf" | "state" | "bump" | "seek" | "export";
  gapMs: number;             // since previous eval start — the true fps signal
  phases: {                  // ms
    flatten: number;
    topo: number;            // topo sort + computeNeededSet
    fingerprint: number;     // summed across nodes
    compute: number;         // summed node self time
    post: number;            // universal mask + opacity passes
    blit: number;
    total: number;           // evaluateGraph wall clock
  };
  fingerprintBytes: number;  // total chars built — directly tests the O(N²) hypothesis
  pool: { allocs: number; releases: number; live: number; bytes: number };
  nodes: NodeSample[];
}
```

Ring buffer of the last N frames (default 600 ≈ 10s at 60fps), configurable.

### Reason attribution (the part that matters most)

Today only the joined fingerprint string is compared. To attribute a miss,
keep the fingerprint **parts array** on the cache entry and compare
component-wise. Cost is paid **only on a miss** — the hot path (a hit) still
does one string compare and is untouched.

Two things fall out for free and are exactly the report this was built for:

- `stable: false` nodes never take the cache path at all
  (`cacheable = def.stable !== false && !node.bypassed`), so their reason is
  always `unstable`.
- Everything downstream of one reports `input`. Walking the graph from each
  `unstable` node and summing the downstream `input` time gives a
  **chain-poisoning report**: "Text#a1 forces 14.2ms/frame across 9 downstream
  nodes." That is a number you can act on immediately, and no GPU port
  produces it.

### Capture levels

Zero cost when off; the flag is checked once per eval, not per node.

- **off** — default. No collector, no branches in the node loop beyond the
  existing `timings` write.
- **level 1** — frame phases + per-node ms + reason. `performance.now()` ×N
  and a columnar append. Cheap enough to leave on while working.
- **level 2** — adds fingerprint bytes/time, volume attribution (point count,
  subpath/anchor count, texture allocs). Volume requires poking at socket
  values post-compute; opt-in because it touches every output.
- **level 3** (M5) — GPU timer queries.

## UI

Two surfaces, both fed from the same collector.

**Perf panel** (new `PanelKind`, added to `PANEL_KINDS` / `PANEL_LABELS` in
[layout/model.ts](../src/components/effects/layout/model.ts#L20), so it inherits
tiling and pop-out for free):

- frame sparkline — total ms and gap ms over the ring buffer, with the 16.7ms
  line drawn; spikes clickable to pin that frame
- stacked phase bar (flatten / topo / fingerprint / compute / post / blit) so
  "the evaluator itself is the cost" is visible at a glance
- sortable node table: type, id, p50/p95/max ms, % of frame, recompute rate,
  dominant reason, volume, ms-per-point
- chain-poisoning summary at the top — the `unstable` roots ranked by
  downstream cost

**Graph heatmap**: tint node bodies in the editor by share of frame cost, with
a distinct treatment for `unstable` roots and their poisoned descendants. The
panel answers *why*; the heatmap answers *where*, instantly. The existing
on-node ms badge is unchanged and independent.

## MCP surface

Follows the existing pattern exactly — `registerTool` in
[scripts/mcp-server.mjs](../scripts/mcp-server.mjs), handler in
[mcp-handlers.ts](../src/components/effects/mcp-handlers.ts).

- `set_perf_capture({ level, frames? })` — off/1/2/3; lets the agent arm and
  disarm capture around a reproduction instead of asking the user to.
- `get_perf({ frames?, top?, groupBy? })` — **aggregate** by default:
  session info, frame stats (p50/p95/max total, effective fps), phase
  breakdown, top-N nodes with reason distribution, chain-poisoning report.
  `groupBy: "type"` collapses across instances to answer "which *kind* of node
  is expensive."
- `get_perf_frame({ seq })` — one frame's full node list, for interrogating a
  spike found in the aggregate.

Token discipline is part of the contract: aggregate by default, `top` capped
(default 20), ms rounded to 2 decimals, no per-frame dumps unless asked.

## Headless bench

`scripts/bench.mts`, alongside the existing `check-*.mts` gates. Those stub
the DOM and GL (see [check-sim-preroll.mts](../scripts/check-sim-preroll.mts))
and only exercise pure logic — real timings need real GL, so the bench spawns
**Electron** with a minimal bench renderer (note: `ELECTRON_RUN_AS_NODE` must
be unset for the GPU path to come up).

```
npx tsx scripts/bench.mts <project.toolbox> [--frames 300] [--level 2] [--out trace.json]
```

Loads a `.toolbox`, evaluates N frames headless, writes the trace as JSON.
This is the piece that lets perf work happen without a human driving the app,
and makes traces **diffable across commits** — the foundation for a perf
regression gate later (not in scope here).

## Found while instrumenting: there is no texture pool

The devguide describes `ctx.allocImage/allocMask/allocUv` as *leasing* from a
pool and `ctx.releaseTexture` as *returning* to it. **That pool does not
exist.** `allocTexture` in [gl.ts:341](../src/engine/gl.ts#L341) is a bare
`gl.createTexture()` + `texImage2D` — a fresh driver-side allocation — and
`releaseTexture` ([gl.ts:478](../src/engine/gl.ts#L478)) is a bare
`gl.deleteTexture()`. Every intermediate any node allocates is a real
allocate/free round trip, every eval.

At 1080p RGBA16F a full-canvas texture is ~16MB of driver allocation. A graph
with twenty image-producing nodes at 60fps churns >1000 texture objects/sec.

**And the working canvas is 4K.** The live session this was written against
(`kaminotests_03`) runs 3840×2160, where one full-canvas RGBA16F texture is
**66 MB**. Merge is the node that compounds this: it allocates its output plus
one intermediate per layer in the chain
([merge.ts:348](../src/nodes/effect/merge.ts#L348),
[412](../src/nodes/effect/merge.ts#L412),
[419](../src/nodes/effect/merge.ts#L419)), so an 8-layer Merge is on the order
of **half a gigabyte** of texture allocate-and-free per evaluation — which
matches the owner's independent observation that Merge nodes are responsible
for a large share of the slowdown. Level 2 attributes `allocs`/`px` per node,
so `get_perf` names the number rather than inferring it.

This is deliberately **not** acted on yet — it is a hypothesis with an obvious
fix, which is exactly the kind of thing that gets "optimized" on intuition and
turns out to be 2% of the frame. The profiler now counts allocs, deletes, and
bytes per frame and attributes them per node (level 2), so the next trace
answers it with a number. If it is real, a free-list keyed by
(w, h, format) is a contained change behind the existing `ctx` interface, and
would make the devguide's description true rather than aspirational.

## Milestones

**M1 — collector + trace format. DONE (2026-08-07).**
- [src/engine/profiler.ts](../src/engine/profiler.ts) — columnar ring buffer
  (interned id/type tables, typed-array columns, objects materialized only on
  read), capture levels 0/1/2, frame + node arenas with wrap reporting.
- [evaluator.ts](../src/engine/evaluator.ts) — phase timers (flatten, topo,
  fingerprint, compute, post), `FpParts` retained on `CachedEntry`,
  `classifyMiss` reason attribution, nested-eval depth tagging, per-eval
  fingerprint-byte counting.
- [gl.ts](../src/engine/gl.ts) — alloc/delete/byte counters (see above).
- [src/lib/perf-console.ts](../src/lib/perf-console.ts) — `window.__perf`
  (`start` / `stop` / `report` / `summary` / `frames` / `frame`) plus
  `summarize()`, the aggregation M2 and M3 both consume: per-node p95 /
  recompute-rate / dominant-reason / ns-per-point, phase breakdown with an
  explicit `unattributed` residual, and the chain-poisoning report.
- [scripts/check-profiler.mts](../scripts/check-profiler.mts) — 57 assertions,
  wired into `npm run check`.

Trace semantics worth remembering: phase buckets and the node table are two
decompositions of the same frame, not addends. Phases charge nested (Iterate)
work to the bucket it happened in; depth-0 node samples charge it to the
enclosing shell. `blit` is measured outside `evaluateGraph` and is not part of
`total`.

**M2 — MCP tools. DONE (2026-08-07).**
- [scripts/mcp-server.mjs](../scripts/mcp-server.mjs) — `set_perf_capture`,
  `get_perf` (with `groupBy: "type"` to collapse instances), `get_perf_frame`.
- [mcp-handlers.ts](../src/components/effects/mcp-handlers.ts) — handlers over
  `summarize()`, with errors that state the fix ("capture is off", "the editor
  only evaluates on playback / a param edit / a graph change", "frame aged out
  of the ring").
- [check-mcp.mts](../scripts/check-mcp.mts) — extended to 27 checks: tool
  listing parity, argument marshalling (numbers stay numbers, absent optionals
  stay absent), and required-arg rejection at the server.

Note: the MCP server process must be restarted for a client to see the new
tools — the tool list is sent at connect time.

**M3 — Perf panel + graph heatmap. DONE (2026-08-07).**
- New `"perf"` `PanelKind` ([layout/model.ts](../src/components/effects/layout/model.ts))
  — inherits tiling, the kind menu, and pop-out for free.
- [PerfPanel.tsx](../src/components/effects/PerfPanel.tsx): capture-level
  buttons (0–3), frame sparkline with the budget line and a separate GPU
  trace, stat row (CPU / GPU / budget / actual fps / cache / texture churn),
  stacked phase bar, recompute-roots list, and a node table.
- Graph heatmap: EffectsApp broadcasts each node's SHARE of the frame on a
  700 ms interval (`node-perf`); EffectNode draws a cost bar along its top
  edge plus a ms readout. Same colour ramp as the table so a node reads
  identically in both places.

**Everything sorts and colours by GPU time when level 3 data exists**, falling
back to CPU otherwise. That ordering is the whole point: ranked by CPU, this
panel would have put `rasterize-spline` on top and buried the Merge chain at
0.02 ms — confidently pointing at the wrong node.

Two deliberate choices: shares rather than absolute ms (an absolute scale
washes out on a fast graph, and the question is "where does the frame go"),
and polling rather than pushing on eval-complete (GPU timings resolve 1–3
frames late, and re-rendering every node at frame rate would distort the
measurement being displayed).

Also added `triggers` to the summary — a count of what caused each eval
(`raf` / `state` / `bump` / `seek` / `export`). It exists because a paused,
idle editor showing hundreds of `raf` frames would mean a full graph
evaluation per tick for nothing, and no per-node number reveals that.
Measured: **0 frames in 8 s of true idle** — the editor is correctly inert
when nothing is happening.

**M4 — Headless Electron bench.** `scripts/bench.mts`, JSON trace artifact,
trace-diff helper.

**M5 — GPU timing (level 3). PROMOTED — do this next, ahead of M3/M4.**
`EXT_disjoint_timer_query_webgl2` for the WebGL path, `timestampWrites` for
WebGPU. Async result collection with disjoint-flag handling; degrade cleanly
where unavailable. See "First real trace" below for why the original deferral
was wrong.

Then, and only then: read the traces and write the optimization spec. The
likely candidates in rough order of expected payoff — to be confirmed or
killed by data, not assumed:

1. cut `stable: false` where a cheaper `fingerprintExtras` would do
2. make fingerprints O(depth) — hash instead of concatenate
3. fuse the parallel-friendly points runs onto the GPU with one readback

## First real trace (2026-08-07, `kaminotests_03`, 3840×2160 @ 30fps)

84 frames of playback, level 2, captured over the MCP tools. Caveat up front:
the editor window was backgrounded for most of the run, so rAF was suspended
and this samples only the ~2.8s it held focus. Within that window the eval
loop was steady (mean gap 33.7ms ⇒ 29.7fps, p5 27.2), so the numbers are
internally consistent — but this is a sample of a *healthy* stretch, not of
the slowdown being chased.

| Metric | Value | Read |
|---|---|---|
| eval ms | mean 4.07 · p50 3.70 · p95 6.05 · max 12.2 | **12% of a 33ms budget** |
| compute | 3.49 ms/frame | the bulk of eval, as expected |
| fingerprint | 0.17 ms/frame, **101 KB of string** | real, but 4% — the O(N²) worry is minor *today* |
| flatten + topo | 0.06 ms/frame | noise |
| blit | 0.04 ms/frame | noise |
| cache hit rate | **0%** — every node, every frame | structural, see below |
| texture churn | **23 create/delete pairs, 533 MB/frame** | nominal bytes; drivers defer, so ≠ cost |

**The headline is a negative result: CPU-side node compute is not the
bottleneck.** The whole spline → points → copy-to-points → raster → post chain
costs 4ms. Whatever makes this project feel slow is not in the numbers this
profiler can currently see.

Three things follow.

1. **GPU timing is now the critical path, and deferring it to M5 was the wrong
   call.** The evaluator measures CPU dispatch only — the devguide says as
   much. At 4K, full-canvas fill is the obvious suspect, and Merge is exactly
   that shape: two draw calls per layer over 8.3M pixels. Its CPU cost in this
   trace is **0.024 ms/frame**, which is entirely consistent with the owner's
   report that Merge is slow *and* with the instrument being blind to it. Do
   M5 before M3/M4.
2. **Cache hit rate is 0%.** Every node reports `input` every frame, rooted at
   a `scene-time` node. Harmless here only because these nodes are cheap; it
   means the graph is one expensive node away from a cliff, and it makes every
   future optimization worth less than it should be.
3. **Texture churn is confirmed but must not be oversold.** 23 allocs/frame at
   4K is 533 MB nominal — but `bloom` alone allocates 13 of them in 0.046 ms,
   which is only possible because drivers defer the real allocation behind
   `texImage2D(…, null)`. The pool is still worth building; the case for it is
   memory-system pressure and GPU-side stalls, not the CPU time measured here.
   Confirm with M5 before acting.

### Corrected trace (400 frames, foregrounded, after the fixes below)

| Metric | Value |
|---|---|
| eval ms | mean 3.46 · p50 3.40 · p95 3.80 · max 4.8 |
| fps | mean 32.7 · p5 30.7 — **at target** |
| compute | 2.98 ms/frame |
| cache | 32% hit rate, **19 of 28 nodes recompute every frame** |
| churn | 22.9 create/delete pairs, 532 MB/frame nominal |

Chain-poisoning report, once attribution was fixed:

| Root | Reason | Self | Downstream | Nodes |
|---|---|---|---|---|
| `lissajous-3d` ×3 | anim | 0.01–0.03 ms | **2.52 ms/frame** | 13 |
| `points-on-path` | anim | 0.43 ms | 2.49 ms/frame | 9 |
| `scene-time` | unstable | 0.004 ms | 0.03 ms/frame | 3 |

**Read this correctly: it is not a pathology.** Three animated Lissajous
sources and an animated Points on Path drive nearly the whole graph, so nearly
the whole graph legitimately recomputes. The 32% hit rate is what an
animation-driven graph *should* look like. There is no free win available from
caching here, and anyone who reads "19/28 nodes recompute every frame" as a
bug will waste a week. The value of the report is that it says *which* roots
own the cost, so a future optimization knows where the leverage is.

**Also: this scene is not slow.** 3.46 ms of CPU against a 33 ms budget, fps
at target. Whatever the owner is experiencing is either (a) GPU-bound and
invisible until M5, or (b) a different graph state / interaction than
steady-state playback. Capture has to be armed during the actual slow moment
before any optimization work starts.

### Three defects the first real use exposed

- **The poisoning walk used raw project edges.** Flatten dissolves groups and
  rewires layer interiors onto the layer's hidden `content` input, so a walk
  over raw edges stops at every boundary — the report named one root with one
  descendant while every node in the graph was recomputing. Fixed: the
  evaluator now hands the profiler its POST-flatten, post-gating edge list
  (`recordTopology`), and sinks prefer it.
- **`get_perf` reported p95/max with no way to reach those frames.**
  `get_perf_frame` needs a `seq` and nothing in the summary carried one. Fixed:
  `worstFrames` returns the three slowest with seq and trigger.

- **Animated nodes classified as `input`, hiding every real root.** A node
  whose own keyframes advanced pushed `anim:<tick>` into `inputFpParts`
  ([evaluator.ts:1376](../src/engine/evaluator.ts#L1376)), which landed in the
  `inputs` fingerprint segment — so `classifyMiss` reported it as "dragged by
  an ancestor" rather than "my own animation advanced". Every keyframed node
  filed itself as a victim, and the poisoning report could only ever find
  `scene-time` with three descendants. The tick now rides its own `anim`
  segment; the very next trace surfaced the three Lissajous roots above.
  Regression-guarded in check-profiler.mts — if this breaks again the report
  degrades silently, which is the worst failure mode for a diagnostic.

Also added `cache: { hitRate, alwaysRecomputing, totalNodes }`. The first cut
counted nodes with *zero* hits ever and reported 1 of 28 on a graph where
twelve nodes had hit exactly once in 600 frames — technically cached, in
practice recomputing forever. Now it's a ≥95% recompute-rate threshold, which
reported the honest 19 of 28.

## GPU trace — the answer (2026-08-07, level 3, 400 frames)

The owner's own A/B settled the direction before the instrument could:
viewing a lone Rasterize Spline runs at 120fps; adding the Merge chain drops
it to 30. Merge's CPU cost is 0.02 ms. So the cost was always GPU-side, and
level 3 now measures it.

**GPU 16.21 ms/frame against CPU 4.09 ms/frame.** Coverage 67%, which is
exactly the non-cache-hit share — every node that actually computed was
timed.

| Node | CPU ms/frame | **GPU ms/frame** | ratio |
|---|---|---|---|
| `bloom` | 0.043 | **4.23** | 98× |
| `merge-1ykw21` | 0.021 | **2.51** | 120× |
| `layer-9s78nf` | 0.011 | **1.79** | 163× |
| `rasterize-spline-7afsqc` | 1.763 | 1.72 | 1× |
| `grain` | 0.011 | **1.61** | 146× |
| `rasterize-spline-ymtw07` | 0.516 | 1.53 | 3× |
| `merge-tz3448` | 0.009 | **1.51** | 168× |
| `points-on-path` | 0.380 | 1.48 | 4× |

Those eight nodes are essentially the entire GPU frame (16.4 of 16.2 ms — the
overshoot is rounding). The compositing and post chain — bloom + two merges +
layer + grain — is **11.6 ms, 72% of GPU time**, against 0.1 ms of CPU. Strip
it and you are left with ~3.2 ms, which is the owner's 120fps.

### What this actually says about the architecture

Not "Merge is badly written". **Every image node is a full-canvas pass, so
frame cost ≈ (number of image nodes) × (canvas fill cost).** Merge is simply
the node that multiplies passes by layer count: it walks its chain running one
full-canvas blend per layer
([merge.ts:416-428](../src/nodes/effect/merge.ts#L416-L428)), each one reading
and writing every pixel.

That reframes every fix worth considering:

1. **Pass fusion, not caching.** An N-layer Merge is N sequential full-canvas
   blends; it could be one shader sampling N textures. That is the direct
   answer to "only the merge brings it down to 30", and it is a contained
   change to one node.
2. **Bloom is the single largest line item** at 4.23 ms — a separate
   investigation (pyramid resolution, tap count).
3. **The texture pool is a side issue.** Worth doing, but the earlier
   enthusiasm was misplaced: nominal churn came out at 222 MB/frame here, and
   it is not what is eating the frame. Fill rate is.
4. **CPU work is not worth optimizing on this graph.** 4 ms of a 16 ms frame,
   and the spline/points chain the investigation started from is a rounding
   error next to compositing.

Note the preview appears to render below 3840×2160 (22.9 allocs averaging
9.7 MB implies mostly sub-canvas targets), so **export-resolution GPU cost is
likely materially higher than these numbers**. Worth a level-3 trace during an
actual export before sizing any fix.

## Fix 1 — Merge pass fusion (2026-08-07)

The old chain ran **one full-canvas pass per layer**: N layers meant N writes
of every pixel plus N−1 read-backs of a full canvas, plus a separate pass for
the base matte. `merge.ts` now composites the whole chain in **one pass**,
accumulating in registers.

- `BLEND_MODE_GLSL` holds the twenty-nine blend formulas and `compositeOver`
  ONCE. Both the pairwise shader (`BLEND_FS`, still used by the Layer node)
  and the fused shader are built from it — two copies would have drifted the
  first time either was touched, and the divergence would surface as a subtle
  color shift nobody would trace back here.
- `fusedMergeFs(n)` generates a program for exactly `n` layers. Generated
  rather than looped because **GLSL ES 3.00 only allows CONSTANT expressions
  when indexing a sampler array** — a loop counter does not compile.
- Chunked against `MAX_TEXTURE_IMAGE_UNITS`: each layer costs two units
  (image + matte) on top of the base pair, so the per-pass cap is
  `(units − 2) / 2` — **7 layers on a minimum-spec 16-unit device, 15 on a
  32-unit one**. Passes drop from N to `ceil(N / cap)`, which is 1 for
  essentially every real Merge.
- The base matte folds into the first pass instead of costing its own.
- `layer.ts`'s shader key bumped to `merge/blend-v3` (getShader caches by key
  alone, so a refactored source under the old key would serve stale).

### Verification

Shader correctness is invisible to typecheck and to every DOM-stubbed
`check-*.mts` — a mistyped blend formula only shows up as wrong pixels in
someone's project. So `npm run check:shaders`
([scripts/check-shaders.cjs](../scripts/check-shaders.cjs)) boots Electron
with a software GL context and asserts:

1. every generated program (n = 1…8) compiles **and links**;
2. **fused output === chained output** across all 29 blend modes × 3 cases
   (opacity 1, mixed opacity, matte on one layer);
3. the base-matte flag actually changes output — a guard against the fold-in
   silently becoming a no-op.

**The pass criterion is breadth, not peak delta**, and getting that wrong is
what the first run of this test exposed. Against RGBA8 targets it reported a
delta of 174/255 on hard-mix, which reads as a catastrophic formula error. It
isn't: the chain quantises to 8 bits at its intermediate while the fused path
stays in float, and `hard-mix` is `step(1.0, a + b)` — a discontinuity that
turns one bit of rounding into a full-scale flip. So the test now uses
**RGBA16F targets** (what the engine actually allocates) and fails a mode only
when it differs on **>2% of channels**. A wrong formula is wrong nearly
everywhere; a precision artifact is a large delta on the handful of pixels
sitting exactly on a threshold.

Result: peak delta 0.0024 and 0.0005 on the two continuous cases, and no mode
differing broadly in any case. The one notable peak — 0.889 on hard-mix with a
matte — is confined to threshold pixels. **So the fused path is not bit-identical
to the old one on discontinuous modes, and cannot be**; it is the more accurate
of the two, since it never quantises mid-chain.

Not wired into `npm run check` — it needs Electron and a GL context, heavier
than the other gates. Run it after touching any blend code.

## Fix 2 — Bloom's unconsumed aux output (2026-08-08)

After Merge fusion, Bloom was the largest GPU item at **4.17 ms/frame** and
allocated 13 textures per eval — more than every other node combined. Its
`bloom_only` aux is a **full-canvas pass**, rendered every frame whether or not
anything was wired to it. On this graph, nothing was.

`bloom.ts` now gates it on `ComputeArgs.consumedOutputs`, the mechanism the
devguide already documents (Text uses it for its JFA SDF and marching-squares
spline).

### The trap that made this more than a one-line change

**`consumedOutputs` gating was only safe for `stable: false` defs.** Text is
one, so it never hits the cache and its internal validity flags suffice. Bloom
is **cacheable** — and a fingerprint knows nothing about which outputs were
requested. Gate an output on a cacheable node and the moment a user wires that
aux, the node cache-hits and hands back a texture that was never rendered. It
looks like a broken node, not a stale cache, and it only appears at the exact
moment someone connects the output.

So `NodeDefinition.gatesOutputs` was added: the evaluator folds the sorted
consumed-handle set into the fingerprint for defs that declare it, forcing
exactly one recompute when consumers change. Opt-in rather than automatic —
applying it to every node would make selection changes (which mark
`primary`/`aux:image` consumed) bust caches for no benefit.

Guarded by [scripts/check-output-gating.mts](../scripts/check-output-gating.mts)
(in `npm run check`): a gated def skips its aux while unconsumed, cache-hits on
an unchanged graph, **recomputes exactly once when the aux is wired and the
value reaches the graph**, settles back to hits, and an unflagged def is
untouched by the same change.

### Result

| | before | after |
|---|---|---|
| `bloom` GPU | 4.17 ms/f | **2.99 ms/f** |
| bloom texture allocs | 13/eval | **12/eval** |
| GPU total | 14.62 ms/f | **12.76 ms/f** |
| fps mean / p5 | 60.3 / 56.5 | **75.1 / 67.6** |

## Cumulative (2026-08-07 → 08)

| | baseline | now |
|---|---|---|
| GPU per frame | 16.21 ms | **12.76 ms** (−21%) |
| fps p5 | 41.3 | **67.6** (+64%) |
| worst frame (CPU) | 26.1 ms | **5.6 ms** |
| textures/frame | 22.9 | **20.9** |

CPU never moved (≈3.5 ms throughout) and never mattered — which is the whole
lesson of this document.

## M4 — per-node bench (2026-08-08)

`npm run bench:nodes` ([scripts/bench-nodes.cjs](../scripts/bench-nodes.cjs) +
[scripts/bench/harness.ts](../scripts/bench/harness.ts)). esbuild-bundles the
harness, runs it in a hidden Electron renderer on **hardware GL**, and writes
`bench/node-bench.json` (diffable) and `bench/node-bench.md` (the worklist).

Hardware GL deliberately — the shader checks use swiftshader because they only
test correctness, but a *performance ranking* from a software rasterizer would
rank swiftshader, not the GPU anyone runs on.

Method: call each `def.compute()` directly with synthesized inputs rather than
going through `evaluateGraph`. Identical inputs, identical canvas, no caching,
no topology, no upstream cost bleeding in. **187 of 233 nodes measured.**

### Three harness bugs worth remembering

1. **A wedged GPU timer read as "GPU work is free."** If a node threw between
   `timer.begin()` and `timer.end()`, the query stayed open and every later
   `begin()` returned false — so the first run reported real numbers for a few
   early generators and 0.000 for everything after, including Bloom. Fixed
   with `try/finally` + `timer.reset()` on the error path. Unresolved timings
   now report **`n/a`, never 0**, because a zero reads as "free" when it means
   "not measured".
2. **`performance.now()` is coarsened to 100 µs** in Chromium without
   cross-origin isolation, so per-rep CPU timing quantised and everything
   cheap read as exactly 0. Now one timing block spans all reps and divides.
3. **Concentric-ellipse test geometry under-measured a whole node class.**
   Blend Intersections, Boolean, Offset Resolve and Shortest Path cost scale
   with how often the input CROSSES ITSELF. Fed circles, Blend Intersections
   measured 0.000 ms — reported free, while the owner already knew from real
   use that it's among the slowest. The synthetic spline is now
   self-intersecting Lissajous lobes.

### Known limitations — read the numbers with these in mind

- **Default params only.** A node whose expensive path sits behind a
  non-default toggle is under-measured. Blend Intersections still reads
  0.100 ms for this reason, and is *not* believed to be cheap.
- **One input size** (8×24-anchor spline, 2000 points, 1920×1080). Cost that
  scales with input moves with real data; the ranking is relative, not a
  frame budget.
- Nodes needing real upstream state (audio, particles, SDF, element sockets)
  are skipped, as are I/O and model-inference nodes whose cost is a decode or
  a download rather than anything optimizable.

### Bugs the bench surfaced

- **`color-literal` threw on every palette extraction from a wired image** —
  `ctx.releaseTexture(small)` passed the `ImageValue` wrapper instead of
  `small.texture`. Inside a `finally`, so it masked the real return value and
  leaked the texture. **Fixed.**
- **`spline-boolean` crashes on self-intersecting input** — "Unable to find
  segment #678 … in SweepLine tree" from polygon-clipping. Not yet fixed;
  likely needs self-intersections resolved before the boolean. Real and
  user-reachable.

### Worklist (top of `bench/node-bench.md`)

| # | node | total ms | note |
|---|---|---|---|
| 1 | `point-labels` | **2551** | allocates **2 textures per point** — 4001 for 2000 points |
| 2 | `loop-weave` | **387** | CPU-bound |
| 3 | `diffusion-curves` | **233** | GPU, 43 textures |
| 4 | `spline-repeat` | **126** | CPU — the one the owner flagged as commonly used |
| 5 | `spline-offset` | **63** | CPU |
| 6 | `copy-to-points` | **36** | GPU, one instanced draw — higher than expected |
| 7 | `dither` | **29** | 27.8 of it CPU |
| 8 | `spline-intersections` | **19** | CPU |

Everything below ~4 ms is in normal territory for a full-canvas pass.

## Decisions recorded (2026-08-07)

- **GPU timing deferred to M5.** The described workflows are CPU-bound by
  construction; GPU queries are async, need disjoint-flag handling, and are
  not uniformly available. The CPU picture very likely explains them outright.
- **Headless bench is in scope (M4).** Traces must be producible without a
  human driving the app, and diffable across commits.
- **Both UI surfaces** (panel + graph heatmap) rather than either alone.
- **Diagnose before optimizing.** No GPU port work starts until traces name
  the bottleneck.
