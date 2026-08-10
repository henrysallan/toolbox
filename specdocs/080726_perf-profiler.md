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

---

# Session 2 (2026-08-08) — the spline chain

Owner set up `Benchmark_01_blendintersections_offsetpath` to work three
nodes: **blend-intersections, rasterize-spline, spline-offset**. The graph:

```
noise -> advect-points (100 pts, accumulate, trails)
      -> points-to-spline (linear) -> blend-intersections
      -> spline-offset -> rasterize-spline (layered + punch holes)
```

Opening trace: **3.1 fps, 309 ms/frame, 99.6% CPU** (total GPU 1.29 ms).

| node | ms/frame | share |
|---|---|---|
| `spline-offset` | 244.58 | 79% |
| `blend-intersections` | 50.78 | 16% |
| `rasterize-spline` | 13.21 (+0.57 GPU) | 4% |

## Fix 3 — Offset Path: bisection instead of a linear t-scan

`offsetSubpath` called bezier-js's `.offset(d)` per segment. That delegates to
`reduce()`, whose second pass finds "simple" spans by **linear scan at t-step
0.01**, constructing a throwaway `Bezier` via `split(t1,t2)` at every step. A
span already simple end to end still paid ~100 splits to discover that; with
the extrema pre-pass, ~500 Bezier constructions per source segment. At 925
segments/frame that is ~460k allocations per frame. Measured **264 µs per
segment**.

Replaced with bisection (`reduceToSimple` / `reduceSpan` in `spline-math.ts`):
test the span, and only when `simple()` fails split at the midpoint and
recurse. A simple span now costs ONE split and one test. `scale()` is still
bezier-js's, so the offset geometry is unchanged.

Also: `offsetSubpath` built its segments via `subpathToBeziers`, which runs a
24-sample Gauss-Legendre `length()` per segment — and the offset never reads
arc length. Added `subpathToCurves` (no lengths) and pointed the three
length-discarding callers at it.

**Result (deterministic bench, identical input): 466–501 µs/segment -> 20–36,
i.e. 13–25x.** Output anchor count is slightly LOWER (954->916, 1018->994),
so downstream is not paying for the win.

### A bug this introduced, and the escape it needed

`simple()` compares endpoint normals through `acos`. On a **zero-extent span**
those normals are NaN, so `simple()` is false forever — bisection recursed
straight to the depth cap and emitted 2^8 pieces: **259 anchors, 257 of them
non-finite, from one zero-length input segment.** bezier-js escaped this via
reduce()'s "we can never form a reduction" bail-out. `spanHasExtent()` is the
equivalent, plus an `allFinite()` guard on `scale()`'s output (it can return
non-finite control points without throwing). Regression-guarded in
`scripts/check-offset.mts`.

## Fix 4 — Rasterize Spline: bbox prefilter for hole islands

`groupHoleIslands` is **O(n²) in subpaths**, and each containment test walked
the candidate's whole flattened polygon — O(n²·m). At 218 subpaths × ~150
vertices that is ~7M crossing tests per frame, and it runs for BOTH `holes`
and `layered`, which per the owner are the two modes actually worth using
("the ones that are cheaper are the ones that are less useful").

Added an axis-aligned bbox reject before the crossing test (a point outside
the box cannot be inside the polygon, so grouping is unchanged), and memoized
`polyArea` per container.

Also **raised the silent cap 256 -> 2048**. Above the old cap `groupHoleIslands`
returned null and punch-holes SILENTLY STOPPED WORKING with no diagnostic —
and the benchmark graph sits at 218, just under the cliff. The cap stays
because the prefilter degrades to the old cost when boxes genuinely overlap
(concentric rings).

Not separately measurable in this graph: at the 120–144 subpaths the live
trace actually produced, n² is only ~20k tests. It matters at the 218+ counts
seen in the opening trace.

## Neutral: squared-distance culling in blend-intersections

`segDist` rooted before the caller's `d <= influence` cull, and the candidate
lists come from a 3×3 bucket neighborhood reaching ~3x further than
`influence`, so most roots were spent on points about to be discarded.
Switched to `segDistSq` + cull on `influenceSq`.

**Measured: no gain** (36.5/38.1 ms -> 34.9/36.3, inside noise). `Math.sqrt`
is one instruction; the loop is memory/branch bound. Kept only because the
old comment claimed "Squared-distance" on a function that returned a rooted
one. Recorded here so nobody re-attempts it expecting a win.

## The measurement trap this session (important)

