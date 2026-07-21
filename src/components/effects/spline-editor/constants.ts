// Shared sizing / tuning / palette constants for the Spline Draw editor
// overlay (spline-editor/). Split out of the monolith in M0 of
// specdocs/071926_spline-draw-authoring-upgrade.md.

// Visual sizing. Anchors are intentionally small and outlined (blue stroke,
// faint fill); corner anchors (no handles) draw as squares, smooth/handled
// anchors as circles — matching Illustrator/AE pen-tool affordances.
export const ANCHOR_R = 4; // circle radius for handled (smooth) anchors
export const ANCHOR_SQUARE = 7; // square side for corner anchors (no handles)
export const HANDLE_R = 3; // handle dot radius
// Hidden hit-target radius around each anchor / handle. Larger than
// the visual dot so users don't have to be pixel-perfect, and so a
// small wiggle during a click doesn't trip the drag threshold and
// suppress the corner ↔ smooth toggle.
export const ANCHOR_HIT_R = 11;
export const HANDLE_HIT_R = 9;
// px stroke width of the invisible per-segment hit path used for hover +
// direct segment dragging in select mode.
export const SEGMENT_HIT_W = 12;
// px; below this a pointerup counts as a click. Bumped well above
// the visible dot radii so trackpad jitter and mouse wobble during
// a rapid double-click don't trip into drag mode and suppress the
// corner ↔ smooth toggle.
export const DRAG_THRESHOLD = 10;

// Pencil (freehand) tuning, all in canvas px so the fit is isotropic on a
// non-square canvas. PENCIL_FIT_ERROR is the max distance the fitted bézier
// may stray from the samples before it subdivides — "slight smoothing". A
// new sample is kept only when it's this far from the previous one (jitter /
// duplicate filter). A stroke whose end lands within PENCIL_CLOSE of its start
// auto-closes the subpath.
export const PENCIL_FIT_ERROR = 2.5;
export const PENCIL_MIN_SAMPLE = 2;
export const PENCIL_CLOSE = 12;

// Palette.
export const COL_STROKE = "#3b82f6"; // anchor outline (blue)
export const COL_FILL = "rgba(59, 130, 246, 0.18)"; // low-opacity anchor fill
export const COL_SEL_STROKE = "#f59e0b"; // selected anchor outline (amber)
export const COL_SEL_FILL = "rgba(245, 158, 11, 0.25)";
export const COL_PATH = "#22d3ee"; // authored-curve preview
export const COL_HANDLE_LINE = "#60a5fa"; // anchor → handle connector
export const COL_HANDLE_FILL = "#3b82f6";
export const COL_HANDLE_STROKE = "#dbeafe";
export const COL_SEG_HOVER = "#22d3ee"; // highlighted segment under cursor
export const COL_RUBBER = "#22d3ee"; // dotted next-segment preview
// Muted color for the non-active subpath outlines.
export const COL_INACTIVE = "rgba(148, 163, 184, 0.55)"; // slate-400 @ 55%

// Snapping (snapping.ts, spec 071926 M2): px radius within which a dragged /
// placed point locks onto an anchor or canvas guide. Cmd/Ctrl suppresses.
export const SNAP_R = 8;
export const COL_GUIDE = "#4ade80"; // smart-guide green — distinct from all editor chrome
// Hovered (not selected) anchor/handle outline — one step lighter than the
// resting blue so hover reads without competing with amber selection.
export const COL_HOVER = "#93c5fd";

// Live Corners widget (tools/corner.ts). The widget dot sits
// CORNER_WIDGET_OFFSET px along the interior bisector when the radius is 0
// and slides inward with the radius; the hit ring is oversized like the
// anchor/handle rings. Rendered ABOVE the anchor hit rings so it wins the
// overlap zone between anchor and widget.
export const CORNER_WIDGET_OFFSET = 16;
export const CORNER_WIDGET_R = 4;
export const CORNER_WIDGET_HIT_R = 10;
export const COL_CORNER_WIDGET = "#f0abfc"; // fuchsia-300 — distinct from anchors/handles

// The tool dock's sizing constants (TOOL_BTN / TOOL_INSET) moved to the
// shared ../tool-dock.tsx chrome module (071926_paint-toolkit.md).
