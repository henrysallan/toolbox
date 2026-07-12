# Risk-fix plan (2026-07-08)

Working checklist for the six risk areas from the architecture review
([070326_architecture-review.md](070326_architecture-review.md) — full
evidence and line numbers there). Process per area: **verify** the
findings against current code (the tree has moved since the review) →
agree fix scope → implement → manual smoke check → update Status here.

Statuses: `unverified` / `confirmed` / `partially confirmed` /
`already fixed` / `fix in progress` / `fixed`.

---

## 1. Engine texture lifecycle

**Status: confirmed** (verified 07-08: post-pass releases at
evaluator.ts:956/975/983 with raw `gl.deleteTexture` at gl.ts:374; text.ts:1379
returns `state.primary` and declares OPACITY_PARAM at :721; simulation-end.ts
has no `noMaskInput` and returns `state.readTex` at :122/:141; video.ts:208
stable:false + :324 allocImage per compute, webcam same; uncacheable results
never registered for release (evaluator.ts:990-1000); **zero** dispose call
sites outside the types.ts declaration; allocTexture is unpooled.)

The claims:
- (a) Evaluator's universal opacity/mask post-passes release textures
  that belong to node `ctx.state` (Text w/ opacity < 1, Simulation End
  w/ mask wired) → use-after-free.
- (b) Uncacheable (`stable:false`) outputs are never released — Video
  Source/Webcam orphan a full-canvas texture per eval (~1GB/s VRAM churn
  at 1080p/60); same for coercion allocs, post-pass outputs, and
  `emptyClipOutput`; compute-throw leaks intermediates.
- (c) `NodeDefinition.dispose` is never called anywhere (deleted Text
  nodes leak DOM canvases; sim zones keep textures forever).
- (d) `allocImage` is not pooled — fresh `gl.createTexture` +
  `texImage2D` per call.