`advect-points` in `accumulate` mode is **stateful**: its geometry evolves
every frame AND resets whenever HMR reloads a module. So **every before/after
comparison taken from the live editor is confounded** — subpath count moves
between runs, and subpath count is exactly what these nodes scale on.

Concretely, this bit twice:
- A visual A/B of the offset change produced a completely different image. The
  points had moved — which is UPSTREAM of the node being toggled, so the node
  could not have caused it. The reload had reset the sim.
- After the rasterize fix the frame appeared to get *worse* (53 -> 65 ms) and
  `blend-intersections`, which was not touched, appeared to move 42.6 -> 51.9.

`scripts/bench-spline-chain.mts` (`npm run bench:spline`) exists for this:
fixed synthetic input, pure functions, min-of-reps timing. Use the profiler
trace to find WHICH node is hot in a real graph; use the bench to decide
whether an edit made it faster.

Note min-of-reps, not mean — the mean drifts ~10% run to run, the same size as
some of the wins being measured.

## Fix 5 — marching squares: integer endpoint keys (5.7x)

Phase-timed `blendIntersections` before optimizing, which overturned the
guess. The SDF field loop was NOT the biggest phase:

| phase | share |
|---|---|
| field sampling | ~40% |
| **marching squares** | **~37%** |
| bezier refit | ~21% |
| setup | ~1% |

(Absolute phase numbers ran high — instrumenting the function appears to cost
it some optimization — but the split is what mattered, and going straight at
the field loop would have capped out at ~40%.)

Two things in `marching-squares.ts`:

1. **`chainSegments` keyed endpoints by STRING** — a template literal
   `` `${qx}:${qy}` `` into a `Map<string, …>`, built twice per segment and
   re-derived on *every step of every walk*. Replaced with an integer key
   (same 1/8-cell quantization, so the same points match), precomputed once
   per segment endpoint, into a `Map<number, number[]>` whose entries are
   `idx*2+isStart` rather than `{segIdx, isStart}` objects.
2. **Four arrow functions allocated per boundary cell** (`top`/`right`/
   `bottom`/`left`), to lazily evaluate the two edges a case needs. That
   traded four closure allocations for two divisions. Inlined as plain
   numbers.

**Result: 5.68 ms -> 1.01 ms (5.7x) on a 320² field, byte-identical output**
across a 9-field corpus (rings, nested rings, saddles, thin sub-cell bars,
degenerate all-in/all-out). End to end that took blend-intersections from
~36 ms to ~24.5 ms (**-32%**) on fixed input.

Six callers benefit, not just this one: `sdf-to-spline` (already on the
worklist), `text`, `spline-flow`, `points-to-surface`, `growth-emit`.

`scripts/check-marching-squares.mts` guards it. The strongest assertion there
is geometric, not a snapshot: every emitted point must bilinearly sample the
field to ~0, which catches a mis-indexed corner or a wrong edge assignment
that a point count would sail past.

### Pre-existing chaining quality, recorded not fixed

The corpus exposes that rings fragment: `two-overlapping` yields 9 subpaths
with 1 closed where 1 closed ring is geometrically right; `blob-field` gives
34 subpaths with 6 closed for 24 blobs. This is why blend-intersections
re-closes near-meeting endpoints and drops sub-cell debris downstream. The
characterization counts in the check pin current behavior; if chaining is
deliberately improved they SHOULD move.

## `resolution` is mostly inert at typical widths

`cell = min(cell, max(0.5, r * 0.75))` — the thin-feature guard — clamps the
grid independently of `resolution`. At `width: 6` (r = 3) the cell can never
exceed 2.25 px, so over a ~717 px bbox the grid is ≥319 regardless. Measured:
resolution 144 -> 25.1 ms, 288 -> 23.1 ms (identical within noise), 512 ->
36.0 ms.

So **turning Resolution down does not make this node faster** — only raising
Width coarsens the grid. Worth surfacing in the param's help text.

## Where it stands

After fixes 3 and 5, `blend-intersections` is ~24.5 ms on fixed input, split:

| piece | ms | share |
|---|---|---|
| **bezier refit** (`fitSplineToPolyline`) | **11.6** | **43%** |
| field sampling + march + setup | 15.3 | 57% |

### Polyline thinning before the fit — TRIED AND REVERTED

Douglas-Peucker at errPx/2 before `fitSplineToPolyline` (owner signed off on
changing geometry). It worked, on every metric that was being watched:

