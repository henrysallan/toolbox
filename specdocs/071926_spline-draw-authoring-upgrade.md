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

## M5 — Shape Builder node (procedural)

`shape-builder` (spline→spline, category spline/modifier). Param stores the
ops list keyed by signature: `{ op: "merge" | "delete", signature }[]`,
re-derived each eval via spline-planar.ts. Overlay (selected-node gated,
like Spline Draw's) provides the same click/drag/Alt gestures but writes the
ops param instead of baking. Documented limitation: signatures are stable
only while upstream subpath count/order is stable (same spirit as morph's
by-index correspondence). Deferred until the tool (M3) proves the gestures.

## Later (agreed direction, unscheduled)

Curvature tool (Catmull-Rom auto anchors + `auto` anchor flag), per-anchor
`width` profile consumed by Stroke, mirror/symmetry drawing, primitive
stamping in-overlay (backlog #55), subpath list panel, curvature comb,
stable anchor `id`s (consider before per-anchor keyframing).

## Invariants touched

- Engine self-containment: spline-planar.ts and the roundCorners variant are
  engine-side; spline-editor/ modules are components-side and never imported
  by engine/nodes.
- No schema bump: `cornerRadius` (and later `width`, `auto`, `id`) are
  optional anchor fields; JSON.stringify omits undefined; old saves load
  unchanged.
- Param writes stay on the one onChange path (undo coalescing + autokey).
- Delete stays scoped via shortcut-scope.ts.
