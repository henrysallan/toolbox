# Spline Draw — authoring upgrade (Live Corners, snapping, Shape Builder, path surgery)

Status: agreed 2026-07-19 (design Q&A done). Umbrella spec for the program of
work that turns Spline Draw into a competitive vector authoring tool. Each
milestone ships independently; M0 is a pure refactor with zero behavior change.

Decisions from the Q&A (owner-confirmed):

- **Live Corners is LIVE** — a per-anchor radius field, not a destructive bake.
- **Shape Builder ships as a tool first** (destructive, inside Spline Draw);
  the procedural node version comes later (M5).
- **The overlay refactor is its own milestone (M0)**, before any feature work.
- Polygonal-then-refit output fidelity (matching Spline Boolean today) is
  acceptable for Shape Builder v1.

## Why

SplineEditorOverlay.tsx is a strong pen/pencil/select editor, but the gap to
Illustrator/Figma-grade authoring is (a) refinement vocabulary — corner
rounding, snapping, join/cut, alignment — and (b) shape composition as a
gesture (interactive booleans) rather than a node. The engine already holds
most of the math: `roundCorners` (spline-math.ts — Illustrator-style fillet,
radius clamped to half the adjacent edge), `splineBoolean`/`splineSelfMerge`
(spline-boolean.ts, polygon-clipping), `fitSplineToPolyline` (Schneider),
`nearestTOnCubic` + de Casteljau splitting (the overlay).

## M0 — overlay decomposition (no behavior change)

SplineEditorOverlay.tsx (~2.6k lines) becomes a directory,
`src/components/effects/spline-editor/`:

```
spline-editor/
  SplineEditorOverlay.tsx  the component: state, effects, render memos, SVG.
  types.ts                 ToolMode, DragState, BBoxHandle, SplineEditorEnv.
  constants.ts             sizing, palette, pencil tuning, dock metrics.
  geometry.ts              pure helpers: bezierAt, nearestTOnCubic, vlen,
                           subpathToPathD, handleAxis, alignHandles,
                           evenHandles, autoSmoothHandles, subpathsOf.
  ops.ts                   makeSplineOps(env): every value-writing helper
                           (addAnchorAt … applyHandleOp) + query helpers
                           (findInsertOnSpline). All reads/writes go through
                           env refs, so stale closures stay safe.
  drag.ts                  dragMove()/dragUp(): the per-kind bodies of the old
                           mega drag effect, dispatched from a ~20-line
                           useEffect in the component.
  tools/pen.ts             background-click add/extend/new-subpath + the
                           click-toggle (corner↔smooth / close-loop) logic.
  tools/pencil.ts          stroke begin + commitPencilStroke.
  tools/path.ts            whole-path grab + bbox scale (applyBBoxDrag).
  tools/subpath.ts         anchor select/marquee/segment-grab logic.
  dock.tsx                 ToolDock (ModeSlider, IconToggle, icons),
                           MenuItem, the anchor context menu.
```

Contracts:

- `SplineEditorEnv` is a plain object rebuilt each render: value/onChange/
  rect/tool/activeSubpath/selected/penSealed as refs (+ the current-render
  `rect` and `tool` values), the state setters, and `clientToNorm`/`normToPx`.
  Tools and ops never touch component state directly.
- Rendering stays centralized in the component — the 4-pass SVG z-order
  (handle hits → anchor hits → anchor visuals → handle dots) is load-bearing
  and documented there; per-tool render extraction is NOT part of M0.
- The keyboard effect (bound once) calls ops through a ref
  (`opsRef.current`) so it never holds a stale `rect`.
- Import site updates: GizmoTickOverlays.tsx points at the new path. No other
  behavior, naming, or visual change. Verification: typecheck + lint ratchet +
  manual smoke of every gesture in the header comment.

Adding a future tool = a new `tools/<name>.ts`, a DragState kind, a dock
entry, and a render block — no edits to other tools.

## M1 — Live Corners

**Data model.** `SplineAnchor` gains `cornerRadius?: number` (types.ts) —
normalized units, same space as `pos` (matching the Round Corners node's
radius semantics). Optional field ⇒ plain JSON, no schema bump, old saves
untouched; rasterizers ignore unknown anchor fields (the `broken` precedent).

