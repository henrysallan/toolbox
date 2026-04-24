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
