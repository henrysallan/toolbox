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
                          drawFullscreen, blitToCanvas, readImagePixels (CPU pixel
                          readbacks — FBO + readPixels; never blitToCanvas+getImageData,
                          which resizes the context's canvas), WebGPU bridge helpers.
    evaluator.ts          evaluateGraph(): flatten → toposort → fingerprint cache → compute.
    coerce.ts             Cross-type socket coercions (mask↔image, image→scalar, audio→scalar…).
    audio-analysis.ts     Shared audio DSP: getAudioFrame() (live AnalyserNode / offline
                          decoded-buffer), radix-2 FFT, band energy, MPM pitch. Feeds the
                          audio→scalar coercion AND the Audio Bands/Pitch/Spectral nodes.
    conventions.ts        Universal opacity param + universal mask input helpers.
    exr/                  OpenEXR import: vendored EXRLoader fork (exr-core.js,
                          multilayer/DWA fixes), layer grouping, worker decode
                          pool. See "EXR import + color pipeline" sharp edge.
    registry.ts           registerNode()/getNodeDef() — a Map, nothing more.
    flatten.ts groups.ts  Node-group/layer/reroute dissolution pass + group socket
                          plumbing (reroute = a dot-rendered passthrough node
                          spliced out at eval; archive/071326_reroute-node.md). Also
                          extracts Iterate interiors wholesale (they evaluate
                          privately in the shell's compute — see § Groups &
                          layers and archive/071826_iterate-node.md).
    layout.ts             Auto Layout: layout units + pure Figma-semantics solver.
    element.ts            Element-socket GL helpers: wrap/flatten coercions, positioned
                          source-over compositing, alpha-bbox trim, canvas upload.
    text-raster.ts        Text measure/wrap/draw core shared by the Text node's primary
                          raster and its Auto Layout element (maxWidth = word-wrap).
    keyframes.ts          Tick-based keyframe model + easing + evaluateKeyframesAt.
    clips.ts              Per-node timeline clip windows (gate + local time).
    graph-helpers.ts      Handle-id parsing, param→socket type mapping.
    sdf*.ts, spline-*.ts, points.ts, noise.ts, marching-squares.ts, …  domain math.
    voronoi-geometry.ts   pcg3d integer hash (bit-exact GLSL↔TS mirror — the
                          only hash allowed where CPU geometry must overlay a
                          shader render) + shared Voronoi diagram derivation
                          (cells/edges/vertices/centers/neighbors) behind the
                          unified Voronoi node's three sources; Fracture is a
                          hidden legacy registration of the same def
                          (073026_voronoi-unified.md).
    sim-kernel.ts         Shared CPU sim kernel (force/collider ports, chamfer
                          mask fields, property-map readbacks, spatial hash) —
                          Rope + Rigid Body Simulators both ride it.
    vector-kernel.ts      Facade + SplineValue↔PathData adapter over the
                          kurbo/WASM geometry kernel (rust/toolbox-vector-
                          kernel → src/wasm/pkg, binary fetched from
                          public/wasm/v1). Lazy main-thread init; converts
                          to canvas px (normalized space is anisotropic);
                          input shaping notes in the spec are load-bearing.
                          Drives the Optimize Path node. Spec:
                          archive/attractor-vector-kernel-spec.md.
    driver-reduce.ts      Shared luminance-driver box reduce + readback (mask
                          .r or image luminance × alpha → small grid) feeding
                          the CPU-authoritative grid nodes: Adaptive Pixelate
                          (072326_adaptive-pixelate.md) and Bento Slice
                          (072326_bento-slice.md — sliced-image assemble/split
                          animation: bento binary cuts, per-piece seeded
                          scatter × fac, N-step staircase w/ keyframe easing,
                          instanced quad render, animated points aux).
    velocity-field.ts     THE velocity-field wire convention (signed-RG
                          image, midlevel 0.5, Y-DOWN, isotropic canvas-
                          width units) + encode/decode GLSL. Read its
                          header before producing/consuming flow fields
                          (072526_flow-fields.md).
    poisson.ts            Multigrid Poisson/Laplace solver over pool
                          textures (cascadic schedule, fluid-sim Jacobi
                          convention, Dirichlet mask + optional h²·div
                          RHS). Diffusion Curves' color + blur-map
                          solves (072726_diffusion-curves.md); generic
                          for any future Poisson-editing node.
    convolve/             THE convolution backend behind the Blur node
                          (080226_blur-convolution.md). One execution
                          shape — N separable passes + weighted
                          recombine — serving every kernel family, so
                          Gaussian / complex-separable bokeh / (M2)
                          low-rank SVD are plan BUILDERS, not separate
                          nodes. boundary.ts is the ONLY place the
                          engine's alpha + colour conventions are
                          converted for filtering: premultiply in,
                          un-premultiply out (straight-alpha
                          convolution is why the old blur darkened soft
                          edges), plus optional sRGB↔linear — optional
                          because there is no pipeline-wide working
                          space, so an EXR/ACES graph is already linear
                          and must not be transformed twice. complex.ts
                          FITS its coefficients (least squares against a
                          target radial profile) instead of shipping a
                          table, which is what makes disc/ring/soft one
                          solver. Read its header before touching the
                          fit — the (a,b) search needs the
                          coordinate-descent refinement or it stops
                          being monotonic in component count. Clamp
                          alpha low on output: hard kernels ring
                          negative, and negative coverage breaks
                          source-over downstream. svd.ts is the second
                          plan builder — power iteration + deflation
                          for the top-r rank-1 terms, deterministic
                          init (a random one would desync the
                          fingerprint cache) — serving BOTH the
                          non-circular bokeh apertures (kernels.ts
                          rasterizes them; the phasor basis can only
                          express functions of r²) and Convolve mode's
                          user kernel images. Its header owns THE
                          orientation rule: screen-order kernel in,
                          exactly ONE axis (columns) reversed, because
                          on the row axis the convolution flip and the
                          screen-down/UV-up flip cancel. Get that wrong
                          and only an ASYMMETRIC kernel reveals it.
  nodes/                  One file per node def. index.ts registers ~130 defs.
    source/ effect/ sdf/ group/ output/
    effect/physarum.ts    The one node that draws GEOMETRY inside a sim step:
                          agents live in RGBA32F ping-pong textures (16F's
                          ~1px resolution at 1000 quantises visibly), and
                          the deposit is an additive gl.POINTS draw into a
                          16F texture — WebGL2's stand-in for the compute-
                          shader atomicAdd the reference uses. 16F for the
                          field is deliberate: half-float is core-blendable
                          AND core-linear-filterable, where 32F needs
                          EXT_float_blend / OES_texture_float_linear. Copy
                          it if you need per-agent scatter rather than
                          fullscreen passes. Its two normalisation notes
                          (Poisson deposit correction; diffusion radius
                          coupled to distance scale) generalise to any
                          agent-deposit sim — archive/080226_physarum.md §2.
  components/effects/     The editor UI. EffectsApp.tsx is the shell/orchestrator.
    layout/               Blender-style tiled window layout (072726_window-tiling.md,
                          complete): model.ts (split-tree data + presets +
                          computeRects), ops.ts (pure tree ops — the graph-ops
                          pattern), LayoutRegion.tsx (renders leaves as FLAT
                          absolutely-positioned siblings — panels never nest, so
                          tree changes never remount content; percentage rects =
                          SSR-safe; owns the PANEL_FRAME/PANEL_GAP chrome + gutter
                          divider resize), PanelKindMenu.tsx (per-panel editor-kind
                          chip). Every leaf shows Viewport / Node Editor /
                          Parameters / Timeline (PANEL_KINDS in model.ts is the
                          single source of truth — menu + both validators read
                          it); duplicates are legal. ONE viewport leaf is
                          PRIMARY (sticky, see below) — it owns canvasRef,
                          every overlay/gizmo and the Shift+S A/B
                          split (the kind menu refuses to retire the LAST viewport);
                          other viewport leaves are WatchViewport blit targets
                          (renderFrame blits the terminal image to each registered
                          canvas, own pan/zoom). Each Node Editor pane wraps its OWN
                          ReactFlowProvider (independent cameras — the old
                          shell-level provider is gone); window-level shortcut/
                          paste/pie handlers gate on nodes-pane-scope.ts (sticky
                          "pane the pointer last entered", composing with
                          shortcut-scope's editor-kind gate). The old default/
                          timeline layouts live on as the two BUILT-IN entries
                          of Window → Layouts; presets.ts adds USER presets
                          saved from the live tree (name modal =
                          NewLayoutPresetModal.tsx; same localStorage-plus-
                          cloud strategy as brush presets — Supabase
                          user_preferences.layout_presets, migration
                          sql_archive/user-preferences-layout-presets-migration.sql, cloud
                          wins on load, absent column = local-only). Saving
                          under an existing name replaces it.
                          M2: 12px corner hotspots (crosshair, z 20 — above
                          gutter dividers, below the kind chips at z 30) start
                          the SPLIT gesture: drag INTO the panel, the dominant
                          axis locks the seam after 12px, seam+tint preview is
                          painted imperatively into refs (no re-render per
                          move), Esc cancels (tree untouched until commit),
                          release commits splitLeaf — the clone copies the
                          source's kind, the ORIGINAL keeps its leaf id. An
                          outward drag (M3) enters JOIN mode: the hovered
                          leaf's inner-45% center = SWAP (kinds trade, ⇄
                          glyph), sides = MERGE — the source's side of the
                          lowest separating split swallows the other side,
                          with the doomed region (joinRemovedLeaves in
                          model.ts) darkened + an arrow before release;
                          merges that would close every viewport leaf are
                          refused (same last-viewport invariant as the kind
                          menu). Primary-viewport election is STICKY state
                          (falls back to first-in-tree-order only when the
                          primary stops being a viewport leaf) so splitting
                          the primary never remounts canvas/overlays.
                          M4: the layout persists per-project as
                          SavedProject.layout — ADDITIVE, schema stays 9,
                          typed `unknown` in project.ts (model.ts owns the
                          shape: toSavedLayout strips ids, fromSavedLayout
                          re-mints + validates untrusted blobs, requiring
                          ≥1 viewport). EffectsApp attaches it post-
                          serialize at the cloud + .toolbox save sites and
                          applies it on all three load paths (cloud /
                          .toolbox / public /p/); absent → default preset;
                          File → New keeps the current layout. The docs
                          round-trip stashes layoutTree + primary id
                          (editor-session), and NodeEditor's module-level
                          paneCameraStash restores a pane's camera across
                          kind round-trips (fitView suppressed via
                          defaultViewport). Double-click a gutter divider
                          → 50/50.
                          POP-OUT (080226_panel-popout-windows.md, M1–M3
                          — every panel kind except the PRIMARY
                          viewport): PanelPopout.tsx detaches a leaf
                          into its own OS window. The child is a
                          same-origin `window.open` portalled into with
                          createPortal, so it is the SAME React tree —
                          same state, no sync protocol, no second
                          evaluator — and the engine is untouched
                          because blitToCanvas ends in a `drawImage`,
                          which is legal cross-document while
                          same-origin. A detached leaf LEAVES layoutTree
                          (ops.removeLeaf) and lives in EffectsApp's
                          `detachedPanels`, keeping its leaf id so the
                          watch-canvas registry still finds it; closing
                          the window re-homes it beside the largest leaf
                          (ops.attachLeaf + model.largestLeaf).
                          INVARIANT: anything renderable inside a
                          detachable panel must resolve its window from
                          layout/panel-window.tsx — `usePanelWindow()`
                          (context; `const win = panelWin ?? window`
                          INSIDE the effect, `panelWin` in the deps) or
                          `ownerWindow`/`ownerDocument` when it holds an
                          element. NEVER module scope: `window` is
                          always the main one, so a listener registered
                          there never hears the child and hit-tests its
                          rects in the wrong coordinate space. Portal
                          targets must come from context, not a ref —
                          they're computed during render. The app's own
                          window CustomEvents go through
                          `broadcastAppEvent` so either end can be in
                          another window; `nodes-pane-scope.ts` answers
                          per-window for keystrokes and GLOBALLY for
                          broadcasts (which hit every window at once).
                          The primary viewport is deliberately
                          undetachable (it owns canvasRef + every
                          overlay/gizmo).
    NodeEditor.tsx        xyflow wrapper: wires, validation, splice (drop a node
                          on a wire → A→N→C) + detach-heal (Cmd/Ctrl-drag a
                          clean-inline node out → A→C reconnects), copy/paste, marquee.
                          Paste chain: text field → Toolbox fragment JSON →
                          SVG text (Figma "Copy as SVG" / bare path `d` →
                          Spline Draw node, contain-fit to the visible
                          canvas; archive/073026_svg-paste.md) → OS files (.svg
                          FILE still → SVG Source) → internal clipboard.
                          Shift-drag "fuzzy connect": pull a wire from a socket
                          (or the whole node body — capture-phase interceptor)
                          with Shift held → blue ring + line, drop over any node
                          to land on its first accepting socket (buildShiftDrop-
                          Connection / buildNodeConnection). Shift-drag ACROSS
                          wires (or double-click a wire) drops a Reroute node
                          (RerouteNode.tsx — a dot; insertReroutesOnEdges in
                          graph-ops) that reorganizes wiring: source→reroute→
                          targets, dissolved at flatten. Spec: archive/071326_reroute-node.md.
                          Right-click a node with a spline-typed output →
                          "Make Editable": bakes the node's EVALUATED spline
                          at the playhead (trim/fillets/animation resolved)
                          into a fresh Spline Draw node, bypasses the
                          original as a revert point, moves the baked
                          handle's out-wires (+ image/fill/mask wires for
                          raster-family sources, styling copied) onto the
                          new node, and selects + viewport-activates it so
                          the pen overlay engages (makeSplineEditable in
                          graph-ops; disconnected/gated outputs force one
                          eval pass via the peek-style extraTargets path —
                          pendingBakeRef in EffectsApp). Hidden for Spline
                          Draw itself, group/layer shells, and reroutes.
                          Covered by check-graph-ops.mts.
    ParamPanel.tsx        Renders ParamDef[] → controls; all custom param-type UIs.
    EffectNode.tsx        The node chrome on the graph canvas (sockets, header, +).
                          Also hosts ON-NODE param controls (first: the Color
                          node's per-output swatches → ColorPickerPopover, a
                          compact HSV picker + hex + eyedropper + a numeric
                          H/S/L(/A) row anchored inside the node div; edits
                          dispatch `effect-node-param`,
                          which routes through onParamChange so undo/autokey/
                          socket-resolve fire naturally). The picker lives in
                          lib/color-picker-popover.tsx and is the UNIVERSAL
                          color UI: ColorControl's swatch opens it via
                          ColorSwatchPicker (fixed-position portal, Dropdown
                          dismiss rules) everywhere — param panel, gradient
                          points, ramp stops, live viewer, exported apps — in
                          place of the native browser picker. Spec:
                          archive/071026_color-node-multi-output.md.
                          Cosmetics (073026_node-cosmetics-and-frames.md):
                          right-click tint (7 presets, node-tints.ts, wash +
                          border) and Bold (extra box-shadow ring, never a
                          border-width change) render here off data.tint /
                          data.bold — additive persisted fields, schema 9.
    FrameNode.tsx         Blender-style frame zones (073026 spec). A frame is
                          a real hidden-def node (`frame-zone`, FRAME_TYPE)
                          rendered as a shaded rect BEHIND nodes: wrapper is
                          click-through (FRAME_XY_PROPS: pointerEvents none,
                          z -1, dragHandle) and only its edge bands + label
                          chip take pointer events. Membership = each
                          member's data.frameId (same-scope siblings; an
                          Iterate shell member brings its zone along).
                          computeFrameRects is shared render/hit-test
                          geometry (excludeMemberId = the Iterate leave
                          trick); EffectsApp reconciles frame position +
                          uiWidth/uiHeight to it so the box hugs members
                          (shrink-to-fit — the union excludes the frame's
                          own box). Shift+F frames the selection (resolving
                          out-of-scope picks to their scope ancestor);
                          drop-in joins, Cmd-drag-out leaves (NodeEditor
                          drag-stop, same grammar as Iterate zones); label
                          renames via the `effect-node-rename` event →
                          handleRenameNode. cloneSubgraph remaps frameId
                          with the clone set; deleting a frame strands
                          member ids harmlessly (undo-friendly).
    NodeInspectorPopup.tsx / SocketPeekPopover.tsx   data readouts. The `i`
                          inspector panel lists a node's inputs/outputs as
                          text summaries; dwelling ~2s on an OUTPUT handle
                          pops a per-socket peek with visual previews
                          (image/mask/uv thumbnails via readImagePixels,
                          spline/points drawings, color swatches, strings).
                          The eval loop force-evaluates the peeked node
                          (extraTargets + the evaluator's extraConsumed opt,
                          so consumption-gated auxes build too). Spec:
                          archive/072126_socket-peek-popover.md.
    TrackEditor.tsx / LayersEditor.tsx / PlaybackBar.tsx   timeline UIs.
    timeline/             Shared timeline core (080126 consolidation):
                          theme.ts (one palette/metrics — the editors had
                          3 drifted copies), view.ts (useTimelineView:
                          tick↔px, cursor-anchored zoom, gutter-aware fit),
                          keyframe-ops.ts (move/scale/stagger with the
                          unified policy: Shift bypasses frame-snap, ticks
                          clamp ≥0 via gesture-delta, collisions resolve
                          dragged-key-wins, scale pins at a 1-frame span;
                          plus SelectionKey/selKey (NUL-escape separators)
                          and nextGestureKey — per-gesture undo coalesce
                          keys so multi-lane delete/paste/easing is ONE
                          entry), clip-ops.ts (bar move/trim + slip +
                          footage clamp, both editors), ruler.ts,
                          EasingTile.tsx, DiamondNav.tsx + PlayheadChrome
                          (self-subscribing clock leaves — the editors no
                          longer read the tick at top level, so playback
                          re-renders only these leaves; actions read
                          playbackClock.get().tick at event time).
    *Overlay.tsx, TransformGizmo.tsx, PrimitiveGizmo.tsx   on-canvas editing.
                          spline-editor/: the Spline Draw overlay as a module
                          directory (071926_spline-draw-authoring-upgrade.md
                          M0) — SplineEditorOverlay.tsx owns state/effects/
                          ALL rendering; tools/*.ts own per-tool pointer
                          logic, ops.ts the value writes, drag.ts the drag
                          stream, dock.tsx the chrome, geometry.ts pure math,
                          snapping.ts the snap service (coincident anchor
                          snap → per-axis ALIGNMENT with other anchors
                          (dashed spanning guide, ticked at each participant)
                          → canvas edge/center/third hairlines, plus the 45°
                          handle lock; Cmd/Ctrl suppresses);
                          everything shares a per-render SplineEditorEnv
                          (types.ts). Multi-subpath pen/edit (Pen / Pencil /
                          Rectangle / Ellipse / Path-Select / Sub-path-Select
                          / Shape-Builder / Width tools
                          + GUI bbox transform + Live Corners per-anchor
                          rounding widgets). Rectangle (M) / Ellipse (L)
                          rubber-band ONE closed subpath (tools/primitive.ts,
                          spec 071926 M6): Shift = 1:1 in SCREEN space, Alt =
                          press point is the centre; the resolved px box
                          lives in the drag state so preview == commit, and
                          the landing geometry is ordinary editable anchors
                          (ops.appendSubpath, shared with the pencil).
                          Sub-path Select's SEGMENT grammar (071926
                          addendum): click selects the two adjacent anchors
                          and drags them as a pair (rigid segment move —
                          reuses the "anchor" DragState with a 2-entry
                          groupStarts, so snapping/HUD/autokey come free),
                          double-click selects the whole subpath, ALT+drag
                          bends. Blender-style MODAL transforms
                          (tools/transform.ts, spec 071926 M7): G/S/R move/
                          scale/rotate the selection (whole active subpath
                          when empty; all subpaths in Path Select) about its
                          median, gated on the cursor being over the canvas,
                          confirmed by click/Enter, reverted by Esc/right-
                          click, X/Y axis-locked, Shift = 45° rotate snap.
                          E EXTRUDES — a new anchor off the open subpath's
                          end riding the same modal move, staying selected
                          so E chains; its cancel drops the anchor too
                          (hence ModalTransform.cancelValue). NOT a
                          DragState — keydown
                          to click, so it owns capture-phase listeners; the
                          math is pure normalized units because the
                          overlay's normalized space is aspect-corrected
                          (offset → px is a uniform rect.width scale on both
                          axes). Shape Builder (B) rides
                          engine/spline-planar.ts (coverage-signature planar
                          faces over spline-boolean.ts primitives): hover
                          highlights the face under the cursor, click
                          extracts, drag merges, Alt deletes — destructive,
                          one undo per gesture. Path surgery via context
                          menus (cut/scissors, join J, reverse + chevron,
                          align/distribute selections). New tool =
                          tools/<name>.ts + a DragState kind + a dock entry
                          + a render block.
                          paint-editor/: the Paint node's toolkit overlay
                          (071926_paint-toolkit.md) — brush / eraser / blur /
                          fill / eyedropper + Clear. PaintOverlay.tsx maps
                          pointer→canvas px through the preview canvas's
                          TRANSFORMED rect (zoom/pan-exact; brush size is
                          canvas px); engine.ts is the stamp pipeline
                          (stroke-local scratch canvas → base+scratch
                          composite each rAF, so opacity caps and mid-stroke
                          pipeline feedback are both exact; blur mutates the
                          target per stamp); brushes.ts = settings model +
                          built-in presets + stamp cache; BrushEditor.tsx =
                          the ParamPanel preset block + floating editor
                          window (user presets sync to Supabase
                          user_preferences.brush_presets — migration
                          sql_archive/user-preferences-brush-presets-migration.sql —
                          with localStorage fallback). Every action commits
                          pre-action pixels through the paint undo lane.
                          Generic dock chrome (shell/pill/toggle) shared
                          with spline-editor via ../tool-dock.tsx.
                          GradientOverlay: linear/radial/multipoint
                          handles. Multi-select shows one gizmo per selected
                          transform/primitive node, each editing only its own
                          params (TransformGizmo swaps its canvas-wide translate
                          rect for its bounds polygon via `boxTranslate` so
                          stacked gizmos don't fight; topmost handle wins on
                          overlap). Spline Draw / Gradient / Paint / Segment
                          overlays stay single-selection. Spec:
                          archive/070826_multiselect-gizmos.md.
  state/
    graph.ts              NodeDataPayload (what lives in each xyflow node's data).
    graph-ops.ts          ALL structural graph mutations (pure functions). New
                          structural logic goes here, not in EffectsApp.
    history.ts            Undo/redo snapshots. editor-session.ts: docs-nav stash.
  lib/
    project.ts            serializeGraph/deserializeGraph, SavedProject SCHEMA (v4).
    project-file.ts       .toolbox zip container (manifest + project.json + assets).
    recent-projects.ts    File → Open Recent local cache (073026_open-recent.md):
                          cloud entries in localStorage + FSA handles in
                          IndexedDB for web-local .toolbox reopens, merged with
                          the desktop platform.recents list at menu-build time.
    num-expr.ts           evalNumExpr(): safe + - * / ( ) arithmetic for numeric
                          text fields — every commit-on-blur/Enter number input
                          (NumberField, frame/resolution fields) accepts math
                          like "1920/2" or "24*8+1". Null = revert. Use it, not
                          parseFloat, when adding a numeric field.
    number-field.tsx      NumberField (type / drag-to-scrub / stepper) + HslField
                          + formatNum. Its own module, not part of
                          param-controls, because color-picker-popover needs it
                          and param-controls already imports the picker — so
                          keeping it there would cycle. param-controls
                          re-exports all of it, so existing imports still work.
    shortcut-freeze.ts    Dev-only "Freeze" pill (MenuBar, next to the file name;
                          next dev builds only): capture-phase window gate that
                          stopImmediatePropagation()s key/clipboard events on
                          non-editable targets, killing every app shortcut except
                          Escape while typing keeps working. Registered at module-eval time so
                          it precedes all effect-registered listeners.
    supabase/             client/server helpers, projects table CRUD, user prefs.
    media-relink.ts       Missing-media handles (video/audio re-pick on load).
    export*.ts            Image/video export, audio mixdown, exported-app manifest+packager.
    live-viewer/          LiveViewer + control panel used by /live and exported apps.
    fonts.ts font-*.ts    Curated + custom font loading, variable-font axis parsing.
    local-fonts.ts        OS-installed fonts via queryLocalFonts (Chromium/desktop);
                          enumerate for the Text picker + read bytes for save-bundling.
    mcp-bridge/           Editor side of the Claude MCP bridge: WS client + command
                          registry (React side: useMcpBridge + McpPairingDialog;
                          server: scripts/mcp-server.mjs via `npm run mcp`; e2e:
                          `npm run check:mcp`). Spec: archive/070926_claude-mcp-bridge.md.
                          scripts/mcp-source.mjs adds server-side, bridge-free
                          source-reading tools (get_node_source / read_source /
                          search_source over src/nodes + src/engine, local
                          checkout with a GitHub-tag skew fallback) so Claude can
                          read node/engine code to explain behavior + tree-building.
                          Spec: archive/071226_mcp-node-source-tools.md.
    platform/             Platform-adapter seam (web vs Electron) — see "Desktop
                          (Electron) build". index.ts → `platform`; web.ts is
                          today's behavior verbatim; native.ts → window.toolboxNative.
  export-template/        Vite app source for exported standalone apps (built into
                          public/export-template/v1 by scripts/build-export-template.mjs).
electron/                 Electron desktop shell (NOT part of the Next build): main.js,
                          preload.js (the toolboxNative bridge), ffmpeg.js (native
                          export/transcode), files.js (native dialogs), recents.js
                          (Local tab), server.js (embedded standalone Next server).
rust/toolbox-vector-kernel/  kurbo→WASM geometry kernel (Optimize Path node).
                          kurbo pinned exactly; built artifact IS committed
                          (src/wasm/pkg + public/wasm/v1) so no Rust toolchain
                          is needed to build the app. `npm run build:wasm`
                          rebuilds (rustup + wasm-pack); `npm run check:kernel`
                          verifies. Spec: archive/attractor-vector-kernel-spec.md.
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
type (Auto Layout — see [archive/autolayout-node.md](archive/autolayout-node.md)): a
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
  **Exception — SDF primitive params are Y-UP.** An `sdf-circle`/`rect`/
  `polygon`/`star`'s `y` param is compared against the compiler's
  `vec2 p = v_uv`, and v=0 is the framebuffer's *visual bottom* (see
  FULLSCREEN_VS in gl.ts and the readPixels note beside it, and the
  Y-flip in nodes/sdf/to-spline.ts). So a larger `y` sits HIGHER on
  screen, the opposite of everything else in this list. Anything mapping
  those params to screen must flip — and, when Aspect Correct is on,
  also scale by `aspect = W/H`, since the shader evaluates at
  `p.y = (v − 0.5)/aspect + 0.5`. Both conversions live in
  `sdfYToGizmo`/`gizmoYToSdf` in PrimitiveGizmo.tsx; reuse them rather
  than re-deriving.
- GL textures sample with **v_uv Y-UP** (v=0 at bottom). Nodes/shaders flip
  at the boundary (see the Y-flips in text.ts, image-source.ts,
  marching-squares readback). When pixels look upside down, you missed one.
- The cursor (`ctx.cursor`) is stored **Y-UP** canvas UV (flipped from DOM
  in EffectsApp's pointermove). Its optional `pressed` flag is true while
  the primary button is held after a press that STARTED inside the preview
  box (capture-phase listeners in EffectsApp + LiveViewer) — the drawing
  gesture Cursor Trail Points' `emit: press` reads; point-emitting
  consumers must flip to y-down (071926_loop-weave.md).
- Non-square canvases: normalized coords are anisotropic. Geometry that
  must stay round uses the aspect-correct helpers
  ([aspect.ts](../src/engine/aspect.ts)) / the SDF compiler's
  `u_aspectCorrect` path. New geometry features must decide this
  explicitly.
- **`points` / `spline` sockets are AUTHORED space — always.** Every
  renderer aspect-corrects y on the way to pixels (spline-raster,
  spline-width, text-raster, svg-serialize, Copy to Points' instanced
  VS, Point Labels, PointsOverlay), so a producer that emits canvas UV
  gets DOUBLE-corrected and its geometry spreads vertically; a consumer
  that reads authored as canvas UV squashes it toward the middle. A sim
  whose solver runs in another space (canvas UV, grid index, canvas px)
  must convert at the socket, not in its consumers — `aspectCorrectY` /
  `aspectUncorrectY` for UV-ish spaces, `authoredToPxY` /
  `pxToAuthoredY` (sim-kernel.ts) for pixel spaces. Same rule for FORCE
  and analytic-collider descriptors: they are authored everywhere
  (Particle, Matter, Rope, Rigid Body all agree), because that is the
  only space in which a `radius` bounds a circle and a collider normal
  survives the trip. This exact bug has been fixed five times — check it
  when adding any producer, consumer, or simulator.
- Alpha is **straight (non-premultiplied)** throughout;
  `UNPACK_PREMULTIPLY_ALPHA_WEBGL` is explicitly disabled on uploads.
  Compositing is Porter-Duff source-over done manually in shaders
  (see merge.ts BLEND_FS). Caveat: WebGL **ignores** that flag for
  ImageBitmap sources — the bitmap's creation-time `premultiplyAlpha`
  wins, and `createImageBitmap`'s default is premultiplied. Mint
  straight-alpha bitmaps explicitly
  (`createImageBitmap(src, { premultiplyAlpha: "none" })`, as the paint
  snapshot paths do) or downstream compositing applies alpha twice and
  soft edges fade through grey.

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
points instead carry per-item `groupIndex` tags) · `list` (ordered,
possibly-MIXED `SocketValue[]` — the List node emits it and the list
transform nodes chain on it. Items are BORROWED, like image_group's: the
evaluator's release walks never recurse into containers, so the producer's
cache entry owns any texture inside and a list op must never allocate or
release per-item. `engine/list-value.ts` states the contract;
`engine/list-parse.ts` is the format-sniffing parser, which reuses
csv-parse's `parseRows`. No coercions — with mixed items there's no honest
list→anything, so every conversion is a node. archive/080526_list-socket.md) ·
particle descriptors
(`force`/`emitter`/`collider` CPU structs + `particles` GPU state textures)
· compile-time ASTs (`sdf`, `position`, `scalar_field`) that do **zero GL
work** until SDF Rasterize compiles the tree to one shader · `render`
(inert organizational link Output→Render Queue) · `color_ramp` (a
`ColorRampStop[]` + interp mode as a value; Color Ramp's `ramp` aux output
feeds any `color_ramp` PARAM, so one authored palette drives Stroke,
Rasterize Spline's fill/stroke ramps, Ascii… — archive/080526_on-node-color-ramp.md.
No coercions: it only meets its own type).

Coercions ([coerce.ts](../src/engine/coerce.ts)): mask↔image,
spline→mask (the shape's filled silhouette — even-odd, open subpaths closed
for fill, aspect-corrected, canvas-sized; identity-cached per SplineValue so
a static shape rasterizes once — this is what lets a Rectangle/Circle wire
straight into any mask socket), scalar→vec2/3/4/uv-broadcast,
vec WIDENING (vec2→vec3/vec4, vec3→vec4; pads z = 0, w = 1 — a point's
homogeneous coordinate, a colour's opaque alpha. Widening only: narrowing
would silently drop components, and a vec4 landing on a vec2 socket is far
more often a mistake than an intent),
image→uv (zero-copy re-wrap — same RGBA pool texture, R/G read as per-pixel
(u,v), so wiring a noise image into any UV input re-evaluates the consumer
at warped coordinates: Blender's Fac→Vector domain warp. Mask is excluded —
its R-format texture would read v = 0. archive/073026_image-to-uv.md),
image/mask→scalar (1×1 readback), audio→
scalar (RMS level, via engine/audio-analysis.ts), image↔element (wrap as
full-canvas element / flatten centered at natural size; identity-cached in
WeakMaps inside engine/element.ts). The editor-side "can this wire land
here" checks are SINGLE-SOURCED in two functions: `coercible` — the pure
type table, also used by AI-recipe validation and by node defs that unify
what's wired into them (Switch) — which lives in engine/graph-helpers.ts (a
LEAF module, so a node def can import it without a registry cycle) and is
re-exported from engine/graph-validation.ts, where `editorCanCoerce` sits
(it adds the polymorphic defType exceptions — Math uv, Copy-to-Points
instance, Displace/Transform source, Scatter Points density←spline, Switch's
numbered slots while its Type is "auto"; its optional `targetParams` arg is
what lets a param-dependent exception like Switch's answer precisely).
NodeEditor's
`isValidConnection` + splice check and EffectsApp's wire-drop auto-connect
all call it — **add new coercions in coerce.ts (runtime) + coercible
(editor/validator); add polymorphic socket exceptions in editorCanCoerce
only.** The exceptions cover the INPUT side; the splice check
(drag-a-node-onto-a-wire) also has to answer the output side, where a
retyping node's stored `primaryOutput` still reads its resting type while
it sits unwired — so `findSpliceCandidate` runs `projectPrimaryOutput`
(resolvePrimaryOutput with the prospective `connectedTypes`) instead, and
a Transform drops onto a spline/points wire exactly like the hand-drawn
pair of wires it stands in for. `image→mask` is **luminance × alpha** (coverage-weighted): opaque
grayscale (noise/gradients) reads as its old luminance, but a shape drawn on
transparency (Rectangle/Circle/Text/SVG rasters) mattes by its silhouette,
not by whatever RGB sits in the cleared surround. A dark-*colored* fill still
reads dim — matte with a light fill for a clean cutout (or wire the spline
itself: spline→mask is styling-independent).

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
     time ([clips.ts](../src/engine/clips.ts)). **Layer pre-roll:** a gated
     layer whose next window starts within ~0.5s keeps its `content` edge,
     so its interior evaluates invisibly with the clock PINNED to the
     window's entry tick and `ctx.preroll` set — media park paused on the
     entry frame (Video's freeze path, Audio pause) so cuts land warm with
     no seek/no cold compile. Media nodes that play elements must respect
     `ctx.preroll` (never audible, never advancing while set).
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
     blend bases). Merge opts out entirely (`noMaskInput`) — it declares its
     own `mask`-typed socket under every image input (`mask:base`,
     `mask:<layerId>`), each the matte for that layer (multiplies the
     layer's effective alpha in BLEND_FS, exactly like a per-pixel opacity;
     see archive/070926_merge-layer-masks.md). Also the universal `opacity` param
     (declare `OPACITY_PARAM`
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
optional `init`/`dispose`/`fingerprintExtras`/`stable`/`simulation` (marks
frame-accumulated state — see § Export, simulation pre-roll)/`terminal`/
`noMaskInput`/`hidden`/`validateParams` (static param sanity check run by
the AI-recipe validator only — Point Expression smoke-runs its kernel
there), UI hints (`supportsTransformGizmo` — requires the
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
   Color params can opt into an alpha channel with `alpha: true`: the
   value becomes 8-digit `#rrggbbaa` while translucent (6-digit stays the
   opaque canonical form, straight alpha), the panel adds an A field and
   the universal picker an alpha strip, and wires/keyframes carry it
   (vec4 socket alpha honored, oklab lerp alphas linearly). OPT-IN ONLY
   after verifying the node's hex parse path handles 8 digits — many
   local `hexToRgb` copies mis-read them; the spline raster core
   (`hexToRgba`/`hexToRgba01`) and raw Canvas fillStyle are safe. Spec:
   archive/072026_color-alpha.md (Fill is the reference opt-in).
4. Shaders: `ctx.getShader("<unique-key>", FS_SOURCE)` (cached by key) +
   `ctx.drawFullscreen(prog, target, setup)`. GLSL 300 es, fullscreen
   triangle provides `v_uv`.
5. If you add a ParamType: types.ts union → ParamPanel renderer →
   keyframes.ts `isKeyframable`? → export-manifest.ts control support? →
   serialization check (plain JSON or media-envelope?). Array params that need
   per-item keyframing (`merge_layers`, `gradient_points`, `color_ramp`)
   follow the virtual-key pattern: a clone-and-override block in evaluator.ts
   + an autokey mirror in EffectsApp's `onParamChange` + per-item diamonds in
   ParamPanel — copy an existing one. `color_ramp` additionally supports
   per-item expose/control via the same virtual names (see § Animation).
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
  itself isn't keyframable): merge-layer opacities (`layer_opacity:<id>`),
  multipoint-gradient point x/y/color (`gpoint_x/y/c:<id>`), and color-ramp
  stop color/alpha/position (`ramp_c/a/p:<paramName>:<stopId>` — ramp keys
  embed the param name since a def may declare several ramps). The evaluator
  resolves them onto a cloned array before compute (see conventions.ts + the
  three blocks in evaluator.ts); ParamPanel renders a diamond per item;
  EffectsApp auto-keyframes edits. Color virtual keys store RGBA tuples.
  Ramp stops go further: the same virtual names are valid `exposedParams`
  entries (per-stop input sockets — vec4 for color, scalar for
  alpha/position; wire > keyframe per FIELD) and `controlParams` entries
  (per-stop knobs in exported apps — the manifest synthesizes a
  color/scalar ParamDef and the live viewer patches the stop in place).
  Removing a stop drops its tracks, exposures, controls, and edges in the
  same `onParamChange` pass. Spec:
  archive/071026_ramp-stop-keyframe-expose-control.md.
  The WHOLE ramp is also exposable now (`color_ramp` socket, 080526) — a
  wire replaces the stops array wholesale, and the per-stop wires still
  apply on top wherever the incoming ramp reuses a stop id. Which brings up
  the general rule, easy to miss: **a param gets an expose button iff
  `paramSocketType(p.type)` is non-null** — ParamPanel derives `exposable`
  from it, so adding one case in graph-helpers.ts lights up the socket on
  every node declaring that param type at once. That one line is what gave
  all nine `color_ramp` params across eight nodes their input socket.
  `Keyframe.value` is `unknown` — most types are scalars/colors/vecs, but
  the whole spline shape keyframes too: Spline Draw's `spline_anchors` param
  is keyframable ("Path Animation" row in ParamPanel), and `interpolate`
  lerps it anchor-by-anchor (pos + handle offsets) between keyframed states.
  INDIVIDUAL anchors keyframe too (spec 072726 M6): anchors carry optional
  stable `id`s (minted by the editor), and `anchor_p/in/out:<id>` virtual
  vec2 tracks animate one anchor's pos / handle offsets — resolved by a
  fourth clone-and-override block in evaluator.ts via `resolveAnchorTracks`
  (conventions.ts, shared with the overlay's value-at-tick). EITHER/OR with
  whole-shape Path Animation (the spline block wins when animated). Enabled
  per anchor from the overlay's context menu ("Animate anchor"); autokey
  mirrors drags into just the dragged anchors' tracks; deleting an anchor
  drops its tracks in the same onParamChange pass.
  The graph editor stays scalar-only; non-scalar tracks just show diamonds.
- **Panel readouts are animated**: controls display the keyframe-evaluated
  value at the playhead (`animatedValueAt` in engine/conventions.ts — the
  keyframe step of wire > keyframe > constant), so sliders/fields/swatches
  move while scrubbing or playing. Covers ParamRow (all keyframable types),
  the AutoLayout panel's scalars, and the virtual-key sub-controls
  (merge-layer opacity, gradient points, ramp stops + the ramp bar).
  Display-only: edits still diff/patch the STORED constants (autokey mirrors
  them at the playhead), driven params show the stored value (wire wins and
  the row is dimmed), and diamond inserts capture the *evaluated* value so a
  mid-segment insert pins the curve (same contract as TrackEditor). Spec:
  archive/071526_animated-param-readouts.md.
- Clips: in/out windows on source nodes (`CLIPPABLE_NODE_TYPES`); video is
  the only time-remapped type. Layers use clip windows as their in/out
  bars and offset their interior's clock. Trim semantics (both timeline
  editors): on clock-carrying clips (video + layer — `clipSlipsOnInTrim`
  in clips.ts) an in-trim slips `sourceInTick` by the trim delta so the
  content stays anchored (NLE trim = reveal; the in-handle clamps at the
  content anchor), while a bar move slides content with the window;
  pure-gate types trim without slipping.
- Timeline UIs: PlaybackBar (transport), TrackEditor (per-param tracks +
  graph editor), LayersEditor (AE-style layer stack at root). Shared
  behavior (tick↔px view, keyframe move/scale/stagger, clip drag math,
  theme, playhead/diamond leaves) lives in components/effects/timeline/ —
  edit it there, not per-editor. Spec:
  archive/080126_timeline-consolidation.md.
- The dock that hosts those three (Layers / Tracks / Graph tabs) has TWO
  hosts, both rendering EffectsApp's `renderDockBody` closure: the
  floating modal the PlaybackBar's curves button opens (root-level
  `position: fixed`, z 900 — over every panel, under the playback bar at
  950, the menu bar at 1000 and the dialogs at 2000; drag by the
  toolbar's empty middle, 8-way resize, rect + open state in
  localStorage, hidden in full-canvas) and any `timeline` layout leaf.
  `host` only decides what sits left of the tab toggle — the close ✕ in
  the modal, the panel-kind chip in a panel. The tab is per-instance so
  the two don't fight; the other dock toggles are deliberately shared.
  Spec: archive/080226_timeline-modal-panel.md.

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
  (`resolvePromotedParams` in graph-ops.ts) — a minted boundary socket
  wired straight into a deep node's exposed param (`in:param:…`). The
  ParamPanel surfaces these as editable widgets on the **shell** node
  (slider/dropdown/color, keyframe diamonds, driven-dimmed when the shell
  socket is wired from outside) — a remote control writing through to the
  interior node, not a copy. This works for **both** `node-group` **and**
  `layer` shells (ParamPanel's "group inputs" / "layer inputs" section);
  the layer case filters out the reserved fixed-interface sockets
  (`stack`/`content`/`backdrop`/`audio`) and hides the output-socket
  editor. This is the composition-level knob for per-instance layer params:
  duplicate a layer (deep-copied interior) and tweak each copy's promoted
  params in the panel without diving in.
- **Iterate** (specs archive/071826_iterate-node.md +
  archive/071926_iterate-zone-view.md rev 3) is the third structural variant,
  presented as an always-inline ZONE of exactly two nodes. **Iteration
  Output** (`iterate`) is the engine-side shell: it computes, anchors
  membership (members' parentId = its id), mints collect sockets via
  its virtual input (any number — each same-named aux output carries a
  GROUPED result: image → image_group of iterate-OWNED texture copies,
  spline/points → merged with groupIndex = iteration; one nested pass
  per iteration evaluates every tap via evaluateGraph's extraTargets),
  and carries hidden `zi__<name>` passthrough inputs. **Iteration Input**
  (`iterate-input`, itself a member) holds the loop params (count /
  seed / random_min / random_max — resolved SHELL-side with wire >
  keyframe > constant: keyframes off the stashed node's animation at the
  scoped tick, wires via flatten-rerouted hidden `zi__param__` inputs;
  member→Iteration Input wires are rejected as circular), emits
  index / t / random per iteration from
  `ctx.iteration`, and is the exterior face for passthroughs (flatten
  reroutes `exterior → its in:<name>` onto the shell's `zi__` input;
  the collect tap `member → shell in:` rides the interior record).
  Eval: flatten's `extractIterateInteriors` removes members wholesale;
  the evaluator stashes each interior + a fingerprint hash on
  `ctx.state[ITERATE_STASH_KEY]` (hash folds member
  params/structure/animation + time when time-driven into the shell's
  fingerprint). The shell's compute re-runs members K times through a
  nested `evaluateGraph` over a PRIVATE cache, `{nested:true}` (skips
  the state sweep — whose members-only keep-set would dispose everything
  else — and audio routing); collected image copies happen BEFORE the
  next nested eval frees transients. Nested Iterates are rejected.
  Editor: compound "iterate" menu entry (`makeIterateNodes`), no diving
  (isEnterableScope excludes it), `scopedNodes` recurses visibility
  through shells, `IterateZoneUnderlay` shares its rects with the
  drag-stop reparent hit-test, dragging the shell moves the whole zone,
  and `isValidConnection` allows exactly four cross-scope crossings
  (collect tap / exterior→Iteration Input / auto-minted exterior→member
  / auto-minted member→exterior via `connectAcrossIterateBoundary`,
  which dedupes repeat wires onto existing sockets). Membership
  gestures: drop-in absorbs; plain drag-out just stretches the zone;
  Cmd/Ctrl-drag ending outside (rect computed sans the dragged node)
  takes the node out, composing with Cmd-drag detach-with-heal.
  `reparentNode` refuses boundary nodes, cycles, and wire-crossing
  moves. Serialization: plain nodes + parentId, no schema bump.
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
- The interior **Layer Output** (`group-output`, `fixed: true`) is the one
  boundary whose sockets are NOT a 1:1 mirror of the shell's outputs.
  `LAYER_OUTPUT_SOCKETS` (groups.ts) is `image` / `audio` / `spline`, and
  flatten PUSHES two of them onto the layer shell's own hidden inputs —
  `image` → `in:content` (what the blend reads), `spline` → `in:spline`
  (the vector export tap, stashed by `layer.compute`, never rendered); the
  map is `LAYER_OUTPUT_TO_LAYER_INPUT` in flatten.ts. Only `audio` resolves
  on the PULL side (resolveBoundarySource), because a spliced audio chain
  has to land directly on its consumer for the evaluator's audio-routing
  detection. Both pushed handles are dropped for a gated layer. Because the
  interface is immutable, `resolveOutputBoundarySockets` treats the
  constant — not the stored `sockets` param — as the source of truth, which
  back-fills sockets added after a project was saved with **no migration
  and no schema bump** (handle ids are name-based, so appending is safe).

## Persistence & sharing

- `serializeGraph`/`deserializeGraph` ([project.ts](../src/lib/project.ts)),
  `CURRENT_SCHEMA = 10` — the version history is documented at the top of
  that file; bump it when the wire shape changes and keep loading old ones.
  (v6 renamed Text's `mask` input to `morph_mask` and migrates old
  `in:mask`→`in:morph_mask` edges on load — see below. v7 removed Merge's
  universal mask in favor of per-layer mask sockets; an old Merge `in:mask`
  edge fans out into one `in:mask:<layerId>` edge per layer on load —
  equivalent output under source-over. See archive/070926_merge-layer-masks.md.
  v8 added the `{kind:"exr"}` original-bytes envelope for EXR stills on
  Image Source — see archive/070926_exr-color-pipeline.md. v9 lets a media envelope
  carry `{asset:<sha256>, ext}` instead of `dataUrl` — cloud media in
  Storage; see the cloud-asset bullet below. v10 switched Lissajous 3D's
  `phase_x/y/z` from units of π to turns so a keyframed phase loops over
  each whole 0→1 span; load halves the param, its keyframe values and
  bezier `dy`, and any custom slider range. Lissajous 2D still uses × π.)
- Media (image bitmaps, paint canvases) inline as data-URLs; video/audio
  don't serialize — they become "missing media" entries re-picked via
  MediaRelinkModal ([media-relink.ts](../src/lib/media-relink.ts)).
- **Cloud media = content-addressed Storage (v9, Tier 2).** The cloud save
  path ([supabase/project-assets.ts](../src/lib/supabase/project-assets.ts))
  post-processes serialize's inline graph: extract each asset → upload the
  ones **not already present** to the public `project-assets` bucket
  (`<user>/<project>/<sha256>.<ext>`) → leave `{asset,ext}` refs in the row.
  Unchanged media re-hashes to an existing object = zero upload; the DB row
  stays tiny (no more 50MB cap / statement-timeout). Load rewrites refs →
  public Storage URLs (`resolveAssetRefs`) BEFORE deserialize, so the
  deserializer (which `fetch()`es `dataUrl`) is unchanged and ≤v8 inline
  saves load untouched. **Streamed load:** the editor passes
  `deserializeGraph(..., { deferRemoteMedia: true })`, which returns those
  Storage images in `pendingMedia` instead of blocking on them — the graph is
  interactive immediately and EffectsApp's `streamPendingMedia` fetches them
  in parallel, patching each into its node when it lands and showing a
  per-node spinner (`node-media-loading` event) meanwhile. A save awaits the
  in-flight batch (`mediaLoadRef`) so a not-yet-loaded image never serializes
  to null; a stream that fails keeps its envelope so the ref still
  round-trips. Viewers / `.toolbox` / fragment loads omit the flag and stay
  synchronous. The [Spinner](../src/components/effects/Spinner.tsx) (smooth
  linear arc) drives both this and the save/load progress readout in the
  MenuBar's status chip
  ([MessageConsole.tsx](../src/components/effects/MessageConsole.tsx) — the
  chip also shows every flashToast message and opens a draggable console
  window with the message history). **Rollout-safe:** upload falls back to the inline
  graph if Storage errors (e.g. the bucket's migration hasn't been run), so
  saves keep working the old way until `specdocs/project-assets-migration.sql`
  is applied, then switch automatically. Delete removes the project prefix;
  a won-CAS re-save prunes its own orphans. **Privacy note:** the bucket is
  public, so a private project's media is unguessable-path-public (content
  hash + UUID), same trust level as thumbnails. Spec:
  archive/071426_cloud-asset-storage.md.
- All bytes→data-URL encoding goes through [data-url.ts](../src/lib/data-url.ts):
  native encoders cached per source object (Blob / ArrayBuffer / ImageBitmap)
  in WeakMaps, seeded on load — an unchanged asset costs ~0ms on every save
  after the first, and re-saves emit byte-identical data-URLs (stable
  `.toolbox` asset hashes). Paint serializes from the committed **snapshot**
  bitmap (every stroke/fill/resize/undo mints a fresh one), never the live
  canvas. INVARIANT: media param values are replace-only — mint a new
  Blob/bitmap for new content, never mutate behind an existing reference, or
  the cache serves stale bytes. Priming only accepts `data:` URLs (a v9
  storage-URL load skips it). The `.toolbox` writer STOREs pre-compressed
  mimes (png/jpeg/webp/gif/exr) instead of re-DEFLATing them. The asset-
  envelope vocabulary (`isInlineAsset`/`isAssetRef`/hash/ext) is shared by
  the `.toolbox` and cloud paths in
  [asset-envelope.ts](../src/lib/asset-envelope.ts). Spec:
  archive/071426_save-optimization.md.
- All bytes→data-URL encoding goes through [data-url.ts](../src/lib/data-url.ts):
  native encoders cached per source object (Blob / ArrayBuffer / ImageBitmap)
  in WeakMaps, seeded on load — an unchanged asset costs ~0ms on every save
  after the first, and re-saves emit byte-identical data-URLs (stable
  `.toolbox` asset hashes). Paint serializes from the committed **snapshot**
  bitmap (every stroke/fill/resize/undo mints a fresh one), never the live
  canvas. INVARIANT: media param values are replace-only — mint a new
  Blob/bitmap for new content, never mutate behind an existing reference, or
  the cache serves stale bytes. The `.toolbox` writer STOREs pre-compressed
  mimes (png/jpeg/webp/gif/exr) instead of re-DEFLATing them. Spec:
  archive/071426_save-optimization.md.
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
- **File → Open Recent** ([recent-projects.ts](../src/lib/recent-projects.ts),
  archive/073026_open-recent.md): per-machine cache of recently opened projects.
  Cloud entries `{id,name}` live in localStorage (recorded on cloud
  load/save/rename); web-local `.toolbox` opens persist their FSA
  `FileSystemFileHandle` in IndexedDB (Chromium only — File → Load… uses
  `showOpenFilePicker` there so the handle exists; the input fallback
  isn't recorded); desktop entries are NOT stored — the Electron
  `platform.recents` list (main-owned, self-pruning) merges in at list
  time, so this menu and the LoadGrid "Local" tab always agree. Clear
  Menu clears all three stores (including that Local tab list).
- Supabase: auth (AuthProvider), `projects` table (private/public, slugs →
  `/p/[slug]` public editor, `/live/[slug]` live viewer), user preferences,
  image-gen edge function. SQL migrations live as `specdocs/*-migration.sql`.
- **Project folders** (Private tab of the load grid): per-user,
  arbitrarily nestable `project_folders` table + `projects.folder_id`
  (null = root) — specdocs/project-folders-migration.sql. LoadGrid
  drills in (folder tiles/rows listed before projects, breadcrumb chips
  in its toolbar that navigate AND accept drops), pointer-based drag &
  drop files projects/folders (`useTileDrag`: past a 5px threshold the
  tile lifts into a rAF-lerp ghost chasing the cursor; targets are
  elementFromPoint-hit-tested via `data-drop-target`; invalid release
  glides home; near the scroll container's top/bottom edge the list
  edge-auto-scrolls; the ghost transform is owned by the rAF loop, NOT
  the React style prop; cycle guard client-side + DB trigger backstop), and
  folder delete re-homes
  contents to the deleted folder's parent — never deletes projects.
  Data layer: lib/supabase/project-folders.ts (same session-cache /
  timeout / offline conventions as projects.ts). `moveProjectToFolder`
  deliberately does NOT bump `updated_at` — a drag must not conflict an
  open editor's CAS save or reorder the date sort. Rollout-safe before
  the migration runs: `listFolders` returns [], `listPrivateProjects`
  retries without `folder_id` on 42703, and the grid renders flat as
  before. Spec: archive/072726_project-folders.md.
- **Load-grid views** ([LoadGrid.tsx](../src/components/effects/LoadGrid.tsx)):
  `grid` (thumbnail tiles), `list` (compact text table), `detail` (the
  same table, taller rows led by a 40px square thumbnail). List and
  detail are ONE component — `ListView` takes a `detail` flag and shares
  a single `rowStyle` across project rows, folder rows and New Project so
  the columns stay aligned; the Title header is indented by the thumb
  width in detail. Drag ghosts branch on `view === "grid"` (tile replica)
  vs everything else (compact chip), so detail must never be lumped in
  with grid there.
- **Landing gateway** ([Landing.tsx](../src/components/effects/Landing.tsx)):
  shown on a clean visit to `/`, and re-openable at any time from the
  Toolbox menu's version row (`onOpenLanding` → `setShowLanding(true)` +
  `setMenuSettled(false)` so the menu bar re-animates). The re-opened
  copy is the one that takes `onClose` — that prop also skips the opaque
  boot veil (nothing is booting) and arms Escape. Its "New Project" runs
  `handleNewProject`, NOT `resetToFreshProject`, so unsaved work in the
  editor underneath still gets the confirm.
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
    **Caveat: ffmpeg's `prores_ks` alpha is not reliably read by NLEs.** The
    file is spec-correct (verified `yuva444p12le`, alpha data intact) but
    DaVinci Resolve ignores the channel (Apple-QuickTime signaling mismatch)
    and After Effects decodes it opaque. For cross-app alpha use **qtrle**
    (below), not ProRes.
  - **Universal alpha (`qtrle`)**: the QuickTime Animation codec (max-tier
    `videoCodec: "qtrle"`, `-c:v qtrle -pix_fmt argb` in export-ffmpeg-args.js)
    is the alpha delivery format that AE **and** Resolve both read. Lossless
    8-bit RGBA, straight alpha, always alpha-bearing (no `videoAlpha` toggle,
    no CRF), forced to a `.mov` container (like ProRes). RLE compresses
    transparent/flat runs extremely well (often smaller than ProRes for cutout
    graphics) but balloons on busy full-frame content — PNG/EXR sequence is the
    escape hatch there. Shares both encode paths (wasm + native ffmpeg).
- **SVG** — the third product on an Output **and** on a Layer Output, and
  the only vector one. A `spline` tap is a pure export side-channel: the
  evaluated path is stashed under `svgExportStashKey(nodeId)`
  (engine/svg-serialize.ts serializes it) and styled by the shared
  `SVG_STYLE_PARAMS` from nodes/output/svg-export.ts. Wiring the tap is what
  reveals the on-node **SVG** button and the panel's styling rows +
  "Export SVG →" — unwired, both nodes look exactly as before.
  - Composition **Output**: a plain optional input; its own compute stashes.
  - **Layer Output**: the third fixed boundary socket, so a layer exports
    its own vector art the way it already exports its own image/video. It
    has no compute (flatten dissolves every boundary), so the **enclosing
    layer** stashes on its behalf under the LAYER's id — `exportSvgNode`
    maps Layer Output → `parentId` to find it, while styling params still
    come from the Layer Output, which owns the layer's export config.
    `EXPORT_PARAMS` still excludes the SVG rows; the panel appends them
    itself, gated on the wire.
  - The standalone **SVG Export** node (spline · utility) is the same
    mechanism as a passthrough you can sit inline in a chain. All three fire
    `effect-node-export` with `kind: "svg"` into EffectsApp's one
    `exportSvgNode`.
  - Caveat on all three: the stash only refreshes on evals that reach the
    stashing node, so a viewport-**Active** node (the sole eval target, per
    `computeNeededSet`) — or a gated/bypassed layer — can leave the
    snapshot stale. Spec: archive/072726_spline-animation-program.md M2.
- **Export resolution** (073126_export-resolution-and-app-slim.md): every
  Output / Layer Output carries a `resolution` param (**canvas** / **scale**
  / **custom** + `resScale`/`resWidth`/`resHeight`), applied to image,
  video, sequence AND gif. `resolveExportResolution` (lib/export.ts)
  resolves it — video paths pass `{even:true}` (H.264/H.265 reject odd
  dims). EffectsApp's `beginExportResolution`/`endExportResolution`
  bracket every export driver: it recreates the engine backend at the
  target size via the exportResOverride → renderRes path (the same
  battle-tested recreation as a project-resolution change; the preview
  canvas element resizes with it, so toBlob / captureStream / native
  readback all capture at target size with no per-path code), then
  restores. A depth counter lets Render Queue / wedge batches hold the
  bracket open (`beginExportResolution(null)`) so per-row brackets don't
  thrash back to preview res between items. This also fixed a bug:
  exports used to capture at `canvasRes × previewScale`, so a lowered
  preview render scale silently shrank every export. The five duplicated
  two-pass settle loops are now ONE helper (`renderSettledFrameAt` —
  render, awaitMediaSettle, conditional re-render, optional rAF flush).
- **Simulation pre-roll on still export** — the sharp edge of the above.
  Recreating the backend runs `disposeAllNodeState` + `destroy()`, which
  takes `ctx.state` with it, and `ctx.state` is where every stateful node
  keeps its frame-accumulated result. So a still captured at frame 50 used
  to come out reseeded — or blank, for the solvers (matter, particles) that
  publish their readback one frame late. `NodeDefinition.simulation` marks
  the affected node types; `outputNeedsSimPreroll` (lib/sim-preroll.ts)
  flattens + reverse-BFSes from the Output to ask whether one is reachable;
  `prerollSimulations` (EffectsApp) then steps the offline clock 0 → target
  frame at export res before the capture, behind the offline banner. Guarded
  by `scripts/check-sim-preroll.mts` (in `npm run check`).
  - `exportImage` pre-rolls only when the size **actually** switches — a
    matching size early-returns from the bracket, so the live state on
    screen is already the right one. `renderImageToBlobAtFrame` renders an
    arbitrary frame and so always pre-rolls.
  - Mark a node `simulation` only when a state wipe visibly changes its
    output AND the accumulation is driven by `ctx.time` — a pre-roll can't
    reproduce wall-clock nodes (Cursor Trail), so they stay unmarked.
  - Put the flag on the **registered** def: the Particle Simulator's
    registry entry is the backend router (particle-simulator.ts), not the
    webgl/webgpu impls it delegates to.
  - Still open: the closing `endExportResolution()` tears the backend down
    a second time, so the user's LIVE sim is reset after an export that
    switched resolution. Fixing that means a second pre-roll at preview res
    (≈2× the wait), so it's deliberately not done.
- The Output node's animated export has an `exportMode` param (**video** /
  **sequence** / **gif**, a segmented pill — `ParamDef.control: "segmented"`).
  Sequence = one still per frame (`exportSequence` in EffectsApp), delivered
  per `seqDelivery` (zip / folder / sequential — same machinery as the Render
  Queue's `delivery`). Both modes share a **start/end frame range**
  (`startFrame`/`endFrame`, half-open `[start, end)`), which replaced the
  legacy `videoFrames` duration — old saves migrate in `migrateLoadedParams`
  (project.ts). `resolveFrameRange()` derives the range (with `videoFrames`
  fallback) for all exporters. Spec: archive/061726_png-sequence-export.md.
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
  back to the raw ffmpeg GIF if gifsicle fails. Spec: archive/061826_gif-export-and-image-sequence.md.
- **Wedge batch rendering** (spec archive/071026_wedge-render-batching.md — Houdini
  "wedging"): the **Wedge** node (utility, src/nodes/source/wedge.ts) emits
  one value per batch iteration — scalar (value list / range / seeded
  random / bare index), color, vec2, or string — wired into seeds, Switch
  indices, or any exposed param. EVERY export path (standalone image /
  video / sequence / GIF Export and Render Queue rows) resolves the wedges
  upstream of the rendered Output (`resolveWedgeBatchInfo` in
  lib/wedge-batch.ts: flatten + reverse reachability, shared with the UI
  readouts) and renders once per variation, with `ctx.wedgeIndex` stepping
  0..N−1 (EffectsApp's `wedgeIndexRef` → makeContext). Multiple wedges
  **zip** (batch = max count; a shorter wedge clamps, so its last value
  holds). Outside a batch `ctx.wedgeIndex` is undefined and the node emits
  its `preview` param — scrub Preview to audition variations live;
  `enabled: false` pins a wedge to preview (reports count 1). **Caching
  invariant:** the node folds the clamped effective index into
  `fingerprintExtras`, and the batch drivers deliberately do NOT clear the
  eval cache between variations — wedge-independent branches render once
  per batch. Don't break either half. Filenames: `{i}` / `{i:3}` /
  `{wedge}` / `{wedge:Name}` tokens in the Output's `filename`
  (lib/export-naming.ts); a batch that names no token auto-appends
  `_{i:3}`. Sequence batches share ONE zip/folder (zip name strips
  tokens). Caveats: batched videos always use the wasm encoder (the
  native-ffmpeg path needs a Save dialog per file, same as the queue);
  Layer Output exports don't batch (the fixed group-output id dissolves in
  the flatten pass).
- Exported apps: `buildExportManifest` walks the graph for params marked
  `controlParams` (per-node "user controllable" flags) → manifest of
  panel controls + file inputs; export-packager.ts zips the prebuilt Vite
  template (public/export-template/v1) with project.json + assets. The
  same manifest powers `/live/[slug]` via lib/live-viewer/LiveViewer.tsx.
  **This is why src/engine + src/nodes must stay self-contained.**
  Packaging rules (073126_export-resolution-and-app-slim.md): the 25 MB
  cap applies to USER content (serialized graph + manifest — embedded
  media is the payload), NOT the fixed template weight — counting the
  template is what silently broke every Export App when the ~22 MB
  ONNX wasm landed in dist/. That wasm (`ORT_WASM_ASSET_RE`) is only
  fetched at runtime by the ML nodes (`ML_NODE_TYPES` in
  export-packager.ts: bg-remove / segment-anything / depth-anything —
  keep in sync with nodes importing lib/ai), so `runExportApp` skips
  downloading + zipping it when `graphUsesMlNodes(graph)` is false.
  The modal's size estimate is real now: serialize once on open + the
  template manifest's `distBytes`/`sourceBytes`/`tierABytes` (emitted by
  build-export-template.mjs; older manifests → graph-only estimate).
  **Where the template comes from per target** (`public/export-template`
  is gitignored — nothing ships it implicitly): the release CI runs
  `install:export-template` + `build:export-template` before
  `desktop:publish`, and vercel.json's `buildCommand` runs the same pair
  with **`--slim`** before `next build`. `--slim` drops the ONNX wasm from
  the published copy (28 MB → 5 MB of static assets per deployment) and
  records `mlRuntime: false` in the manifest; `runExportApp` refuses an
  ML-node project against such a template (and the modal disables Export
  with the reason) rather than shipping an app that 404s its runtime.
  Manifests predating the flag have no `mlRuntime` and read as full.
  A build that never ran the script at all has no manifest → the fetch
  404s to the HTML error page, so `runExportApp` checks `resp.ok` before
  `.json()` (otherwise: `Unexpected token '<'`).
  Template-build gotcha: engine/editor imports reaching the template
  bundle need their aliases/shims maintained — vite.config.ts maps
  `@/wasm` (vector-kernel glue) and src/shims/state-graph.ts carries
  verbatim copies of the `@/state/graph` values graph-ops imports
  (newNodeId, newCompositionId, FRAME_XY_PROPS) — a new such import
  breaks `npm run build:export-template` (and the release CI).

## Desktop (Electron) build

The app ships as **both** the web app and a native **Electron desktop app**
(**macOS** arm64 + **Windows** x64) from one codebase. The desktop build's only
behavioral differences: heavy export runs through **native ffmpeg** (no wasm
heap/thread limits), file open/save use **native OS dialogs**, and it works
**offline**. Full design: archive/062626_electron-native-export.md; the Windows target +
native window controls: archive/070626_windows-desktop-build.md.

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
  archive/070626_windows-desktop-build.md.
- **Graceful offline**: auth uses `getSession()` (local cache, "signed in
  offline") not `getUser()`; project lists fail-fast (timeout + `navigator.onLine`
  + try/catch → empty/cached). Local files + native export work fully offline;
  curated/web fonts, ML/tracker nodes, and wasm-GIF still need network
  (accepted). Installed local fonts (desktop is Chromium → `queryLocalFonts`)
  work offline and are the preferred picker source there.
- **Auto-update** (spec archive/070826_desktop-auto-update.md): `electron-updater`
  over the GitHub Releases feed (`latest*.yml` + blockmaps → differential
  downloads). Main-side `electron/updater.js` broadcasts one
  `toolbox:update:state` payload; the seam exposes an optional `updates`
  capability; `useDesktopUpdates` + the Toolbox-menu slot + `UpdateToast`
  are the UI. Checks quietly ~10s after launch + manual "Check for Updates…";
  download is user-initiated; `quitAndInstall(true,true)` restarts. Gotchas:
  electron-updater ships as an **esbuild vendor bundle**
  (`electron/vendor/`, built by `desktop:prepare` — node_modules are excluded
  from the app package); mac updates install from the **zip** target (added
  alongside dmg; Squirrel needs it + a signed app); dev/unpackaged runs no-op.
  A release now bumps **three** version spots: package.json, a new entry in
  src/lib/changelog.ts (`CURRENT_VERSION`), and the git tag.
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

## Theming (080226_theme-modes.md)

The editor is light/dark themed, plus a per-mode brightness trim, both under
User Preferences → Appearance. `theme/theme.ts` follows the `ui-font.ts`
pattern (localStorage, `useSyncExternalStore`, applied to `<html>`); mode
rides a `data-theme` attribute that `app/theme-tokens.css` keys off, and a
pre-paint script in `app/layout.tsx` sets it before first paint.

**Write `var(--tb-…)`, not a hex literal.** The neutral ramp is
**positional** — `--tb-n-0` (deepest surface) … `--tb-n-17` (brightest ink) —
because `#27272a` was a border in 59 files and a raised surface in others, so
role-based names would have been wrong half the time. Light mode mirrors the
ramp end-for-end, which means a site keeps its relative position and nesting
inverts for free. Semantic aliases (`--tb-panel`, `--tb-border`, `--tb-ink`)
sit on top for new code. Accents are `--tb-a-*`, one-off tints `--tb-t-*`,
the app frame `--tb-frame`, and translucent washes go through
`color-mix(in srgb, var(--tb-lift) N%, transparent)` so a "lighten by N%"
becomes a "darken by N%" on a light surface.

Socket colours are a special case: `socketColor.ts` carries a dark/light
pair per type, with the HUE identical in both modes (that is the wire
identity) and only lightness capped for light mode, so a bright
`#facc15` scalar doesn't become unreadable pale text on a white node. Use
`colorForSocket()` in DOM/SVG; use `resolveSocketColor()` in a canvas 2D
context, where `var()` cannot resolve.

Deliberately NOT themed, and should stay that way: canvas gizmos and
overlays (contrast is against the user's artwork, not the UI), node tint
presets and any other value PERSISTED into a project (a `var()` in a saved
file resolves nowhere), the live viewer and export template (exported apps
are user artifacts), and saturated identity colour like the macOS traffic
lights. `scripts/theme-scope.mts` is the authority on that list.

Two runtime adjustments ride on top of the ramp, both in `theme/theme.ts`:
a per-mode **brightness trim** (OKLCH lightness offset) and a global **tint**
(a hue pushed onto the greys, chroma scaled by an intensity slider). The tint
touches greyscale tokens ONLY — accents, socket hues and `--tb-t-*` keep
their own colour, so tinting the chrome can't restyle an error state. Both
are applied in one OKLCH round-trip per token and cached for the pre-paint
script.

Elevation uses `--tb-shadow-node` / `--tb-shadow-chip` / `--tb-shadow-pop`,
which are whole `box-shadow` values per mode — light mode gets its own far
softer shadow rather than the dark one recoloured.

Source of truth is `theme/tokens.ts`. After editing it run
`npm run gen:theme-css`; `npm run check:theme-css` fails if the generated
`src/app/theme-tokens.css` is stale. `scripts/audit-theme-colors.mts` lists
every colour literal still unthemed, and
`scripts/codemod-theme-tokens.mts --apply` sweeps up new ones (idempotent).

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
when designed (e.g. archive/layers-groups-attributes.md, archive/webgpu-particles.md,
timelinespec / archive/updatedtimelinespecv2.md, archive/sdf-nodes.md,
archive/autolayout-node.md). The flow that works: read the devlist entry →
explore the relevant engine/UI code → write/iterate a spec with the owner
→ implement in milestones. In-app user-facing docs live under
src/app/docs + lib/docs/manifest.

Verification gates (also CI, `.github/workflows/ci.yml`, on every push/PR):
`npm run typecheck` and `npm run check` (the six offline check-*.mts
scripts guarding the AI-recipe trust boundary) are hard gates. Lint gates
through a **ratchet** — `npm run lint:ratchet` fails only when a file
gains errors beyond `scripts/lint-baseline.json` (pre-existing React 19
hooks-rule errors are grandfathered; warnings never gate). After fixing
errors, tighten with `npm run lint:ratchet -- --update` and commit the
baseline. Spec: archive/070826_riskfix-plan.md §2.

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
  empty and is re-picked in the panel. Spec: archive/061826_gif-export-and-image-sequence.md.
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
- **EXR import + color pipeline** (spec archive/070926_exr-color-pipeline.md).
  Image Source and Video Source's sequence kind accept OpenEXR — single or
  multilayer, DWAA/DWAB/ZIP(S)/PIZ/RLE/PXR24/B44 — with a per-node layer
  dropdown (`exr_layer`: a `control:"exr_layer"` enum whose options come
  from the loaded file's header, which is stored on the media param value)
  and an un-premultiply toggle (EXR is associated-alpha; the engine is
  straight-alpha). The decoder is a **vendored fork of three's EXRLoader**
  in [src/engine/exr/](../src/engine/exr/) (engine-side so exports carry
  it): `parseExrHeader` is header-only (~1ms at 4K, run at pick time),
  `decodeExrLayerAsync` decodes one layer to straight-alpha RGBA Float32
  (rows top-first like ImageBitmap; HDR intact) on a worker pool
  (min(4, cores−2), ping-handshake before jobs since buffers TRANSFER,
  sync fallback when workers can't load — the single-file exported app
  can't inline the worker chunk). The fork fixes paths upstream never hit
  (it rejected multilayer files outright): DWA's unknown-rule channel
  block is now read (float Z/Normal channels live there — upstream never
  even skipped it, garbling ALL channels), one DWA CSC set per layer
  prefix with shared AC/DC stream counters, channel-planar RLE/UNKNOWN
  buffer layouts, per-channel byte sizes for mixed HALF/FLOAT files (ZIP +
  PIZ), and float-DCT half→float expansion. Verified against
  Blender-rendered multilayer DWAA/ZIP/PIZ with ffmpeg as an independent
  cross-decoder. Costs (measured, M2 MBP-class): 4K×15-channel multilayer
  ≈ 4.2s/frame DWAA, ≈ 2.1s ZIP — chunk decompression covers ALL channels
  regardless of the selected layer, so realtime raw playback is out;
  sequences lean on a **byte-budgeted** texture LRU (512MB; a 4K RGBA16F
  frame is ~66MB) + 3-frame decode-ahead, and hold the last-good frame
  when starved. Offline export stays exact via settles. UINT channels
  (cryptomatte) and deep files are rejected with clear errors. EXR stills
  serialize their ORIGINAL bytes (`{kind:"exr"}` envelope, schema v8);
  EXR sequences relink like any sequence. Image Source is cached, so its
  async decode readiness rides `fingerprintExtras` (upload key + pending
  flag). Color pipeline: the **Color Space** node does analytic
  conversions (sRGB / Linear sRGB / ACEScg / ACES2065-1 / Rec.709 /
  Gamma 2.2 / Display P3) with optional ACES (Hill fit) / AgX / Filmic
  (Hable) view transforms applied in scene-linear; **Apply LUT** gained a
  log2 HDR shaper + 16F volume so `ociobakelut` shaper+cube LUTs grade
  scene-linear footage (and 8-bit banding is gone).
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
  `scalar`/`image`. Spec: archive/062926_audio-analysis.md.
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
  texture). **Rasterize Spline** additionally routes the wired image per two
  toggles (`image_fill` default on, `image_stroke` default off — defaults =
  legacy fills-only): the compositor grew optional `strokeFromImage` (stroke
  alpha = coverage, recolored by the sampled image) and `fillPrecolored`
  (the fill layer arrives as finished colors — how ramp/flat fills survive
  when the image drives only the stroke) flags; omitting them reproduces the
  old behavior for every other caller.
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
  indexed by `ramp_by` (index / seeded random / groupIndex / centroid position).
  Ramp sampling is the CPU helper `sampleColorRamp` in the engine-side
  [color-ramp.ts](../src/engine/color-ramp.ts) (where `ColorRampStop`/
  `COLOR_RAMP_MAX_STOPS` now canonically live — the Color Ramp node re-exports
  them). A wired `fill` image still overrides the ramp. The per-subpath
  color-resolver itself (`makeSubpathColorFn` + `hash01` + centroid) lives in
  engine-side [spline-color-source.ts](../src/engine/spline-color-source.ts):
  Rasterize Spline's fill and the **Stroke** node's stroke color both build a
  `SubpathColorConfig` and share it, so stroke color has the same flat/ramp
  source options (index/random/group/position) as fill. In Stroke the
  per-subpath source strokes each subpath in its own color, and the per-ring
  Repeats ramp (`repeat_color_mode`) takes precedence over it when both are on.
  Rasterize Spline's own stroke has the same sourcing (`stroke_source` +
  `stroke_ramp` / `stroke_ramp_by` / `_seed` / `_angle` / `_interp`),
  independent of the fill's — flat color keeps the legacy single-pass stroke
  (translucent overlaps don't double-blend); ramp strokes per subpath.
  (4) Rasterize Spline's **`holes`** ("Punch holes", default OFF — old saves
  byte-identical): per-subpath fills (stacking / ramp / layered) paint nested
  contours SOLID — text counters, donuts, Points-to-Surface air pockets fill
  over. With holes on, subpaths group into containment ISLANDS
  (even-nesting-depth outer + its odd-depth children, point-in-poly on
  8-samples-per-cubic polylines, ≤256 subpaths else legacy fallback) and each
  island fills as ONE even-odd path colored by its outer — negative space
  punches while ramp colors and stacking order survive, in both overlap modes
  and the image-fill coverage path. Toggling re-rasters via the `hol` key in
  both raster signatures.
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
  Depth Anything specifics in archive/061926_depth-anything-node.md (incl. the
  per-frame normalization flicker caveat for video).
- **Dynamic input sockets — two patterns.** (1) *Param-backed* (Merge's
  `merge_layers`, Render Queue's `render_queue`, Collect's `count`): the
  socket list lives in a param and `resolveInputs(params)` derives sockets
  from it; the UI re-syncs `data.inputs` on param change. Growth is a
  manual `+` (an `effect-node-toggle` event; Combine/collect also grows this
  way via a `collectAddInput` bump of its `count` param). The Color node
  (`color-literal`) applies the same pattern to OUTPUTS: a `count` param
  (1..8) unlocks declared `color2..color8` params (each a first-class color
  param — keyframe/expose/control for free) and `resolveAuxOutputs` mints a
  vec4 output per extra color; the `+` (`colorAddOutput`) bumps count, and
  shrinking count via panel drops edges to the removed outputs in
  onParamChange. Spec: archive/071026_color-node-multi-output.md. (2) *Auto-grow from
  edges* (Proximity Join/Merge — archive/070126_proximity-join-merge.md; and Spline
  Interpolate — archive/070626_spline-interpolate.md — which share the effect): a
  `slots: string[]` param whose value is **derived from the node's edges** by a
  dedicated `useEffect` in EffectsApp keyed on `edges` (guarded on those two
  `defType`s), kept equal to (connected sockets) + one trailing empty spare. Wiring the spare mints
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
  connectedTypes-retyping node to that set (the **Reroute** node is one — its
  wildcard `value` input + output adopt whatever's wired in; the **Mirror**
  node is another — its spline-resting `source` retypes to points,
  archive/072026_mirror-node.md). **AI recipes/edits can author
  pattern-(1) merge stacks** (070926_claude-mcp-bridge.md §4c): `layers`
  accepts [{mode, opacity}, …] via `vetMergeLayers` (ids minted, or
  preserved by index on edit so wires survive), edge targets `in:layerN` /
  `in:maskN` alias onto the real id sockets with auto-grow
  (`resolveOrdinalHandle`, gated on the `merge_layers` param type), and
  `graphToSpec` surfaces resolved sockets for any dynamic def.
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
- **Rope Simulator** (`rope-simulator`, spec archive/071926_rope-simulator.md)
  is a CPU string-dynamics node: spline in → simulated spline out
  (+ aux `points` and per-frame `tears` points). Subpaths resample to
  particle chains (exact even-arc-length seeding — resampleSubpath
  alone bunches samples on handle-less segments); XPBD distance +
  bending constraints in canvas-px space; per-particle material attrs
  (friction/bounce/stretch/stick multipliers, tear weakness) from base
  params × mask-typed map inputs, baked at reset by default with
  per-map live (world-field) toggles; pinning via ends enum / pin map /
  animated `pins` points capture / `follow_input` arc-length tracking
  of the live input spline. It CONSUMES the Particle Simulator's
  force/collider descriptor nodes — the CPU ports live in
  engine/sim-kernel.ts (shared with the Rigid Body Simulator) and
  mirror the GLSL exactly; keep them in sync when adding kinds. The image-mask
  collider deliberately diverges: it builds a chamfer DISTANCE FIELD
  from the readback (alpha-gradient nudges stall deep inside solids;
  ropes drape into them). Self/string↔string collision is a counting-
  sort spatial hash at `thickness` px. State is session-only in
  `ctx.state`, reset on time-wrap / topology change / seed-param
  change — input SHAPE edits don't reseed (deliberate, for
  follow_input); scrub to 0 to reseed. Steps on the house sim
  contract (matter-simulator precedent): playing evals and
  time-advancing offline evals advance; paused evals re-emit without
  stepping, so a parked playhead (frame 0 included) holds its pose.
  Coordinate spaces (sim-kernel.ts header): geometry sockets are
  AUTHORED space (engine/aspect.ts) mapped to TRUE canvas px for the
  solver via `subpathToCanvasPx`/`authoredToPxY`; canvas bounds, mask
  colliders, and property maps use canvas UV; force and analytic
  circle/line collider descriptors are evaluated at authored coords
  (Particle Simulator parity). Rigid Body shares all of this.
- **Rigid Body Simulator** (`rigid-body-simulator`, spec
  archive/072026_rigid-body-simulator.md) is the rope's sibling: one BODY per
  subpath via Müller shape matching (closed-form 2D fit; pins carry a
  large fit weight — one pin = hinge/pendulum, two+ = frozen; same
  four pin mechanisms as the rope). Shares engine/sim-kernel.ts with
  the rope. Body↔body contacts are particle↔EDGE capsules (+ same-body
  particle pairs under `self_collide`): discovered once per substep,
  deduped to the deepest contact per (particle, other body), then
  re-projected EVERY iteration interleaved with the shape match — the
  interleave is what makes stacks settle; don't hoist contacts out of
  the loop. Rigidity 1 outputs the ORIGINAL bezier anchors under the
  fitted rotation+translation (handles rotate only — exact authored
  curves, tumbling); < 1 rebuilds from particles, with the per-pull k
  composed over iterations × substeps so the slider is solver-rate
  independent. Glue mints particle↔particle bonds at cross-body
  contacts (rest = contact distance, 4/particle cap, `glue_map`
  strength field); breaks are PIXEL-denominated — bond overstretch OR
  endpoint displacement from the body's fitted pose — NOT strain
  (bond projection runs last in the loop, so a yanked bond stays
  satisfied while ripping its endpoints off the pose; see the spec's
  Breaking note). `snaps` aux emits break points; `bodies` aux emits
  one point per body (centroid + rotation) for Copy-to-Points image
  stamping. Clamp bounds additionally zero inward velocity at the
  wall node-side (kernel clamp keeps rope/particle semantics) so
  resting bodies don't accumulate phantom gravity velocity.
- **Per-point field logic lives in Point Expression** (`point-expression`,
  spec archive/070726_point-expression-node.md). The engine has no general per-element
  field system like Blender geometry nodes — a `PointsValue`'s attributes are
  baked at generation and otherwise vary per-point only via image-field
  sampling (Modulate Points / Sample Texture at Points / Displace). Point
  Expression is the one exception: a `"use strict"` JS block run **once per
  point** with `index/count/groupIndex/px/py/rot0/sx0/sy0` + the frame clock +
  optional `path`-spline sampling (`pathPos/pathLen/pathAngle`), writing
  `x/y/sx/sy/scale/rot` and culling via `keep` (count shrinks — Blender
  Delete-Geometry parity). `rand(seed)` is a frame-independent triple32 hash
  (index-stable windows/gates — the "Random Value hashed on Index" primitive);
  `random()` varies per frame. **Tunables are Houdini-style channels**:
  `ch("name", default)` reads a named slider input (wired scalar ?? slider ??
  inline default), and the panel **Sync** button (`ParamDef.channelSync`) scans
  the expression for `ch(…)` calls and mints the sliders (`syncChannelInputs`,
  add-only). Channels are read via `ch()` — **never bare variables** — so a
  channel name can't collide with a built-in (`ch("x")` is fine); the kernel
  signature is fixed `(__env, __pt)`. Reuses the `expr_inputs` param UI
  (type-driven in param-controls.tsx). The scalar Expression node stays
  once-per-frame and keeps its bare-variable inputs. Strict mode means
  intermediates need `let`/`const` (bare assignment throws → fails safe to
  passthrough). At runtime only the compiled epilogue's exact 7-tuple counts
  as a result — a user `return` of any other shape keeps the point unchanged
  (a returned short array used to leave `keep` undefined and cull every
  point). **AI recipes can author the expression** (`expression` is a
  settable string): `buildRecipe`/`applyRecipeEdit` auto-run the channel
  Sync on an authored/patched expression (`syncExpressionChannels` in
  recipe-builder.ts — `expr_inputs` itself isn't LLM-settable), recipe
  edges/inputs may target a channel by NAME (`pe:in:speed` —
  `resolveChannelHandle` aliases onto the id-based socket; literal sockets
  win collisions), and the def's `validateParams` hook compiles + smoke-runs
  the kernel during recipe validation so undeclared temps and `return`-style
  code come back as repairable `PARAM_INVALID` errors instead of silently
  no-oping.
- **Multi-stroke + float curves + stroke units** (spec
  archive/071226_multi-stroke.md). The `float_curve` ParamType is a single
  monotone-cubic 0..1→0..1 curve (`CurvePoint[]`, plain JSON, NOT
  keyframable/exposable) whose model lives engine-side in
  [float-curve.ts](../src/engine/float-curve.ts) — the RGB Curves /
  Color Correction math re-exports from there, and the generic
  `FloatCurveEditor` in param-controls.tsx is the one curve-chart UI
  (CurvesControl wraps it per channel; remount via `key` to clear its
  selection). Multi-stroke offsets live in
  [spline-repeat.ts](../src/engine/spline-repeat.ts)
  (`buildRepeatStrokes`): fixed-band model (offset_i = width ×
  spacingCurve(i/(N−1))), offsets computed in canvas-PIXEL space so rings
  stay uniform on non-square canvases (distance unit = canvas-width
  fraction), closed subpaths winding-normalized via shoelace sign so
  `outer` always expands (open paths: inner/outer = left/right of
  travel). Consumed by the **Repeat Path** node (`spline-repeat`,
  spline→spline, tags each ring's subpaths with `groupIndex` = ring) and
  the **Stroke** node's collapsible Repeats group (per-ring
  thickness/opacity falloff curves + optional color ramp; two-tier
  signature so styling edits re-stroke cached Path2Ds without re-running
  bezier-js offsets). The concave-region self-overlap is now resolvable:
  an **Overlap** enum (`keep`/`sharp`/`smooth`, default `keep` — no schema
  bump) on Offset Path, Repeat Path, and Stroke's Repeats runs
  `resolveSubpathOverlaps` ([spline-offset-resolve.ts](../src/engine/spline-offset-resolve.ts))
  — a cubic-exact loop cull that finds every self-crossing (bezier-js
  `selfintersects`/`intersects`) and skips the geometry between each
  crossing's two feet (sharp = one corner point; smooth adds a local
  junction fillet). Runs in px space for isotropic tolerances; closed rings
  rotate to a loop-free seam first, and a fully-inverted ring resolves to
  null (dropped). Stroke plumbs the two params into its `geomSig` so ring
  Path2Ds re-cache. Loop-cull only — a collapsed inner offset simplifies to
  one clean closed subpath rather than splitting into islands. Spec:
  archive/071426_offset-overlap-resolve.md. Shipping the multi-stroke work fixed a
  latent `offsetSubpath` bug that also bit
  the Offset Path node: bezier-js's offset() NaNs on handle-less
  (polyline) segments — the shared fix synthesizes 1/3-chord handles
  (identical geometry) before offsetting (`solidifyForOffset` in
  spline-math.ts). Stroke metrics (thickness, dash/dot) on Stroke / Rasterize
  Spline / Spline Draw / the primitives' bundled rasterizer now take a
  px-vs-`%` units toggle ([stroke-units.ts](../src/engine/stroke-units.ts),
  % = canvas-width fraction — the #174 fix; default stays `px` so old
  saves render byte-identical).
- **Adaptive Pixelate** (`adaptive-pixelate`, spec
  archive/072326_adaptive-pixelate.md) renders non-constant pixel grids (uniform /
  quadtree / lattice) with block size driven by its `size_map` mask input
  (or the source's own luminance when unwired). The grid is
  CPU-AUTHORITATIVE: a GPU box-reduce of the driver reads back at
  finest-grid resolution (small), the CPU builds the cell list, and the
  single image pass reads the grid through an RGBA32F cell-rect index
  texture (quadtree/uniform — cells are unions of finest texels, exact) or
  two per-canvas-pixel axis LUTs (lattice — cuts round to integer px, so
  pixel granularity is exact). One authority means the image and the points
  aux can't disagree on a threshold cell. The readback runs per recompute,
  so an animated driver pays a small sync stall each frame (static graphs
  cache normally). The points aux (cell centers y-down normalized, scale
  relative to the max block, groupIndex = quadtree level) is built
  UNCONDITIONALLY — the node caches, so consumption-gating would serve
  stale empties once wired (the loop-weave rule, 072226 audit #5).
- **Flow fields** (spec archive/072526_flow-fields.md): velocity fields travel
  as plain images per [velocity-field.ts](../src/engine/velocity-field.ts)
  (signed-RG, midlevel 0.5, Y-DOWN, isotropic canvas-width units — the
  encoding Perlin Noise `curl` already emits and Displace / Advect
  Points `vector` already read; y sign flips at the GL boundary, y steps
  scale by aspect). Producers: Perlin curl, **Spline Flow Field**
  (`spline-flow-field` — regularized vortex dipoles along a drawn curve,
  divergence-free by construction; `along`/`orbit`, chainable `field`
  input sums fields), **Flow Obstacle** (`flow-obstacle` — deflect/block
  a field around a mask; boundary handling lives HERE, composable, not
  on producers). **Advect Image** (`advect-image`) is the stateless
  consumer: per-pixel backward semi-Lagrangian trace, field modes mirror
  Advect Points; two passes so its uv map is a first-class `uv` aux
  (built unconditionally — loop-weave rule). CAVEAT: matting an encoded
  field decodes as v=(−1,−1) — matte consumer outputs, not fields.
- **Fluid Simulator** (`fluid-simulator`, spec archive/072626_fluid-simulator.md)
  is the 2D Eulerian ink/smoke sim: Stam stable fluids + advection-
  reflection (energy-preserving mid-step reflection, two warm-started
  Jacobi projections per substep) + vorticity confinement dial, on
  Watercolor Ink's chassis (stable:false + time fingerprint, node-owned
  RGBA16F grid state in ctx.state, reset on scene wrap, playing/offline
  gate, drive_by_scene_time, deposit/color dye vocabulary). Consumes the
  particle FORCE/COLLIDER descriptors via slot params (forceCount/
  colliderCount) — its `applyForce` + curl2 GLSL are copied VERBATIM
  from particle-simulator-webgl.ts (third copy of the contract after
  sim-kernel.ts): keep all three in sync when adding force kinds.
  Internal frame is GL texel space (y-up, isotropic); particle-frame and
  M1-field conversions happen only at the seams. `field` input = guide
  field in; `velocity` aux = live sim field out (M1 encoding, built
  unconditionally) so Advect Points/Image can ride the sim.
- **Matter Simulator** (`matter-simulator`, spec archive/072726_matter-simulator.md)
  is MLS-MPM deformable matter (liquid/jelly/snow, mpm99 material
  models) as WGSL compute — the first real WebGPU node beyond the
  particle Phase-1 test, and it inherits that node's bridge pattern
  verbatim: async device boot cached at `<type>:<id>:status`, ONE FRAME
  BEHIND via renderOut → staging → mapAsync → uploadFloat32ToImage,
  offline export exact via pushMediaSettle (the settle re-render can't
  double-step — time hasn't advanced past the active gate). P2G scatter
  uses fixed-point i32 atomics (round(v·2¹⁶); WGSL atomicAdd is
  i32-only). Seeds from a `seed` points input / `region` mask / default
  block — no continuous emitters; `particle_radius` packs seeding at a
  rest spacing (liveCount ≤ budget rides the whole pipeline). Consumes
  force descriptors (FOURTH copy of the applyForce contract — webgl
  GLSL, wgsl integrate.ts, fluid-sim GLSL, matter-sim WGSL: keep all
  four in sync). Obstacles two ways: analytic circle/line colliders
  (free-slip on grid nodes + G2P position projection, surfaces inflated
  by `collider_radius`), and a baked SDF — the `obstacle` spline input
  ∪ image-mask collider alphas → CPU chamfer signed distance at grid
  res → storage buffer, rebaked only on value-identity change (animated
  spline obstacles work). Per-material dials (visibleIf material):
  liquid stiffness/viscosity, jelly stiffness, snow stiffness/crumble/
  hardening. Outputs `particles` + a `points` aux that must stay
  populated on paused evals (kept CPU-side as lastPositions — the
  readback is consumed once but stable:false recomputes every eval).
  **Points to Surface** (`points-to-surface`,
  archive/072726_points-to-surface.md) is the surfacing companion — Zhu-Bridson
  / metaballs field + marching squares, points → spline with per-blob
  groupIndex; general to ANY points producer, not just sims.
- **Diffusion Curves** (`diffusion-curves`, spec
  archive/072726_diffusion-curves.md — Orzan et al. 2008): spline →
  smooth-shaded image. Left/Right `color_ramp`s run ALONG each subpath
  (stop position = t; per-stop alpha diffuses too, so results composite
  via Merge); trace mode samples a wired image at the source bands
  (the paper's §4.2 tracing — live per frame over video). Stateless
  steady-state solve → NORMAL caching (not stable:false): static
  graphs are free, and the recompute cost is the brute-force
  nearest-segment pass (O(segments·pixels), ≤2048 samples — segIdx
  must stay half-float-exact). All constraint rasters are texelFetch
  lookups through that nearest-field texture; nearest-segment-wins
  replaces the paper's stencil discard at crossings/thin structures.
  The on-curve gradient band must stay 1px (halfw 0.5) — wider
  double-counts the jump in div w and overshoots. Solve rides
  engine/poisson.ts (RHS restricted by 2×2 SUM across levels — the h²
  scaling; sanity test: straight line, red/blue ramps → hard step).
  Two nodes can't share one solve (solved images don't sum) —
  constraint-level chaining is future work; composite via diffused
  alpha instead.
- No automated tests; keep modules pure where possible (layout solver,
  graph-ops) so they're testable when a runner lands.


Notes:
1. Never use playwrite unless explicitly asked
