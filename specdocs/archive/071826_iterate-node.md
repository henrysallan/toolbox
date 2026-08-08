# Iterate node — bounded variants of a subgraph (spec, 2026-07-18)

The "left side" of per-copy variation. Companion spec:
[071826_copy-identity-stroke-width.md](071826_copy-identity-stroke-width.md)
(the "right side" — per-copy identity + drivers downstream of Copy to
Points for geometry that survives it).

## Why

Image instances are baked before Copy to Points and flattened by it, so
"randomize a generator's parameters per copy" (circle radius, rectangle
roundness, a blur amount — anything upstream) is impossible today except
by hand-building K duplicate branches into a Combine. True per-copy
re-evaluation (Houdini copy stamping) is off the table on purpose: N×
branch cost per frame and cache-hostile — the industry replaced it with
bounded for-each loops. The Iterate node is that answer here: evaluate a
subgraph **K times** with per-iteration values injected, collect the K
results, and let the existing variant machinery (`pick_mode`,
`image_group`, groupIndex) distribute them. `types.ts` already promises
this on ImageGroupValue's doc comment ("iterate via Foreach — coming in
a follow-up").

Randomization stays **wiring, not parameters**: the iteration values are
sockets you wire into any interior node's exposed params. No node grows
a jitter block; anything drivable by wire becomes randomizable.

## What the user sees

A new **Iterate** node (utility). Tab dives inside (same navigation as
groups/layers). Interior has the standard Iteration Input / Iteration
Output boundary nodes:

