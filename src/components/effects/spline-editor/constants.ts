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
export const COL_STROKE = "var(--tb-a-blue-500)"; // anchor outline (blue)
export const COL_FILL = "color-mix(in srgb, var(--tb-a-blue-500) 18%, transparent)"; // low-opacity anchor fill
export const COL_SEL_STROKE = "var(--tb-a-amber-500)"; // selected anchor outline (amber)
export const COL_SEL_FILL = "color-mix(in srgb, var(--tb-a-amber-500) 25%, transparent)";
export const COL_PATH = "var(--tb-a-cyan-400)"; // authored-curve preview
export const COL_HANDLE_LINE = "var(--tb-a-blue-400)"; // anchor → handle connector
export const COL_HANDLE_FILL = "var(--tb-a-blue-500)";
export const COL_HANDLE_STROKE = "var(--tb-a-blue-100)";
export const COL_SEG_HOVER = "var(--tb-a-cyan-400)"; // highlighted segment under cursor
export const COL_RUBBER = "var(--tb-a-cyan-400)"; // dotted next-segment preview
// Muted color for the non-active subpath outlines.
export const COL_INACTIVE = "rgba(148, 163, 184, 0.55)"; // slate-400 @ 55%

// Snapping (snapping.ts, spec 071926 M2): px radius within which a dragged /
// placed point locks onto an anchor or canvas guide. Cmd/Ctrl suppresses.
export const SNAP_R = 8;
export const COL_GUIDE = "var(--tb-a-green-400)"; // smart-guide green — distinct from all editor chrome
// Hovered (not selected) anchor/handle outline — one step lighter than the
// resting blue so hover reads without competing with amber selection.
export const COL_HOVER = "var(--tb-a-blue-300)";

// Onion-skin ghost outlines (spec 072726 M1) — the classic animator
// convention: previous keyframe red, next keyframe green.
export const COL_ONION_PREV = "var(--tb-a-red-400)";
export const COL_ONION_NEXT = "var(--tb-a-green-400)";

// Multi-node ghosts (spec 072726 M5): other Spline Draw nodes' outlines —
// dimmer than the active node's inactive-subpath slate so ownership reads.
export const COL_GHOST = "rgba(148, 163, 184, 0.32)";

// User guidelines (spec 080226 M5).
export const COL_USER_GUIDE = "#818cf8"; // indigo-400 — distinct from snap-guide green
export const GUIDE_DOT_R = 3.5;
export const GUIDE_DOT_HIT_R = 8;

// Measurement tool (spec 080226 M4).
export const COL_MEASURE = "#f4f4f5"; // zinc-100 — reads as neutral "ruler"
export const MEASURE_TICK = 5; // half-length of a crossing tick, px

// Tunni tension widget (spec 080226 M3): shown for segments whose two
// adjacent anchors are BOTH selected (click a segment — the pair-select
// grammar — and it appears at the handle-ray intersection).
export const TUNNI_R = 3.5;
export const TUNNI_HIT_R = 9;
export const COL_TUNNI = "#fb923c"; // orange-400 — distinct from all editor chrome

// Width tool (spec 072726 M3). Widget pairs sit WIDTH_BASE_PX × the
// anchor's multiplier from the path, perpendicular to travel — a SYMBOLIC
// scale (×1 = 16px regardless of actual stroke thickness), so the widgets
// stay predictable at any zoom/resolution; the node raster shows the true
// result live. Dragging maps distance back through the same scale.
export const WIDTH_BASE_PX = 16;
export const WIDTH_MAX = 8; // multiplier ceiling
export const WIDTH_WIDGET_R = 3.5;
export const WIDTH_WIDGET_HIT_R = 9;
export const COL_WIDTH_WIDGET = "var(--tb-a-violet-400)"; // violet-400 — distinct from all editor chrome

// Live Corners widget (tools/corner.ts). The widget dot sits
// CORNER_WIDGET_OFFSET px along the interior bisector when the radius is 0
// and slides inward with the radius; the hit ring is oversized like the
// anchor/handle rings. Rendered ABOVE the anchor hit rings so it wins the
// overlap zone between anchor and widget.
export const CORNER_WIDGET_OFFSET = 16;
export const CORNER_WIDGET_R = 4;
export const CORNER_WIDGET_HIT_R = 10;
export const COL_CORNER_WIDGET = "var(--tb-t-magenta-l-0)"; // fuchsia-300 — distinct from anchors/handles

// The tool dock's sizing constants (TOOL_BTN / TOOL_INSET) moved to the
// shared ../tool-dock.tsx chrome module (071926_paint-toolkit.md).
