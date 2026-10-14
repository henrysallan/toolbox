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
| `npm run check:readback-async` | ~10s | `EngineBackend.readImagePixelsAsync` (PBO + fence) is byte-identical to the sync readback, never hands back a stale frame with one read in flight, and cancel/destroy leave GL clean. Needs Electron (SwiftShader). |
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
  trust boundary. `check-mcp` also covers the multi-instance hub/proxy
  handoff (091126_mcp-proxy.md): a second server on the same port must
  proxy tool calls through the first and take over when it exits. Since
  2026-09-20 it also guards the agent-facing shapes that MCP feedback
  found missing: `float_curve` params are settable as `[{x, y}]` and print
  id-free with the identity default omitted (the recipe half is in
  `check-builder`); `get_node_data` always reports `attrNames` /
  `subpathAttrNames` gathered over the whole value; `insert_recipe` and
  `edit_group` forward `dry_run`; and the source tools read the PAIRED
  editor's tag — `git archive v<ref>` locally, the GitHub tarball as the
  fallback — for `search_source` too, not just `get_node_source`. The
  tag test needs either the `v0.5.7` tag fetched or network; with neither
  it asserts the local-fallback wording instead. That `set_param` /
  `set_keyframes` bump `rev` is editor-side (mcp-handlers.ts) and not
  covered offline: set a param over MCP and `get_graph({since})` must
  report the change, not `unchanged`.
- `check-persistence`, `check-graph-ops`, `check-fragment-roundtrip` — save
  format and structural graph edits.
- `check-node-presets` — user node presets ("Save as Preset"): fragment
  round trip + the untrusted-JSON sanitize gate.
- `check-kernel`, `check-sim-preroll` — the vector kernel and simulation
  pre-roll predicate.
- `check-image-trace` — Image Trace SVG→spline mapping (image-pixel Y-down
  → canvas01 via `aspectUncorrectY`, fill color + driver) and the vendored
  VTracer WASM glue. Potrace (`esm-potrace-wasm`) is browser-only — Node
  ESM hits `__dirname`/`require("node:fs")` — so this gate does not
  live-import it.
- `check-profiler` — the perf collector: ring-buffer wrap, recompute-reason
  classification, GPU results resolving into already-committed frames.
- `check-output-gating` — `NodeDefinition.gatesOutputs`. See §5.
- `check-scalar-fp` — wired scalar inputs fingerprint by value, not producer identity (`wiredInputFp` in evaluator.ts). Floor/step/gate hold still across frames while an animated ancestor moves; non-scalars stay identity-keyed.
- `check-tracker` — motion-tracking kernel (ZNCC + LK + homography/ESM +
  smoothing/repair) and `track_data` identity-token fingerprinting. See
  specdocs/082226_motion-tracking.md M0.
- `check-video-frame-cache` — Video Source scrub cache, pure half: the
  byte-budgeted frame LRU, window planner (GOP widening, sliding-job
  accept/slide rules), sequence decode-ahead planner, and the paused /
  playing draw planners whose decision the fingerprint stamps. The
  WebCodecs/GL/IPC half is browser-only — drive it live
  (specdocs/090526_video-scrub-optimizations.md §Results describes the
  harness); `scripts/bench-video-seek.cjs` measures raw seek/decode costs.
- `check-lfo` — the LFO's timebase (2026-09-20): unwired it rides the
  scoped playhead (`ctx.time`, which the evaluator derives from the tick —
  never wall-clock, so it was always scrub-exact; the old `stable: false`
  flag meant "uncacheable", not "nondeterministic"); a wired `clock`
  replaces it (seconds, or frames ÷ fps per `clock_unit`) and the wave is
  a pure function of that value; sawtooth at amplitude 0.5 / offset 0.5
  is a 0→1 ramp per period; negative clocks wrap. The def is now
  cacheable with the tick in `fingerprintExtras` and flagged
  `tickDriven`, which the Iterate / Time Offset interior hash reads so an
  interior made of an LFO (or Stagger) alone still re-evaluates per frame
  — that hash previously counted only `stable: false` defs as
  time-driven. The interior half is a live-app question (an LFO inside a
  Time Offset must keep moving).
- `check-modulate-points` — the attribute sources on Modulate Points
  (2026-09-20): `scale_attr` multiplies the per-point scale by a point
  column (arity-1 channel / dotted component / built-in broadcasts to
  x and y; an arity-2 channel scales the axes separately), `rotate_attr`
  adds value × `rotate_attr_amount` radians (default 2π), both compound
  with the uniform inputs and the existing per-point values, a blank or
  missing column is ignored, and the no-op fast path returns the input
  object itself. The image-field path (GL readback) is not covered.
- `check-scene-time` — Scene Time's stepped mode ("change by `step_size`
  every `step_seconds` / `step_frames`, per `unit`; `scale` is ignored) and
  the node's saved-param migrations: a pre-2026-09-19 save, where
  `step_size` was the step duration and `scale` converted time units to
  output units, must render identically after the split (duration = old
  step_size, size = old step_size·scale), in either unit and any mode, and
  migrate idempotently; the ping-pong `period → rate → period_frames` fold
  still runs from its new home next to the def. Also the `custom` easing:
  the ramp samples `easing_curve`, clamps, and blends with
  `ease_intensity` exactly like a named curve, in both eased modes. And
  the `sawtooth` mode (2026-09-20): a min→max ramp over `period_frames`
  that resets hard, sharing ping-pong's controls and hiding unit / scale /
  offset — with the defaults, the plain 0→1 loop driver.
- `check-float-curve-socket` — the `float_curve` socket type
  (091926_float-curve-socket.md): `paramSocketType` maps it (so every
  float_curve param is exposable), `coercible` is identity-only, the clip
  and group-shell defaults are the identity ramp, Switch and Time Offset
  carry it, the wire colour exists; the Float Curve node's `curve` aux is
  the sanitized authored curve; the Expression node's `out_type: curve`
  sweeps `u` over 65 samples, clamps y, binds input variables, and emits
  the identity ramp on error; `validateGraph` accepts curve → exposed
  float_curve param and rejects scalar → it; and a real `evaluateGraph`
  run drives Scene Time's custom easing from each producer through the
  exposed-param path. The editor's dashed handle and the read-only on-node
  curve widget are live-app questions.
- `check-grain` — Grain v2 (specdocs/091626_grain-node-v2.md), the pure
  half: the temporal moving-average kernel keeps unit variance at every
  fractional grain time (`Σw² = 1`, the anti-breathing rule — a plain lerp
  of two noise frames dips to 0.5), loops wrap seamlessly, the cache key is
  one value per project frame while the kernel is hard, the CPU mirror of
  the shader's hash → Gaussian draw has the right mean / std /
  decorrelation, and saved nodes migrate to `classic`. The GLSL itself
  compiles under `check:shaders`; the look is a live-app question.