- ~24.5ms -> ~18ms (**-27%**)
- subpath count IDENTICAL (26/29/29) — topology preserved
- fewer output anchors (245 -> 206), so spline-offset got cheaper too
- static render looked correct

The owner saw it immediately: "significantly more snapping and popping."

Measured on a 12-frame animated sweep — mean frame-to-frame contour movement
for 1.41px of input motion:

| | mean jump | max jump |
|---|---|---|
| current | **7.60 px** | 15.38 px |
| with thinning | **10.76 px** | 13.70 px |

**+42% mean jitter.** RDP picks its keep-set by max deviation, so a sub-pixel
change in the contour flips which points survive, and the fit — now
under-constrained between the survivors — swings visibly. Reverted; the
reason is written above the fit call so it isn't re-attempted.

Note the MAX went the other way (15.38 -> 13.70). Reading the max would have
concluded the change was fine. `npm run bench:jitter` prints the mean first
for that reason.

### The popping is partly inherent — and it points at the chaining

Baseline amplification is **5.39x**: for 1.41px of input motion the contour
moves 7.60px per frame with no thinning at all. The subpath count over a
12-frame sweep is not stable either:

```
29 27 27 27 27 27 25 25 24 24 24 24
```

Whole contours appear and vanish. That is the same defect the marching-squares
corpus exposed — rings fragment into open chains, so blend-intersections'
downstream "re-close near-meeting endpoints, drop sub-cell debris" heuristics
fire differently frame to frame.

Owner's call on this: **the original output is the target — "basically good,
just not fast enough."** The popping above is the node's existing character,
not a defect to fix; optimizations must not change output at all. That closes
the chaining-quality thread and rules out anything geometry-changing.

## Fix 6 — bit-identical scalar rewrites (~24.5 -> ~21.5ms)

Two changes, both verified BIT-IDENTICAL on an 18-configuration snapshot of
blendIntersections (3 sizes x 2 phases x 3 smoothing values, 52,823 anchors
compared exactly, handles included):

1. **Schneider fit de-vectorized** (`newtonStep`, `maxFitError`,
   `generateBezier` in spline-math.ts). V2 is `[number, number]`, so every
   vSub/vScale/vAdd allocated a fresh array; newtonStep alone built ~15 per
   call, per sample, per iteration, per recursion level. Rewritten in scalars
   with THE SAME operations in THE SAME order — including Math.hypot where
   vLen used it, which is not bit-equal to sqrt(x*x+y*y), and a changed last
   bit can flip a split-point choice and cascade. Fit: 11.6 -> 9.0ms (-22%).
   Also benefits the pencil tool and spline-weave, which share the fit.
2. **Branch smooth-min sort** — `branchDists.sort((a,b)=>a-b)` ran per deep
   grid sample (~26% of ~140k samples) on a handful of numbers each, where
   comparator dispatch dwarfs the compare. Insertion sort, same ascending
   sequence. Field portion: 15.3 -> 12.5ms.

Where the node stands after fixes 3, 5, 6: **~52ms (session start) ->
~21.5ms**, output unchanged at every step. Remaining split: ~12.5ms field
sampling + marching + setup, ~9ms fit.

