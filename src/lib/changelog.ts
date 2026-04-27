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