Fix plan:
- Per-eval allocation ledger in `RenderContext`: record allocs, move
  cached/surviving outputs out (per `ownsTextures`), bulk-release the
  rest (previous frame's uncacheable set released at start of next eval).
  Covers (b) incl. throw paths.
- Ownership flag for state-backed outputs (or post-passes never release,
  deferring to cache eviction) → (a).
- Call `def.dispose(ctx, nodeId)` in the evaluator's removed-node
  eviction loop + on backend destroy → (c).
- Free-list texture pool keyed (w, h, channels) + dev-mode live-lease
  counter → (d) and future leak detection.

Smoke: play a Video Source graph while watching VRAM; Text with
opacity 0.5 over several frames; mask into Simulation End; delete a Text
node and check document.body canvas count.

## 2. AI recipe subsystem

**Status: confirmed** (verified 07-08: no auth in either route; env-key
fallback for anonymous/errored auth at anthropic-key.ts:23-26; client
`catalog` into `buildSystem()` at generate-recipe/route.ts:58; no
maxDuration; missing key → 500 at :44; value checks are type-only
(recipe-builder.ts:113, recipe-edit.ts:198); stale-fragIds commit now at
EffectsApp.tsx:2417-2445.)

The claims:
- (a) Both routes unauthenticated; anonymous callers fall back to the
  server env `ANTHROPIC_API_KEY`; no rate limit; unbounded `history`.
- (b) Client-supplied `catalog` spliced verbatim into the system prompt
  (prompt injection / open proxy).
- (c) Param **values** from the model are never validated; bad values
  persist into saves (durable corruption).
- (d) Group-edit commit applies a stale submit-time snapshot after a
  long await — mid-flight user edits reverted, deleted group resurrected.
- (e) Edit-path `add_edge` into a param socket skips `exposedParams` →
  invisible active wire.
- (f) No maxDuration / abort / cancel anywhere in the chain.

Fix plan: require Supabase session (401), gate env-key fallback
explicitly; build catalog server-side; `vetParamValue(pdef, v)` in both
build + edit paths surfaced as repairable issues; re-derive fragment and
re-apply ops at commit time (bail with toast if group gone); mirror
exposedParams in add_edge/remove_edge; `maxDuration` + AbortSignal +
Cancel button.

Smoke: anonymous curl against the route (expect 401); mid-edit graph
mutation then commit; recipe with out-of-range scalar → repaired.

## 3. Save→load integrity

**Status: confirmed** (verified 07-08: PNG re-encode at project.ts:169/:225;
paint/file branches call `dataUrlToBitmap` unguarded (~:388/:400) while the
font branch above them IS guarded; `handleLoadProject` (EffectsApp.tsx:6501)
has finally but no catch; `updateProject` blind `.eq("id")` at
projects.ts:283, explicit updated_at bump at :270, CACHE_TTL 60min at :142;
font bundles per-param with no project-level dedup.)

The claims:
- (a) `bitmapToDataUrl` re-encodes everything to PNG (huge rows); v5
  font bundles inline per-node with no dedup; no size pre-flight in
  `saveToRow`; failed saves = toast only, no fallback/autosave.
- (b) `deserializeParams` paint/file branches call `dataUrlToBitmap`
  unguarded; `handleLoadProject` has no catch → one corrupt data-URL
  bricks the project silently (and `pushGraph` fires before the failed
  load, dirtying the save pill).
- (c) `updateProject` is a blind UPDATE (no `updated_at` CAS) on a
  60-min module cache → two tabs silently clobber each other.

Fix plan: try/catch the decode branches → degrade to null + missing-media
report (pattern exists for video/audio); catch + toast in
`handleLoadProject`, move `pushGraph` after success; store original
encoded bytes instead of PNG re-encode; project-level font-bundle dedup;
size pre-flight with .toolbox-export fallback offer; `updated_at` CAS.

Smoke: hand-truncate a data-URL in a saved row copy → load degrades with
report instead of hanging; save a project with 3 Text nodes on one local
font → row size.

## 4. Playback render-storm

**Status: confirmed** (verified 07-08: `time` useState at
EffectsApp.tsx:988, rAF `setTime` at :1560; EffectNode.tsx:46,
NodeEditor.tsx:181, ParamPanel.tsx:351 all plain unmemoized exports;
`currentTick` in the deps of onParamChange (:3843) and onAnimationChange
(:3960); edge-pruning effect at ~:4109-4140 unconditionally returns
`prev.filter(...)` on `[nodes]`.)

The claims:
- (a) `time` is React state advanced in rAF → whole shell re-renders per
  frame; NodeEditor/ParamPanel/EffectNode unmemoized; NodeEditor passes
  per-render inline handlers to `<ReactFlow>` defeating xyflow's memo
  chain → every node re-renders every frame / slider tick.
- (b) `onParamChange`/`onAnimationChange` close over `currentTick` →
  new identity per frame; `effect-node-param` window listener re-added
  60×/s.
- (c) Stale-edge-pruning effect returns a new `edges` array even when
  nothing pruned → double full-graph invalidation per drag frame,
  re-running `structFp` (deep param stringify) twice.
- (d) Engine-side: `stableStringify(params)` + `(animation)` per needed
  node per eval; O(n·e) edge scans; full `flattenGraph` + toposort every
  eval.

Fix plan (order): memo(EffectNode); `return prev` guard in pruning
effect; `currentTickRef`; useCallback the ReactFlow handlers; memoize
NodeEditor/ParamPanel/projectTimeline. Then engine: WeakMap-memoized
stringify keyed on params/animation identity; per-eval target-keyed edge
Map; flatten cache on array identity. Later (own milestone): clock out
of React state into a subscription store.

Smoke: React DevTools highlight during playback + slider drag before/
after; frame time on a 100+ node graph.

## 5. Convention drift

**Status: confirmed** (verified 07-08: fifth canCoerce copy at
EffectsApp.tsx:2638 — has math uv→scalar but NOT Transform/Displace;
inline `def.resolveInputs` socket-refresh duplication now ~10 sites
(:1641, :1742, :1815, :1876, :2606, :3008, :3171, :3388, :3612) while
graph-ops.refreshNodeSockets (:153) is never imported by EffectsApp;
createLayer (graph-ops.ts:875) and reorderLayers (:1217) take no
compositionId and find the first root Output over the whole array —
several call sites pass unscoped `nodesRef.current` (:2103, :2483, :3080).)

The claims:
- (a) Coercion table in 5 places; EffectsApp's private copy already
  missing Transform/Displace (wire-drop → search-add silently fails to
  auto-wire).
- (b) `refreshNodeSockets` re-implemented inline ~13× in EffectsApp
  (one copy already omits aux outputs).
- (c) `createLayer`/`reorderLayers` not composition-scoped → "Add
  layer"/reorder can rewire another composition's Output.
- (d) "Apply loaded project" exists 4× and diverged (suppress-flag,
  applyScene inlining).
- (e) ParamType behavior enumerated in ~7 independent lists.

Fix plan: canonicalize on `graph-validation.coercible()` + def-level
polymorphic metadata, derive all UI checks; `withUpdatedParams()`
wrapper in graph-ops replacing the 13 sites; thread `compositionId`
through createLayer/reorderLayers; single `applyLoadedProject()`;
ParamType capability registry (bigger, can trail).

Smoke: drag spline wire → pane → search "Transform" → auto-wires; add
layer with two compositions where comp B is active; each socket-refresh
trigger exercised once.

## 6. Electron hardening

**Status: confirmed** (verified 07-08 against post-auto-update code:
will-navigate still file://-only (main.js:28-32); no onHeadersReceived /
setPermissionRequestHandler / requestSingleInstanceLock anywhere in
electron/; `...process.env` still forwarded at server.js:58; before-quit
only calls stopServer() (main.js:178) — ffmpeg.js has per-session
SIGKILL (:184) but no quit-time sweep; did-fail-load retry now in TWO
places (:83, :104). NEW since review: electron/updater.js
(electron-updater from a vendored bundle) — auto-update + still-unsigned
builds needs its own look; the stray root server.js got **committed** in
the catch-up commit and should be `git rm`'d.)

The claims:
- (a) `will-navigate` only blocks `file://` → any https top-frame nav
  keeps the `toolboxNative` bridge exposed.
- (b) No CSP, no `setPermissionRequestHandler`.
- (c) `utilityProcess.fork` passes `{...process.env}` to the Next server
  → shell-exported `ANTHROPIC_API_KEY` spendable by any local process
  via the unauthenticated routes.
- (d) No ffmpeg session kill on quit/close → zombie processes +
  truncated files.
- (e) `assets.read` allowlist is lexical prefix, not realpath (symlink
  escape); no single-instance lock; unbounded `did-fail-load` retry.

NOTE: desktop auto-update + Windows support landed after the review
(`738ca2b`) — re-verify against current main.js/ffmpeg.js; auto-update
also raises the stakes on (a)/(b).

Fix plan: same-origin will-navigate guard (off-origin →
shell.openExternal); CSP via onHeadersReceived + deny-by-default
permission handler; env allowlist for the fork (+ optional per-launch
secret header on API routes); `killAllSessions()` on before-quit/close;
realpath check in assets.read; requestSingleInstanceLock; capped
did-fail-load retry.

Smoke: `location.href = "https://example.com"` from devtools (expect
external browser); quit mid-export → no orphan ffmpeg (`pgrep`);
symlink in an assets dir.

---

## Order of attack

1. **Quick wins sweep** — ✅ DONE 07-09 (one working-tree change set):
   - AI routes: Supabase session required (401), env-key fallback now only
     reachable signed-in, `maxDuration = 300`, missing-key 500→400
     (`resolveAnthropicKey` → `resolveRecipeAuth` in anthropic-key.ts).
   - electron/server.js: fork env is an explicit allowlist (PATH/HOME/
     TMPDIR/LANG/TZ + NEXT_PUBLIC_*) — shell secrets no longer reach the
     loopback server.
   - electron/preload.js: **origin gate** — toolboxNative only exposed on
     the app origin (passed via additionalArguments); the OAuth redirect
     chain keeps working but foreign pages get no bridge.
   - electron/main.js: will-navigate now same-origin-or-https-only
     (blocks file://, custom schemes, off-origin http); ffmpeg
     `killAllSessions()` on before-quit/window-all-closed (partial
     outputs unlinked).
   - Load path: paint/file decode branches degrade to null + console.warn
     on corrupt data-URLs; `handleLoadProject` has catch + flashToast;
     both load paths snapshot history only AFTER a successful deserialize.
   - Perf: `memo(EffectNode)`; edge-pruning effect returns `prev` when
     nothing pruned; `currentTickRef` stabilizes onParamChange/
     onAnimationChange identities during playback.
   - Hygiene: TrackEditor NUL separators → `\u0000` escapes (file is
     text to git/grep again); stray root server.js removed.
   - Verified: `tsc --noEmit` clean; `node --check` on all electron files;
     eslint — no new issues (3 pre-existing errors remain untouched).
   - Manual smoke still needed: desktop sign-in (OAuth chain through the
     new nav guard + preload gate), one native export + quit-mid-export,
     cloud + .toolbox load, AI recipe generate while signed in/out.
2. **CI** — ✅ DONE 07-09:
   - `.github/workflows/ci.yml`: hard gate = `npm run typecheck` +
     `npm run check` (all six check-*.mts, chained in package.json;
     `tsx` pinned as a devDependency — verified it runs under
     `npm ci --ignore-scripts`, which CI uses to skip electron/ffmpeg
     binary postinstalls). Both green locally at setup time.
   - Lint runs as a separate **advisory** job (`continue-on-error`).
     Repo-wide lint was 76,952 problems / 1,604 errors; after ignoring
     built artifacts (export-template dist, public/export-template,
     electron/vendor, dist-electron) and allowing CJS require in
     electron/**, it's 170 problems / 127 errors — almost all the React 19
     hooks rules (`refs during render` ×75, `setState in effect` ×33)
     tripping on the codebase's ref-mirror pattern. Flip the job to
     blocking after that cleanup (naturally pairs with the area-4
     clock-store milestone, which removes most ref mirrors).
   - 07-12 UPDATE: the lint job is now **blocking via a ratchet**
     (`npm run lint:ratchet`, scripts/lint-ratchet.mts): per-file error
     counts are baselined in scripts/lint-baseline.json (134 errors / 34
     files at capture) and CI fails only when a file gains errors beyond
     its allowance — new errors can't hide behind unrelated fixes, and
     the red-✗-on-every-push problem is gone. After fixing errors, tighten
     with `npm run lint:ratchet -- --update` (commit the baseline). At
     zero, drop the ratchet for plain `npm run lint`. Warnings never gate.
3. **Engine texture lifecycle (area 1)** — ✅ core landed 07-09:
   - `NodeOutput.ownsTextures?: false` (types.ts): declared by nodes whose
     output textures live in ctx.state. Flagged after a full audit of all
     27 stable:false nodes: **Text, Cursor, Simulation Start/End** (image
     branches). Everything else returns fresh allocs or CPU values
     (dither's state.tex is an internal temp, not returned; hand-tracker's
     primary is a CPU spline; particle values are excluded by kind).
   - Post-passes (universal mask/opacity) now release originals only when
     evaluator-owned — fixes the use-after-free (Text+opacity, and since
     schema v6 freed Text's `mask` for the universal matte, Text+mask too;
     Sim End+mask). Replacements are tracked and correctly owned.
   - **Transient release**: uncacheable nodes' owned output textures are
     collected per eval and released at the start of the NEXT eval on the
     same cache (WeakMap-keyed; split-viewport/offline caches independent).
     Kills the ~16MB/frame video/webcam orphaning and the per-frame
     emptyClipOutput/post-pass-product leaks.
   - **dispose() finally runs**: end-of-eval sweep of ctx.state keys
     (`<type>:<nodeId>` convention) against the pre-flatten id set — calls
     def.dispose for deleted nodes then deletes leftover keys. Engine-
     internal `__…__` keys and `sim-zone:<zoneId>` are untouched.
     `disposeAllNodeState()` exported; EffectsApp runs it on backend
     teardown (resolution change/unmount) so DOM canvases/media elements
     don't outlive the GL context.
   - Verified: tsc clean, all 6 check scripts green, 0 new lint issues.
   - Manual smoke needed: VRAM flat while a Video Source plays
     (Activity Monitor GPU / about:gpu); Text with opacity 0.5 and with a
     mask wired stays correct over many frames; mask into Simulation End;
     delete a Text node → its hidden canvas leaves document.body; sim
     zones keep feeding back; resolution change with Text in graph.
   - Deferred (follow-ups): coercion-temp + compute-throw intermediates
     (full alloc ledger), texture free-list pool (perf), sim-zone state
     teardown when a zone is deleted, audit of state-owning nodes that
     lack a dispose.
4. **AI value vetting + commit race (area 2 remainder)** — ✅ landed 07-09:
   - `vetParamValue(pdef, v)` in engine/node-catalog.ts (next to
     SETTABLE_PARAM_TYPES): per-type shape checks (finite numbers, vec
     arity, enum membership — skipped for open-world `control:"font"`
     enums — hex-or-RGBA colors, string length cap), hard-range clamping
     for scalars (softMax stays soft, like the sliders). Wired into BOTH
     `buildRecipe` and `applyRecipeEdit`'s applyParams; rejections surface
     as `BAD_PARAM_VALUE`, added to both clients' blocking sets so the
     repair loop fixes them. Closes the "corrupt values persist into
     saved projects" hole.
   - `applyParams` (edit path) also emits a soft `PARAM_KEYFRAMED` note
     when a static value is set on an animated param (spec §7's
     "surface a note rather than a silent no-op").
   - Edit-path `add_edge` into `in:param:<name>` now mirrors the
     builder's exposedParams handling — no more invisible-but-active
     wires. (remove_edge deliberately does NOT unexpose: exposed-but-
     unwired is a legitimate state.)
   - Commit race: `handleEditGroup` re-derives the fragment at commit
     time and bails with a toast unless it's identical to the submit-time
     fragment (node `data` identity + edge-id sequences — tolerates pure
     canvas moves, catches param/structure/keyframe edits, deletion, and
     panel retargeting). `handleGenerateRecipe` falls back to root when
     its target scope was deleted mid-flight (no more dangling parentId).
   - check-builder.mts grew a bad-values section (string→scalar,
     Infinity, non-option enum, clamp-to-max, valid-sibling-survives) —
     runs in CI via `npm run check`.
   - Verified: tsc clean, all 6 check scripts green, no new lint issues.
   - Deferred: server-side catalog build (kills the prompt-injection
     vector properly), rate limiting, AbortSignal/Cancel button +
     streaming, generate/edit route unification (riskfix §2 fix plan).
5. **Save integrity (area 3 remainder)** — ✅ landed 07-10:
   - **Original bytes, not PNG re-encode**: new lib/image-bytes.ts
     WeakMap registry (decoded ImageBitmap → source Blob). Registered at
     every `file`-param import site (panel picker, canvas drop, image-gen
     drop) AND on deserialize, so loads AND re-saves round-trip the
     original encoded bytes; serialize falls back to PNG re-encode only
     for unregistered bitmaps (paint snapshots etc.). A 3MB camera JPEG
     now costs ~4MB of base64 instead of ~40MB.
   - **Font-bundle dedup**: serializeGraph threads a per-save family set
     through serializeParams — one `__fontbundle` sibling per family per
     save (registration is global on load, so params resolve by name).
     No schema change; deserializer untouched.
   - **Size pre-flight** in saveToRow: >50MB throws with "use File →
     Save to File" before hitting the 30s statement-timeout hang; >16MB
     warns. Save-failure catch sites now surface the real error message
     instead of a bare "save failed".
   - **updated_at compare-and-swap**: updateProject takes
     expectedUpdatedAt and reports `conflict` when the row moved (nothing
     written); EffectsApp tracks `currentProject.updatedAt` from load and
     each save, and shows "saved from another window — reload or Save As"
     on conflict. rename/visibility (which also bump updated_at) return
     the new stamp and the editor mirrors it, so they can't false-
     conflict the next save. Overwrite-by-name keeps last-writer-wins
     (that row was never loaded here); fresh inserts are unguarded until
     first load (acceptable).
   - Verified: all 6 check scripts green; tsc clean except one
     pre-existing error from in-flight MenuBar MCP work (not this
     change); no new lint issues.
   - Manual smoke: save a project with a big JPEG → inspect row size;
     open the same project in two tabs, save in both → second gets the
     conflict message; rename then save → no false conflict; .toolbox
     round-trip of an image keeps original bytes.
   - Deferred: autosave / beforeunload guard; per-upload custom-font
     (FontParamValue) dedup; envelope-driven .toolbox asset extraction
     (area 7 in this doc).
6. **Coercion single-source + socket-refresh consolidation (area 5)** —
   ✅ landed 07-10:
   - `editorCanCoerce(src, tgt, targetDefType?, targetHandle?)` in
     engine/graph-validation.ts: `coercible` + the polymorphic defType
     exceptions (Math uv→scalar, Copy-to-Points instance incl.
     text_instance, Displace/Transform source), ONE copy. NodeEditor's
     isValidConnection + splice canCoerce and EffectsApp's wire-drop
     auto-connect now all call it — the EffectsApp copy's missing
     Transform/Displace rows (search-add auto-wire silently failing for
     spline/points) are fixed by construction. Devguide §Coercions
     updated.
   - `withUpdatedParams(node, nextParams)` in graph-ops wraps
     refreshNodeSockets; replaced 10 inline resolveInputs/withMaskInput
     copies in EffectsApp (proximity slots, math + copy-to-points
     promotions — the latter was the drifted copy missing aux outputs —
     sim-zone partner mirror, and the six effect-node-toggle socket-adder
     branches). Left alone by design: the connectedTypes/ResolveCtx path,
     onParamChange's conditional resolve, and four sites inside
     structural-edit flows (merge-selection / shelf / splice / onAddNode)
     that Phase-3 graph-ops extraction will absorb.
   - Verified: tsc fully clean, all 6 check scripts green, lint error
     count unchanged vs stashed baseline (all pre-existing).
   - Smoke: drag spline wire → pane → search "Transform"/"Displace" →
     auto-wires now; wire UV into Math scalar; image onto Copy-to-Points
     instance; merge "+ layer", autolayout/expression/queue/collect "+",
     color "+ output"; sim-zone kind flip mirrors partner.
7. **Render-storm work (area 4)** — cheap fixes ✅ landed 07-10; clock
   store spec'd as its own milestone:
   - memo(NodeEditor) + memo(ParamPanel) (EffectNode was done in the
     quick-wins sweep); EffectsApp stabilized every prop feeding them:
     `projectTimeline` + `queueRenderInfo` useMemo'd, onSelectNode /
     onPanePointer / onNavigateScope / onSeekTick / panel onSelectNode
     useCallback'd. During playback the whole xyflow tree and the panel
     chrome now sit out of the per-frame re-renders (ParamPanel still
     re-renders while PLAYING via its currentTick prop — that's the
     clock-store milestone).
   - NodeEditor's five per-node ReactFlow handlers (dragStart/drag/
     dragStop/contextMenu/doubleClick) now have never-changing
     identities via effect-refreshed ref bodies — node drags no longer
     re-render every NodeWrapper on the canvas.
   - Verified: tsc clean, 6/6 checks green, lint error count back to the
     pre-existing baseline (the ref-shell bodies refresh in an effect,
     not during render, so no new hook-rule hits).
   - Smoke: React DevTools highlight during playback (only clock
     consumers paint), node drag on a big graph (only the dragged node's
     wrapper), slider drag, context menu / double-click dive, alt-drag
     duplicate, cmd-drag detach, splice highlight during drag.
   - **The structural fix is specced**: 071026_clock-store.md —
     subscription store + imperative rAF driver, consumer-by-consumer
     migration, invariants (tick model, loop wrap + sim re-seed, autokey
     tick source, offline determinism), 4-step plan with step 2 as the
     one high-blast-radius commit.
8. Devguide refresh at the end of each area (schema v5, monolith sizes,
   coercion count, utilityProcess, ownership rules).
