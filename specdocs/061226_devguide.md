# Toolbox — developer guide (snapshot 2026-06-29)

Orientation doc for anyone (human or LLM) picking up this codebase cold.
It describes what the app is, the architecture, the invariants you must not
break, and the standard recipes (adding a node, adding a param type, etc.).
Update it when you ship a feature that changes any of this.

## What the app is

Toolbox is a **web-based, node-graph motion design tool** — think
TouchDesigner / Blender-geometry-nodes energy, aimed at 2D motion graphics.
Users wire sources (images, video, webcam, audio, text, splines, SVGs,
noise, SDF shapes, particles) through effect nodes into an Output node; a
WebGL2 engine evaluates the graph every frame onto a preview canvas. There
is a timeline with keyframes, clips, and AE-style layers; projects save to
Supabase (cloud) or `.toolbox` files (local zip); finished work exports as
image / video (3 quality tiers) or as a **standalone interactive web app**
with user-facing control panels ("live links" / exported apps).

- Stack: Next.js 16 (App Router, `next dev --webpack`), React 19,
  TypeScript, `@xyflow/react` (node editor canvas), Tailwind v4 (postcss),
  Supabase (auth + project rows + image-gen), WebGL2 (engine), WebGPU
  (opt-in compute nodes), ffmpeg.wasm + WebCodecs + mediabunny (export),
  MediaPipe + HuggingFace transformers (trackers, bg-remove, segment,
  depth), three.js
  (available; minor), JSZip (.toolbox + export packaging). Also ships as a
  **macOS Electron desktop app** (native ffmpeg export, native file I/O,
  offline) from the same codebase — see "Desktop (Electron) build".
- `AGENTS.md` warning is real: this Next version has breaking changes —
  check `node_modules/next/dist/docs/` before leaning on Next behavior.
- No test runner is set up. Verification is manual in the browser.

## Repo map

```
src/
  app/                    Next routes. page.tsx → <EffectsApp/> (whole editor).
    docs/                 In-app documentation (manifest-driven pages).
    live/[slug]/          Hosted live viewer of a public project (control panel UI).
    p/[slug]/             Public editor link (read-only-ish editor of a public project).
    auth/callback/        Supabase OAuth callback.
  engine/                 The render engine. SELF-CONTAINED — see invariant #1.
    types.ts              SocketType/SocketValue/NodeDefinition/RenderContext. READ FIRST.
    gl.ts                 EngineBackend: hidden WebGL2 canvas, texture pool, shader cache,
                          drawFullscreen, blitToCanvas, WebGPU bridge helpers.
    evaluator.ts          evaluateGraph(): flatten → toposort → fingerprint cache → compute.
    coerce.ts             Cross-type socket coercions (mask↔image, image→scalar, audio→scalar…).
    audio-analysis.ts     Shared audio DSP: getAudioFrame() (live AnalyserNode / offline
                          decoded-buffer), radix-2 FFT, band energy, MPM pitch. Feeds the
                          audio→scalar coercion AND the Audio Bands/Pitch/Spectral nodes.
    conventions.ts        Universal opacity param + universal mask input helpers.
    registry.ts           registerNode()/getNodeDef() — a Map, nothing more.
    flatten.ts groups.ts  Node-group/layer dissolution pass + group socket plumbing.
    layout.ts             Auto Layout: layout units + pure Figma-semantics solver.
    element.ts            Element-socket GL helpers: wrap/flatten coercions, positioned
                          source-over compositing, alpha-bbox trim, canvas upload.
    text-raster.ts        Text measure/wrap/draw core shared by the Text node's primary
                          raster and its Auto Layout element (maxWidth = word-wrap).
    keyframes.ts          Tick-based keyframe model + easing + evaluateKeyframesAt.
    clips.ts              Per-node timeline clip windows (gate + local time).
    graph-helpers.ts      Handle-id parsing, param→socket type mapping.
    sdf*.ts, spline-*.ts, points.ts, noise.ts, marching-squares.ts, …  domain math.
  nodes/                  One file per node def. index.ts registers ~130 defs.
    source/ effect/ sdf/ group/ output/
  components/effects/     The editor UI. EffectsApp.tsx is the shell/orchestrator.
    NodeEditor.tsx        xyflow wrapper: wires, validation, splice (drop a node
                          on a wire → A→N→C) + detach-heal (Cmd/Ctrl-drag a
                          clean-inline node out → A→C reconnects), copy/paste, marquee.
                          Shift-drag "fuzzy connect": pull a wire from a socket
                          (or the whole node body — capture-phase interceptor)
                          with Shift held → blue ring + line, drop over any node
                          to land on its first accepting socket (buildShiftDrop-
                          Connection / buildNodeConnection).
    ParamPanel.tsx        Renders ParamDef[] → controls; all custom param-type UIs.
    EffectNode.tsx        The node chrome on the graph canvas (sockets, header, +).
    TrackEditor.tsx / LayersEditor.tsx / PlaybackBar.tsx   timeline UIs.
    *Overlay.tsx, TransformGizmo.tsx, PrimitiveGizmo.tsx   on-canvas editing.
                          SplineEditorOverlay: multi-subpath pen/edit (Pen /
                          Path-Select / Sub-path-Select tools + GUI bbox
                          transform). GradientOverlay: linear/radial/multipoint
                          handles.
  state/
    graph.ts              NodeDataPayload (what lives in each xyflow node's data).
    graph-ops.ts          ALL structural graph mutations (pure functions). New
                          structural logic goes here, not in EffectsApp.
    history.ts            Undo/redo snapshots. editor-session.ts: docs-nav stash.
  lib/
    project.ts            serializeGraph/deserializeGraph, SavedProject SCHEMA (v4).
    project-file.ts       .toolbox zip container (manifest + project.json + assets).
    supabase/             client/server helpers, projects table CRUD, user prefs.
    media-relink.ts       Missing-media handles (video/audio re-pick on load).
    export*.ts            Image/video export, audio mixdown, exported-app manifest+packager.
    live-viewer/          LiveViewer + control panel used by /live and exported apps.
    fonts.ts font-*.ts    Curated + custom font loading, variable-font axis parsing.
    local-fonts.ts        OS-installed fonts via queryLocalFonts (Chromium/desktop);
                          enumerate for the Text picker + read bytes for save-bundling.
    platform/             Platform-adapter seam (web vs Electron) — see "Desktop
                          (Electron) build". index.ts → `platform`; web.ts is
                          today's behavior verbatim; native.ts → window.toolboxNative.
  export-template/        Vite app source for exported standalone apps (built into
                          public/export-template/v1 by scripts/build-export-template.mjs).
electron/                 Electron desktop shell (NOT part of the Next build): main.js,
                          preload.js (the toolboxNative bridge), ffmpeg.js (native
                          export/transcode), files.js (native dialogs), recents.js
                          (Local tab), server.js (embedded standalone Next server).
specdocs/                 Design specs + devlist.md (numbered feature backlog).
```

