# SVG → editable spline + multi-subpath Spline Draw — spec (2026-06-15)

Two coupled features:

1. **Convert Editable** — a button on the SVG Source node that spawns a new
   **Spline Draw** node holding the SVG's paths as editable bezier curves.
2. **Multi-subpath Spline Draw** — extend the pen/edit overlay so one Spline
   Draw node can hold and edit *multiple independent subpaths* (so a
   multi-path SVG converts into a single editable node).

Read [061226_devguide.md](../061226_devguide.md) first. Coordinate (normalized
[0,1]² **Y-DOWN** for CPU spline geometry) and back-compat invariants apply.

## Decisions (2026-06-15)

- **One node, many subpaths.** A multi-path SVG converts into a single Spline
  Draw node with multiple subpaths. Rationale: SVG import already flattens
  per-path styling — `SvgFileParamValue` is just `{ subpaths, filename,
  aspect }` and the SVG Source applies *one* stroke/fill — so splitting into
  multiple nodes preserves nothing. Compound-path holes already render
  correctly because the rasterizer fills `evenodd` across subpaths.
- **Two selection tools** (Illustrator-style): **Path Select** (filled
  pointer icon) moves the whole path; **Sub-path Select** (stroked pointer
  icon) direct-selects/edits one subpath. Pen stays the third tool.

## Current state

- `SplineParamValue = { subpaths: SplineSubpath[] }` — already an array, but
  [SplineEditorOverlay.tsx](../../src/components/effects/SplineEditorOverlay.tsx)
  authors only `EDIT_SUBPATH = 0`. Tools today: `ToolMode = "add" | "select"`
  (pen P / edit V), a `ModeSlider` toolbar, and all geometry ops read/write
  `subpathsOf(value)[EDIT_SUBPATH]`.
- The node's rasterizer (`spline-raster-aux` / spline-draw) already draws ALL
  subpaths — only the *overlay* is single-subpath.
- SVG subpaths are cubic beziers in the same normalized [0,1]² Y-DOWN space
  Spline Draw uses, so conversion is a data copy (+ optional transform bake).
- Panel action-button precedent: `BgRemovePanel`, `SegmentPanel`,
  `AutoLayoutPanel` are `defType`-dispatched custom panels in ParamPanel,
  receiving `node` + `onParamChange`. Node creation flows through
  `spawnNode(type, pos)` in EffectsApp (→ `makeInstanceNode`, graph-ops).

---

## Part A — Multi-subpath Spline Draw editor

### A.0 State model

- Replace the `EDIT_SUBPATH = 0` constant with an **`activeSubpath`** state
  (index into `subpaths`). Default 0; clamped when subpaths are
  added/removed. The pen extends `activeSubpath`; the edit handles render on
  `activeSubpath`; sub-path select changes it.
- All existing `subpathsOf(value)[EDIT_SUBPATH]` reads and `withSubpathPatch`
  writes retarget `activeSubpath`. `withSubpathPatch` already maps over
  subpaths by index, so this is mostly swapping the constant for state.

### A.1 Render all subpaths

Today only the active subpath is drawn. Render **every** subpath:
- **Active** subpath: full treatment (anchors, handles, segment hit-strips,
  close affordance) — unchanged from today.
- **Inactive** subpaths: their curve outline only, muted (no anchor handles),
  but hit-testable for Sub-path / Path select.

### A.2 Tool split (the headline UX)

`ToolMode = "pen" | "path" | "subpath"` (rename `"add"`→`"pen"`,
`"select"`→`"subpath"`, add `"path"`). Update the `ModeSlider` to three
entries and the keymap:

- **Pen** (`PenIcon`, **P**) — as today, but anchors append to
  `activeSubpath`; a background click when the active subpath is *closed* (or
  none exists) **starts a new subpath**, appended and made active. This is
  how new disjoint subpaths get authored from scratch.