- `check-node-facts` — every visible node carries a well-formed `facts`
  block (the NodeFacts mini-schema behind `description`: per-socket space,
  attributes read/written, gotchas) and the catalog DSL renders it. It
  cross-checks socket refs against the def and attribute names against the
  node's source. Author with the `node-facts` skill; apply with
  `scripts/apply-node-facts.mts`. See specdocs/090626_node-facts.md.
- `check-node-layout` — the pure wire-aware layout behind right-click
  Tidy / Align / Distribute, the `tidy` MCP tool and agent insertion
  placement (specdocs/090626_tidy-layout.md): wires run forward, a lone
  wire comes out horizontal, fan-in keeps socket order with the consumer
  in the middle, pillars pin first/last column, zones and frames stay
  compound, nothing overlaps, and — what the agent loop relies on — a
  tidy graph tidies to itself. Boxes are estimates here; the live editor
  feeds measured sizes and real handle offsets, so a layout that looks
  off in the app but passes the gate is an adapter (node-layout-graph.ts)
  question, not a solver one.
- `check-export-manifest` — `buildExportManifest`'s reachability seed
  (the live link / exported-app control panel). The viewport-active
  terminal can be a STRUCTURAL node — a Layer's Group Output when the
  author saved while previewing inside the layer — and flatten dissolves
  those, so seeding the walk with that id used to reach nothing: every
  control vanished from `/live` while the canvas still rendered (the
  evaluator remaps before its own flatten; the builder didn't). The gate
  builds a Layer whose Group Output is active and asserts the interior
  controls survive; `manifest.outputNodeId` must stay the original id.
  It also asserts per-node slider range overrides (`paramOverrides`
  min / max / softMax, the right-click "Slider range" editor) land on the
  scalar control's def — full and partial overrides, stock def untouched —
  because the live panel renders `ParamControl` from `control.def` alone.
  And the per-layer Merge controls (`mlayer:<param>:<layerId>` in
  `controlParams`, toggled per layer card since 2026-09-16): one toggled
  layer synthesizes a blend-mode enum + opacity scalar, a legacy literal
  `layers` entry expands to every layer, a stale layer id warns.
  And the param-driven scalar hints (`maxFrom` / `controlFrom` /
  `optionLabelsFrom`, functions the JSON clone drops): the builder
  evaluates them at build time, so a Switch index reaches the live panel
  spanning its live slot list (not the 0…255 static cap) and, in toggle
  mode, as a `segmented` pick over the wired inputs carrying their names.
  And the active-branch filter (`engine/active-branch.ts` — the viewer's
  "which rows show right now"): the same walk, but at a Switch only the
  picked slot's upstream counts, so a live index flips which branch's rows
  show, a node feeding both branches stays, picking the empty spare hides
  both, a wired / exposed-param / keyframed / bypassed Switch shows
  everything (no per-frame flicker), and a Switch inside a Layer resolves
  after the builder's remap + flatten.
  And the on-canvas handles (091726_live-gizmos.md): a node flagged
  `controlGizmo` ships a `transform` / `primitive` / `gradient` gizmo only
  when it is reachable, eligible (lib/live-gizmo.ts — the pen suite never
  is) and not wired away (a Transform with `in:transform` wired, a
  primitive's `hideWhenWired` socket), warning `gizmo-hidden-by-wiring`
  otherwise; its `nodeName` comes from the same counter as the node's
  knobs, and a gizmo-only link is not "no controls". The handles
  themselves are a live-app question.
  And the viewer SVG source (`manifest.svgExport`, 2026-09-23): set only
  when the rendered terminal has a spline in its tap — Output / Layer
  Output `in:spline`, SVG Export `in:path` — with `stashId` = the
  terminal, except a Layer Output, whose is its LAYER; a spline on the
  image socket, another node's tap, or any other terminal gives none.
- `check-live-presets` — the live-link style packs (081426 M4): every
  non-classic entry in design.ts's SLIDER/DROPDOWN/NUMERIC/TRANSPORT registries has
  a `.live-root[data-<class>="<id>"]` block in design-presets.css, every
  block sets the full `--ps-*` set for its class (no half-inherited
  fallbacks) with tokens only, and `fromSavedLiveDesign` keeps known ids /
  degrades unknown ones to classic. Since 2026-09-16 it also guards the
  designer's layout / theme sliders (`panelWidth`, `uiScale`, `rowGap`,
  `textBrightness`): a pre-slider blob reads as today's look, values
  clamp, non-numbers default rather than hitting the floor, the 0–100 %
  slider calibration puts the defaults at 25 % / 50 % and round-trips,
  and text brightness fades only ink tokens (surfaces, borders, accent
  untouched; 100 % is byte-identical). And the pan / zoom flag
  (091826_live-pan-zoom.md, `layout.panZoom`): off when absent or junk,
  on only for `true`; `export.svg` follows the same rule. Visual
  correctness is NOT covered —
  audition packs in File → Live Link… (the preview iframe is the real
  `.live-root`).
- `check-live-param-history` — the live viewer's undo / redo
  (`lib/live-viewer/param-history.ts`, 2026-09-19), the pure half: rapid
  same-key writes coalesce into one entry that undoes to the FIRST
  before-value and redoes to the last after-value; the window refreshes
  per write so a long drag stays one step; a gap, a different key, no key
  or an undo in between starts a new entry; a gizmo drag writing several
  params undoes them together; two ramp-stop virtual keys landing on one
  stored array unwind to the array before either moved and redo to the
  final one however the writes interleaved; a write after undo drops the
  redo stack; `MAX_HISTORY` caps the stack. ⌘Z reaching the viewer, and
  the writes onto the runtime graph / `paramValues`, are live-app
  questions (open a `/live` link, drag a slider or a gizmo, ⌘Z).
- `check-glsl-translation` — the graph → GLSL tools (091626_graph-to-glsl.md):
  every visible image producer is classified in
  `src/lib/glsl-translation/classes.ts`, node docs agree with the table,
  `docs.generated.ts` is fresh (`npm run gen:glsl-docs` after editing
  `docs/**/*.md`), `get_glsl_docs` leads with the core three and names
  missing slugs, and `planTranslation` cuts fixture graphs built from the
  real registry the way the spec says (pure chain fuses whole, video is a
  sampler, a stateful node splits the region, interior matte vs the
  target's own mask, sampler cap shrinks with a named exclusion, zone
  members stay out). The MCP hop for both tools is in `check:mcp`.
- `check-viewport-guides` — viewport rulers + guides
  (091726_viewport-rulers.md), the pure half in `lib/viewport-guides.ts`:
  the `SavedProject.viewportGuides` gate drops malformed entries and
  collapses duplicates but keeps off-canvas positions (a ruler drop, not a
  clamp, is the delete); the shared snap helpers pick the SMALLEST
  correction across a box's edges + centre and nothing beyond the
  threshold; the ruler ladder only emits 1 / 2 / 5 × 10ⁿ steps with labels
  ≥ minLabelPx apart; ruler drags land on the project pixel grid. The
  overlay itself (ViewportRulers.tsx) and each gizmo's snap wiring are
  live-app questions — Shift+R, drag a guide out, drag a Transform box
  onto it.
- `check-unified-attrs` — one schema for built-in and named point
  attributes (092026_unified-attributes.md): `withPointAttr` routes any
  name — `scale`, `scale.y`, `x`, `group`, a channel — with the schema's
  coercion (a scalar fills both scale lanes, `group` rounds, non-finite →
  the lane default, a lane write keeps the others, multiply / add against
  the current value, `index` / `z` / normals return the input unchanged);
  Set Named Attribute (any name, `mode`, `source=exponential`), Attribute
  Math (built-ins in and out), Map Attribute (`output_name` + `mode`, and
  the `map_target` load migration renders identically) and Point
  Expression's `setattr("scale", …)` all go through it; the subpath
  `driver` is `attrs.driver` (legacy field → 0.5 fallback) for Rasterize /
  Stroke `by: driver`; Collect and Copy to Points carry every attribute;
  the name-field rule accepts writable built-ins on writers. The picker
  tint in the live editor is a live-app question.
- `check-easing-editor` — the Tracks editor's easing overlay
  (091726_easing-editor.md), the pure half: the `cubicBezier` easing kind
  is a CSS cubic-bezier time remap (thirds = identity, the exact table
  entries reproduce t² / t³, y overshoots, x clamps so time stays
  monotonic), a scalar plays it exactly like the same shape as
  `customBezier` handles while vec / color lanes get the remap too, a
  shapeless key or an unknown preset name plays linear (not NaN); every
  easing kind normalizes into the unit square and denormalize →
  normalize round-trips; the pair rule (both selected AND adjacent in the
  lane, per lane, across lanes, step-only lanes out, earliest-then-topmost
  first), seeds / ghosts, the `mixed` comparison, the shape and named-
  preset writes, the view math (zoom keeps the cursor's point fixed, the
  pan clamp keeps the square reachable), the shelf's auto-naming and its
  fit-to-height (a short dock shrinks the square, never below the
  minimum). The overlay itself (EasingEditorOverlay.tsx) — anchors,
  handle drags, gestures, resize grip, the shelf's clicks and right-click
  menu, the dock button — is a live-app question.
- `check-export-capture` — the export capture + log path
  (lib/export-capture.ts, lib/export-log.ts), pure half. Exports read frames
  straight off the terminal texture (EngineBackend.readImagePixels) since
  2026-09-21 — never the on-screen canvas, which Chromium can hold stale
  while a window is occluded or the 2D canvas is starved (the desktop 3840²
  export that froze a few frames in while the evaluator kept rendering).
  The gate covers the sampled frame checksum (deterministic, length-aware,
  byte 0 and every stride multiple always sampled), the identical-run
  tracker and its "mostly one picture" hint threshold (≥20 frames, run ≥10
  and ≥ half), the worker string → Error normalisation, and ExportLog's
  line format, frame-line cadence (first 3 / every 30th / last), one-shot
  run warning, summary numbers, ring cap and idempotent finish. The GPU
  readback itself, rgbaToBlob (OffscreenCanvas), the desktop log file
  (electron/export-log.js, `~/Library/Logs/Toolbox/exports`) and ffmpeg's
  stderr landing in it are live-app questions — run an export and open the
  log the failure toast names.
- `check-export-pipeline` — the pipelined export frame loop
  (092126_async-pipelined-readback.md, lib/export-pipeline.ts), pure half.
  Since 2026-09-21 the native-ffmpeg exporter keeps ONE readback in flight:
  frame i's eval + PBO copy are issued before frame i-1's bytes are awaited
  and written, so the GPU renders i while the CPU ships i-1. The gate drives
  `runFramePipeline` with hand-resolved fake reads and asserts the issue
  order (render 0, read 0, render 1, read 1, THEN wait on 0), that a later
  frame landing first is never consumed early, strict index-order hand-off,
  the `render` / `capture` (fence wait) timings, and the abort paths: a null
  read rejects naming the frame, a throwing `consume` or `render` propagates
  the same error, and in every case the read already issued for the next
  frame is cancelled. The GPU half is `check:readback-async` (above); the
  speed win is a hardware question — see the parity + speed procedure below.

  **Verifying the pipelined export on the desktop.** Export the same project
  twice from the desktop app, once on the current build and once with the
  sync loop (check out the commit before the pipeline landed, or temporarily
  swap `runFramePipeline` for the old loop), same range, size and codec.
  Open the two logs under `~/Library/Logs/Toolbox/exports`: every per-frame
  `checksum` must match between runs (the log prints one per frame at its
  cadence — for an exhaustive comparison, temporarily set `FRAME_LOG_EVERY`
  to 1 in lib/export-log.ts). `distinctFrames` must equal `frames` for an
  animated graph and the "unchanged for 10 frames" warning must not fire.
  Speed is in the summary's `avgMs` block: `capture` should fall from the
  GPU-finish-plus-copy time (340 ms at 3840² on the M5 Pro reference) to
  the fence wait alone, and the per-frame total toward
  `max(render + gpu, write)`. State the project, size, codec and machine
  with the numbers (§6); a window that is occluded during the run still
  exports correctly but is not a fair timing.
- `check-export-presets` — the video export presets
  (092126_export-presets-and-progress.md, lib/export-presets.ts): every
  preset's codec belongs to its tier and survives `describeVideoExport`
  without a silent substitution; `effectiveVideoPreset` sends an untouched
  node to the default, a pre-preset save with raw encoder rows to Custom,
  and an unknown id to the default; Custom resolves the legacy rows with
  the Output's old defaults; the description maps hevc-under-Max → h265,
  h264/mov-under-High → avc/.mp4, ProRes-in-mp4 → .mov, warns for lossless
  H.264 playback, browser ProRes alpha, browser AV1 and low bitrates at
  large sizes, and sizes fixed-bitrate and ProRes exports (150 Mbps × 4 s
  = 75 MB; 4444 at 3840² × 240 ≈ 1.9 GB); the Output rows hide the raw
  encoder rows under a preset and show them under Custom. The panel's
  summary block, the two-bar banner and the encoders are live-app
  questions.
- `check-vanity-slug` — named live links (092126_vanity-live-links.md),
  the pure half in `lib/vanity-slug.ts`: title → slug (lowercase ASCII
  kebab-case, diacritics stripped, capped on a word boundary, null when
  nothing usable survives), typed text → handle (tolerates `@` and casing,
  3–32 chars, no edge dashes, the reserved list), the `@<handle>` route
  segment parser (anything else must 404 — the root `[handle]` route
  catches every unrouted two-segment URL), and the URL builders. The DB
  constraints in `specdocs/vanity-live-links-migration.sql` mirror these
  rules by hand — change both. The settings row, the account-menu handle
  editor, and the `/@handle/slug` page resolving against Supabase are
  live-app questions.
- `check-svg-export-stash` — the evaluator contract behind the SVG button
  on Output / Layer Output / SVG Export (nodes/output/svg-export.ts): the
  `svg-export:<id>` stash is written by whichever node COMPUTES for the
  surface — a Layer Output's lives under its enclosing LAYER's id (flatten
  pushes the tap onto the layer shell) — so a pass that skips that node
  (an Active node elsewhere, or the offline forced terminal on a Layer
  Output, which remaps to the interior image producer) leaves no stash
  even with the wire present; `extraTargets: [stashOwner]` restores it,
  while a bypassed / clip-gated layer or an empty spline honestly stays
  empty. Pins the "Nothing to export — wire a spline into Layer Output"
  regression. Also `svgStyleFromParams`, the style both the editor and the
  live link's SVG button write: unset rows read as their defaults, so an
  untouched Layer Output (seeded with EXPORT_PARAMS only) exports a
  visible stroke rather than `fill="none"` and no stroke. EffectsApp's
  exportSvgNode forcing the owner via `svgExportStashTargetRef`, the
  viewer's forced render (LiveViewer onExportSvg), the sequence-mode file
  loop and its toasts are live-app questions.
- `check-keyframe-clipboard` — the keyframe clipboard shared by the
  Tracks editor (Cmd+C / Cmd+V) and the Graph editor's right-click menus
  (Copy / Paste / Paste flipped): offsets are relative to the earliest
  copied key across lanes; "flipped" mirrors ticks about the span
  midpoint (integers stay integers, multi-lane about the WHOLE span) and
  reverses every segment's easing — ease-in ↔ ease-out, a `cubicBezier`
  shape reflected through the unit square, `customBezier` handles swapped
  with dx negated — so the flipped block evaluates at t exactly as the
  original does at min+max−t (scalar and vec; hold and the mirror-less
  bounce / elastic stay as they are); flipping twice is the identity;
  paste re-anchors, replaces a colliding key, sorts, marks the block
  animated, drops sub-zero ticks and skips a lane whose block is gone.
  The menus themselves and the selection after paste are a live-app
  question.
- `check-bounding-box` — Bounding Box's per-socket output toggles
  (2026-09-23). Every aux socket is opt-in behind its own `show_<socket>`
  boolean, all off: a fresh node shows only the Box spline, each toggle
  adds exactly its socket in display order, and compute emits values for
  shown sockets only (empty content → empty values, still only the shown
  ones). The load migration matters most — the editor drops wires out of a
  missing socket, so a save from before the toggles must keep the sockets
  it always had: the 14 measurement sockets on, the guide pair per the old
  `guides` flag (dropped), its expose / control / keyframe entries and any
  `in:param:guides` wire fanned out onto both guide toggles; a current
  save (all-off toggles) is never mistaken for legacy, and re-save is
  stable. A node with no `show_*` key at all (an editor that hot-reloaded
  onto the new def keeps its in-memory nodes un-migrated) resolves and
  computes that same old set. Also: wiring a hidden socket in a recipe
  fails with the toggle named (`hiddenAuxHint` in graph-validation.ts,
  generic over boolean-gated aux sockets), and the catalog still
  advertises all sixteen. The panel rows and the node's handles appearing
  / wires dropping on a toggle are a live-app question.
- `check-line` — the Line node's `start` / `end` vec2 sockets and bezier
  mode (2026-09-23), compute and gizmo together. Wired values go through
  `coerceValue` first: a wired socket replaces that endpoint's params, a
  scalar lands on both axes, a non-finite vec2 falls back to the params.
  `mode=straight` ignores the eight handle params; `mode=bezier` emits
  them as offsets relative to their (possibly wired) endpoint, leaves a
  0,0 handle off (all-zero bezier ≡ straight), gives a save without them
  the def defaults, and trims along the curve. The gizmo half is the
  line adapter in PrimitiveGizmo.tsx: every dot sits on the point compute
  emitted, mapped through buildPath2D's `aspectCorrectY` (a raw-y adapter
  drifts off the line on a non-square canvas — the gate runs at 1920×1080);
  endpoint drags write X/Y with the aspect undone, handle drags write the
  offset from the endpoint (y ÷ aspect); a wired endpoint is pinned to the
  wired value and locked while its handles stay draggable, or left out,
  handles and all, when its producer has nothing cached (`readWiredInputs`
  → undefined), with writes still resolving by key; wiring start / end
  never hides the gizmo, in the editor or the live link — only transform
  does. The overlay itself (PrimitivePointHandles' cubic connector, stems,
  handle hit rings, the locked ring) is a live-app question: select a Line,
  flip it to Bezier, drag a handle, then wire a Vec2 into Start.