## Core mental model

A project is `Node<NodeDataPayload>[]` + `Edge[]` (xyflow arrays) held in
React state in EffectsApp. Each frame (rAF while playing; on state change
while paused) EffectsApp calls `evaluateGraph(nodes, edges, ctx, cache,…)`
from [evaluator.ts](../src/engine/evaluator.ts), then blits the terminal
image to the visible preview canvas. The engine renders into a hidden
canvas owned by `EngineBackend` ([gl.ts](../src/engine/gl.ts)); preview
canvases are blit targets only.

**Everything image-like is a full-canvas texture.** `ctx.allocImage()`
returns a canvas-resolution RGBA16F (fallback RGBA8) texture from a pool.
Sources fit/center their content onto the full canvas; the one
intrinsic-size concept that flows through wires is the `element` socket
type (Auto Layout — see [autolayout-node.md](autolayout-node.md)): a
deferred measure/render closure pair, coercible both ways with `image`.
Sub-sized allocs are allowed (`allocImage({width,height})`) and are how
Auto Layout composites containers and children at exact px sizes.

**Node identity of evaluation:** every node def's `compute({inputs, auxIn,
params, ctx, nodeId})` returns `{ primary?, aux? }` of `SocketValue`s.
Wires reference handles `out:primary` / `out:aux:<name>` →
`in:<socketName>` / `in:param:<paramName>`.

### Coordinate conventions (memorize these)

- CPU-side geometry — splines, points, SDF positions, transform params,
  pivot/translate — is **normalized [0,1]², Y-DOWN** (row 0 = top).
- GL textures sample with **v_uv Y-UP** (v=0 at bottom). Nodes/shaders flip
  at the boundary (see the Y-flips in text.ts, image-source.ts,
  marching-squares readback). When pixels look upside down, you missed one.
- The cursor (`ctx.cursor`) is stored **Y-UP** canvas UV (flipped from DOM
  in EffectsApp's pointermove).
- Non-square canvases: normalized coords are anisotropic. Geometry that
  must stay round uses the aspect-correct helpers
  ([aspect.ts](../src/engine/aspect.ts)) / the SDF compiler's
  `u_aspectCorrect` path. New geometry features must decide this
  explicitly.
- Alpha is **straight (non-premultiplied)** throughout;
  `UNPACK_PREMULTIPLY_ALPHA_WEBGL` is explicitly disabled on uploads.
  Compositing is Porter-Duff source-over done manually in shaders
  (see merge.ts BLEND_FS).

### Socket types (src/engine/types.ts)

`image`, `mask`, `uv` (texture-backed, canvas-sized) · `element`
(deferred intrinsically-sized renderable: measure/render closures,
runtime-only like sdf — engine/element.ts owns the GL helpers,
engine/layout.ts the pure solver) · `scalar`, `vec2`,
`vec3`, `vec4` (CPU values) · `string` (plain CPU text — the String node
emits it; any `string` param exposed as an input socket consumes it, e.g.
Text's `text`; no cross-type coercions) · `spline` (multi-subpath cubic
beziers, CPU) ·
`points` (typed-array SoA + lazy `Point[]` view — producers use
`makePoints`/`pointsFromArray`, hot consumers read typed arrays) · `audio`
(live HTMLAudioElement) · `image_group` (ordered ImageValue list; splines/
points instead carry per-item `groupIndex` tags) · particle descriptors
(`force`/`emitter`/`collider` CPU structs + `particles` GPU state textures)
· compile-time ASTs (`sdf`, `position`, `scalar_field`) that do **zero GL
work** until SDF Rasterize compiles the tree to one shader · `render`
(inert organizational link Output→Render Queue).

Coercions ([coerce.ts](../src/engine/coerce.ts)): mask↔image,
scalar→vec2/3/4/uv-broadcast, image/mask→scalar (1×1 readback), audio→
scalar (RMS level, via engine/audio-analysis.ts), image↔element (wrap as
full-canvas element / flatten centered at natural size; identity-cached in
WeakMaps inside engine/element.ts). The UI mirrors this list in `canCoerce`
/ `isValidConnection` (NodeEditor.tsx) — **add new coercions in both
places**. `image→mask` is **luminance × alpha** (coverage-weighted): opaque
grayscale (noise/gradients) reads as its old luminance, but a shape drawn on
transparency (Rectangle/Circle/Text/SVG rasters) mattes by its silhouette,
not by whatever RGB sits in the cleared surround. A dark-*colored* fill still
reads dim — matte with a light fill for a clean cutout.

## The evaluator (what actually happens per frame)

1. `flattenGraph` dissolves node-groups (pure structure) and rewires layer
   interiors onto the layer node's hidden `content` input. Node objects
   pass by reference so param identity survives for caching.
2. Topo sort; `computeNeededSet` walks back from the active/terminal node —
   disconnected branches never compute. `render` edges are ignored here.
3. Per node, in order:
   - Layer-local clock: nodes inside a layer run on
     `globalTick − layerOffset` (AE-style). Clip windows gate output
     (empty value outside the window) and, for Video, remap to clip-local
     time ([clips.ts](../src/engine/clips.ts)).
   - Inputs resolve through `resolveInputs(params, {connectedTypes})` if
     present (polymorphic sockets), get the universal `mask` input appended
     (`withMaskInput`, opt out with `noMaskInput`), and each incoming value
     is coerced to the socket type.
   - Param precedence: **wire (exposed param) > keyframes > stored value**.
     Overrides are merged into `effectiveParams` before compute.
   - Fingerprint = type + bypass + stableStringify(params) + input
     fingerprints + animation block + (`stable:false` ⇒ ctx.time) +
     `fingerprintExtras`. Cache hit ⇒ reuse previous `NodeOutput`
     verbatim, skip compute.
   - Post-passes the evaluator owns: universal mask (the appended `mask`
     input — see conventions.ts). With a base image input wired it **blends**
     `mix(base, output, m)` (reveal an effect through the mask); with none
     (pure sources) it **mattes** `output*m`. A def can force matte-only with
     `noMaskBase` (Text does — its `fill`/`morph_mask` image inputs aren't
     blend bases). Also the universal `opacity` param (declare `OPACITY_PARAM`
     and image outputs fade for free — never implement opacity in a node).
   - `ComputeArgs.consumedOutputs`: the set of this node's output handles
     (`"primary"`, `"aux:<name>"`) that something actually reads this eval
     (wired to an evaluated node, or shown by the viewport). A node can
     skip building expensive outputs nobody consumes — Text gates its JFA
     SDF and marching-squares spline on it so dragging text that only
     feeds an image/element pays nothing for them. Pair with per-output
     validity flags so a now-consumed output recomputes correctly.
4. Terminal image = the active node's image (user can set any node Active /
   Active2 for split viewport) or the first Output node's input. Preview
   fallback shows the selected node's primary or `aux.image`.

### Caching & texture rules (break these → leaks or flicker)

- The pool: `ctx.allocImage/allocMask/allocUv` lease textures;
  `ctx.releaseTexture` returns them. The evaluator releases a cached
  node's textures when the entry is evicted — `ownsTextures:false` marks
  pass-through outputs (bypass, gated layers) that must NOT be released.
- A node that allocates intermediates must release them before returning
  (see merge.ts's chain loop). Never release your *inputs*' textures.
- Texture object identity is stable across cache hits (same `ImageValue`
  object returned). Identity ≠ content for `stable:false` upstreams —
  don't use texture identity to detect content change (see text.ts's
  mask-driven re-render workaround); DO use value-object identity as an
  "upstream recomputed" signal (WeakMap caches keyed on it are sound).
- Per-node persistent state lives in `ctx.state[\`<type>:<nodeId>\`]`,
  created in `compute`/`init`, torn down in `dispose(ctx, nodeId)`.
- `stable: false` = recompute every eval (time/external-state readers).
  Pair with an internal signature cache if compute is expensive (text.ts).
- Async results (font loads, MediaPipe, video frames, image-gen) dispatch
  `window.dispatchEvent(new Event("pipeline-bump"))` — EffectsApp
  rAF-coalesces these into one re-eval.

## NodeDefinition anatomy & the "new node" recipe

Anatomy (all in [types.ts](../src/engine/types.ts), every field
documented there): `type` (immutable once shipped — saves reference it),
`name`, `category` (`image|spline|point|audio|utility|effect|output`) +
`subcategory` (`generator|modifier|utility` for typed categories),
`backend` (`webgl2|webgpu`), `inputs`/`params`/`primaryOutput`/`auxOutputs`
plus dynamic variants (`resolveInputs`, `resolvePrimaryOutput`,
`resolveAuxOutputs` — keyed off params and `connectedTypes`), `compute`,
optional `init`/`dispose`/`fingerprintExtras`/`stable`/`terminal`/
`noMaskInput`/`hidden`, UI hints (`supportsTransformGizmo` — requires the
7 standard transform params; `headerControl` — enum dropdown on the node
header; `linkedPairs` — chain-lock two scalars).

To add a node:
1. Create `src/nodes/<category>/<name>.ts` exporting a `NodeDefinition`.
   Copy the closest existing node — merge.ts (dynamic sockets), transform.ts
   (polymorphic modes), text.ts (heavy state + signature cache), collect.ts
   (group semantics), sdf/* (AST builders).
2. Register it in [src/nodes/index.ts](../src/nodes/index.ts). If renaming
   a type later, keep the old string registered `{...def, type: old,
   hidden: true}` — back-compat with saved projects is mandatory.
3. Params: prefer declared `ParamDef`s (they get keyframing, exposing,
   range-override UI, export controls for free). `visibleIf` for dependent
   rows. Scalars get sliders (use `softMax` for escape-hatch ranges).
4. Shaders: `ctx.getShader("<unique-key>", FS_SOURCE)` (cached by key) +
   `ctx.drawFullscreen(prog, target, setup)`. GLSL 300 es, fullscreen
   triangle provides `v_uv`.
5. If you add a ParamType: types.ts union → ParamPanel renderer →
   keyframes.ts `isKeyframable`? → export-manifest.ts control support? →
   serialization check (plain JSON or media-envelope?). Array params that need
   per-item keyframing (`merge_layers`, `gradient_points`) follow the
   virtual-key pattern: a clone-and-override block in evaluator.ts + an autokey
   mirror in EffectsApp's `onParamChange` + per-item diamonds in ParamPanel —
   copy an existing one.
6. Check the docs page renders it sanely (descriptions come from the def).

## Animation & time

- Master clock: `time` (seconds, wall-clock rAF advance in EffectsApp,
  loops at `loopFrames/fps`). Derived: `frame`, integer `tick`
  (`ticksPerFrame` = 1000/frame). Keyframes & clips store integer ticks —
  exact equality, no float drift. New time code should use ticks.
- Keyframes ([keyframes.ts](../src/engine/keyframes.ts)): per-param
  `KeyframeAnimationBlock` on `node.data.animation`; rich easing presets +
  custom bezier (scalar only); color interpolates in oklab by default.
  Virtual keys animate per-item sub-values of array params (the array param
  itself isn't keyframable): merge-layer opacities (`layer_opacity:<id>`) and
  multipoint-gradient point x/y/color (`gpoint_x/y/c:<id>`). The evaluator
  resolves them onto a cloned array before compute (see conventions.ts + the
  two blocks in evaluator.ts); ParamPanel renders a diamond per item;
  EffectsApp auto-keyframes edits. Color virtual keys store RGBA tuples.
  `Keyframe.value` is `unknown` — most types are scalars/colors/vecs, but
  the whole spline shape keyframes too: Spline Draw's `spline_anchors` param
  is keyframable ("Path Animation" row in ParamPanel), and `interpolate`
  lerps it anchor-by-anchor (pos + handle offsets) between keyframed states.
  The graph editor stays scalar-only; non-scalar tracks just show diamonds.
- Clips: in/out windows on source nodes (`CLIPPABLE_NODE_TYPES`); video is
  the only time-remapped type. Layers use clip windows as their in/out
  bars and offset their interior's clock.
- Timeline UIs: PlaybackBar (transport), TrackEditor (per-param tracks +
  graph editor), LayersEditor (AE-style layer stack at root).

## Groups & layers

- A group is a `node-group` node + interior `group-input`/`group-output`
  boundary nodes (`parentId` = group id; flat arrays, nesting by parentId
  chain). Boundary sockets are user-editable with a Blender-style trailing
  virtual socket (`__virtual__`) that mints real sockets when wired.
  Cmd+G groups a selection; Tab dives in (breadcrumbs top-left).
- Groups are dissolved by the flatten pass at eval — they never compute.
  Layers (root-only group subtype) DO compute (blend-over-stack) and give
  their interior local time. Root scope is a strict layer chain feeding
  Output (since schema v4; older saves auto-wrap into "Layer 1").
- Params deep inside a group can be promoted to its interface
  (`resolvePromotedParams` in graph-ops.ts).
- A layer's interior **Layer Input** node (`group-input`, reserved
  `backdrop`) mints extra sockets like any group. Those surface as real
  input sockets on the layer node in the parent composition via
  `layer.resolveInputs` (reads the synced `interface` param, same as
  `node-group`) — `backdrop` itself stays represented by the exterior
  `stack` input. The flatten pass routes each minted input straight through
  to its interior consumers: `resolveBoundarySource` maps a non-`backdrop`
  Layer Input socket to the same-named exterior input on the layer node (the
  layer shell computes only the blend; these extra inputs are pure
  passthrough). Back-compat: old layers have no `interface`, so they resolve
  to just `stack`/`content`/`audio`.

## Persistence & sharing

- `serializeGraph`/`deserializeGraph` ([project.ts](../src/lib/project.ts)),
  `CURRENT_SCHEMA = 6` — the version history is documented at the top of
  that file; bump it when the wire shape changes and keep loading old ones.
  (v6 renamed Text's `mask` input to `morph_mask` and migrates old
  `in:mask`→`in:morph_mask` edges on load — see below.)
- Media (image bitmaps, paint canvases) inline as data-URLs in cloud saves;
  video/audio don't serialize — they become "missing media" entries
  re-picked via MediaRelinkModal ([media-relink.ts](../src/lib/media-relink.ts)).
- Fonts: uploaded `custom_font` bytes bundle (v5). The Text `font_family`
  picker (`control:"font"`, [param-controls.tsx](../src/lib/param-controls.tsx))
  merges the user's **installed local fonts** ([local-fonts.ts](../src/lib/local-fonts.ts),
  Chromium `queryLocalFonts`) with the curated baseline. A picked local font
  renders by name while editing and **auto-bundles its bytes on save** (best-
  effort — sandboxed/commercial faces fall back to name-reference) under a
  sibling `<param>__fontbundle` envelope that deserialize re-registers under the
  same family. Curated/web families stay name-referenced (resolve via CDN
  anywhere). Offline export pre-warms every Text family before the frame loop so
  the first frames don't capture a fallback face.
- `.toolbox` files ([project-file.ts](../src/lib/project-file.ts)): zip of
  manifest.json + project.json + thumbnail + content-hashed assets/.
- Supabase: auth (AuthProvider), `projects` table (private/public, slugs →
  `/p/[slug]` public editor, `/live/[slug]` live viewer), user preferences,
  image-gen edge function. SQL migrations live as `specdocs/*-migration.sql`.
- Editor state survives the in-app docs round-trip via a module-level
  stash ([editor-session.ts](../src/state/editor-session.ts)) — not
  sessionStorage (bitmaps/canvases don't structure-clone).

## Export

- Image: png/jpeg/webp snapshot of an Output. Video tiers on the Output
  node: **fast** (MediaRecorder live capture), **high** (WebCodecs +
  mediabunny, frame-stepped offline), **max** (ffmpeg.wasm — ProRes/H.265/
  lossless). Offline renders set `ctx.offline = true`: nodes with deferred
  async GPU work MUST settle synchronously then (see offline-settle.ts and
  the `offline` flag docs in types.ts). Audio mixes down via
  export-audio.ts. Render Queue node batches multiple Outputs.
  - **ProRes alpha**: the `videoAlpha` Output param (shown for max-tier
    ProRes on the 4444/4444xq profiles, default on) drives `prores_ks` to
    `yuva444p10le` + explicit `-alpha_bits 16` (export-ffmpeg.ts). The
    `-alpha_bits 16` is load-bearing — without it some ffmpeg builds drop
    the channel even with a yuva pixel format. Capture preserves straight
    alpha end-to-end: the WebGL2 context is `premultipliedAlpha:false` and
    `blitToCanvas` (gl.ts) disables `BLEND` so the present doesn't flatten
    transparency over its opaque-black clear before the PNG-frame capture.
- The Output node's animated export has an `exportMode` param (**video** /
  **sequence** / **gif**, a segmented pill — `ParamDef.control: "segmented"`).
  Sequence = one still per frame (`exportSequence` in EffectsApp), delivered
  per `seqDelivery` (zip / folder / sequential — same machinery as the Render
  Queue's `delivery`). Both modes share a **start/end frame range**
  (`startFrame`/`endFrame`, half-open `[start, end)`), which replaced the
  legacy `videoFrames` duration — old saves migrate in `migrateLoadedParams`
  (project.ts). `resolveFrameRange()` derives the range (with `videoFrames`
  fallback) for all exporters. Spec: 061726_png-sequence-export.md.
- **GIF** (`exportMode: "gif"`, `exportGif` in EffectsApp → export-gif.ts):
  same frame-stepped offline scaffold as high/max video, but frames go through
  ffmpeg.wasm palettegen/paletteuse (reuses the `getFfmpeg` singleton from
  export-ffmpeg.ts) for palette size (`gifColors`), dithering (`gifDither`),
  and 1-bit transparency (`gifTransparent`); then gifsicle-wasm ALWAYS runs a
  normalize pass (adds `--lossy` when `gifLossy > 0`). The normalize is not
  optional: raw ffmpeg palettegen GIFs render in browsers but macOS
  Preview/Quick Look rejects them — gifsicle's output opens there. Opaque GIFs
  use `-O3`; **transparent GIFs use `--unoptimize --disposal=background`** —
  macOS ImageIO chokes on inter-frame transparency + "leave previous"
  disposal, so transparent frames are expanded to self-contained full frames
  with restore-to-background disposal (larger, but Preview opens them). Falls
  back to the raw ffmpeg GIF if gifsicle fails. Spec: 061826_gif-export-and-image-sequence.md.
- Exported apps: `buildExportManifest` walks the graph for params marked
  `controlParams` (per-node "user controllable" flags) → manifest of
  panel controls + file inputs; export-packager.ts zips the prebuilt Vite
  template (public/export-template/v1) with project.json + assets. The
  same manifest powers `/live/[slug]` via lib/live-viewer/LiveViewer.tsx.
  **This is why src/engine + src/nodes must stay self-contained.**

## Desktop (Electron) build

The app ships as **both** the web app and a native **Electron desktop app**
(**macOS** arm64 + **Windows** x64) from one codebase. The desktop build's only
behavioral differences: heavy export runs through **native ffmpeg** (no wasm
heap/thread limits), file open/save use **native OS dialogs**, and it works
**offline**. Full design: 062626_electron-native-export.md; the Windows target +
native window controls: 070626_windows-desktop-build.md.

- **The seam is `src/lib/platform`** (`platform` from index.ts). Feature code
  calls `platform.saveFile(...)` / `platform.encodeVideo?.(...)` / etc. and
  **never branches on web-vs-native itself**. `web.ts` is today's behavior
  verbatim (so the web target can't regress); `native.ts` forwards to the
  `window.toolboxNative` bridge. `platform.isNative` is detected by the bridge's
  presence. Capabilities that are native-only (`encodeVideo`, `windowControls`,
  `recents`, `transcodeVideoForPlayback`) are **optional** on the interface;
  callers gate on them. UI that renders differently on desktop detects native
  **post-mount** (`useEffect`) to avoid SSR hydration mismatches (MenuBar,
  LoadGrid). `src/engine` + `src/nodes` stay platform-agnostic (invariant #1).
- **How it's served.** `electron/main.js` loads `TOOLBOX_DEV_URL` (dev) or, by
  default, spawns the app's own **Next standalone server** (`electron/server.js`,
  via `ELECTRON_RUN_AS_NODE`) on `127.0.0.1:38274` and loads that. So the desktop
  app is self-contained/offline-capable but still talks to Supabase over the
  network when online. `output:'standalone'` is gated behind `DESKTOP_BUILD=1`
  (next.config.ts) so the Vercel/web build is unchanged.
- **The bridge** (`electron/preload.js`, contextIsolation + sandbox, no
  nodeIntegration): narrow, intent-level methods only — `saveFile`,
  `pickSaveFolder`/`writeFileInFolder`, `pickOpenFiles`, `encodeVideo*`,
  `transcodeForPlayback`, `window.*` (controls), `recents.*`. Paths are chosen by
  native dialogs in main, never supplied by the page; bytes cross as ArrayBuffer.
- **Native export** (`electron/ffmpeg.js`): the renderer keeps the frame loop
  (engine settle), reads RGBA8 per frame and streams it to a bundled
  `ffmpeg-static` process via **rawvideo on stdin** (`await`-per-frame
  backpressure), written straight to the chosen path. Encoder/ProRes/alpha args
  are the **single source of truth** in `src/lib/export-ffmpeg-args.js`, shared
  by this and the wasm path (export-ffmpeg.ts). Only the standalone Export's
  heavy tier routes native; Render Queue still uses wasm.
- **Transcode-on-import**: Electron's Chromium decodes fewer codecs than a
  system browser, so undecodable videos (10-bit/4:2:2 H.264, HEVC, ProRes) fail
  with `MediaError code 4`. `registerVideoFile` (lib/video.ts) falls back to
  native ffmpeg: 10-bit→VP9 profile 2 (preserves gradients), 8-bit→H.264.
- **Native file I/O + Local tab.** Save/open/folder go through native dialogs.
  Recents are **main-owned** (`electron/recents.js`, userData JSON — survives
  restarts/rebuilds, validates which paths the renderer may read) and recorded
  automatically whenever a `.toolbox` path is opened/saved (by extension). The
  desktop-only **Local** tab lives in LoadGrid (so it shows in both the landing
  modal and the menu→Projects view); `loadToolboxFile` in EffectsApp is the
  shared open path.
- **Frameless window**: `frame:false`; the nav bar IS the title bar — MenuBar
  (and the Landing screen) render `WindowControls`, which branches on
  **`platform.os`** (surfaced from the bridge's `process.platform`): macOS
  traffic lights on the **left** (close/min/fullscreen), or Windows caption
  buttons flush in the **top-right** (min/maximize-restore/close, Segoe Fluent
  Icons glyphs). All controls go through `platform.windowControls`
  (`minimize`/`toggleMaximize`/`toggleFullscreen`/`close` + `isMaximized`/
  `onMaximizeChange` so the maximize↔restore glyph tracks native maximize —
  Snap, Win+Up). `-webkit-app-region` (drag on the spacer, no-drag on controls;
  the CSS prop is augmented in src/types/css.d.ts). `backgroundThrottling:false`
  so rAF/timers aren't throttled (real-time tool). Spec:
  070626_windows-desktop-build.md.
- **Graceful offline**: auth uses `getSession()` (local cache, "signed in
  offline") not `getUser()`; project lists fail-fast (timeout + `navigator.onLine`
  + try/catch → empty/cached). Local files + native export work fully offline;
  curated/web fonts, ML/tracker nodes, and wasm-GIF still need network
  (accepted). Installed local fonts (desktop is Chromium → `queryLocalFonts`)
  work offline and are the preferred picker source there.
- **Build/run.** `npm run dev:desktop` (one command: next dev + Electron) for UI
  iteration; `npm run electron`/`electron:dev` for embedded/dev URLs;
  `npm run desktop:prepare` builds `.next/standalone`; `npm run desktop:build`
  packages the mac dmg, `npm run desktop:build:win` the Windows NSIS installer
  (`:publish`/`:publish:win` variants add `-p always` to upload to GitHub
  Releases). NOTE: `npm run electron` serves the **prebuilt** `.next/standalone`
  — re-run `desktop:prepare` to see source changes there (dev:desktop uses live
  HMR). On Windows, dev via `dev:desktop` or `electron` (`electron:dev`'s bash
  env-prefix is mac-only).
- **Packaging gotchas** (electron-builder, package.json `build`): pin
  `mac.target` arch to **arm64** (it targets the build host's node arch, and the
  studio node is x64-under-Rosetta → wrong-arch app runs slow). `ffmpeg-static`
  installs per node arch too — force arm64 if node is x64
  (`npm_config_arch=arm64 node node_modules/ffmpeg-static/install.js`); the real
  fix is a native arm64 node. The standalone is bundled via **`files` +
  `asarUnpack`** (not `extraResources`, which silently strips top-level
  `node_modules`); server path → `Resources/app.asar.unpacked/.next/standalone`.
  Builds are unsigned (`identity:null`) → Gatekeeper warns; notarization is TODO.
  OAuth on desktop needs `http://127.0.0.1:38274/auth/callback` allowlisted in
  Supabase.
  - **Windows** (`build.win` = nsis/x64, `build.nsis` = assisted installer,
    `build/icon.ico`): the shared `files`/`asarUnpack`/`publish` config applies
    as-is; `npm ci` on a Windows runner fetches the win32 `ffmpeg.exe`
    automatically. Currently **unsigned** → users bypass a SmartScreen "unknown
    publisher" prompt (signing is wired-ready but deferred; no arm64 target
    yet). CI (`.github/workflows/release.yml`) is three jobs on a `v*` tag:
    `ensure-release` (ubuntu, pre-creates the Release so the two OS jobs don't
    race to create it), `build-mac` (macos-14, signed/notarized dmg), `build-win`
    (windows-latest, unsigned nsis exe). Both build jobs `needs: ensure-release`.

## Invariants — do not break

1. **Engine self-containment**: nothing under `src/engine/` or
   `src/nodes/` may import from `src/components/`, `src/state/`, or
   `src/lib/` (except engine-internal helpers) — the export bundle copies
   the engine subtree verbatim. Shared helpers live engine-side
   (see graph-helpers.ts, groups.ts precedents).
2. **Saved-project back-compat**: never repurpose a node `type` string, a
   param name, or handle format without a load alias/migration. Schema
   bumps documented in project.ts.
3. **Texture discipline**: release what you alloc, never what you receive;
   respect `ownsTextures` semantics if you touch the evaluator.
4. **Coordinate/alpha conventions** (§ Core mental model). Flip Y at
   boundaries; straight alpha; aspect-correct geometry deliberately.
5. **Structural graph edits go in graph-ops.ts** as pure functions;
   EffectsApp applies results. Param-only updates flow through the
   ParamPanel onChange path (which handles undo snapshots + autokey).
6. **Don't bypass the universal conventions** — opacity param, mask input,
   wire>keyframe>constant precedence — they're applied by the evaluator,
   not by nodes.
7. **Type changes ripple**: SocketType additions touch types.ts, coerce.ts,
   socketColor.ts, NodeEditor validation (×2 places), clips.ts
   emptyClipOutput, and possibly the docs/colors legend.

## Specdocs & process

`specdocs/devlist.md` is the numbered feature backlog (currently ~145
items) written in the owner's voice; features get a dedicated spec doc
when designed (e.g. layers-groups-attributes.md, webgpu-particles.md,
timelinespec / updatedtimelinespecv2.md, sdf-nodes.md,
autolayout-node.md). The flow that works: read the devlist entry →
explore the relevant engine/UI code → write/iterate a spec with the owner
→ implement in milestones. In-app user-facing docs live under
src/app/docs + lib/docs/manifest.

## Known sharp edges (today)

- EffectsApp.tsx (~7.2k lines) and ParamPanel.tsx (~5.6k) are the two
  monoliths; prefer extracting logic (graph-ops pattern) over growing them.
- WebGL↔WebGPU interop is CPU-mediated (Float32Array hop) — fine ≤ ~1MB.
- `image-source` fit happens at source; original bitmap dimensions are
  not recoverable downstream of the image output — but the node's
  `element` aux output carries true bitmap dimensions into Auto Layout.
  Sources with an `element` aux (Image Source, Frame, Circle, Rectangle,
  Text) auto-redirect a primary-image wire dropped on an Auto Layout slot
  to that aux, so the layout gets raw intrinsic content with no upstream
  canvas fit baked in. Image/spline elements measure aspect-aware
  (`aspectFitMeasure` in engine/element.ts) so they hold ratio as the
  layout resizes; Frame is the fixed-box escape hatch.
- Text lays out inside a text box (boxWidth/boxHeight params, fractions
  of canvas, default 1×1 = full canvas; position rides translateX/Y).
  Primary raster wraps on explicit `\n` always, plus at the box width
  when "Wrap in box" is on; the `element` aux output word-wraps under
  layout constraints regardless. Text and Auto Layout use the bounds
  gizmo (PRIMITIVE_GIZMO_ADAPTERS, anchored resize) — the symmetric
  TransformGizmo is only Transform + SVG Source now.
- Text is `stable:false`, so anything downstream of it (Auto Layout
  included) recomputes per frame during playback — same cost profile as
  Text→Merge today. Paused/param-edit evals cache normally.
- **Text has two mask-ish inputs, don't confuse them.** The pink `mask`
  socket is the universal matte (appended by withMaskInput; matte-only via
  `noMaskBase`) — wire a shape/image in to cut the text to it. The blue
  `morph_mask` socket (a plain `image` input, labelled "Morph") is the
  variable-font morph driver, consumed only when an axis is in maskDriven
  mode. `morph_mask` was named `mask` pre-v6 — that's why the schema bumped
  and old `in:mask` Text edges migrate to `in:morph_mask` on load.
- **Text on Path** (spec 062526_node-expansion §4): wire a spline into the
  Text node's `path` input to lay glyphs along it. It's built into the Text
  node — no separate node — reusing the raster stack. `path_enabled` (default
  on, doubles as the collapsible group header + off-switch) gates it;
  `path_align`/`path_offset`/`path_side`/`path_flip` tune the run. The engine
  side is `drawGlyphsAlongPath` in [text-raster.ts](../src/engine/text-raster.ts):
  it forces the modulated per-glyph draw, builds a **canvas-pixel** arc-length
  table from the spline (`buildPathSampler` — measured in px, not the spline's
  anisotropic normalized length, so advances map right on non-square canvases),
  and draws each glyph centred + rotated to the path tangent. Animator glyph
  transforms stack on top. A wired path forces a per-frame re-raster (`livePath`,
  like `liveMask`) since CPU splines can animate and can't be diffed by texture
  identity. Scope: primary raster only (the `element` output stays box layout);
  subpaths concatenate into one arc-length domain; no word-wrap in path mode.
- Video/audio params don't serialize; relink flow covers them. Fonts DO now
  (custom + picked-local bundle their bytes — see "Persistence & sharing").
- **Video Source has two source kinds** (`source_kind`: video / sequence). The
  sequence kind plays numbered stills as frames: `image_sequence` param type
  (`ImageSequenceParamValue` = encoded frame Blobs + numbering bounds);
  `registerImageSequence` (lib/image-sequence.ts) parses each filename's
  trailing integer and sorts. Playback maps scene time → frame via `seq_fps`,
  **honors numbering gaps** (forward-filled `resolved[]` holds the previous
  frame), and decodes lazily into a small per-node LRU texture cache (offline
  export settles on the in-flight `createImageBitmap` like a video seek).
  Sequences are NOT serialized — project.ts stores a frame descriptor only;
  the multi-file relink re-pick UI is still a TODO, so a saved sequence loads
  empty and is re-picked in the panel. Spec: 061826_gif-export-and-image-sequence.md.
  The video kind also exposes an **`audio` aux output** (via
  `resolveAuxOutputs`; hidden for the sequence kind) carrying the `<video>`
  element as an `AudioValue` (`source: "video"`). The element is created
  `muted` (lib/video.ts) and the node un-mutes it (honoring a `volume` param)
  only while that output is wired into the Output node's `audio` socket —
  same `ctx.audioRoutedToOutput` gate as Audio Source, except routing is now
  detected on `out:aux:audio` too (evaluator.ts). `AudioValue.element` widened
  to `HTMLMediaElement` and `source` gained `"video"` (coerce's audio→scalar
  analyser tap treats it like a file element). Offline export decodes the
  audio track straight from the video's ObjectURL via `decodeAudioData`
  (`ExportAudioSpec` now carries `url`/`element`, not a typed file value).
- **Audio analysis nodes** (Audio Bands, Audio Pitch, Audio Spectral) all
  read through `getAudioFrame` ([audio-analysis.ts](../src/engine/audio-analysis.ts)),
  which has two backends behind one API: **live** taps the per-element
  `AnalyserNode` (one per element, shared with the audio→scalar RMS
  coercion); **offline** (`ctx.offline`) decodes the source URL to an
  `AudioBuffer` once and slices the fftSize window centered on
  `element.currentTime` (the Audio/Video Source seeks it deterministically
  each frame, so it's the authoritative playhead). The one-time decode is
  async but `getAudioFrame` is sync, so the first offline frame kicks the
  decode, registers an **offline-settle** promise, and returns null (nodes
  emit rest values); the export driver's settle→re-render pass then captures
  real data. Frames are cached per element per `ctx.frame` so all consumers
  on one source share a single read/FFT. Mic input has no offline form
  (returns null). All three nodes are `stable:false` (like LFO); Bands/Pitch
  keep smoothing/glide state in `ctx.state`; Spectral caches its lookup
  texture there (deleted in `dispose`). No new SocketType — outputs are
  `scalar`/`image`. Spec: 062926_audio-analysis.md.
- **Serialize/deserialize progress is throttled** to ~5% buckets
  ([project.ts](../src/lib/project.ts)). The progress callback does a React
  `setState`; firing it once-per-node inside serialize's tight async loop on a
  large graph blew past React's nested-update limit → "Maximum update depth
  exceeded" thrown out of `serializeGraph` → **save crashed**. Don't revert to
  per-node progress. (The collateral symptom was the error getting blamed on
  unrelated pointermove `setState`s.)
- **Image fill for shapes**: the spline rasterizers (Spline Draw, Circle,
  Rectangle, SVG Source, Spline Boolean, Rasterize Spline) and Text take an
  optional `fill` **image** input (reuses the `image` socket; mask/element
  coerce in) with a `fill_fit` enum (window / contain / cover). The fill
  region is rendered as a coverage mask and composited with the sampled image
  (stroke over fill) by the shared [spline-fill.ts](../src/engine/spline-fill.ts)
  `compositeSplineFill` — `spline-raster-aux` routes through it too. Text has
  its own glyph-coverage variant (`fillMode: "image"`, fill over stroke). The
  Auto-Layout `element` output keeps flat fill (deferred CPU render, no input
  texture).
- **Overlapping-spline compositing** (spec 070526; the Copy-to-Points→Rasterize
  flow). Three knobs: (1) **Spline Merge** node ([spline-merge.ts](../src/nodes/effect/spline-merge.ts))
  — single-input self-combine of all subpaths of ONE spline via
  `splineSelfMerge` in [engine/spline-boolean.ts](../src/engine/spline-boolean.ts)
  (union = merged silhouette, vs. `splineToGeom`'s even-odd XOR of subpaths;
  also intersect/exclude). Union treats each subpath as solid, so intra-shape
  holes fill in. (2) Rasterize Spline's **`overlap`** param: `flatten` (legacy —
  all fills then all strokes, the "x-ray") vs `layered` (per-subpath fill+stroke
  in draw order, so a later shape occludes earlier strokes). (3) Rasterize
  Spline's **`fill_source: ramp`** — per-subpath fill color from a `color_ramp`,
  indexed by `ramp_by` (index / seeded random / groupIndex). Ramp sampling is
  the CPU helper `sampleColorRamp` in the engine-side [color-ramp.ts](../src/engine/color-ramp.ts)
  (where `ColorRampStop`/`COLOR_RAMP_MAX_STOPS` now canonically live — the Color
  Ramp node re-exports them). A wired `fill` image still overrides the ramp.
- **Contextual Delete** uses [shortcut-scope.ts](../src/components/effects/shortcut-scope.ts)
  (the last-clicked scoped region wins). It tracks BOTH `pointerdown` and
  `mousedown` in capture phase: overlay handlers that `preventDefault()` their
  pointerdown suppress the compat mousedown, so without the pointerdown
  listener a click on a spline point wouldn't claim the `"spline"` scope and
  Delete would remove the graph node instead of the point.
- **Browser-ML nodes (bg-remove / Segment / Depth Anything) never run
  inference in `compute`.** Heavy work (HF Transformers.js) runs from the
  custom param panel and writes results into a **session store** parked on
  `globalThis` ([segment-session.ts](../src/lib/ai/segment-session.ts),
  [depth-session.ts](../src/lib/ai/depth-session.ts)); `compute` only resolves
  which bitmap applies at `ctx.frame`, uploads it, and runs a shader. Two
  modes: a **live** single-frame result (Preview / dot-click) and a **bake** —
  per-frame PNG cache over an in/out range, driven by EffectsApp's generic
  `captureNodeFrames` frame-stepper, LRU-decoded on playback, settled into the
  offline-export queue (`pushMediaSettle`) for frame accuracy. Invariants when
  adding/maintaining one: (a) bakes are **session-only**, deliberately not
  serialized — params save, the cache doesn't, so reopen → re-bake; (b) key
  baked frames by the node's **scoped** clock (`recordScopedFrame`/
  `getScopedFrame`), trusting it only if it advanced across the capture, or a
  node inside an offset layer freezes at frame 0; (c) fold the session
  `version` + per-frame readiness into `fingerprintExtras` so a static chain
  caches as a constant and a baked range re-fingerprints only per frame.
  Depth Anything specifics in 061926_depth-anything-node.md (incl. the
  per-frame normalization flicker caveat for video).
- **Dynamic input sockets — two patterns.** (1) *Param-backed* (Merge's
  `merge_layers`, Render Queue's `render_queue`, Collect's `count`): the
  socket list lives in a param and `resolveInputs(params)` derives sockets
  from it; the UI re-syncs `data.inputs` on param change. Growth is a
  manual `+` (an `effect-node-toggle` event). (2) *Auto-grow from edges*
  (Proximity Join/Merge — 070126_proximity-join-merge.md): a `slots:
  string[]` param whose value is **derived from the node's edges** by a
  dedicated `useEffect` in EffectsApp keyed on `edges`, kept equal to
  (connected sockets) + one trailing empty spare. Wiring the spare mints
  the next; disconnecting prunes. It's undo-safe *because* it's derived
  (edges are in history) and writes `data.inputs` without a `pushGraph`
  snapshot. Why not just read `connectedTypes` in `resolveInputs`? Because
  the UI socket-refresh path (`refreshNodeSockets`, the param-change
  handlers) calls `resolveInputs(params)` **without** a `ResolveCtx` —
  `connectedTypes` is populated only inside the evaluator — so any
  connection-driven socket *rendering* must be param-backed, not
  connectedTypes-driven. (connectedTypes is still the right tool for
  socket *retyping*, e.g. Math/Transform/Displace.) **Caveat for mode-less
  poly nodes:** Math/Copy-to-Points anchor their retype on a stored `mode`
  param (onConnect flips it), so their sockets stay correct across refreshes.
  **Transform and Displace have NO mode param** — they retype inputs *and*
  primary output purely from `connectedTypes`. Nothing in the generic UI
  refresh hands those resolvers a `connectedTypes` map, so their stored
  `data.primaryOutput` would sit at "image" forever — the engine displaces a
  wired spline fine, but you couldn't wire the *output* into a spline consumer
  (and the param-change handler re-reset it every edit). Fixed by a dedicated
  edges + output-type-signature-keyed `useEffect` in EffectsApp
  (`CONNECTED_TYPE_RETYPE_NODES`) that recomputes their `connectedTypes` from
  the current graph (small fixpoint for chains) and writes the resolved
  inputs/primaryOutput/aux back into `data`; the param-change path skips
  re-resolving these two so it can't clobber it. Add any future mode-less
  connectedTypes-retyping node to that set.
- **Simulation Zone is a Start/End pair sharing a `zone_id`** (minted at
  create time in EffectsApp; re-minted on clone in graph-ops). It's a
  per-frame feedback loop: End stashes its `state` input in
  `ctx.state[\`sim-zone:<id>\`]`, Start emits it next frame (or re-seeds
  from `initial` on frame 0 / a scene-time wrap). Both halves resolve the
  **same** state blob, so they MUST agree on `kind`
  (`image | points | spline`) — a mismatch makes `ensureZoneState` tear
  down and reallocate every frame. Because of that, a `kind` edit on
  either half is mirrored to its partner (matched by `zone_id`) inside
  `onParamChange` — the one place param edits fan out to a *second* node.
  Kinds: `image` ping-pongs two persistent textures; `points`/`spline`
  are CPU values retained by reference (points as a typed-array
  `PointsValue`, not the `Point[]` view — the sim hot path never
  round-trips). Empty zones emit the frozen `EMPTY_POINTS` sentinel, which
  `ensurePointArray` short-circuits (count 0) so it's never mutated.
- No automated tests; keep modules pure where possible (layout solver,
  graph-ops) so they're testable when a runner lands.
