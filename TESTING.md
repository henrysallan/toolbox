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
- **Skia parity tools** (Electron or devices, not in `npm run check`):
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
  - `npm run parity:skia [-- --write-golden]` — toolbox vs the exported
    bundle on RN Skia's web target (needs `npm --prefix skia-harness run
    export:web`); `--write-golden` also writes toolbox's frames to
    `scripts/fixtures/skia/golden/` for the device lanes. Re-run it whenever
    the bundle is re-exported: the device lane refuses stale goldens.
  - `npm run parity:skia:device -- --platform ios|android` — the same
    frames captured on the iOS Simulator / Android emulator through the
    harness's deep-link capture mode, scored against the goldens. Needs
    Xcode or the Android SDK; runs in GitHub Actions
    (`skia-device-parity.yml`, dispatch only). `--simulate` self-tests the
    collector → metrics → report path with no device. Device snapshots are
    replays into an sRGB surface: they measure GPU math, not a Display P3
    screen.

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
