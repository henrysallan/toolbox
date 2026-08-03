# Spline Draw — font-precision toolkit (corner styles, Harmonize, Tunni, measure, guides)

Status: agreed 2026-08-02. Program 3 for the spline editor — five features
mined from font-authoring tools (Glyphs / FontLab / RoboFont), building on
the spline-editor/ architecture and the optional-anchor-field pattern.
Outline Stroke and shape poses were considered and deliberately parked.

## M1 — Corner styles (round / chamfer / scoop)

`SplineAnchor` gains `cornerStyle?: "chamfer" | "scoop"` (absent = round —
old saves render identically). All three share the Live Corners fillet
frame (inset points p1/p2 at distance d = min(radius, half-edges)):
round = the existing circular arc; **chamfer** = a straight edge between
the insets (no handles); **scoop** = the round arc's control tips REFLECTED
across the p1→p2 chord — the same tangent circle bulging into the corner
(concave fillet). Emitted by `roundSubpath` (spline-math.ts), so Spline
Draw's Live Corners, the Round Corners node, the overlay preview, Shape
Builder, and the rasterizers all honor it automatically. Path Animation
lerps the radius and snaps the style (a-side, like `broken`).

Editor: **Alt-click a Live Corners widget cycles** round → chamfer → scoop
(applying to the selected eligible corners, like the radius drag); the
anchor context menu lists the three styles with the current one marked.

## M2 — Harmonize (G2 curvature continuity)

Context-menu command on selected smooth anchors: move each anchor along its
handle axis to the point where the incoming and outgoing endpoint
curvatures match (the classical construction: with collinear handles, the
node sits between its two control points; curvature continuity holds when
|B−C_in| / |B−C_out| = √(d_in/d_out), d_* being the neighbor controls'
perpendicular distances to the handle line). Handles stay put; the NODE
slides — Glyphs' harmonize behavior. Pure helper in geometry.ts; applies
via one patchAnchors. Anchors that aren't smooth-with-both-handles are
skipped. A maintained `g2` anchor mode is a possible follow-up, not in
scope.

## M3 — Tunni tension widget

In Sub-path Select mode, a segment whose BOTH handles exist and whose
handle rays properly intersect shows a small widget at the intersection
(the Tunni point). Dragging it re-aims both handles at the new intersection
while preserving each handle's fractional distance along its ray (tension);
double-click balances the two fractions to their average. One DragState
kind; HUD shows the two tension percentages. Widgets hide during other
drags and for parallel/degenerate rays.

## M4 — Measurement tool

New ToolMode `"measure"` (key `M`, dock ruler icon): drag a measurement
line; everywhere it crosses the node's EFFECTIVE outlines (all subpaths,
fillets applied) a tick renders, with px distances labeled between
consecutive crossings and the total span at the end — the type-designer
stem-width workflow. Crossings computed editor-side by sampling each cubic
to a px polyline and intersecting with the drag segment. Nothing writes to
the graph; Escape/tool-switch clears.

## M5 — Guidelines

Per-node guides — SHIPPED in a hidden sibling param `spline_guides`
(`Array<{ axis: "x" | "y"; pos: number }>`, normalized anchor space), NOT
the spline envelope the spec first proposed: the envelope is the keyframed
Path Animation value, so a guide edit routed through it would write the
evaluated shape into the constant and mint a spurious keyframe under
autokey. A separate undeclared param serializes with the node, gets its own
undo-coalesced onParamChange path, and can never touch animation. Context
menu on the canvas background: "Add vertical/horizontal guide here" (+
"Clear guides"); guides render as indigo full-canvas lines with a grab dot
at the near edge — drag to move (HUD shows the position), drop outside the
canvas to delete. Their positions join the snap service as first-class
line candidates for anchor drags, pen clicks, and primitive draws (anchor
ALIGNMENT still wins ties, per the smart-guide priority).

## Invariants touched

- Optional anchor field (`cornerStyle`) + optional envelope field
  (`guides`) — plain JSON, no schema bump, old saves untouched.
- Corner styles live engine-side in the shared fillet so every consumer
  agrees; Harmonize/Tunni/measure/guides are editor-side only.
- One onChange per gesture throughout.