**Where rounding happens.** Spline Draw's `compute` applies the fillet at
emit time via a per-anchor-radius variant of `roundCorners`
(spline-math.ts) — `roundCornersPerAnchor(subpath, aspect)` reading each
anchor's own radius. Downstream nodes see ordinary cubics; nothing else in
the engine changes. The fillet math runs aspect-corrected (like the offset
machinery) so a rounded corner is circular on non-square canvases; clamp is
the existing `min(radius, |prevEdge|/2, |nextEdge|/2)` rule.

**Keyframing.** `spline_anchors` morphs anchor-by-anchor, and `cornerRadius`
lerps in spline-morph.ts — animatable rounding per corner, with topology
stable (the whole point of live-vs-bake).

**Editor.** Eligible anchors: handle-less (corner) anchors with two incident
segments (interior anchors of open subpaths; every anchor of closed ones).
On hover/selection, a small circle widget sits a fixed px offset along the
interior angle bisector. Dragging (new DragState kind `"corner-radius"`)
projects the pointer onto the bisector in px space → radius (clamped);
dragging on a multi-selection applies the radius to all selected eligible
anchors (one `patchAnchors` write per move). The overlay's cyan preview path
renders the EFFECTIVE rounded curve (same fillet helper — components may
import engine); the anchor mark stays at the logical sharp corner. Right-
click menu gains "Reset corner" (clears the field). Numeric entry deferred.

## M2 — snapping service + hover/cursor states

`spline-editor/snapping.ts`: given a candidate point in px, return the
snapped point + which guide matched. Candidates: other anchors (all
subpaths), canvas center/edges/thirds, and 45°-increment angle lock for
handle drags. Applied in anchor/new/handle drags; matched guides render as
thin lines/dots. Modifier table decided at impl time and documented in the
header comment (constraint: Shift in pen mode already means insert-on-path;
angle lock uses Shift only during handle drags, where Shift is free).
Escape hatch: hold Cmd/Ctrl to suppress snapping mid-drag.

**Alignment guides (added 2026-08-02).** Coincidence snapping alone only
fires in the 8px disc around another anchor, which is a small target and
says nothing about *lining things up*. `snapPoint` now resolves each axis
independently: a `point` guide when a target is within SNAP_R on both axes
(unchanged, still highest priority), otherwise per axis the nearer of
(a) an anchor sharing that coordinate → the axis locks and an `align` guide
renders as a dashed hairline spanning the dragged point and every
participating anchor, ticked across each one, and (b) a canvas guide line →
the existing solid hairline. Anchor alignment takes ties: lining up with the
user's own geometry is the stronger intent. Guides are built after BOTH axes
resolve so the span reaches the point's final position. Applied everywhere
a point is placed — anchor drags (single + group), pen clicks, and the M6
primitive draws.

