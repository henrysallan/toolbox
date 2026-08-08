# Toolbox — architecture & risk review (2026-07-03)

Six parallel deep-dive reviews over the major subsystems: EffectsApp.tsx,
the engine core (evaluator/gl/coerce), persistence + undo history, the
Electron shell, the AI recipe subsystem, and the editor UI layer
(NodeEditor/ParamPanel/param-controls/TrackEditor/graph-ops). All findings
below carry file:line evidence from the review; line numbers reflect the
working tree on 2026-07-03.

## Verdict

**The architecture is not set up wrong.** The load-bearing decisions are
right and have held under fast growth: engine self-containment (invariant
#1) is intact, graph-ops.ts is genuinely pure, there is exactly one
serializer for cloud and .toolbox, the Electron IPC bridge is intent-level
with no command injection, and the AI recipe trust boundary is
structurally well designed (builder whitelist → whole-graph validator →
repair loop).

What's wrong is that **conventions are outrunning enforcement**. The
codebase runs on documented invariants ("release what you alloc", "add
coercions in both places", "structural edits go in graph-ops") with zero
mechanical enforcement — no CI, no tests wired up, no dev-mode assertions
— and at the current growth rate the invariants are now visibly breaking:
the coercion table has drifted across five copies, the evaluator itself
violates the texture-ownership rule, `dispose()` is never called, and
EffectsApp re-implements graph-ops helpers 13 times. Plus one subsystem
(AI routes) shipped with a real external exposure.

---

## Tier 1 — fix now (real bugs / live exposure)

### 1. Engine texture lifecycle is broken in three ways

The most serious correctness findings in the review.

**(a) Use-after-free by the evaluator's own post-passes.** The universal
mask/opacity passes release `result.primary.texture` after replacing it
(`evaluator.ts:951-953`, `:969-983`) — but several nodes return
*persistent `ctx.state` textures* as primary. Text with `opacity < 1`
gets its state texture `gl.deleteTexture`'d (text.ts:1253 returns
`state.primary`); Simulation End with a mask wired gets its ping-pong
feedback texture deleted (`simulation-end.ts:139-145` + it doesn't set
`noMaskInput`). `releaseTexture` is a raw delete (`gl.ts:374-376`), no
refcount.

**(b) Uncacheable outputs are never released.** `stable:false` nodes that
alloc per compute — Video Source (`video.ts:324`), Webcam
(`webcam.ts:232`) — orphan a full-canvas RGBA16F texture (~16MB at 1080p)
*every eval*: ~1GB/s of VRAM churn during playback, reclaimed only when JS
GC happens to collect the wrapper object. Same class: coercion allocs
(`coerce.ts:82,93`, no identity cache), post-pass outputs on uncacheable
nodes, `emptyClipOutput` per frame (`clips.ts:144-147`), and intermediates
when compute throws (the catch at `evaluator.ts:997-1011` only evicts the
previous cache entry).

**(c) `NodeDefinition.dispose` has zero call sites.** The eviction loop
(`evaluator.ts:1069-1074`) releases cached textures but never calls
`def.dispose`; neither does node deletion nor backend teardown. Deleted
Text nodes leak canvases appended to `document.body` (`text.ts:276-278`);
sim zones keep state textures forever.

**Fix (one mechanism covers a, b, and e):** give `RenderContext` a
per-eval allocation ledger — record every alloc, move a node's surviving
cached outputs out of the ledger (per `ownsTextures`), bulk-release the
remainder at end-of-node / start-of-next-eval. For (a) specifically, add
per-output "owned by state" marking (or have post-passes never release,
deferring to cache eviction). For (c), call
`getNodeDef(type)?.dispose?.(ctx, id)` in the eviction loop and in
`EngineBackend.destroy()`.

Also: the "texture pool" is not a pool — `allocImage` does
`gl.createTexture` + `texImage2D` every call (`gl.ts:239-306`). A
free-list keyed by (w, h, channels) kills the churn and gives you a live
lease counter for dev-mode leak detection.

### 2. AI recipe routes are an unauthenticated LLM proxy (web) with prompt injection

- Neither `/api/generate-recipe` nor `/api/edit-recipe` checks auth;
  `resolveAnthropicKey` (`anthropic-key.ts:26`) silently falls back to the
  server env `ANTHROPIC_API_KEY` for anonymous callers — anyone can POST
  and burn the key. No rate limiting, unbounded `history` accepted.
- The client-supplied `catalog` string is spliced verbatim into the
  system prompt (`generate-recipe/route.ts:58` → `recipe-prompt.ts:117-127`)
  — arbitrary instructions in, completion read back through the free-text
  tool fields. This is a general-purpose Claude proxy on your key.
- No `maxDuration`, no streaming, no AbortController anywhere in the
  chain; the panel has no cancel and `busy` sticks on a hung request.

**Fix:** require a Supabase session (401 otherwise); gate the env-key
fallback explicitly (desktop loopback / owner id) instead of
"anyone without a cookie"; build the catalog **server-side** (the
check-*.mts scripts prove the node registry loads under Node with ~20
lines of DOM stubs — the route comment claiming otherwise is wrong);
add `export const maxDuration`, an AbortSignal from panel → client →
fetch, and a basic rate limit.

### 3. Save→load integrity loop can permanently brick projects

Two findings that compound into the worst user-facing failure mode:

- **Cloud rows bloat without bound.** `bitmapToDataUrl` re-encodes every
  image to PNG (`project.ts:155-163`) — a 3MB JPEG becomes ~40MB of
  base64. New v5 font bundling inlines the full TTF **per node, no dedup**
  (`project.ts:245-274`; the .toolbox writer dedups by hash, the cloud
  path doesn't). No size pre-flight in `saveToRow`. Oversized saves hit
  the Supabase statement timeout (the code already knows:
  `logProjectWriteError`, `projects.ts:176-210`) → user gets a toast, no
  fallback, no beforeunload guard, no autosave.
- **The load path can't tolerate a bad byte.** The `paint`/`file`
  branches of `deserializeParams` call `dataUrlToBitmap` with no try/catch
  (`project.ts:377-394`); `handleLoadProject` has no catch at all
  (`EffectsApp.tsx:6285-6354`). One truncated data-URL = project never
  opens again, error only in the console. (The .toolbox path already does
  this right: per-param degradation + toast.)
- Bonus: two tabs silently clobber each other — `updateProject` is a
  blind UPDATE with no `updated_at` compare-and-swap, on top of a 60-min
  module-level cache (`projects.ts:142,254-290`).

**Fix:** guard the decode branches (degrade to null + missingMedia-style
report — pattern exists at `project.ts:429-444`); add catch + toast to
`handleLoadProject` and move its `pushGraph` after success; store original
encoded bytes instead of PNG re-encode; dedup font bundles project-level;
pre-flight serialized size and offer .toolbox export on failure; add
`updated_at` CAS to `updateProject`.

### 4. AI output values are unvalidated and the edit commit races user edits

- The builder vets param *names* and *types*, never **values**
  (`recipe-builder.ts:107-119`, `recipe-edit.ts:191-204`);
  `validateGraph` checks structure only. A model can set a scalar to
  `"abc"`, an enum to a non-option, or a number to Infinity — and it
  **serializes verbatim into saves**, i.e. durable project corruption.
  Fix: a ~40-line `vetParamValue(pdef, v)` (finite + clamp to min/max,
  enum membership, vec arity, string cap) used by both build and edit
  paths, surfaced as a repairable `BuildIssue`.
- The group-edit commit uses a fragment snapshot taken at submit, applied
  30–180s later against live refs (`EffectsApp.tsx:2278` → `:2303-2309`).
  User edits inside the group mid-flight are silently reverted; deleting
  the group mid-flight **resurrects it**; nothing stops the user editing,
  and the commit fires even if the panel was closed. Fix: re-derive the
  fragment at commit time and re-apply the validated *ops* (they're pure
  and cheap) or bail with a toast if the group changed/vanished; drop the
  commit if the edit target no longer matches.
- `add_edge` in the edit path skips the `exposedParams` mirroring the
  builder does (`recipe-edit.ts:249-265` vs `recipe-builder.ts:144-147`)
  → an invisible-but-active wire driving a param with no visible handle.

### 5. Electron: navigation + CSP + env forwarding

The bridge itself is solid (verified: no ffmpeg arg injection, dialog-owned
paths, contextIsolation/sandbox on, loopback-only server, no keys in the
packaged bundle). The gaps:

- `will-navigate` only blocks `file://` (`main.js:27-32`) — top-frame
  navigation to any https origin is allowed **and the preload bridge
  rides along**. Fix: same-origin check, off-origin → `shell.openExternal`.
- No CSP, no `setPermissionRequestHandler` anywhere — one XSS in the app
  (which renders user project data, SVGs, AI output) = full native
  surface. Fix: restrictive CSP via `onHeadersReceived`, deny-by-default
  permissions.
- `utilityProcess.fork` passes `{...process.env}` to the Next server
  (`server.js:57-62`) — launch from a shell with `ANTHROPIC_API_KEY`
  exported and any local process can spend it via the unauthenticated
  routes (see risk 2). Fix: explicit env allowlist; optionally a
  per-launch secret header so only the app's renderer can hit the API.
- Zombie ffmpeg: nothing kills in-flight encode sessions on quit/close
  (`ffmpeg.js` sessions map; `main.js:156-161` only stops the server) —
  orphaned processes + truncated files. Fix: `killAllSessions()` on
  before-quit/close.
- `assets.read` allowlist is a lexical prefix check, not realpath
  (`assets.js:105-118`) — symlink escape. Fix: `fs.realpath` both sides.
- Lifecycle: no single-instance lock, no EADDRINUSE handling, unbounded
  `did-fail-load` retry every 500ms (`main.js:93-95`).

---

## Tier 2 — structural (why the app "feels" like it's outgrowing itself)

### 6. Playback re-renders the entire app 60×/second

`time` is React state advanced in a rAF loop (`EffectsApp.tsx:1546`), so
every frame re-renders the 9.6k-line shell — and none of the heavy
children stop the cascade: NodeEditor, ParamPanel, EffectNode are all
unmemoized, and NodeEditor hands `<ReactFlow>` a dozen per-render inline
handlers, which defeats xyflow's internal memo chain for **every node on
the canvas** (verified against @xyflow internals). A 100-node graph pays
~100 full component renders per frame during playback *and* during every
slider drag. Additional churn: `onParamChange` identity changes every
frame (closes over `currentTick`), so a window listener is
removed/re-added 60×/s; the stale-edge-pruning effect returns a new
`edges` array even when nothing was pruned (`EffectsApp.tsx:3934-3955`),
doubling full-graph invalidation per drag frame and re-running `structFp`
(which deep-stringifies every param of every node).

**Fix in escalating order:** (1) `memo(EffectNode)` + `useCallback` the
ReactFlow handlers + `return prev` guard in the pruning effect +
`currentTickRef` — afternoon-sized, huge payoff; (2) memoize
NodeEditor/ParamPanel/projectTimeline; (3) the real fix: move the clock
out of React state into a subscription store (rAF drives `renderFrame`
imperatively; only PlaybackBar/TrackEditor subscribe).

Engine-side per-frame CPU has the same flavor: `stableStringify` of every
param + every keyframe of every needed node per eval (`evaluator.ts:430,
439`), O(n·e) edge scans (`:658-662,703-707`), full `flattenGraph` +
toposort every eval (the early-out never fires because v4 wraps roots in
layer chains). Fix: WeakMap-memoize stringify on params/animation object
identity (the identity contract already holds — edits replace objects),
one target-keyed edge Map per eval, cache flatten on array identity.

### 7. Duplicated-by-convention invariants have started to drift (confirmed)

- **Coercion table: five copies** — coerce.ts (truth),
  graph-validation.ts, NodeEditor `isValidConnection` (:1082) and
  `canCoerce` (:762), and a fifth private copy in EffectsApp
  (`:2497-2531`) which is **already missing Transform/Displace** — so
  dragging a spline/points wire onto the pane and picking Transform from
  the search popup silently fails to auto-wire, while dropping on the node
  succeeds. Fix: canonicalize on `graph-validation.coercible()`
  (engine-side, export-safe) + def-level polymorphic metadata; derive all
  UI checks from it.
- **`refreshNodeSockets` re-implemented inline 13×** in EffectsApp
  (1621, 1687, 1746, 2464, 2865, 3028, 3243, 3434, 3610, 4037, 4064,
  4092, 4120) while the real one sits in graph-ops.ts:151. The
  copy-to-points copy already omits aux outputs. Fix: one
  `withUpdatedParams()` wrapper; replace all sites.
- **"Apply loaded project" exists 4×** and diverged (suppress-flag
  handling differs between cloud load and file load; `applyScene`
  re-inlined twice). Fix: one `applyLoadedProject()`.
- **Composition scoping missed in graph-ops:** `createLayer` (:885) and
  `reorderLayers` (:1223) find "the" root Output over the *whole* node
  array while EffectsApp passes unscoped arrays — in a multi-composition
  project, "Add layer" / reorder can rewire **another composition's
  Output**. Silent graph corruption. Fix: thread `compositionId` like
  `getLayerChain` already does.
- ParamType behavior enumerated in ~7 independent lists
  (keyframes/graph-helpers/param-controls/ParamPanel ×2/project.ts/
  export-manifest). Fix: a ParamType capability registry
  (`Record<ParamType, {render, keyframable, inline, controlSupported,
  serialize}>`).

### 8. EffectsApp.tsx (9,609 lines) — decompose along existing seams

~20 distinct subsystems in one component (74 useState / 49 useRef / 42
useEffect / 121 useCallback). It communicates internally through refs,
which is exactly what makes extraction mechanically safe. The reviewed
plan, ordered by regression risk (no tests — each phase ends with a
manual smoke script):

- **Phase 0 (hours):** the hot fixes from risks 4/6 above + synchronous
  export-busy ref (`recordingRef` lags a render — double-click Export
  starts two exports, `:5134` vs `:5242`) + `viewportSplit` missing from
  the eval-effect deps (toggling split while paused shows a blank second
  canvas) + one `selectNode()` helper (selection is hand-synced in ~8
  places and has already diverged between load paths).
- **Phase 1 (~1,400 lines out, no logic change):** module helpers,
  leaf components, viewport gesture hooks; replace the 13 socket-refresh
  copies.
- **Phase 2:** self-contained hooks — `useAiRecipePanel`,
  `useCompositions`, `useProjectPersistence` (build
  `applyLoadedProject` here), `useExportDrivers` (add an input-blocking
  scrim during offline export: today the graph is **fully editable
  mid-export** and the encoder captures the mutations).
- **Phase 3:** structural editing → graph-ops as pure functions
  (`spliceNodeIntoEdge`, `mergeSelection`, `addShelfNode`,
  `promoteNodeForIncomingType` — the promotion logic is currently
  triplicated).
- **Phase 4:** view split (`ViewportPane`, `DockPanel`, `AppModals`).
- **Phase 5 (last, highest blast radius):** `useRenderLoop` — the clock
  store from risk 6.

Target: ~3–3.5k lines of state + wiring, structural mutations all pure
and testable.

### 9. Undo history and session stash pin unbounded native memory

- Snapshots are shallow refs (sound design — structural sharing), but
  they *pin*: every project load pushes the entire outgoing project into
  history (`EffectsApp.tsx:6294, 6506`) — browse 50 projects, all 50 stay
  resident. Paint undo stores full uncompressed ImageData per stroke
  (4.2MB at 1024², 33MB at 4K → 1.6GB at MAX_HISTORY=50).
- Correctness rests on never mutating `node.data` in place — honored
  today, but in-place mutation of *fresh* nodes is an established pattern
  and nothing distinguishes fresh from live. Fix: dev-mode
  `Object.freeze` in `getGraphSnapshot` makes violations throw instantly.
- The editor-session stash survives auth changes (resurrects the previous
  account's project) and undo doesn't ride it (docs round-trip silently
  drops the undo stack). Fix: clear on auth change, consume-on-read,
  byte-budget history instead of entry-count.

### 10. Schema growth is under-defended

- **No forward-version guard:** a v6 save opened by a v5 client loads
  silently, drops unknown fields, and a re-save rewrites the row as v5 —
  permanent loss. (.toolbox guards the container version but not
  schemaVersion.) Fix: throw a typed "newer version" error.
- Additive params rely on scattered `?? default` in compute; fix with a
  def-driven default fill in the load loop (kills the class).
- Live drift found: `active2` is documented as persisted
  (`graph.ts:78-82`) but never serialized; `linkedParams` likewise.

---

## Quick wins (each ≤ a day, most ≤ an hour)

1. Delete stray root `server.js` (byte-identical dup of electron/server.js).
2. Edge-pruning effect: `return prev` when nothing pruned (3 lines).
3. `export default memo(EffectNode)`.
4. `currentTickRef` mirror; drop `currentTick` from callback deps.
5. Synchronous `exportBusyRef` guard (copy the `relinkBusyRef` pattern).
6. Add `viewportSplit` to the eval-effect deps.
7. catch + toast in `handleLoadProject`; try/catch the paint/file decode
   branches.
8. Auth check + `maxDuration` + env-key gating on both AI routes.
9. Env allowlist in the `utilityProcess.fork`; origin check in
   `will-navigate`.
10. `killAllSessions()` for ffmpeg on before-quit.
11. TrackEditor.tsx contains **raw NUL bytes** in the `selKey` separator
    (~line 168) — git treats the file as binary, grep misses it. Replace
    with `""` escapes.
12. Wire the existing check-*.mts scripts into `package.json` +
    a minimal GitHub Actions workflow: `lint && tsc --noEmit && checks`.
13. Dev-mode `Object.freeze` in `getGraphSnapshot`.
14. Fix devguide staleness (below).

## Guardrails (the actual answer to "are we set up wrong")

The recurring root cause across all six reviews is *unenforced
convention*. Cheapest enforcement first:

1. **CI now** — no test runner needed to start: `eslint` + `tsc --noEmit`
   + the six existing check-*.mts scripts (they're good tests guarding
   the AI trust boundary; today nothing runs them).
2. **Single-source the drift-prone tables** (coercions, ParamType
   capabilities, socket refresh) so drift becomes impossible rather than
   discouraged.
3. **Dev-mode assertions for the resource invariants**: texture lease
   counter with end-of-eval leak warning; frozen history snapshots;
   a `dispose`-called check.
4. **When a runner lands** (vitest is the obvious fit), the already-pure
   modules — graph-ops, layout solver, keyframes, graph-validation,
   project serialize round-trip — are immediately testable; the check
   scripts convert nearly verbatim.

## Devguide corrections needed (061226_devguide.md)

- `CURRENT_SCHEMA` says 4; code is 5 (project.ts:52).
- "EffectsApp ~7.2k / ParamPanel ~5.6k" → 9.6k / 2.5k, and
  param-controls.tsx (4.7k) is the new second monolith.
- Coercion mirror count "×2 places" → 5 copies exist (or ideally,
  fix the duplication and document the single source).
- Embedded server mechanism: `ELECTRON_RUN_AS_NODE` → `utilityProcess.fork`.
- Text's "mask input" note: Simulation End & friends returning state
  textures interact with universal opacity/mask — document the ownership
  rule once the ledger/flag fix lands.