- **Path Select** (`FilledArrowIcon`, **V**) — click anywhere on any subpath
  selects the **whole path**; drag translates **all** anchors of all subpaths
  by the pointer delta (Spline Draw has no transform params, so "move path" =
  translate geometry). Clicking a subpath also makes it active. When a path is
  selected, show the **bounding-box transform handle** (A6).
- **Sub-path Select** (`OutlineArrowIcon`, **A**) — direct selection: click a
  subpath's curve → make it active; click+drag an anchor/handle → edit it
  (today's "select" behavior, now scoped to the clicked subpath). Marquee /
  multi-anchor select stays within the active subpath.

Icons: a solid arrow (path) and an outline arrow (sub-path), beside the
existing pen. Reuse `CursorIcon` as the base silhouette for both variants.

### A.3 Hit-testing

- Sub-path/Path select need "which subpath did I click?" — sample each
  subpath's flattened segments (the overlay already builds segment lists for
  the active subpath via the `segments` memo; generalize to all subpaths) and
  pick the nearest within a px threshold. Anchor hit-tests take priority over
  segment hits (so dragging a point wins over selecting the path).

### A.4 Subpath lifecycle

- **New**: pen-on-empty (A.2) appends `{ anchors: [], closed: false }` and
  sets it active.
- **Close/open**: the existing close toggle acts on `activeSubpath`.
- **Delete subpath**: a toolbar/keyboard action (e.g. ⌫ when a subpath is
  selected but no anchor is) removes `activeSubpath`; active clamps to a
  neighbor. Deleting the last subpath leaves one empty subpath (never an
  empty `subpaths` array — matches `EMPTY_SPLINE`).
- Deleting the last anchor of a subpath leaves the subpath (empty) rather
  than dropping it, so the index model stays stable mid-edit.

### A.6 Bounding-box transform handle (Path Select)

When a whole path is selected (Path Select tool), draw a **bounding box**
around the entire spline's flattened extent with corner + edge handles —
**GUI-only, no node params surfaced**. The handle bakes its transform
directly into the spline geometry:

- **Move**: drag the box body → translate all anchors (== A.2 path drag).
- **Scale**: drag a corner/edge → scale all anchors + their in/out handle
  offsets about the opposite corner/edge (anchored resize).
- **Rotate** (optional, low-cost): a rotate affordance comes nearly free.

Implementation reuses two existing pieces:
- `transformSpline(subpaths, { translateX, translateY, scaleX, scaleY,
  rotateDeg, pivotX, pivotY })` (engine/spline-transform) applies the delta in
  normalized space and returns new subpaths — we write the result back to the
  `spline` param. So a drag computes a transform relative to the box's
  start-of-drag bbox and bakes it.
- The bbox itself comes from the spline's flattened extent (same approach as
  `splineBbox` in spline-raster-aux). The interaction/handle rendering can
  follow `PrimitiveGizmo`'s box model, but writes baked geometry instead of
  params.

Writes go through the same `onParamChange(spline, …)` path the overlay
already uses, so Path Animation autokeys a box transform when animated, and
edits coalesce into one undo entry per drag (gizmo key).

### A.5 Keyframing (Path Animation)

`spline_anchors` keyframes interpolate per-subpath by index (`lerpSpline` in
keyframes.ts). Multi-subpath shapes interpolate fine **as long as subpath
count + per-subpath anchor counts match across keyframes** — same constraint
as today's per-anchor lerp. No change required; note the constraint in the
docs. (Out of scope: morphing between differing topologies.)

---

## Part B — "Convert Editable" button

### B.1 UI

Add a **Convert Editable** button at the end of the SVG Source params.
Implementation: extend the `svg_file` control render (ParamPanel ~line 3650)
or add a tiny `defType === "svg-source"` panel section. The button is
disabled when no SVG is loaded (`file?.subpaths?.length` is 0).

### B.2 Conversion

A new EffectsApp handler `convertSvgToEditable(svgNodeId)`:
1. Read the SVG node's `file.subpaths` and its transform params.
2. **Bake the current transform** into the subpaths with `transformSpline`
   (engine/spline-transform — the same call svg-source uses), so the editable
   spline lands exactly where the SVG renders on canvas.
