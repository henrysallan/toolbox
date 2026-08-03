// Shared palette + metrics for the timeline surfaces (TrackEditor,
// LayersEditor, GraphEditor, PlaybackBar). These were previously
// redeclared per file and had drifted — e.g. the selected-keyframe fill
// was amber in Layers and blue in Tracks. One definition here so the
// dock tabs read as one surface.

export const COLOR_BG = "var(--tb-n-0)";
export const COLOR_LANE_SEP = "var(--tb-n-2)";
export const COLOR_BORDER = "var(--tb-n-7)";
export const COLOR_MUTED = "var(--tb-n-10)";
export const COLOR_TEXT = "var(--tb-n-15)";
export const COLOR_ACCENT = "var(--tb-a-blue-500)";
export const COLOR_PLAYHEAD = "var(--tb-a-green-500)";
export const COLOR_PLAYHEAD_HOVER = "var(--tb-a-green-400)";

// The label gutter — an inset rounded card the lane list scrolls inside,
// shared by Tracks and Layers so the two tabs read as one surface. It's
// deliberately quiet: the lanes and their keyframes should be the
// brightest thing in the editor, so the card's text sits back from
// COLOR_TEXT and its own diamonds are muted (see COLOR_DIAMOND_NAV).
export const COLOR_GUTTER_BG = "color-mix(in srgb, var(--tb-n-0) 94%, transparent)";
export const COLOR_GUTTER_BORDER = "var(--tb-n-8)";
export const COLOR_GUTTER_TEXT = "var(--tb-n-12)";
/** Node/layer names — a step brighter than a param row's label. */
export const COLOR_GUTTER_TEXT_STRONG = "var(--tb-n-13)";
export const COLOR_GUTTER_CHEVRON = "var(--tb-n-10)";
export const GUTTER_RADIUS = 8;

// Keyframe diamonds on the LANES. Unselected is a muted amber that
// brightens on hover, so a dense track reads as texture until you reach
// for a key. Selection is a bright yellow OUTLINE, not a colour swap:
// the fill stays amber so a selected key still reads as a keyframe
// rather than as some other kind of marker.
export const COLOR_DIAMOND = "#b4790d";
export const COLOR_DIAMOND_HOVER = "#f0a92a";
export const COLOR_DIAMOND_BORDER = "var(--tb-t-amber-d-1)";
export const COLOR_DIAMOND_HOVER_BORDER = "var(--tb-a-amber-800)";
export const COLOR_DIAMOND_SELECTED_BORDER = "var(--tb-a-yellow-400)";
/** Lane diamond edge length, px. */
export const KEY_SIZE = 7;
// The gutter's ‹◆› cluster is a CONTROL, not data — muted so it doesn't
// compete with the real keyframe diamonds out on the lanes.
export const COLOR_DIAMOND_NAV = "#8a7332";
export const COLOR_DIAMOND_NAV_EMPTY = "var(--tb-n-9)";
export const COLOR_NAV_CHEVRON = "var(--tb-n-10)";
export const COLOR_NAV_CHEVRON_OFF = "var(--tb-n-6)";

// Clip bar palette. Teal so clips read distinctly from the amber
// keyframes. Base is intentionally dim; hover and selected brighten
// progressively.
export const COLOR_CLIP_FILL = "var(--tb-t-cyan-d-0)";
export const COLOR_CLIP_FILL_HOVER = "var(--tb-t-cyan-d-1)";
export const COLOR_CLIP_FILL_SELECTED = "#0e7490";
export const COLOR_CLIP_BORDER = "#1d6373";
export const COLOR_CLIP_BORDER_SELECTED = "var(--tb-t-cyan-l-4)";
export const COLOR_CLIP_HANDLE = "#2b8093";
export const COLOR_CLIP_HANDLE_HOVER = "var(--tb-t-cyan-l-5)";
export const COLOR_CLIP_GHOST = "color-mix(in srgb, var(--tb-a-cyan-400) 7%, transparent)";
export const COLOR_CLIP_GHOST_HOVER = "color-mix(in srgb, var(--tb-a-cyan-400) 13%, transparent)";
export const COLOR_CLIP_GHOST_BORDER = "color-mix(in srgb, var(--tb-a-cyan-400) 22%, transparent)";
export const COLOR_CLIP_GHOST_BORDER_HOVER = "color-mix(in srgb, var(--tb-a-cyan-400) 40%, transparent)";