What's left is structural, not shaveable: the field loop's remaining cost is
the loop itself (~3.7 candidates/sample means the distance math is NOT the
bottleneck — it's per-sample overhead over 140k samples), and the fit is
Schneider's algorithm doing its job. The two real options if this needs to go
further:

- **GPU field evaluation** (fragment shader computes the SDF grid, readPixels,
  march on CPU). The branch clustering makes the shader nontrivial but not
  impossible — branches are per-subpath runs, which could be one draw per
  subpath with min-blending, though smooth-min needs the branches SEPARATED,
  so it likely means a multi-layer target or a fixed max-branch count.
- **Incremental/dirty-region evaluation** — only resample grid cells whose
  candidate set changed. Complex bookkeeping; the sim invalidates most of the
  bbox every frame anyway, so probably poor return here.

Neither is a quick win; both change no output. Stop here unless the node is
still the limiting factor in real use.

The field loop is the other half and is where "put it on the GPU" applies
cleanly — an SDF evaluation is a natural fragment shader. The obstacle is
that the per-sample branch clustering (sort candidates by (subpath, ordinal),
split at ordinal gaps, fold with smooth-min) is awkward in GLSL.

`blend-intersections` was ~52 ms live earlier. Its cost is the SDF field sample loop: ~101k grid samples ×
~36 candidate segments, each a point-segment distance. That is not a
micro-optimization target — it is the one place in this chain where the
owner's original "get it on the GPU" instinct is straightforwardly right: an
SDF field evaluation plus marching squares is a natural fragment-shader
workload.

Still open:
- `spline-boolean` crash on self-intersecting input (from session 1).
- `layer` still does a full-canvas composite per layer; the fused Merge
  shader already exists and shares `BLEND_MODE_GLSL`.

---

# Session 3 (2026-08-08) — Blend Intersections field on the GPU

Spec `080826_blend-intersections-gpu.md` implemented end to end (its
§Outcome carries the full record; the short version + the lessons live
here). The SDF field loop is now a fragment shader
(`spline-blend-intersections-gpu.ts`); marching, cleanup and the fit are
untouched, and the CPU loop stays in the file as reference + fallback,
byte-identical (18-config snapshot, 52,115 anchors).

| case (hardware GL, M4 Pro) | field CPU→GPU | node CPU→GPU |
|---|---|---|
| wander-100 (bench:spline shape) | 5.0 → 4.1 ms | 10.5 → 10.0 ms |
| 8-lobe network @1920×1080 | 220 → **19.8 ms** | 253.6 → **52.0 ms** |

Gates: field ≤ 8e-5 px vs CPU on the bench corpus (gate 1e-3); contours
bit-close at smoothing 0 (≤ 3e-4 px); jitter mean 7.582 vs CPU 7.596
(ref 7.60) — no added popping. `npm run check:blend-gpu` pins all of it
headlessly; `npm run bench:blend-gpu` is the timing harness.

Things measurement overturned, so they don't get re-learned:

- **The spec's candidate-array shader design was unbuildable.** Max
  survivors/sample is 34 on the light corpus but 276–424 on dense
  networks (GPU gather has no dedup) — no register budget holds that.
  Replaced with STREAMING branch accumulation (interval-merge = the same
  transitive partition as the CPU's sort-then-split; proven bit-exact in
  fp64 over ~3.3M samples before writing GLSL). Max live branches: 26
  dense / 59 stress; cap 64, overflow → detected → CPU.
- **A sync readPixels has a ~3–4 ms latency floor on ANGLE/Metal**
  regardless of size — it cancels the win on light inputs (hence parity
  on wander-100, not the spec's projected "field ~1–2 ms"). The win
  lives where the node actually hurts: dense self-crossing networks,
  5–11×. GPU was never slower at node level, so no dispatch heuristic.
- **fp32 cannot cross the CPU field's own discontinuities cleanly**: the
  farSlack cheap exit and empty-neighborhood `influence` emit are step
  functions, and a handful of samples per million land on the other side
  (3 in 755k on the dense case, every one pinned at a threshold, all far
  from the iso). Same class: one 6.8 px output sliver sitting exactly on
  the `len < cell*3` debris threshold. The check classifies these
  knife-edges explicitly and fails anything unexplained.
- **Contour equivalence at 0.05 px is impossible at smoothing > 0 for
  any non-bit-identical field** — Schneider split choices flip on
  last-bit changes (Fix 6's cascade, now measured from the other side:
  0.21–0.49 px curve wiggle from 1e-4 polyline agreement, 4 of 18
  cases). The gate pins the recovery at smoothing 0 strictly and bounds
  fitted curves by the fit's own errPx budget.
- **bench:nodes cannot measure this node** (geometry-signature cache
  hits → the standing 0.100 ms artifact) and **bench:spline (tsx) runs
  this code ~2× slower than the Electron renderer** on the same machine
  (20.6 vs 10.5 ms) — never compare numbers across those environments.
  `bench:blend-gpu` exists because neither could see the A/B.
- A/B in the live app: `__perf.blendGpu(false)` forces the CPU path.


# Session 4 (2026-08-09) — the full-canvas pass tax (`kaminotests_03` @ true 4K)

Baseline with the viewport at full 3840×2160: **GPU 34.1 ms/frame, 24 fps
against the 30 fps target**, CPU 3.4 ms (irrelevant). Every full-canvas pass
costs ~3.4 ms at this size, and the frame was a stack of them — several
carrying no information. Four fixes, all output-identical (screenshot-pinned
at a fixed frame), took it to **GPU 16.5 ms/frame, p5 fps 32.6**:

| Fix | What | GPU won |
|---|---|---|
| 7 | `rasterize-spline` flat path returns its persistent upload texture directly (`ownsTextures: false`, Y-flip baked into the upload via `UNPACK_FLIP_Y_WEBGL`) instead of pool-alloc + full-canvas blit | 3.4 ×2 instances |
| 8 | `points-on-path` gates its dot-viz aux on `consumedOutputs` (+`gatesOutputs`) — it rendered a full-canvas image every eval that nothing consumed (same shape as Fix 2) | 3.9 |
| 9 | `layer` passthrough fast paths: empty layer returns `stack`; bottom layer at normal/opacity≥1 returns `content` (compositing over transparency is the identity for `normal` ONLY — `blendRgb` reads base RGB unweighted by base alpha, so other modes must keep the pass) | 4.4 |
| 10 | `bloom` mip-chain targets persist in `ctx.state` keyed on (base size × levels) instead of 11 alloc/free per eval | 2.1 |

**Fix 10 answers the texture-churn question with a number.** Same passes,
same pixels — the 2.1 ms was purely createTexture/texImage2D/deleteTexture
churn. The engine-wide free-list pool (still unbuilt) is therefore real GPU
time, not just hygiene: the remaining 5 allocs/frame (merges, grain,
points-on-path positions, bloom output) are worth roughly another
0.5–1 ms by the same ratio.

Method notes that made the diagnosis cheap (details in the MCP session):
paused single evals run ~1.8–2× hotter than the same work under playback —
compare paused conditions only to each other; a sig-hit condition can be
manufactured by wiggling an upstream param whose output values don't change
(`dot_color`), which isolates a node's fixed overhead from its draw+upload.
Found along the way: MCP `set_param` rejects all number/boolean values
(they arrive stringified — enum/string/color params work), and the
rasterize-spline CPU split at 1526 subpaths is ~66% per-subpath ramp
`stroke()` calls / ~24% signature `JSON.stringify` / ~8% actual drawing —
both documented as future CPU candidates, not yet acted on.

Remaining GPU frame (16.5 ms): bloom 5.5, merge 3.7 + 3.7, grain 2.9. All
genuine full-canvas work now — further wins mean fusing the merge chain
across nodes, precision drops (R11F_G11F_B10F bloom mips — needs sign-off,
not bit-identical), or the pool.

### Fix 11 — the texture pool exists now (gl.ts free list)

The free list the devguide always described: `allocTexture` leases from a
per-(size, format) list, `releaseTexture` files back into it. Reused
textures are CLEARED on hand-out (WebGL zero-inits fresh textures and nodes
may rely on that — a render-pass clear is far cheaper than the driver's
create-time zeroing of a 66 MB allocation, which is where the cost was
hiding). A WeakSet guards double-release; entries age out after ~2k leases;
resize()/destroy() flush. Profiler alloc/release counts are unchanged in
semantics — they now measure pool TRAFFIC; driver allocations are only the
misses.

**Measured: GPU 16.5 → 12.1 ms/frame (−4.4 ms), fps p5 87.** Far above the
"~0.5–1 ms" projection scaled from Fix 10 — because the remaining 5
allocs/frame were mostly FULL-CANVAS 66 MB textures, and per-alloc cost
scales with size (mandatory zero-init). Per node: bloom 5.5 → 3.8,
merge-tz 3.7 → 2.4, merge-1y 3.6 → 1.4. Verified: pixel-identical frame,
all gates, bench:nodes clean on hardware GL.

Session 4 cumulative (`kaminotests_03`, true 4K): **GPU 34.1 → 12.1
ms/frame (−65%), fps p5 23 → 87.**

### Bloom quality modes — measured, and a negative result worth keeping

A `quality` enum (high / balanced / performance) was added: the pyramid
starts at ½ / ¼ / ⅛ res with the level count reduced to match, so the halo
WIDTH is preserved and only the finest octave(s) of glow detail go. "high"
is byte-identical to before (the tap-spread is a pre-scaled uniform — no
GLSL change); the modes verifiably engage (⅛ start is visibly softer).

Measured at 4K on the M-series dev machine: **5.53 / 5.40 / 5.43 ms GPU** —
the knob buys ~0.1 ms. The pyramid was never the cost; bloom's GPU time
sits in its two fixed full-res touches (the threshold's source read and the
composite read/write) plus per-pass overhead, none of which resolution
scaling below ½ can remove. This is the mip-chain technique working as
designed ("constant cost"), not a defect. Do not re-attempt pyramid-res
scaling expecting frame-rate wins on this class of GPU; the modes may still
matter on fill/bandwidth-starved hardware, which is the only reason to keep
them.

# Session 5 (2026-08-09) — Sketch_01, the readback saga

Project: 75 nodes, 2048×2048 @ 60 fps target, playing at ~19 fps. The trail
led through three wrong-looking answers before the right one; each step is
recorded because the traps generalize.

1. **Level-3 trace said `sdf-to-spline` cost 28.4 ms/frame CPU** (70% of
   eval) — a 254² march whose own design budget is ~1 ms. Paused isolation
   (own-param wiggle → upstream cache-hits → drained queue): 8.1 ms.
   Resolution probe 254²→128²: 8.1→7.1 — cost is FIXED, not per-pixel.
   Diagnosis at this point: sync-readback stall + fixed floor.
2. **Async PBO readback built** (opt-in `async_readback` param on
   sdf-to-spline — 1-frame contour lag interactive, sync path for export
   (`ctx.offline`), cold start, and the toggle off; PIXEL_PACK_BUFFER +
   fence, 2-slot round robin, never blocks). Paused cost: unchanged (!),
   which broke the diagnosis and forced honesty:
3. **`scripts/bench-readback.cjs`** (standalone hardware-GL harness) says
   the machinery is fine: PBO issue+collect ≈ 0.0 ms even against a busy
   queue; sync readPixels ≈ 0.9 ms idle / 2.3 busy. Also: ANGLE/Metal's
   native read for RGBA16F is RGBA/**HALF_FLOAT** — the app's RGBA/FLOAT
   takes a conversion path (~0.4 ms, minor but free to fix).
4. **The 8 ms floor was an observer effect.** At capture level 1 the same
   paused eval costs 2.9 ms. Level 3's GPU timer queries serialize around
   sync GL calls (fences/readbacks) and bill ~6 ms/eval to the node under
   measurement. Now in TESTING.md.
5. **Honest level-1 playback A/B** (sync 28.5 vs async 19.6 ms/frame billed
   to the node, async run covering the denser loop span): the toggle saves
   ~9+ ms of CPU frame. fps moved only 19→22, because the project's binding
   constraint is **GPU oversubscription** — ~96 ms of queued passes per
   frame (four masked, linearized gaussian blurs at 2048² ≈ 28 ms, JFA 11,
   texts/copies/bloom/merge the rest). On a stream that deep, ANY sync GL
   round trip (even a fence poll) waits behind the service-side backlog —
   which is where the async path's remaining playback cost sits, and why
   no CPU fix alone can rescue this project.

Where Sketch_01's remaining time actually is: (a) the four blurs — the
graph-level fix; (b) `rasterize-spline-mp0rdg` 3–10 ms CPU depending on
loop section (dense march output through the image-fill path — the
rasterize-spline CPU candidates from Session 4 apply directly);
(c) fingerprint building at 0.6–1.1 ms/frame (583 KB of spline
serialization — the hash-instead-of-concatenate item, now with a real
workload behind it).

## Panel capture semantics (2026-08-08, owner request)

The panel previously accumulated every eval — paused param edits, scrubs —
into the same stats until Clear was hit, blending "how fast is my graph"
with "what did I poke while reading the panel". Changed:

- **The panel arms with `playingOnly: true`** (new `setCaptureLevel` option).
  Paused evals are gated at `beginEval` — not discarded at commit, which
  matters: a commit-time discard leaves its seq reusable, and a late GPU
  resolve for the discarded frame would bill into whichever committed frame
  reused that seq. Gated at open, nothing happens at all: no frame, no GPU
  queries, no arena writes, no seq.
- **Seeking to frame 0 auto-clears an armed trace** (any armed trace, panel
  or MCP). Hooked in EffectsApp's `setTime`, which every user path funnels
  through — transport rewind, scrub, MCP seek. The rAF loop-wrap writes the
  clock directly and does NOT clear, so looping playback accumulates across
  passes. Guarded on `currentSeq() > 0` because `resetTrace` reallocates the
  ring and a scrub parked at the head fires per pointermove.
- **MCP `set_perf_capture` unchanged** (records paused evals) — the agent
  workflow traces paused edits deliberately. Arming from either side
  replaces the other's mode and clears.

Covered in `scripts/check-profiler.mts` (gate, trigger consumption, seq
stability, nested-inside-gated, default unchanged). Verified live over MCP:
600 accumulated frames → seek frame 0 → 14 (the post-clear paused evals);
seek frame 50 → seq continues, no clear.