- `check-figma-import` — the Figma → toolbox import
  (092326_figma-import.md), pure half. `parseFigmaScene` is the clipboard
  trust boundary: truncated JSON, a missing marker, a newer format, non-
  base64 / non-image payloads and path data with foreign characters are
  refused or dropped, non-numeric values fall back, the root transform is
  pinned. `convertFigmaScene` on a hand-built scene: the root Merge follows
  Figma's bottom→top order, a flat white frame fill becomes the Solid Color
  base, frame px land in width-relative spline space (closing duplicate
  folded, its in-handle kept), rotation is exact, fill + centred stroke
  share one Rasterize, an inside stroke is 2× weight matted by the shape, an
  open dashed path strokes its centerline in `%` metrics, a half-opacity
  group of two isolates into a nested Merge, a clipping frame with overflow
  mattes by its outline, a mask mattes every sibling above it up to the
  next mask, text imports as glyph outlines, an image FILL lands on its
  cover rect through Rasterize's fill input — and every edge meets a real
  socket and `validateGraph` is clean. It then converts every plugin export
  in `scripts/fixtures/figma-import/` (drop a **Download JSON** file there to
  add one). Pixels are a live-app question: paste with **Include Figma's
  render** on and `compare_renders` the "Figma reference" node against the
  root Merge. The plugin itself type-checks with `npm run
  figma-plugin:typecheck` (it runs only inside Figma's desktop app).
- `check-skia-canvaskit` — the CanvasKit wiring behind SkSL / Skia nodes
  (101326_skia-target.md): the loader's pinned version is the installed
  `canvaskit-wasm` (and RN Skia's, when skia-harness is installed),
  `copy-canvaskit` copies `bin/full/` (RN Skia web's build) byte for byte,
  the export template points the loader at its own `dist/canvaskit/<ver>/`,
  and Export App ships CanvasKit only for graphs with an SkSL Shader or
  `skia-*` node. That an exported app actually loads it is a served-`dist/`
  question (`build:export-template`, then open `dist/` over http — never
  file://, which can't instantiate WASM).
- `check-skia-shapes` — the vector-shapes family (Circle / Rectangle /
  Line (Skia), the twelve spline generators in a Skia layer). The
  primitives bind each value as one param × a constant, so keyframed or
  driven params export as tracks; generator → Skia Shape paths export
  sampled from upstream provenance, with no warning. Every node exports
  keyframed and static and type-checks in skia-harness; one canvas holding
  all of them replays every animated bind at every frame; CanvasKit (CPU)
  pixels land where the params say at 256² and 320×180. It also pins that
  a generator with its bundled raster on still evaluates without GL, and
  that an upstream compute that throws refuses the export instead of
  shipping an empty path.
- `check-skia-paint` — the paint / modifier / text family (Stroke, Fill,
  Trim Path, Round Corners, Dash, Gradient Fill, Text (Skia)) against
  `scripts/fixtures/skia/paint-graph.ts`. Every Skia Canvas there
  exports clean; one combined canvas (animated trim end, corner radius,
  fillet radius, dash offset, font size) type-checks in skia-harness and
  ships tracks / interpolated path series where the nodes tag them. The
  mirrors are checked against the originals' own math, not pixels: the
  fillet path is `roundCorners`', the trim windows are `trimSubpaths`',
  the gradients are what Rasterize Spline hands Canvas2D (a recording
  fake, conic stops rotated). The text constants are measured truths:
  the bundled fonts' tables match the files, the Canvas2D middle →
  alphabetic offset equals Chromium's TextMetrics (measured in Electron;
  re-measure if Chromium's em-box rule changes), `paragraphLineBox`
  equals CanvasKit's SkParagraph line metrics. CanvasKit (CPU) pixels:
  trim share, wrapped remainder, cleared star tips, Dash ≡ Stroke dashed
  pixel for pixel, dot count, radial center color, paragraph wrap,
  kerning. Pixel parity vs the native nodes is `compare:skia` on the
  fixture's pairs (`--a paint:<pair>n --b paint:<pair>s --expect close`;
  the Text pairs need Chromium's text, so they only run there — and on
  macOS CoreText draws the Text node's glyphs ~10 % heavier than
  CanvasKit's FreeType: compare text edges, not ink mass).
- `check-spring-easing` — the `spring` easing (engine/spring-easing.ts:
  Reanimated 4.7's withSpring from rest, fitted to the segment). Sanitizer,
  exact endpoints and rest point, regimes (every ζ ≥ 1 is one curve:
  Reanimated has no over-damped branch), energy never rising, engine ≡
  worklet runtime, editor sampling, MCP vetting, save → load, and parity
  with `withSpring(B, springToReanimated(key, T))` stepped at frame
  timestamps (≤ 1e-9 × |B − A|, measured ~7e-13). It runs Reanimated's
  REAL source when skia-harness/node_modules exists and the transcription
  in `scripts/fixtures/reanimated/spring-4.7.ts` otherwise (CI), holding
  the two bit-identical; `SPRING_EASING_TRANSCRIPTION=1` forces the CI
  path. Trap: CanvasKit's CPU raster approximates exp (~6e-5 rel) and
  sin / cos (~2e-4 abs), so `springSksl` is checked against the fp32
  oracle (`springSkslReference`) within that measured floor — GPU
  precision is the oracle's own ≤ 2e-6, not a CanvasKit-in-Node number.
- `check-skia-baked` — `animation: "baked"` exports
  (src/lib/skia-export/emit-baked.ts: track / sampled program uniforms as
  SkSL functions of iTime). The baked track functions run on an F32
  CanvasKit surface at every frame and at fractional times against
  `evaluateKeyframesAt` / the worklet runtime: constants (keys, clamps,
  holds) are the double rounded once to fp32, interpolated scalars ≤ 2e-6
  of the track's magnitude (measured 9e-7; 2.5e-6 end to end, where the
  fp32 clock itself is ≤ 0.006 ticks off), raw colors ≤ 2e-5 (OKLab →
  linear cancels near the gamut edge), every quantize8 flip one step at a
  double within 2e-3 of a .5 boundary. Then Aurora (SkSL Shader), Aurora
  (Skia-layer scene, two sampled ramp series) and an every-easing fixture
  (`scripts/fixtures/skia/baked-graph.ts`) render baked vs worklet at
  EVERY frame — max 1/255. Plus what stays on the worklet, refusals
  (caps, 2^24 ticks, iTime not the clock, the tbk_ prefix) and
  `checkExportable(…, { animation: "baked", typecheck })`. Traps: the
  baked code calls polynomial sin / cos / exp / pow, not Skia's (CanvasKit
  CPU builtins are off by ~1e-4 — the gate prints them); Skia compiles
  `x / 255.0` as a reciprocal multiply, so a quantized level is within an
  ulp of k/255, not equal to it; and the CPU backend runs every branch of
  the baked if-trees (a GPU takes one), which is why the per-frame
  renders are small (`BAKED_SIZE`, default 32). Web parity is
  `npm run parity:skia -- --bundle baked` (skia-harness/src/bundle-baked).
  Since gradients plan as color-managed programs (lane C, 2026-10-14) the
  scene fixture's gradient child bakes its keyframed stop color (the baker
  adds the program an iTime); baked vs worklet at every frame, 0/255.
- `check-skia-segments` — timeline markers → named segments → the exported
  clock (101326_skia-target.md §3.5a, M3). The marker model
  (`lib/timeline-markers.ts`: save sanitizer, ruler edits, the strict
  `set_markers` boundary), segment derivation (a point marker runs to the
  next point marker or the scene end; a ranged marker is its own span and
  doesn't cut the chain; duplicates / out-of-range / clamped / empty are
  issues, never throws), persistence on `SavedComposition.markers` (round
  trip, repair on load, an older build's resave keeps them — why there is
  no schema bump), and `SEGMENTS` / `MARKERS` in both bundle kinds plus the
  late-layer shift. Then it RUNS the emitted `toolbox-clock.ts` on fake
  frames twice: as TypeScript with mocked hooks, and as the worklets Babel
  plugin's output on an emulated UI runtime (each worklet rebuilt from its
  code string with only its closure — a control that reaches a JS function
  throws there as on a phone). Both runs prove frame-exact wraps at segment
  boundaries over many loops, play-once holds, `thenLoop` chaining,
  seek / pause / play semantics, and that the whole-timeline loop is
  bit-identical to the format-2 clock. Finally both bundles type-check in
  skia-harness beside an app screen using every control (an unknown
  segment name must be a compile error). The (ui) run and the type-check
  skip without `skia-harness/node_modules` (`SKIA_HARNESS_REQUIRED=1` fails
  instead). That real Reanimated plays it is the harness: the web build's
  `?segment=<name>` loops a segment, its chrome row drives the controls,
  and `window.__toolboxHarness.clock()` exposes the live clock. The ruler
  UI itself (drag / rename / context menus) is a live-app question.
- `check-skia-color-management` — every runtime program looks the same on
  an sRGB canvas and on React Native Skia's Display P3 iOS canvas
  (101326_skia-target.md §5.5, `engine/skia/library/color-management.ts`).
  Every registered library function (minimal fused program), every program
  of every family fixture (fused chains, SDF programs, a program child),
  the SkSL Shader node (default source, a user shader sampling iImage1,
  one sampling it from helpers / in parentheses / across comments — plus
  its main / `iImageN.eval` rewrite and error-line mapping), baked
  programs (`animation: "baked"`) and a chain with image / color leaves and
  an SDF program child render on CanvasKit CPU surfaces in sRGB 8-bit,
  Display P3 F32 and Display P3 8-bit. Held to 1/255: P3 F32 read back as
  sRGB vs sRGB; P3 8-bit bytes vs Skia's own P3 encoding of the exact
  result. Held to 0: sRGB vs the same program with color management forced
  off (no drift), and with the intrinsics stubbed to identities (an
  untagged surface). NEGATIVE controls: the same programs uncorrected on
  P3 (up to ~116/255), a literal color, the old `layout(color)` style.
  Native drawing (2026-10-14, Wave 3 lane C): Skia converts solids and
  images itself (held ≤ 1/255) but interpolates gradients and blends in the
  working space, so every gradient is LOWERED — the renderer and the
  exporter both draw `engine/skia/library/gradient-program.ts`'s
  color-managed program instead of a native gradient. 48 gradients (each
  kind × tile, Skia's degenerate rules, hard / unsorted / out-of-range /
  translucent stops, 49 stops) are held to Skia's own native gradient on
  sRGB (≤ 1/255) and like every program on P3 — also a gradient inside a
  Copy to Points (Skia) sprite sheet (`atlas.texture`, lowered in preview
  and export) and a gradient leaf beside an image leaf (the image leaf and
  the scene's assets untouched); the native gradients' P3
  shift (up to 48/255; red → blue 24/255) is the negative control. Native
  blend modes can't be lowered on device — React Native Skia 3.4 exposes no
  runtime blender (the gate re-checks its sources) — so each mode's P3
  shift is measured and printed (exact: the Porter-Duff selectors; srcOver /
  srcATop only for an opaque source; the color blends 55–255/255; Merge
  (Skia) is exact). The SkSL Shader rewrite is token-based: SkSL rejects
  shader-typed parameters, locals, arrays and ternaries (asserted), so
  `iImageN` is the only shader value, and its samples are converted in
  helpers, in parentheses and across comments too. Traps it hit: Skia's
  CPU backend skips a color intrinsic inside a conditional once a child
  was sampled (the helper never branches around them); CanvasKit 0.41.0's
  F32 `readPixels` returns an array 4× too long (slice it); CanvasKit's JS
  `MakeSweepGradient` reads `endAngle` 0 as 360 (`M=M||360` — React Native
  Skia web inherits it, a device doesn't), so a collapsed sweep is only
  comparable as the program; a gradient whose t = 0 edge runs exactly
  through pixel centres flips sides on float noise (the corpus sits off the
  grid); the CPU backend runs a runtime gradient ~100× slower than a
  native one (GPU: ~2×, spec §4) — the cost line is CPU-relative only; and
  `compileSksl`'s cache is per CanvasKit instance — gates run several in one
  process (`checkExportable` makes its own), and an effect compiled by one
  fails in another with embind's "Expected null or instance of Shader, got
  an instance of Shader" (check-skia-paint hit it once gradients became
  programs).
  Programs that are slow on the CPU backend (Kuwahara, Flow Blur,
  Lyapunov) render smaller (`CM_SIZE`, default 32, is the cap).
- `check-skia-native` — the Reanimated-native export mode
  (`animation: "native"`, src/lib/skia-export/emit-native.ts; spec §3.5c).
  The easing table against Reanimated's own Easing (exact rows bit-equal
  to toolbox's easeOf, ulp rows ≤ 1e-15, each custom row's nearest
  Reanimated function proven wrong, Easing.bezier within its tolerance or
  swapped for toolbox's solver); snapshots of the emitted code
  (`snapshots/native-*`); playback of every value through a Reanimated
  stand-in (`scripts/skia/reanimated-sim.ts`) on a steady 60 Hz clock —
  within 2e-5 of range of the worklet value at every frame, no frame of
  lag — with ±0.05 / ±1 ms jittered clocks reported, not asserted; the
  same for `playSegment(name)` over every marker segment of every bundle
  (the easings fixture's markers cut key segments mid-curve: `tbxCut*`);
  `playSegment(name, { from: "current" })` from another frame's values
  (`playNativeFromCurrent` in `scripts/skia/native-drift.ts`): scalars
  start exactly where they are, colors within 1/255 of the color on screen
  (before lane C they jumped to the segment's start color, up to 236/255),
  a color's fade runs on its first move's timing and easing, and every
  value joins from "start"'s frames by the end of that move and stays —
  the transcription and Reanimated's real sources alike (8-bit snapped
  colors can coincide with toolbox's frame for a frame mid-fade, so "joins"
  means the LAST differing frame, not the first equal one);
  `colorAt` ≡ evaluateTrack's colors; refusals; the emitted bundles
  type-check in skia-harness; the `skia-harness/src/bundle-native*` slots
  are today's export; and no worklet in the shipped runtime or an emitted
  module calls one declared below it. With skia-harness installed it also
  runs Reanimated's REAL Easing and animation sources and holds the
  transcriptions bit-identical to them; `SKIA_NATIVE_TRANSCRIPTION=1`
  forces the CI path. Trap it guards: the worklets Babel plugin turns
  every worklet `function` into a non-hoisted `const` that captures its
  callees when created, so calling a worklet declared further down the
  file throws "Cannot access … before initialization" on device and on
  React Native web — while every Node gate (which hoists) passes.
- `check-skia-atlas` — Copy to Points (Skia) (`skia-copy-to-points`,
  101326_skia-target.md §3.4 "built and measured"; fixture
  `scripts/fixtures/skia/atlas-graph.ts`). Defs: the mirror reuses Copy to
  Points' own ParamDefs; Point / Grid / Space Fill / Voronoi are offered in
  Skia layers and evaluate with NO GL (Voronoi skips its image when
  `ctx.gl` has no `createTexture` — the exporter's data-only sampler).
  Placement: every copy of both strategies — groups (outer
  T(p)·R(add)·S(mul) × inner R(rot)·S(scale)·T(−anchor), composed with the
  renderer's own `transformMatrix`) and atlas (`composeAtlasXforms` over the
  sprite sheet) — lands where the GL vertex shader puts it (≤ 1e-9 px,
  canvas-centre and custom anchors, 256² and 320×180, non-uniform scale on
  groups). Strategy: auto picks groups below `ATLAS_AUTO_MIN` (16) and an
  atlas from it; RSXform has one scale, so non-uniform per-point scale
  draws groups even when atlas is forced; spline / point modes are the GL
  node's own output (through `coerceValue`). Anchors: `sceneBounds` (cubic
  extrema, strokes, group transforms, clips; fills and text unbounded) and
  `glContentCenter` against the GL node's readback EMULATED on a CanvasKit
  raster (128-px bilinear taps, 8-bit, one-texel pad) — equal for circles,
  stroked rects and blobs; the fixture star's narrow tips are printed, not
  held (a readback texel sees 2 of its 4 source pixels, so it can miss a
  tip: 2 px at 512²). Pixels (CPU): atlas ≡ groups at integer offsets
  (≤ 2/255 premultiplied), the sheet rasterises at the surface's density
  (k = 2 still ≡ groups), the texture cache renders a sheet once, rotated /
  scaled copies agree in ink mass and centroid. Export: keyframed Scale × /
  Rotate + over static points are TRACKS in both strategies (the atlas's
  `rotate` / `scale` over static xforms — never N×4 floats per frame);
  moving points are SAMPLED; an animated instance under an atlas is
  refused with the fix named (the sheet renders once) and exports under
  groups; the emitted `useRSXformBuffer` worklet, extracted from the TSX
  and run on the emitted `timeline.ts`, reproduces the preview's xforms
  bit for bit at every frame; emitted worklets call only functions
  declared above them; the bundle type-checks in skia-harness; and
  `skia-harness/src/bundle-atlas` is today's export (`npx tsx
  scripts/export-skia.mts --fixture atlas --out skia-harness/src/bundle-atlas`).
  Traps: the GL Copy to Points' image mode writes PREMULTIPLIED rgb into
  its straight-alpha output and bilinear-samples a straight texture, so
  its anti-aliased edges come out dark — compare vs GL with an opaque
  instance (`gl_opq`) for pixels, or `--premul-a` plus `edge-band.cjs`
  for coverage; content-centre anchors can sit a readback texel apart
  (see above), so pixel comparisons use canvas-centre anchors.
- `check-skia-assets` — images + assets in React Native Skia exports
  (101326_skia-target.md §3.8 items 2–3, Wave 3 lane I). The one URL →
  bytes seam (`engine/skia/asset-bytes.ts`: registered schemes — lane B's
  `bake:` — then data:, then fetch; the preview's loader and every export
  go through it) and the async pre-pass in front of the synchronous
  `exportSkia` (`lib/skia-export/assets.ts`; `exportSkiaFromEditor` /
  `planSkiaExportForEditor` are async since then). Image (Skia)'s IR (a
  Group nest whose binds are each one param × a constant, the image leaf,
  the blob: asset of the bitmap's original file) and three formulations of
  Image Source's mapping — the drawing's Group nest, the shader's FIT_FS
  port, the SkSL Shader export's ImageShader matrix — agreeing in CanvasKit
  (≤ 2/255 inside the image) and in algebra (≤ 2e-15 against an independent
  fitRects). A Skia Canvas export with an image draw, an image leaf fused
  into Color Correction (Skia) and Geist text ships every file's bytes, the
  OFL text, `assets.ts` requires, binary zip entries, manifest rows with
  size + `bundled`; without bytes (or with a failing resolver) each asset is
  a warning naming its node and quoting the reason, `assets.ts` maps it to
  null and the bundle still type-checks. The SkSL Shader: `iImage1` from a
  static Image Source + ramp / curve LUT children in declaration order, the
  emitted `images.ts` imageMatrix bit-identical to the preview's
  `imageLocalMatrix`, `luts.ts` the preview's bytes, LUT accessors exact at
  texel centres on sRGB and ≤ 1/255 on Display P3, refusals (keyframed /
  faded / wired / cover-and-transformed / EXR / computed images, wired
  ramps), every animation mode type-checking; the editor (custom
  `resolveAsset`), MCP (`.b64` entries) and CLI paths; and
  `skia-harness/src/bundle-image` is today's export. Pixels against the GL
  Image Source are compare:skia's (`--a image:<pair>n --b image:<pair>d|s`,
  pairs cover / contain / trs / cvtrs, and `ccn` vs `ccs`), the web side
  `parity:skia -- --bundle image`. Traps:
  - **An SkSL Shader samples a static image file itself.** Image Source and
    Image (Skia)'s preview tag their output (`ImageValue.skiaSource`); once
    the asset loader has decoded the file the SkSL Shader binds an
    ImageShader of it — what the export ships — instead of the 8-bit
    readback. Until then (the first frame) it renders the readback, so a
    harness that renders frames back to back must render once and await
    `sceneAssetsSettled()` first (parity-page.ts and compare-page.ts do).
  - **A browser canvas is not a lossless PNG encoder.** `putImageData` →
    `convertToBlob` rounds half-alpha pixels through premultiplied storage,
    so a fixture encoded that way differs from the same picture encoded in
    Node (the first image parity read max 27/255 for exactly that).
    Fixtures encode with `imageFixturePng` (pure JS, stored deflate).
  - compare:skia's `max` on the image pairs reads ~214/255: the RGB of
    near-transparent pixels, where the engine filters straight alpha and
    Skia premultiplied. Read `edge-band.cjs` (premultiplied: ≤ 2/255).
  - A worktree's harness needs `skia-harness/public/canvaskit.wasm`
    (`setup-skia-web`, or copy the main checkout's): without it the web
    export serves index.html for the wasm and the page never gets ready.
  - Node's fetch takes data: and blob: URLs but not root-relative ones
    (`/fonts/…`): the CLI and gates resolve through
    `scripts/skia/node-assets.ts` (public/, offline unless `--fetch`).
- `check-skia-merge` — Merge (Skia), the merge & blend family: Merge's
  `layers` param and sockets, the 8-slot cap, all 29 formulas against a CPU
  reference on float surfaces, Skia's native blend modes measured against
  them, and export (keyframed layer opacity → tracks). Since 2026-10-14
  (lane C) also the layer-stack UX it shares with Merge
  (`nodes/effect/merge.ts`: `mergeLayersParam`, `growMergeLayersOnWire`,
  `newMergeLayer` — what EffectsApp / EffectNode call for any node with a
  `merge_layers` param): wiring the last open layer appends one, up to the
  param's `max` (8 enabled layers on Merge (Skia), none on Merge), a wired
  mask alone doesn't fill a layer, disabled layers take no slot, and the
  grown stack resolves its new sockets. The node header's "+", the row eyes
  and the effect itself running on a wire change are live-app questions.
- **Skia parity tools** (Electron or devices, not in `npm run check`):
  - `npm run bench:skia-atlas [-- --counts 1,4,16,64 --frames 120 --static]`
    — per-frame draw cost of Copy to Points (Skia), groups vs atlas, on
    CanvasKit WebGL (Ganesh, RN web's renderer) in an offscreen Electron
    window: real node, scenes sampled first, each frame drawn + flushed +
    1-px readPixels (GPU wait), sheets from a texture cache (their one-time
    raster is the `first` column). Electron's `performance.now()` is 0.1 ms
    coarse, so the mean is one timed run over all frames. Reuse ONE WebGL
    context — Chromium drops the oldest past ~16 ("Too many active WebGL
    contexts") and later rows then measure a lost context. Writes
    `scripts/.skia-compare-out/atlas-bench[-static].json`.
  - `npm run compare:skia -- --a <fixture>:<node>[:aux:<name>] --b …` —
    renders two nodes of `scripts/fixtures/skia/<fixture>-graph.ts`
    (`export const fixture`, contract in `scripts/skia/fixture.ts`) through
    the real evaluator, headless, and prints compare_renders' metrics plus
    max channel error and identical-pixel fraction; PNGs + report.json in
    `scripts/.skia-compare-out/`. Exit 0 within `--expect` (default
    `match`), 1 beyond it, 2 on any setup/render error. How a port (native
    node vs its `skia-*` / SkSL version) is proven without an editor. Each
    frame evaluates from a fresh cache: stateful nodes see no history.
    `--analysis 256` reproduces the editor's compare_renders sampling (the
    Aurora fixture reads meanAbs 0.0006 there, 0.00025 at full 512²).
    Two traps for vector ports: its `max N/255` includes the RGB of fully
    transparent pixels (a meaningless 255 on any anti-aliased edge), and
    its `motion` line compares RGB where both frames are opaque only, so a
    moving stroke over transparency reads "static". For shapes run
    `node scripts/skia/edge-band.cjs <out dir> [--band 2]`: premultiplied,
    split into a band around every edge vs the interior, plus the real
    per-frame change. The shapes pairs (`shapes-graph.ts`) read interior
    0/255 and band p95 ≤ 56/255: Chromium's canvas 2D (the generators'
    own raster) anti-aliases in coarse coverage steps, CanvasKit finely.
    `--premul-a` divides side A's alpha back out of its rgb before scoring
    (and in `f<N>-a.png`) — for a side that stores premultiplied colour in
    a straight image, which the GL Copy to Points' image mode does.
  - `npm run parity:skia [-- --write-golden]` — toolbox vs the exported
    bundle on RN Skia's web target (needs `npm --prefix skia-harness run
    export:web`); `--write-golden` also writes toolbox's frames to
    `scripts/fixtures/skia/golden/` for the device lanes. Re-run it whenever
    the bundle is re-exported: the device lane refuses stale goldens.
    `--bundle image` plays `src/bundle-image` (an SkSL Shader sampling a
    bundled image through ramp / curve LUTs, `export-skia.mts --fixture
    image`). `--bundle native | native-easings | native-scene` plays the
    Reanimated-native slots instead (`export-skia.mts --animation
    native`): the page runs on a fake animation clock (`?clock=fake`,
    `skia-harness/fake-clock.ts`) that steps Reanimated's real frame loop
    one 60 Hz frame at a time from `play()`, so frames must ascend; it also
    prints every value's drift from the worklet curve at every frame and
    writes `native-values.json`. `--jitter <ms> [--seed n]` wobbles the
    fake vsync to model a real display. `--segment <name>` (native only)
    plays `playSegment(name)` instead of `play()` (the page's `?segment=`):
    frames count from the segment's start (default: eight spread over it),
    toolbox renders the same frames of the timeline offset by the segment's
    start, drift is measured there too, and the output lands in
    `parity-out/<bundle>-<segment>/`. The motion check accepts a quiet
    segment that moves less than 0.01 meanAbs only when the device moved
    exactly as much as toolbox did between the same two frames.
    Trap: React Native web's rAF
    timestamps and `performance.now()` differ within a frame, so without
    the fake clock a native run measures the browser, not Reanimated.
    `--bundle atlas` plays Copy to Points (Skia) (`skia-harness/src/
    bundle-atlas`, `export-skia.mts --fixture atlas`: useTexture sprite
    sheets, a useRSXformBuffer driven by tracks, vector copy groups); the
    fixture is 30 fps, so its default frames 0,20,…,120 (60 Hz capture
    times) are its own frames 0,10,…,60 — pass even frames only. The
    harness web build needs `skia-harness/public/canvaskit.wasm`
    (gitignored; copy `node_modules/canvaskit-wasm/bin/full/canvaskit.wasm`
    in a fresh worktree) or the page never gets ready.
  - `npm run parity:skia:device -- --platform ios|android` — the same
    frames captured on the iOS Simulator / Android emulator through the
    harness's deep-link capture mode, scored against the goldens. Needs
    Xcode or the Android SDK; runs in GitHub Actions
    (`skia-device-parity.yml`, dispatch only). `--simulate` self-tests the
    collector → metrics → report path with no device. Device snapshots are
    replays into an untagged (color-management-off) offscreen surface, where
    the programs' color management passes through: they measure GPU math,
    not a Display P3 screen (`check:skia-color-management` covers that).

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