- **Iteration Input** carries three reserved aux sockets — `index`
  (0…K−1), `t` (index/(K−1), 0 when K=1), `random` (seeded per-iteration
  hash, reshuffled by the shell's `seed` param) — plus user-minted
  passthrough sockets (Blender-style trailing virtual socket, exactly
  like groups) that surface as input sockets on the shell.
- **Iteration Output**: the first minted socket is the collected result.
- Shell params: `count` (K — int, 1…64, softMax 16), `seed`.

Typical build: dive in, make Circle → (whatever), wire `random` into
Circle's exposed `radius`, wire the result to Iteration Output. Outside:
Iterate emits 8 circles with 8 radii → Copy to Points
(`pick_mode: random`) scatters them.

Collection by the interior result's type:

- `image` → `image_group` (K items — flows into CTP image-group mode,
  Group Pick, Merge Group).
- `spline` → one spline, each iteration's subpaths tagged
  `groupIndex = iteration` (flows into CTP variant picks and the
  right-side styling drivers).
- `points` → one points value, `groupIndices = iteration`.
- Other types: out of scope for now (socket types beyond these are
  rejected by the boundary's socket editor for the result slot).

## Architecture

New `ITERATE_TYPE = "iterate"` in engine/groups.ts. The shell is a
**third structural variant**: computes and survives flatten (like
`layer`), interface-driven sockets via `readGroupInterface` (like
`node-group`). Interiors are identified by `parentId` chain, as always.

### Flatten (engine/flatten.ts)

- The shell survives `outNodes` for free (it's not a dissolved type —
  same ride the layer gets).
- New pre-pass (mirror of the `layerOf` parent-chain walk): compute the
  set of nodes whose parentId chain reaches an iterate shell; drop those
  nodes and any edge touching them from the flat graph. No
  `resolveBoundarySource` changes — exterior edges land on the shell,
  never on interior boundary nodes, so nothing splices *through* an
  iterate.
- `FlattenResult` gains the interior membership map
  (`iterateInteriorOf`), because the evaluator needs it twice (below).

### Evaluator (engine/evaluator.ts)

`evaluateGraph` is re-entrant (the split-viewport path already runs it
twice per frame on a shared cache). The iterate shell's `compute` runs
it on the interior K times. The pieces:

1. **Interior hand-off.** Compute can't see the graph, so the evaluator
   stashes each iterate's interior `{nodes, edges}` (original,
   unflattened — interiors may contain plain node-groups, which the
   nested call flattens itself) on the ctx before computing shells.
2. **Interior fingerprint.** The shell's own fingerprint doesn't see
   interior params — editing an interior node must bust the outer cache.
   When fingerprinting an `ITERATE_TYPE` node the evaluator folds in a
   hash of the interior (per-node type/params/bypass/animation + edge
   list) — same spirit as the animation-block fold. If any interior def
   is `stable:false` (Text, time readers), the fold includes `ctx.time`,
   so time-driven interiors animate at an honest K× cost and static
   interiors stay fully cached.
3. **Injection seam.** A `ctx.iteration` field (precedent:
   `ctx.wedgeIndex`) set per nested call:
   `{ index, count, t, random, values }` where `values` carries the
   shell's exterior input SocketValues by socket name. **Iteration
   Input's compute reads it**: reserved sockets emit index/t/random as
   scalars; user-minted sockets emit the matching entry from `values`
   (this is how exterior inputs pass through — the nested eval has no
   exterior edges). Outside an iterate eval, `ctx.iteration` is unset
   and the def stays the no-op it is today. Its `fingerprintExtras`
   returns the iteration signature (index + a per-compute run counter)
   so the private cache never serves iteration i−1's values to i.
4. **Private cache.** One `EvalCache` per shell, in
   `ctx.state["iterate:<id>"]`, reused across the K calls *and* across
   frames. Correctness: interior nodes downstream of Iteration Input
   recompute per iteration (fingerprintExtras above); nodes not touching
   the boundary cache normally (a static heavy branch shared by all
   iterations evaluates once). Teardown releases the cache's owned
   textures via the same eviction discipline the outer cache uses.
5. **Texture lifetime (the trap).** `transientsByCache` frees the
   previous call's transient textures on each `evaluateGraph` entry —
   so the result of iteration i is **copied into an iterate-owned
   texture** (blit into `ctx.allocImage()`) before iteration i+1 runs.
   The collected `image_group` items are therefore owned by the shell:
   released at the start of its next compute and in `dispose`
   (verify the outer evaluator's eviction release and this ownership
   don't double-release — mark `ownsTextures` accordingly).
6. **State sweep.** `sweepNodeState` runs against the pre-flatten id
   set; interior ids excluded from the flat graph must join the
   keep-set (from `iterateInteriorOf`) or interior node state (Text
   canvases, samplers) is disposed every frame. Interior ids are shared
   across iterations — acceptable for stateless/cached interiors;
   sims/feedback nodes inside an Iterate are explicitly unsupported for
   now (documented; they'd need per-iteration state namespacing).
7. **Targeting + misc.** Nested calls pass the Iteration Output's wired
   producer as the target (reuse `resolvePreviewProducer`);
   `ctx.audioRoutedToOutput` is saved/restored around them; audio
   routing is skipped inside.

### Editor + persistence

- graph-ops: `makeIterateNodes` (mirror of `makeLayerNodes`) mints shell
  + boundary nodes, `parentId` wiring, reserved iteration sockets on the
  input boundary (`reserved` mechanism, like layer's `backdrop`), then
  `syncGroupInterface` — which is parentId-keyed and works unchanged.
  Also a `wrapSelectionInIterate` (mirror of `groupSelection`) later;
  M1 ships the empty-shell add path only.
- EffectsApp: add `ITERATE_TYPE` to the dive gate
  (`handleDiveIntoGroup`); scope filtering and breadcrumbs are
  parentId-driven and work unchanged. Adding the node from the Add menu
  routes through the special-case that mints the boundary trio.
- Serialization: zero changes — shells/boundaries/interiors are plain
  nodes with plain-JSON params (`parentId` since schema v3). No bump.

## Guardrails

- `count` hard-capped at 64, softMax 16. K full-canvas RGBA16F images ≈
  16 MB each at 1080p — the docs page and param tooltip say so.
- A failed/empty interior (no result wired, interior eval throws) emits
  an empty collection, never crashes the outer eval.
- Nesting an Iterate inside an Iterate: rejected in M1 (the interior
  pre-pass treats a nested shell as a plain interior node and the shell
  refuses to run — emits empty + a console warn). Revisit if a real
  need appears.

## Milestones

1. **Engine core, image collect.** ITERATE_TYPE + defs + flatten
   pre-pass + ctx.iteration + nested eval + private cache + texture
   copy/ownership + sweep keep-set. Empty-shell creation from the Add
   menu, dive gate. Verify: Circle(radius←random) inside, K=6 →
   image_group of 6 different circles into CTP pick random; param edits
   inside bust the outer cache; no leak warnings after 5 min of
   playback.
2. **Spline/points collect + interior stable:false handling.** Verify:
   spline variant set feeds CTP spline mode with `output_tag`; a Text
   interior animates.
3. **Wrap-selection creation, docs page, guardrail polish.**