// Marquee rubber-band.
export const MARQUEE_FILL = "color-mix(in srgb, var(--tb-a-blue-500) 10%, transparent)";
export const MARQUEE_BORDER = `1px dashed ${COLOR_ACCENT}`;

// Ruler grid + the easing connectors between keyframes. All deliberately
// darker than COLOR_BORDER: this is background structure, and it should
// never compete with the keyframes sitting on top of it.
export const COLOR_RULER_TICK = "var(--tb-n-4)";
export const COLOR_RULER_TEXT = "var(--tb-n-10)";
export const COLOR_SEGMENT = "var(--tb-n-8)";
export const COLOR_SEGMENT_HOLD = "var(--tb-n-10)";
export const COLOR_SEGMENT_HOVER = "var(--tb-n-11)";

// Metrics shared by the tick-based editors.
export const RULER_HEIGHT = 24;
// Lateral slop for grabbing a keyframe diamond.
export const KEY_HIT_PX = 7;
// Vertical slop for grabbing the connector line BETWEEN two keyframes
// (clicking it selects the pair that bounds the segment).
export const SEGMENT_HIT_PX = 5;
// Lateral slop for grabbing a clip bar's in/out edge.
export const CLIP_EDGE_PX = 6;
/**
 * The wash on a lane whose node is selected. TRANSLUCENT by contract:
 * the frame grid is a fixed backdrop behind the lanes, so any opaque
 * fill on a full-width row blanks the ticks under it.
 */
export const COLOR_LANE_SELECTED_BG =
  "color-mix(in srgb, var(--tb-lift) 4%, transparent)";
/**
 * The recessed tint on a twirl-down track's lane (Layers). Translucent
 * for the same reason — it spans the full lane width.
 */
export const COLOR_LANE_RECESSED_BG = "rgba(0, 0, 0, 0.22)";

// Frame-division grid drawn BEHIND the lanes, plus its matching stubs in
// the ruler. Two weights — the numbered major divisions a step stronger
// than the minors between them. Built on --tb-lift (white in dark mode,
// black in light) so the grid stays a subtle lift over the lane in both.
export const COLOR_FRAME_TICK_MINOR =
  "color-mix(in srgb, var(--tb-lift) 4%, transparent)";
export const COLOR_FRAME_TICK_MAJOR =
  "color-mix(in srgb, var(--tb-lift) 9%, transparent)";
/** Height of the ruler's minor stubs, rising from its bottom edge. */
export const RULER_STUB_H = 5;
/**
 * Below this on-screen spacing a division stops being drawn — otherwise
 * a zoomed-out track fills with a solid wash instead of a grid.
 */
export const MIN_TICK_SPACING_PX = 4;

// A lane whose Spline Draw anchor is selected on the canvas. Distinct
// from both the row-selected wash and the keyframe accent — it answers
// "which lane is this anchor?", not "what is selected here".
export const ANCHOR_HIGHLIGHT_BG = "rgba(56, 189, 248, 0.12)";
export const ANCHOR_HIGHLIGHT_EDGE = "#38bdf8";

// Proximity snapping between the playhead and keyframes (Tracks tab):
// how close, in SCREEN px, before either snaps onto the other. Measured
// in px rather than ticks so the pull feels the same at every zoom.
// Option/Alt suppresses it.
export const SNAP_PROXIMITY_PX = 8;

// Zoom envelope for the tick→px scale, and the wheel/drag sensitivity
// used with Math.exp so zooming feels the same in every editor.
export const MIN_PIXELS_PER_TICK = 0.0002;
export const MAX_PIXELS_PER_TICK = 1.5;
export const ZOOM_SENSITIVITY = 0.0015;
// Fraction of the viewport the scene occupies after a fit.
export const FIT_PAD = 0.95;