3. `spawnNode("spline-draw", pos)` at an offset beside the SVG node.
4. Set the new node's params: `spline = { subpaths }`, and **copy the
   stroke/fill style** (`stroke_enabled/thickness/color`,
   `fill_enabled/color`, `fill_fit`) so it looks identical.
5. Select the new node (so its pen/edit overlay opens) and push one undo
   snapshot. The SVG Source node is **left intact** (non-destructive).

### B.3 Plumbing

ParamPanel gets a new optional callback prop `onConvertToEditable?:
(nodeId: string) => void`, wired from EffectsApp (alongside `onParamChange`
etc.). The button calls it with the selected SVG node's id.

---

## Invariants / notes

- [ ] Subpaths stay normalized [0,1]² **Y-DOWN**; the overlay's existing
      canvas↔node mapping is unchanged (it already handles subpath 0).
- [ ] Back-compat: `EDIT_SUBPATH`→`activeSubpath` is internal UI state only;
      the stored `spline` param shape is unchanged. Legacy single-subpath
      saves load + edit identically (activeSubpath defaults to 0).
- [ ] Never produce an empty `subpaths` array (keep ≥1, possibly-empty
      subpath) — matches `EMPTY_SPLINE` and the rasterizer's expectations.
- [ ] Convert is non-destructive (SVG node remains); one undo entry.
- [ ] Engine self-containment unaffected (all changes are overlay/panel/
      EffectsApp UI + reuse of existing engine helpers).

## Milestones (each independently shippable + browser-verifiable)

- **A1 — Multi-subpath state + render. ✅ (2026-06-15)** `activeSubpath` state
  + `activeSubpathRef` replace `EDIT_SUBPATH`; `subpathToPathD` helper; all
  subpaths render (active = cyan + handles, inactive = muted slate outlines).
- **A2 — Tool split. ✅** `pen | path | subpath`, three-icon ModeSlider, P/V/A
  keymap, filled/outline arrow icons. Pen appends to the active subpath; Path
  mode hides the per-anchor editing UI.
- **A3 — Selection behavior. ✅** Sub-path select clicks an inactive subpath to
  activate it (then edits its anchors); Path select grabs any subpath to move
  the whole path (`path-move` drag, `translateWholePath`); per-subpath +
  all-subpath hit paths.
- **A4 — Subpath lifecycle. ✅** Pen-on-empty (active closed / none) starts a
  new subpath (`startNewSubpath`); delete active subpath via toolbar trash +
  ⌫ (Path/Sub-path mode, >1 subpath); per-subpath close/open.
- **A6 — Bounding-box transform handle. ✅** Box + 8 scale handles + interior
  move on Path Select; `scaleWholePath`/`applyBBoxDrag` bake into geometry
  (preserving `broken`, unlike transformSpline); shift = aspect lock;
  degenerate axes suppressed. GUI-only, no params. (Rotate deferred.)
- **B1 — Convert Editable. ✅** Button at the end of the SVG Source params →
  `convertSvgToEditable` (bakes the SVG transform via `transformSpline`,
  copies stroke/fill + fill_fit, spawns a Spline Draw node beside it, selects
  it; non-destructive) + `onConvertToEditable` ParamPanel plumbing.

All milestones typecheck-clean and the production build passes. Lint shows
only the file's pre-existing react-hooks/refs + effect patterns.

## Open questions / risks

- **Resolved:** Path Select moves geometry AND gets a bounding-box transform
  handle (A6), GUI-only, baked into the spline data (no surfaced params).
- Bbox rotate: include now or defer? `transformSpline` supports it for free,
  but the handle UI for rotate is extra; spec lists it optional.
- Marquee/multi-select across subpaths — kept within the active subpath for
  now; cross-subpath multi-select is a future nicety.
- Delete-subpath keybinding collision with delete-anchor — disambiguate by
  "anchor selected ⇒ delete anchor; else delete active subpath".