Hover polish (backlog #150): anchor/handle hover highlight rings, cursor
variants for pen-over-anchor (toggle), pen-over-first-anchor (close), and
pen-over-segment with Shift (insert).

## M3 — Shape Builder tool (destructive, in Spline Draw)

5th ToolMode `"shape"` (key `B`). Faces of the planar arrangement are
identified by **coverage signature** — an N-bit containment vector sampled
at a point. The operands are NOT subpaths but each subpath's **simple
loops** (its flattened ring split at every self-crossing and self-touch —
rev 2, after the owner found self-overlapping paths read as one face):
a figure-eight's lobes and a loop-the-loop's wound-over region are distinct
faces. Face geometry = intersection of bit=1 loops minus bit=0 loops —
composed directly from the boolean primitives. A pick is **component-
precise** (rev 3): a signature can name several DISCONNECTED regions, so a
face is identified by `FaceRef { sig, seed }` — the seed picks the connected
component under the probe, and hover/drag dedupe by containment, not by
signature equality. Cutting still happens per SUBPATH (`owner` maps operands
back; the remainder base is the subpath's even-odd geometry, matching the
rasterizer). New pure engine helper `src/engine/spline-planar.ts`
(decomposeRing, signatureAt, facePickAt, applyShapeBuilderOp) so the node
version (M5) reuses it verbatim.

Gestures: hover → face highlight fill; click a face → extract it as its own
subpath; drag across faces → union them into one subpath; Alt-click → delete
a face (subtract from whatever covers it). The involved subpaths are
replaced by the result (destructive — this is the authoring node); untouched
subpaths pass through unchanged. Output fidelity: flattened rings re-fit
through `fitSplineToPolyline`; where a face edge is an uncut run of an
original subpath we keep the original cubics (only intersection-crossing
spans are refit) — best-effort in v1, full preservation is a fast-follow.

## M4 — path surgery + alignment

- **Scissors**: context-menu "Cut path here" on an anchor (split subpath at
  the anchor) and on a segment point (de Casteljau split, then cut). A
  closed subpath cut once becomes open; an open one becomes two subpaths.
- **Join**: with exactly two endpoint anchors selected (same or different
  subpaths), `J` / context menu joins them — same subpath ⇒ close, different
  ⇒ concatenate (reversing one side as needed). Coincident-endpoint weld.
- **Reverse direction** command + a subtle chevron on the selected subpath.
- **Alignment** (backlog #84): context menu on a multi-selection — align
  selected anchors (min/mid/max, x/y) and distribute evenly. Whole-subpath
  align-to-canvas lives in the dock.

## M5 — Shape Builder node (procedural) — DROPPED

Dropped by the owner 2026-07-27 after M3 shipped: the in-tool Shape Builder
covers the authoring need, and the procedural version's ops-by-FaceRef
param wasn't worth its stability caveats. The engine half
(spline-planar.ts, FaceRef identity) stays node-ready if this is ever
revisited.

## M6 — primitive tools (Rectangle / Ellipse) — shipped 2026-08-02

Backlog #55, promoted out of "Later". Two ToolModes, `"rect"` and
`"ellipse"`, on Illustrator's `M` / `L` (M7's modal transforms took `R` and
`E`), sitting after Pencil in the dock's mode pill — the drawing tools group
together.

- **Gesture.** Press-drag-release rubber-bands a box; the release commits ONE
  closed subpath through the new `ops.appendSubpath` (which the pencil now
  shares): a rect is 4 handle-less corner anchors, an ellipse is 4 quadrant
  anchors with axis-aligned KAPPA (0.55228) handles — the standard 4-segment
  bezier circle. Ordinary editable geometry afterwards; Live Corners rounds a
  rect's corners, the pen/sub-path tools take it from there. A press with no
  drag (< 3px both axes) commits nothing.
- **Modifiers**, re-resolved every move so they can be pressed or released
  mid-drag: `Shift` = 1:1 (square / circle), sized by the dominant axis;
  `Alt/Option` = the press point is the CENTRE rather than a corner;
  `Alt+Shift` = both. `Cmd/Ctrl` suppresses snapping as everywhere else.
- **Aspect.** The constraint math runs in client px, so 1:1 means square ON
  SCREEN — correct on a non-square canvas where normalized space is
  anisotropic. px→normalized is affine and axis-aligned (aspect.ts corrects y
  about 0.5), so the two opposite corners fully determine the stored box and
  a screen-space circle stores as the right anisotropic ellipse.
- **Preview.** The RESOLVED box lives in the drag state (`DragState.box`), so
  the rubber band the user sees and the geometry the release commits cannot
  disagree. The ellipse preview also draws its faint bounding box.
- **Snapping.** The origin snaps like a pen click; the free corner snaps too,
  except while Shift is held — the 1:1 lock owns the corner, so corner
  snapping stands down rather than fighting it.
- Primitive tools hide the anchor/handle chrome (like Path Select and Shape
  Builder) so a drag can start anywhere on the canvas.

## M7 — Blender-style modal transforms (G / S / R / E) — shipped 2026-08-02

`spline-editor/tools/transform.ts`. With the cursor **over the preview
canvas**, `G` / `S` / `R` arm a move / scale / rotate that follows the
pointer with no button held; left-click or `Enter` confirms, `Escape` or
right-click reverts (one write back to the snapshot), `X` / `Y` constrain
move + scale to an axis (toggling, Blender-style), and `Shift` snaps a
rotate to 45° increments of the total angle — the same lock the handle drags
use. Rotation has no axis lock in 2D. Modifier and axis changes re-apply
from the last pointer position, so the shape answers the key immediately
rather than on the next mouse move.

**`E` extrudes** (the reason the tool stops being modal-hostile): it grows a
fresh corner anchor off the OPEN active subpath's end — the single selected
endpoint if there is one, otherwise the tail; selecting the head extrudes
backward by prepending — and hands the modal a move of just that anchor. The
new anchor stays selected, so `E` chains into a run of points without ever
leaving Sub-path Select. Its cancel is why `ModalTransform` carries
`cancelValue`/`cancelSelection` separately from `startValue`: Escape drops
the whole extrude (Blender leaves the duplicate behind; we don't) and puts
the selection back on the anchor it grew from. Since the new anchor sits at
the endpoint's position, the segment into it leaves along whatever
out-handle the endpoint already had — extruding a curved path continues its
tangent.

- **Targets**: the selected anchors; the whole active subpath when the
  selection is empty; every subpath in Path Select (that tool's unit is the
  whole path). Pivot = the targets' median, drawn as a cross while modal.
- **Not a DragState** — it starts on a keydown and ends on a click, so it
  owns capture-phase pointer/key listeners for its lifetime (the confirming
  click never reaches the overlay's own handlers, and the cancelling Escape
  never reaches the tool-letter shortcuts).
- **Normalized-space math is exact here**: the overlay's normalized space is
  aspect-corrected, so a normalized offset maps to px by a UNIFORM scale
  (`rect.width`) on both axes — verified on a 4:3 canvas, where a rotated
  square stays square in px. No px round-trip needed.
- Every move rebuilds the value from the start snapshot (never compounding)
  through the same `onChange` as pointer drags, so undo/autokey behave
  identically. Arming writes nothing (`MODAL_HUD_SEED` supplies the initial
  readout), so G-then-Escape leaves no no-op undo entry.
- **The cursor gate** is what lets these own G/S/R/E while the unconditional
  tool letters keep theirs; Rectangle and Ellipse moved off `R`/`E` onto
  `M`/`L` (Illustrator's shape keys). `Cmd+S` (save) and `Shift+S` (viewport
  split) are untouched — the overlay's key handler ignores modified keys.

## Addendum — segment gesture grammar (revised 2026-08-02)

Sub-path Select's segment gestures were one gesture doing the wrong job: a
plain drag on a segment ran the bend solve, so every attempt to grab a path
reshaped it, and there was no way to select "this bit of the path".

- **Click a segment** → selects its two adjacent anchors, and the same press
  arms the ordinary group-move drag, so a drag translates the segment
  rigidly (handles are stored as offsets, so they ride along). Shift UNIONS
  the pair into the existing selection — a pair has no sensible per-anchor
  toggle.
- **Double-click a segment** → selects every anchor of the subpath;
  double-clicking an INACTIVE subpath's outline activates it and does the
  same (`ops.selectAllAnchors(index)` takes an explicit index, since
  `activeSubpathRef` only catches up on the next render).
- **Alt+drag a segment** → the bend (minimum-norm least-squares solve on the
  two interior controls), unchanged apart from now needing the modifier.

The pair-move reuses the existing `"anchor"` DragState with a two-entry
`groupStarts`, so snapping, the HUD, autokey and undo coalescing all come
along for free; no new drag kind.

## Addendum — numeric drag HUD (shipped 2026-07-27)

The brainstorm's "Numeric HUD", slotted after M4: a small monospace chip
trailing the pointer during drags — anchor moves show position + Δ, handle
pulls (and new-anchor pulls) show screen-space angle + normalized length,
Live Corners shows the radius, bbox shows scale %, whole-path moves show Δ.
Written by drag.ts per move (`env.setHud`), cleared on pointerup. Display
only — no numeric input fields (that remains the deferred Live Corners
double-click entry).

## Later (agreed direction, unscheduled)

Curvature tool (Catmull-Rom auto anchors + `auto` anchor flag), mirror/
symmetry drawing, subpath list panel, curvature comb, more primitives
(polygon / star / rounded-rect with a live corner radius), snapping for
whole-path moves + bbox scales.

## Invariants touched

- Engine self-containment: spline-planar.ts and the roundCorners variant are
  engine-side; spline-editor/ modules are components-side and never imported
  by engine/nodes.
- No schema bump: `cornerRadius` (and later `width`, `auto`, `id`) are
  optional anchor fields; JSON.stringify omits undefined; old saves load
  unchanged.
- Param writes stay on the one onChange path (undo coalescing + autokey).
- Delete stays scoped via shortcut-scope.ts.
