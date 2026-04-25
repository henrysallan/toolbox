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
