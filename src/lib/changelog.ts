// Hand-authored changelog. Newest entry first — that's the display order,
// and `CURRENT_VERSION` mirrors entries[0] so the menu-bar label stays in
// sync with whatever we last shipped.

export interface ChangelogEntry {
  version: string;
  date: string; // ISO, free-form — just what shows in the dropdown
  added: string[];
  changed: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.4.1",
    date: "2026-07-13",
    added: [
      "Multi-stroke: a new Repeat Path node emits N parallel-offset copies of a spline (composable into Stroke / Trim / Boolean / Rasterize), plus a Repeats section right on the Stroke node with per-repeat thickness and opacity falloff and a color ramp across the set. Both are driven by a new float-curve editor — a reusable 0–1 → 0–1 curve control for shaping spacing and falloff.",
      "Spline Merge gains a Flow (\"liquid\") mode — instead of a hard per-frame boolean, the merged silhouette behaves like a fluid surface that chases the union: bridges swell and snap as shapes approach, and necks stretch and thin as they part.",
      "On-node editing: the String and Text nodes now have an editable text box directly on the node body, the Constant node has an inline value slider, and every node has a resize grip on its lower-left corner — drag to resize (the size is saved with the project, double-click to reset).",
      "Claude MCP bridge can now read the engine — new node-source tools let the assistant pull a node's actual source and the engine helpers it calls, so it can explain node behavior and build graphs from ground truth instead of the catalog summary.",
    ],
    changed: [
      "Stroke metrics (thickness, dash / dot lengths) get a units toggle — px (default) or % of canvas — so a stroke no longer changes weight when you change the canvas resolution. Spline Draw and Rasterize Spline share the same resolution-independent path.",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-07-08",
    added: [
      "Windows desktop app — the same app as a native Windows build (x64 installer): native ffmpeg export, native file dialogs, works offline. Windows-native caption buttons (minimize / maximize / close) sit top-right in the title bar; the landing page's download button now leads with your OS and links the other platform below.",
      "Desktop auto-update (macOS + Windows) — Toolbox checks for a new release quietly after launch (and on demand via Toolbox → Check for Updates…). When one is out, \"Update Toolbox\" appears in the Toolbox menu; it downloads with a corner progress toast (differential — only changed blocks, not the full installer), then \"Restart to Update\" installs and relaunches. A downloaded update also installs on the next normal quit.",
    ],
    changed: [
      "macOS desktop builds are signed + notarized, and every release ships the mac dmg and Windows installer together from CI.",
      "Frameless title bar: window dragging fixed — the empty bar area is a full-height drag region (it previously collapsed to zero height, so there was nothing to grab).",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-06-08",
    added: [
      "Color grading suite: RGB Curves node (per-channel + master monotone-cubic curves with a dedicated curve-editor panel), LUT node (apply a `.cube` 3D LUT via a hardware-filtered 3D texture — 1D LUTs expanded to a 3D grid for one sampling path), and a DaVinci-style primaries panel on the Color Correction node — four color wheels (Lift / Gamma / Gain / Offset) with balance discs and master sliders, plus Temp / Tint / Hue / Contrast / Pivot, all writing straight to the node's shader.",
      "On-canvas Primitive Gizmo — transform handles for centered shape primitives (Circle, Rectangle, …) in a node-agnostic center + half-extents space; per-primitive adapters let new primitives opt in without touching the gizmo. Spline primitives also gained an `image` aux output (shared rasterizer) so you can drop one in and see it without a separate Rasterize node.",
      "Viewport shelf (right of the resolution bar): Circle / Rectangle / Draw spline-primitive buttons spawn the matching source node; when a Merge node is selected or active, the new node's image output is wired straight in as a new layer for one-click compositing.",
      "Shift+M in the node editor wraps the selected image/mask-output nodes (including aux image outputs) in a Merge node — leftmost selection becomes the base layer, the rest stack on top in left-to-right order with their layer sockets wired automatically.",
      "Per-node timeline clips — turn a source node (Video / Image / Text / Spline Draw / primitives) into Track-Editor clips with in/out windows. A node can hold multiple disjoint windows (razor-cut splitting) while still producing a single output per frame, so no node duplication or rewiring.",
      "`.toolbox` project files — a self-contained, desktop-loadable zip (manifest + graph + de-duplicated assets) so videos and images relink offline. Toolbox menu gains Save / Load for local `.toolbox` files.",
      "Prev/next keyframe carets flanking the keyframe diamond in the parameters panel — jump the playhead to the adjacent keyframe on that parameter. Always visible, dimmed when there's nowhere to go.",
      "Audio in video exports: the audio wired into the Output node's `audio` socket is muxed across all three encoder tiers — a deterministic offline render (decoded file → AudioBuffer, honoring start offset / loop / volume) for High (WebCodecs, AAC/Opus) and Max (ffmpeg, AAC/libopus), and a live captured track (file or mic) for Fast (MediaRecorder).",
      "WebGPU stipple relaxation — a GPU compute runner for the Stipple node's relaxation kernel, reusing buffers frame-to-frame.",
      "Landing page — first-load project browser (public / private) as its own screen, with a staggered fade-in (StaggerReveal) reused for parameter rows.",
      "Also shipped: WebGPU particle system; Stipple and Shape Cells nodes; variable-font Text; BG Remove and Lens Flare nodes; mip-chain bloom.",
    ],
    changed: [
      "Image / Video Source nodes auto-rename to the loaded file name (extension dropped) on load — via the Load button or drag-drop / paste — and the same label flows through to the Tracks editor.",
      "Audio Source plays to the speakers only when its output is wired into the Output node's `audio` socket; otherwise the element keeps advancing (so amplitude / data stays live for driving parameters) but stays muted.",
      "\"Match Aspect\" button nested in the image / video load module sets the project's aspect ratio to the source clip, keeping the current longest side and swinging only the ratio.",
      "Editor shortcut scoping — contextual shortcuts (G-move, Delete, Shift+D / Shift+M, …) route to the editor region last clicked, so tweaking params no longer silently disables the node editor's shortcuts.",
      "Offline-export media settle: deterministic frame stepping now waits for async video seeks to land before capture, keeping multi-video exports frame-accurate.",
      "Geometry aspect correction so shapes stay round on non-square canvases (render-time Y correction) without mutating any stored param.",
    ],
  },
  {
    version: "0.0.4",
    date: "2026-05-06",
    added: [
      "Image Generate node — chat-driven AI image generation backed by OpenAI's gpt-image-2 (Responses API, multi-turn `previous_response_id` chaining via gpt-4.1-mini orchestrator). Bring-your-own key configured under Toolbox → User Preferences. Custom split param panel: prompt log on the left, generation thumbnails (grid / list, white-stroke selection state) on the right, gear-icon settings popover for size / quality / format. Three optional reference image inputs reserved for future ref-conditioning. Selected thumbnail copies to a public Supabase bucket so saved projects render the curated output for everyone; chat history + alternate generations stay private to the creator in a per-(user, project, node) session row.",
      "User Preferences modal under Toolbox → User Preferences. v1 hosts the OpenAI API key (with show/hide + Test Connection); future editor-wide settings will live alongside.",
      "Timeline layout — Window → Timeline. After-Effects-style: tracks editor pinned full-width to the bottom, playback bar beneath it, canvas top-right, tabbed Parameters / Node Editor pane on the left (defaults to Parameters). Default layout is unchanged; toggle to switch.",
      "Grain node — luminance + chromatic film grain in one shader pass, Gaussian-shaped hash so it has a film-y shoulder. Optional image input with seven mix modes (overlay default), scale param defaulting to 1px (finest), seed for animated grain.",
      "Bevel & Emboss (image) and SDF Bevel (terminal). Image variant renders four bevel styles with two configurable lights using a JFA-cached height field; SDF variant taps the existing distance-field compile path for crisp vector bevels.",
      "Rasterize Spline node — combined fill + stroke in a single canvas pass, both toggleable. Keeps the standalone Stroke and Fill nodes for compositing flexibility.",
      "Transform gizmo overhaul: rounded handles, per-corner rotation grips, center + boundary snapping with red guides, Shift / Alt modifiers, spline-mode AABB hugging the actual geometry, drag coalescing into a single undo entry. Transform context bar above the canvas adds Flip Horizontal / Flip Vertical.",
      "Custom crosshair cursor (replaces every native cursor): white ring + four tick marks, soft hover halo on nodes / edges, red center dot on strong-hover targets (buttons, sockets, gizmo handles, form controls). Position snaps to the pointer with no lag so click target = ring center.",
      "Tracks Editor: clicking a header / lane label selects the owning node in the node editor (selection state mirrored as a white left-stripe + faint wash). New `selected only` toggle next to the Tracks / Graph tabs filters lanes to selected nodes.",
      "Node editor multi-select via Shift; Shift+D duplicates the selection and immediately enters G-move so clones follow the cursor until placed; marquee now uses partial intersection (any overlap = selected).",
      "Noise node field output now respects the W (4D evolution) param via slice-blend, matching the image / value paths so SDF graphs animate the way their visualizers preview.",
      "Default first-load view is the Load Projects browser (private when signed in, public when not) instead of an empty node panel.",
      "Spec docs added: `image-generate-node.md` (full design + OpenAI request shapes), `user-preferences-migration.sql`, `image-gen-migration.sql`, `typed-array-points-refactor.md`, `updatedtimelinespecv2.md`.",
    ],
    changed: [
      "Removed minimap from the node editor; widened pan / zoom envelope (minZoom 0.05, ±100k translate extent) so large multi-stage graphs aren't cramped.",
      "Rectangle source: position parameter now means the rectangle's center, not its top-left corner — consistent with Circle and the SDF primitives.",
      "Param panel: rAF-coalesced sliders so iPad doesn't drop from 60fps to 40 during drag; pointer-up flushes the final value.",
      "Track Editor delete deletes the selected keyframes (was deleting the whole node before).",
      "Performance: per-frame `setErrors` and `setSelectedPoints` shallow-equality guards to keep React out of its max-update-depth guard during playback. Cursor re-render bumps now skip while playback is active.",
      "Bug fixes: fixed timeline-layout vertical-resize drag direction in row-reverse mode; removed ImageBitmap upload race so first-click thumbnails render to canvas without a view-mode toggle workaround.",
    ],
  },
  {
    version: "0.0.3",
    date: "2026-04-26",
    added: [
      "Timeline node — authored bezier animation curves driven by an internal scene-time source (with a time-scale slider) or an optional external `t` input.",
      "Curve editor docked to the canvas via a bottom-center tab: marquee multi-select, Shift+drag axis-constraint, two-finger pan, Cmd+wheel x/y zoom, easing presets, draggable green playhead handle that scrubs scene time.",
      "Playback bar redesign: tick-marked centerline, red playhead, two-finger / middle-click pan, Cmd+wheel horizontal zoom, monotonic auto-grown view span (no more tick reflow on backward scrub), stroke-icon Play/Pause/Reset with hover state.",
      "Split viewport — Window menu or Shift+S stacks two preview canvases vertically with a draggable divider; per-node A1 / A2 toggles drive each viewport from its own active terminal; pan/zoom is independent per viewport and cursor-contextual.",
      "Canvas pan/zoom: two-finger / middle-click pan, Cmd+wheel zoom anchored at the cursor, `0` to reset. CSS-transform only — underlying canvas resolution unchanged.",
      "Spline Draw: select-tool now selects anchors instead of toggling bezier; Shift-click extends, click-drag empty space marquees, Delete removes the whole selection, Esc clears.",
      "Array node now polymorphic — image / spline / point modes with the same per-cell grid math, plus chain-link toggles on countX-Y, sizeW-H, patternOffset, copy translate, and copy scale.",
      "Fill node: `Stack subpaths` toggle (default on) so overlapping spline copies render as opaque stacks rather than evenodd-punching each other.",
      "Threshold and Voronoi / Fracture noise source nodes.",
      "Output node video pipeline: WebCodecs (AVC/HEVC/VP9/AV1, deterministic frame stepping) and ffmpeg.wasm (ProRes, H.265 CRF, lossless H.264) export tiers in addition to MediaRecorder.",
      "Project ratings: 1–5 star rating popover on public projects in the Load grid, persisted in Supabase.",
      "Keyboard shortcuts: Space toggles play/pause; F toggles full canvas; ⇧S toggles split viewport; 0 resets canvas pan/zoom; ⌘⌥N for new project (browser reserves plain ⌘N); X as a delete alias in the node editor; P / V switch Spline Draw modes (already worked, now documented).",
      "Keyboard-shortcuts doc page expanded to cover every new binding plus dedicated sections for the spline editor and the timeline curve editor.",
      "Spec docs: `customnodespec.md` (sandboxed user-authored nodes via QuickJS), `exportappspec.md` (Export App — bundle the active graph as a standalone web app).",
    ],
    changed: [
      "Renamed the bottom playback `Timeline.tsx` to `PlaybackBar.tsx` so the new Timeline node owns the unqualified name.",
      "Number inputs: rounded corners, custom thin-stroke spinner with chevron carets, soft grey focus outline (replaces the bright browser-default focus ring).",
      "Sliders: circular dot thumb with hairline grey stroke; new Shift-drag dampening (10× finer per-event delta) on every range input via a shared `DampenedRangeInput` wrapper.",
      "Parameters panel: uniform 10px spacing rhythm (panel padding, section gap, row padding all aligned), hidden scrollbar so left/right insets stay symmetric, explicit border-box sizing on rows.",
      "Splitter dividers (canvas/right column, node editor/param panel, viewport split, curve editor resize): visible 1px line with a 5px hit area for easier grabbing.",
      "Reset (⏮) on the playback bar now also re-frames the timeline view so the playhead is on screen.",
    ],
  },
  {
    version: "0.0.2",
    date: "2026-04-25",
    added: [
      "Wiki-style /docs route with auto-generated node reference and collapsible sidebar.",
      "Hand Tracker (MediaPipe HandLandmarker) with optional per-finger outputs (vec2 / point / aggregated points), smoothing, throttle.",
      "Lissajous 2D / 3D curve generators, Connect Points, Proximity Merge (with dedupe + lerp), Jitter (per-anchor noise displacement).",
      "Stroke node: dashed and dotted styles with spacing controls.",
      "Spline Draw: close-loop toggle (button or click on start anchor); larger anchor / handle hit areas.",
      "Editor UX: G shortcut for Blender-style move mode; drag-detach from connected input ports; bigger socket click targets.",
      "Per-instance slider range overrides — right-click any scalar slider to set Min / Max / Soft max; saved with the project.",
      "Public projects: Public/Private tab in Load grid, copy-on-save when viewing others' work, profile-based authorship.",
      "File-name pill in menu bar with save-state dot, rename, public/private toggle.",
      "Save / Save As name-collision detection with overwrite mode.",
      "File → New with unsaved-changes confirm; File → Load always accessible.",
      "Project listings cached for the session; manual refresh icon. Thumbnails moved to Supabase Storage.",
      "Node taxonomy reorganized: Image / Spline / Point / Audio / Utility / Effect / Output, with Generator / Modifier / Utility subcategories.",
      "Spline / points groups now flatten into base types with per-item groupIndex metadata; image groups remain.",
    ],
    changed: [
      "Group-Pick → Select by Index; Group-Length → Count Indices (filter / count by groupIndex for splines and points).",
      "Object Tracker + Hand Tracker: GPU-direct WebGL canvas path (no CPU readback), VIDEO running mode, detect-rate throttle.",
      "Pipeline-bump events rAF-batched so high-frequency sources (webcam, audio) don't drive React re-renders past display rate.",
      "Spline editor: clicking the start anchor now closes the loop; click-toggle bezier ↔ linear is no longer eaten by drag detection.",
      "Auto-splice no longer fires when the dragged node already has connections.",
    ],
  },
  {
    version: "0.0.1",
    date: "2026-04-23",
    added: [
      "Initial release.",
      "Node-based WebGL2 effects editor with spline, points, image, and audio data types.",
      "Simulation zones (Start/End) with reaction-diffusion and accumulator nodes.",
      "MediaPipe object tracker, webcam source, and audio source (file + microphone).",
      "Spline tools: draw, resample, offset, stroke, fill, sample-along-path, points-on-path.",
      "Points workflow: Point, Scatter, Copy-to-Points, Set Position, Transform (point mode).",
      "Groups: Group / Pick / Length across image, spline, and points.",
      "Editor UX: Shift+A search popup, auto-wire, drop-on-wire splice, wire combine/cut, middle-click pan, file drag-drop + paste.",
    ],
    changed: [],
  },
];

export const CURRENT_VERSION = CHANGELOG[0].version;
