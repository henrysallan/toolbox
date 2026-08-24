# Time Offset — retiming as a node

Spec — 2026-08-14. Status: **shipped** (M1–M4 same day; engine + nodes +
editor coercion + `scripts/check-time-offset.mts` guard). One deviation:
the M3 boundary warning ships as a once-per-structure `console.warn` + the
node description — the ParamPanel warning row needs an eval→UI warnings
channel that doesn't exist yet and is follow-up work. Decisions at the
bottom.

Two features, one theme: making time a thing you can wire.

1. **Time Offset node** (design fork B from the feasibility discussion): a
   drop-in passthrough node that re-evaluates everything upstream of its
   input at `tick − Δ`, so the whole branch — keyframes, clips, Scene Time,
   procedural animation — plays shifted by Δ frames. Splice it onto any
   wire; the branch behind it time-travels.
2. **Animated Value node** (fork D): a keyframable scalar whose keyframes
   are sampled at a **wired clock** instead of the playhead. Feed it
   `Scene Time → Math` and its curve becomes arbitrarily retimeable —
   offset, stretched, ping-ponged, audio-driven.

They are independent (separate milestones, either ships alone) but
complementary: Time Offset shifts a *branch* by evaluation; Animated Value
retimes *one curve* by data. Both are exact under scrubbing and export
because both are pure functions of time — no buffering, no warm-up.

## Why not the naive version

Wires carry **already-sampled values**, not functions of time. The
evaluator resolves each node's keyframes at `ctx.tick` before compute
([evaluator.ts ~L1308](../src/engine/evaluator.ts)) and the node emits a
plain `SocketValue`. By the time anything reaches a downstream node the
time dimension is gone. So "offset the keyframes in the stream" must become
one of: re-evaluate upstream at a shifted tick (the Time Offset node), or
move the clock to the source (Animated Value). Both are specced here.

## What already exists (the load-bearing precedents)

- **Keyframe sampling is pure.** `evaluateKeyframesAt(block, type, tick)`
  ([keyframes.ts](../src/engine/keyframes.ts)) is stateless; sampling at
  any tick — past or future — is free.
- **The evaluator already runs nodes on shifted clocks.** Layer interiors
  run on `globalTick − layerOffset`; the per-iteration `ctx` save/restore
  discipline around `ctx.tick/frame/time` is established
  ([evaluator.ts ~L1109](../src/engine/evaluator.ts)).
- **A node can privately re-run a subgraph.** Iterate's compute calls
  nested `evaluateGraph(…, {nested:true})` over a private `EvalCache` in
  `ctx.state`, copies result textures out before they can be evicted, and
  folds an interior hash into its own fingerprint via `fingerprintExtras`
  ([iterate.ts](../src/nodes/group/iterate.ts), stash construction at
  [evaluator.ts ~L813](../src/engine/evaluator.ts)). Time Offset is a
  *simpler* Iterate: one nested pass, no per-iteration values.
- **Needed-set edge exclusion has precedent.** `computeNeededSet` already
  skips edges into Render Queue nodes (~L330) so `render` links don't pull
  branches into evaluation.
- **Feed nodes re-inject outer values.** Iterate's `__iterfeed_` synthetic
  nodes re-emit outer-evaluated values inside a nested pass — the exact
  mechanism boundary-feeding needs (§ Non-retimeable upstream).

---

# Part 1 — Time Offset node

## Semantics

`time-offset`, category `utility`. One polymorphic input `in` (any socket
type), primary output mirrors it. One param:

- `offset` — scalar, **frames** (float; sub-frame allowed, converted to
  ticks internally), default 0, wirable like any scalar param. Symmetric
  soft range (±120, hard ±10000).

**Sign convention: positive offset = later.** The node samples upstream at
`scopedTick − offset·ticksPerFrame`, so with offset +10 the upstream's
frame-10 content appears at frame 20 — animation is *delayed* by 10
frames, matching AE/NLE intuition. Negative offsets look ahead, which pure
upstreams support exactly (keyframes clamp at their ends like everywhere
else).

Everything time-dependent upstream shifts coherently: keyframes, clip
windows (a clip gate resolves at the shifted tick — the window slides with
the content, which is the only self-consistent reading), `stable:false`
pure nodes (Scene Time, Wave, LFO, noise driven by `ctx.time`), and layer
interiors upstream of the tap (nested flatten recomputes `layerOf` and
layer offsets from the shifted global tick).

