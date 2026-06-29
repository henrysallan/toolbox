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
    NodeEditor.tsx        xyflow wrapper: wires, validation, splice, copy/paste, marquee.
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
    fonts.ts font-*.ts    Curated font loading, variable-font axis parsing.
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
`vec3`, `vec4` (CPU values) · `spline` (multi-subpath cubic beziers, CPU) ·
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
scalar (RMS level), image↔element (wrap as full-canvas element / flatten
centered at natural size; identity-cached in WeakMaps inside
engine/element.ts). The UI mirrors this list in `canCoerce` /
`isValidConnection` (NodeEditor.tsx) — **add new coercions in both
places**.

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
   - Post-passes the evaluator owns: universal mask blend, universal
     `opacity` param (declare `OPACITY_PARAM` and image outputs fade for
     free — never implement opacity in a node).
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

## Persistence & sharing

- `serializeGraph`/`deserializeGraph` ([project.ts](../src/lib/project.ts)),
  `CURRENT_SCHEMA = 4` — the version history is documented at the top of
  that file; bump it when the wire shape changes and keep loading old ones.
- Media (image bitmaps, paint canvases) inline as data-URLs in cloud saves;
  video/audio/fonts don't serialize — they become "missing media" entries
  re-picked via MediaRelinkModal ([media-relink.ts](../src/lib/media-relink.ts)).
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

The app ships as **both** the web app and a **macOS Electron app** from one
codebase. The desktop build's only behavioral differences: heavy export runs
through **native ffmpeg** (no wasm heap/thread limits), file open/save use
**native OS dialogs**, and it works **offline**. Full design:
062626_electron-native-export.md.

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
  draws custom traffic lights (close/min/fullscreen via `platform.windowControls`)
  and uses `-webkit-app-region` (drag on the spacer, no-drag on controls; the
  CSS prop is augmented in src/types/css.d.ts). `backgroundThrottling:false` so
  rAF/timers aren't throttled (real-time tool).
- **Graceful offline**: auth uses `getSession()` (local cache, "signed in
  offline") not `getUser()`; project lists fail-fast (timeout + `navigator.onLine`
  + try/catch → empty/cached). Local files + native export work fully offline;
  curated fonts, ML/tracker nodes, and wasm-GIF still need network (accepted).
- **Build/run.** `npm run dev:desktop` (one command: next dev + Electron) for UI
  iteration; `npm run electron`/`electron:dev` for embedded/dev URLs;
  `npm run desktop:prepare` builds `.next/standalone`; `npm run desktop:build`
  packages the dmg. NOTE: `npm run electron` serves the **prebuilt**
  `.next/standalone` — re-run `desktop:prepare` to see source changes there
  (dev:desktop uses live HMR).
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
- Video/audio/font params don't serialize; relink flow covers them.
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
- No automated tests; keep modules pure where possible (layout solver,
  graph-ops) so they're testable when a runner lands.