Because `offset` is a wirable param, **time warping comes free**: wire an
LFO, an audio level, or keyframe the offset itself (the node's own
keyframes sample on the *outer* clock — it retimes upstream, not itself).
A varying offset means the private cache fingerprints at a different
interior tick each frame — honest cost, same as scrubbing.

## Engine plumbing

### Upstream-closure stash

After flatten, alongside the Iterate stash (~L813), the evaluator walks
parents from each `time-offset` node's `in` edge and collects the ancestor
closure — node and edge **references** into the flat graph (unlike Iterate
interiors, these nodes STAY in the outer graph; other consumers may still
evaluate them at unshifted time). Stash shape mirrors `IterateStash`:
`Map<offsetNodeId, {nodes, edges, tapProducer, hash}>` under its own
`ctx.state` key (colon-free, like `ITERATE_STASH_KEY`, so the dispose
sweep ignores it).

The hash folds each closure node's `id/type/bypass/params/animation` +
edges, and — when the closure is time-driven (any `stable:false` def or
any animated node) — the **shifted** tick, so the outer fingerprint busts
per-frame only when the interior actually moves. Same rules as the Iterate
stash hash.

The walk **stops at** (and records, for warnings + feeds):

- defs flagged `retimeable: false` (§ below),
- Iterate shells (nested-inside-nested is rejected by Iterate's compute),
- other `time-offset` nodes (v1 rejects chaining — Decision 3).

Stash construction runs on nested passes too (merge, not clobber — same
rule as the Iterate stash at ~L820), so a Time Offset inside an Iterate
zone works: its closure is stashed during the shell's interior pass.

### Needed-set exclusion

`computeNeededSet` skips the `in` edge of `time-offset` targets (precedent:
the Render Queue skip at ~L330), so a branch consumed *only* through the
offset node never evaluates at outer time. The `in:param:offset` wire is
NOT skipped — the wired offset value must evaluate outer-side. If another
consumer also reads the branch directly, it evaluates in both time domains;
that is semantically correct (the same node genuinely has two values at two
times) and costs what it costs.

### `retimeable: false` def flag

New optional `NodeDefinition` field, default absent (= retimeable). Flag
the defs whose output depends on **evaluation history or live external
state** rather than the clock: `video-source` (one media element, one
`currentTime`), `webcam`, `audio` + audio-chain sources (one Tone
transport), `cursor` / `cursor-trail-points`, `image-generate`, the
trackers, and every integrated sim (particles, Matter, rope, rigid-body,
physarum, accretive-growth). Criterion, stated on the field's doc comment:
*"could two copies of this node at two different ticks coexist in one eval
and both be right, given only `ctx`? If not, flag it."* Pure
`stable:false` defs (Scene Time, Wave) are NOT flagged — `f(ctx.time)`
retimes perfectly.

### Non-retimeable upstream: boundary feeds

When the closure walk hits a flagged node (or Iterate shell), the walk
stops **and the node's outer output is fed through**: the stash records
the crossing edge, and compute injects a synthetic feed node (Iterate's
`__iterfeed_` pattern verbatim) that re-emits the outer-evaluated value
inside the nested pass. Effect: a video → blur → Time Offset chain shifts
the blur's keyframes but shows current-frame video, and — critically — the
nested pass never touches the video element's state, so there is no
`ctx.state` collision (state keys are `<type>:<nodeId>`; the collision
hazard only exists for nodes actually computed in both domains).

Feeding requires the flagged producer to be **outer-evaluated**, so its id
joins the outer needed set via `extraTargets` semantics (the stash records
these; `evaluateGraph` already accepts `extraTargets`).

## The node's compute

Iterate's shape, one pass:

1. Read the stash entry; missing/empty (unwired `in`) ⇒ passthrough of
   `inputs.in` (which is `undefined` ⇒ emit nothing).
2. Save `ctx.tick/frame/time`, set all three to the shifted tick, set the
   feed values, call `evaluateGraph(closureNodes+feedNodes, closureEdges,
   ctx, privateCache, tapProducerId, undefined, undefined, {nested:true})`.
   Restore in `finally` (audio-audibility save/restore like Iterate's).
3. Pull the tap producer's output (primary or the specific aux handle the
   `in` wire referenced). GPU-backed values (`image`/`mask`/`uv`) are
   **copied immediately** into node-owned textures (Iterate's `COPY_FS`
   blit + `owned[]` lifecycle: freed at next compute and in `dispose`,
   emitted with `ownsTextures:false`). CPU values pass by reference —
   consumers treat `SocketValue`s as immutable, and private-cache eviction
   only releases textures.
4. Run the input-side coercion to the node's resolved output type if the
   tap's type differs (it shouldn't — the output mirrors the wired input's
   resolved type — but a polymorphic upstream retype mid-edit can race one
   eval; coerce defensively like the evaluator's input path does).
5. `dispose`: `disposeEvalCache(ctx, privateCache)` (exists, ~L690) + free
   `owned[]`.

`fingerprintExtras` returns the stash hash (exactly Iterate's pattern) so
interior edits — params, keyframes, wiring — bust the outer cache even
though the offset node's own fingerprint can't see them.

`stable` stays `true`: time-dependence flows through the stash hash (which
folds the shifted tick only when the interior is time-driven), so a fully
static upstream stays cached across the whole timeline.

## Editor integration

- **Polymorphic sockets.** `resolveInputs` types `in` from
  `connectedTypes` (Switch precedent); `resolvePrimaryOutput` mirrors it.
  `editorCanCoerce` gains the defType exception for `in` accepting
  anything; the splice check's `projectPrimaryOutput` handles the output
  side generically — so **dropping Time Offset on any wire splices it**,
  which is the primary gesture this node exists for.
- **Warnings.** When the stash recorded boundary feeds, surface it.
  SHIPPED v1: a once-per-structure `console.warn` listing the boundary
  types + the rule stated in the node description. FOLLOW-UP: a warning
  row in ParamPanel ("Upstream contains live/simulated nodes — passed
  through un-shifted: Video, Rope Sim") — needs a warnings channel from
  eval results into node data (parallel to `errors`→`data.error`), which
  doesn't exist yet. A chained Time Offset upstream produces a hard node
  error via the compute throw → `errors[id]` ("add the offsets into one
  node instead").
- **Docs.** Manifest entry ([manifest.ts](../src/lib/docs/manifest.ts)) +
  node description mentioning the sign convention and the live-node
  boundary rule.

## Sharp edges (write these into code comments)

- **Shared per-node memo state.** Unflagged nodes computed in both time
  domains share `ctx.state[<type>:<nodeId>]`. That is safe for
  signature-keyed memos (text.ts's pattern — recompute on sig mismatch,
  worst case alternating-sig thrash, never wrong output) but NOT for
  history state — which is exactly what `retimeable:false` fences. When
  flagging defs in M1, audit each unflagged def that touches `ctx.state`
  against the two-copies criterion.
- **Preroll.** Nested passes inherit `ctx.preroll` (~L882) — nothing to
  do, but don't break it: the shifted branch must stay silent/paused
  during a layer preroll like everything else.
- **Profiler.** Nested passes already tag `evalDepthTag=1`; Time Offset's
  interior samples land there like Iterate's. Fine for v1; note in the
  profiler docs that "iterate interior" now also means "time-offset
  interior".
- **`emptyClipOutput` reuse.** With `in` unwired the node emits nothing;
  do NOT invent a new empty-value table — if a gated/empty story is ever
  needed, [clips.ts](../src/engine/clips.ts) `emptyClipOutput` is the one
  table.

---

# Part 2 — Animated Value node

## Semantics

`animated-value`, category `utility`. Params:

- `value` — scalar, keyframable, the point of the node (min/max/softMax
  matching Constant's).
- `unit` — enum `frames | seconds`, default `frames`: how the wired clock
  is interpreted.

Inputs: `time` — scalar, optional. Output: scalar.

Unwired `time` ⇒ behaves exactly like a keyframed Constant (keyframes
sample at the playhead). Wired ⇒ the node's keyframes are sampled at the
wired time instead: `tick = time·ticksPerFrame` (frames mode) or
`time·ticksPerFrame·fps` (seconds mode). `Scene Time (frames) → Math
subtract 10 → Animated Value.time` is a 10-frame offset; a Float Curve in
that chain is a time-warp; an audio level is scrub-by-loudness. Out-of-
range times clamp to the end keyframes (evaluateKeyframesAt already
clamps).

Scalar-only in v1 (Decision 5).

## The `clockInput` evaluator affordance

Keyframe resolution happens in the evaluator, before compute, and compute
never sees `node.animation` — so this needs one small, contained evaluator
change rather than node-local code:

New optional `NodeDefinition` field: `clockInput?: string` — the name of a
declared scalar input socket. In the keyframe-resolution block
(~L1308), for defs with `clockInput`:

1. Inputs are already resolved by this point (the input loop runs first).
   If the named input resolved to a finite scalar, convert to ticks using
   the node's `unit` param (the conversion helper lives next to the flag's
   doc in the evaluator; keyframes.ts stays pure) and use that as the
   sample tick for **all** of this node's keyframe blocks instead of
   `ctx.tick`.
2. The animation fingerprint contribution folds the **effective sample
   tick**, not `ctx.tick` — otherwise a wired-clock node would cache-hit
   while its clock input moves. (In practice the input fingerprint already
   busts it — the upstream clock is `stable:false` — but fold the sample
   tick anyway so the invariant doesn't depend on what's wired.)
3. Wire > keyframe > constant precedence is untouched: a wire into
   `in:param:value` still beats keyframes; `clockInput` only changes
   *when* keyframes are sampled, not whether.

The flag is generic on purpose: later it can be adopted by other
keyframable literals (vec2-literal, color-literal) or an LFO "phase clock"
without touching the evaluator again.

## Editor integration

Add-menu entry under utility next to Constant; search aliases
`retime`, `keyframes`, `channel`, `curve sample`. Docs manifest entry.
ParamPanel needs nothing new (scalar + enum + standard keyframe diamond).
Track/Graph editors need nothing: the keyframes live in a normal
`animation` block and edit normally — only *evaluation* reads them at the
wired clock. (The playhead-position diamond still reflects the outer
clock; that mismatch is inherent to retiming and matches how AE expression
-driven time behaves. Note it in the node's docs page.)

---

# Milestones

- **M1 — engine plumbing (no user-visible change).** `retimeable` flag +
  classification pass over the flagged defs (with the two-copies audit of
  `ctx.state` users); upstream-closure stash + hash after flatten (merge
  rule on nested passes); needed-set exclusion of `time-offset` `in`
  edges + boundary-feed `extraTargets`. Guarded by a small
  `scripts/check-`style script if the stash walk is extracted pure
  (preferred: pure closure-walk in flatten.ts or a sibling module, tested
  headlessly like check-graph-ops).
- **M2 — the Time Offset node.** Def + compute (nested eval, private
  cache, texture copy-out, `fingerprintExtras`, dispose), polymorphic
  in/out + `editorCanCoerce` exception, splice-onto-wire working, wired/
  keyframed offset working. Manual verification per TESTING.md.
- **M3 — boundaries + warnings.** Feed injection for `retimeable:false` /
  Iterate-shell upstream; chained-offset hard error; ParamPanel/inspector
  warning row; docs page.
- **M4 — Animated Value.** `clockInput` affordance in the evaluator
  (sample-tick override + fingerprint fold), the node def, docs page.
  Independent of M1–M3; can land first if sequencing favors it.
- **Ship:** devguide update (evaluator section: time domains + the
  `retimeable`/`clockInput` flags; repo map: the new node files), devlist
  entry closed.

# Decisions

1. **B is nested-eval, not flatten-time cloning (fork E).** Cloning gives
   outer caching for free but churns clone ids — and therefore caches and
   node state — every frame the offset animates. Nested eval handles a
   wired/animated offset gracefully (the private cache fingerprints at the
   interior tick). Revisit E only if time-domain features multiply.
2. **Positive offset = later** (samples the past). AE/NLE convention.
3. **Chained Time Offsets are rejected in v1**, with an error telling the
   user to sum into one node's offset. Transparent composition (closure
   walk crossing an offset node and adding its Δ) is future work; it needs
   per-domain private caches and is not worth the state-scoping machinery
   until someone actually stacks them.
4. **Non-retimeable upstream feeds through at outer time** rather than
   erroring. A partial shift with a visible warning is more useful than a
   dead node — the common case is "shift my keyframed effect chain that
   happens to sit on live video", which this serves exactly.
5. **Animated Value is scalar-only v1** and a NEW node — Constant stays
   bare (its whole identity is "a number, nothing else"). The `clockInput`
   flag is the reusable part; more types come by adopting it on the other
   literals, not by widening this node.
6. **Clip windows shift with the content** under Time Offset (they resolve
   at the shifted tick). The alternative — gating at outer time while
   keyframes shift — splits one node's timeline into two clocks and has no
   sane Track Editor story.
