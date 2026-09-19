# Easing editor (2026-09-17)

A small curve editor docked in the Tracks editor that authors ONE easing
shape and writes it to every selected keyframe pair at once — the same
curve across three keys in a row, across several tracks, or onto a vec2 /
color lane that could never hold a custom bezier before. Built 2026-09-17.

## What it does

- **Open it** with the `easing` button in the timeline dock header (Tracks
  tab, beside `fit`). The overlay is a square (240px by default) pinned to
  the **upper-right corner** of the Tracks editor, under the ruler, with a
  header row (title, a status line, `⌂` fit-view, `✕` close), a numeric
  readout of the four control points underneath, and the preset tray
  below that. It stays open across selection changes until closed.
- **Resize** it from the **bottom-left corner** — an invisible 16px grip
  (the overlay is pinned top-right, so that's the free corner; the cursor
  flips to a diagonal resize over it). The square stays square, the view
  scales with it so the framing holds, and the size is remembered per
  machine (`easingEditor.size` in localStorage, 180–600px).
- **The graph** is the unit square: time 0→1 left to right, progress 0→1
  bottom to top, drawn as a boxed grid with the linear diagonal as a faint
  reference. One curve runs from the bottom-left anchor to the top-right
  anchor. **The anchors are locked** at (0,0) and (1,1) — an easing always
  starts at the first key's value and lands exactly on the second's; the
  owner considered and rejected sliding anchors (they would make the value
  jump at the keyframe).
- **Click an anchor** to reveal its bezier handle (click again to hide it,
  Shift-click to show both, click empty space to hide both). **Drag a
  handle** to shape the curve. Handle **x is clamped to 0…1** — time has to
  stay monotonic, exactly the rule `interpolate()` applies at playback —
  while **y is free**, so a handle above 1 or below 0 overshoots (an
  ease-out-back is a handle pulled above the top edge).
- **Pan and zoom** with the **node editor's gestures**, acting on whatever
  the pointer is over — inside the overlay they move the overlay's view,
  never the timeline underneath (the overlay's native wheel / middle-
  button listeners stop propagation before the Tracks editor's container
  handlers see the event). Trackpad: two-finger scroll pans, pinch or
  ⌘/Ctrl + scroll zooms about the cursor. Mouse: the wheel zooms, a
  middle-button drag pans (the shared `wheelWantsZoom` / input-device
  rule, and xyflow's `panOnDrag [1]`), and **Ctrl / ⌘ + middle-drag
  zooms** about the press point, drag up to zoom in — the chord the
  Tracks editor already uses on its time axis. Touch / pen: a single-finger drag
  on empty canvas pans. A left click on empty space only hides the
  handles — no marquee here. The unit square takes about half the canvas
  at fit, so there is room to pan around an overshooting handle, and the
  pan is **clamped** so at least 24px of the square always stays inside
  the canvas — you can't lose the curve. Double-click or `⌂` refits.
- **What it edits.** With two or more keyframes selected in the Tracks
  editor, the overlay shows the easing of the **first segment** and every
  drag writes the curve to **every selected pair**:
  - A *pair* is two keyframes that are **adjacent in their lane** (no
    unselected key between them) and **both selected**. Per lane, sort the
    selected keys by time; each adjacent pair gets the curve on the
    earlier key's `easingOut`. A skipped key breaks the chain; the last
    selected key of a lane keeps its own outgoing easing; a selection with
    no such pair (one key per lane, or a single column across lanes) shows
    an empty-state hint. Three keys in a row = two segments, same curve.
    Pairs are collected across every lane in the selection, so one drag
    eases a Transform's X, Y and Rotation tracks together.
  - Boolean / enum lanes are step-only (easing is forced to `hold`) and
    are left out of the pair set; if they are all that's selected the
    overlay says so.
  - *First* means the earliest pair in time, ties going to the topmost
    lane. Its current easing seeds the curve: a `cubicBezier` reads back
    exactly; a scalar `customBezier` normalizes its tick / value-unit
    handles into the unit square (flat segments normalize against 1 value
    unit, the Graph Editor's Save rule); `linear`, the sine / quad / cubic
    presets load their standard cubic-bezier equivalents
    (`EASING_PRESET_BEZIER` — the table the Graph Editor already drew
    ghost handles from). Expo, back, bounce, elastic and hold have no
    single-cubic equivalent: the overlay draws the real curve as a dashed
    **ghost** with the handles parked on the diagonal at thirds, and
    writes nothing until the first drag.
  - When the pairs don't all share one easing the status line says
    `mixed`; the first drag makes them uniform, replacing whatever easing
    each pair had (preset or custom).
- **Undo**: a drag is one undo entry however many lanes it touched — the
  overlay mints one gesture key per drag and every per-lane
  `onAnimationChange` shares it (the `nextGestureKey` coalescing rule the
  other multi-lane gestures use). Edits apply live while dragging.
- **Preset shelf** (bottom): two wrapping rows of the shared `EasingTile`
  thumbnails, the tiles the easing menus already use.
  - **Built-ins first** — every preset in `EASING_PRESET_ORDER` except
    `customBezier` (it needs hand-placed Graph Editor handles; nothing to
    apply from a tile). **Clicking one writes the named preset** to every
    selected pair, exactly what the right-click menu / inspector strip
    write — so expo, back, bounce, elastic and hold, which no cubic
    expresses, are reachable from the shelf too. The overlay then shows
    that preset's seed (table handles, or the dashed ghost). The current
    pair's preset tile is highlighted; a user shape that equals a
    preset's cubic highlights that preset (a ghost's parked handles do
    not light `linear`).
  - **Saved** below a divider — the project's saved easings (the same
    list the Graph Editor's dropdown offers under "Saved", persisted on
    `SavedProject.savedEasings`; a `bezier` prop on `EasingTile` draws a
    user shape through `bezierPathFor`, the same box and pad as the preset
    tiles). **Click a tile** to apply that shape to every selected pair
    (one undo entry, like a drag); the matching tile is highlighted.
  - **`+`** (the dashed empty square ending the saved row) saves the
    current curve as a new preset under the first free `Easing N` name —
    the store replaces same-name entries, so an auto name is never one
    already in use (`autoEasingName`). It dims when there is no curve or
    the curve is already a preset.
  - **Fit to height.** The shelf makes the overlay taller than the square,
    and the timeline dock can be short (280px by default). The overlay
    measures the Tracks editor's height and `fitOverlay` picks a form:
    the **wrapping grid** when it fits with a square of at least 200px
    (stepping the square down from the chosen size), otherwise the shelf
    collapses to **one horizontally scrolling row** (a fixed 42px) and
    the square takes the rest — in a 300px dock that is a 216px square
    with every tile a scroll away. Narrowing a wrapping grid makes it
    TALLER (fewer tiles per row), which is why the grid never goes below
    200px and the row exists. The square never drops under 160px; below
    that the overlay overflows. The view is stored normalized to the
    square, so any resize keeps the framing. Wheel over the shelf scrolls
    the shelf (sideways as a row), not the timeline.
  - **Right-click a saved tile** to **label** it: a small menu with the
    name field (Enter or clicking away commits; the field swallows
    keystrokes so Delete / G / S / R don't reach the timeline) and
    **Delete preset**.
    Rename keys on the preset's id, so a Graph Editor dropdown selection
    survives it. Neither is graph history (no undo), but both persist, so
    the save pill goes dirty — the same standing as saving from the Graph
    Editor.

## Data model: `cubicBezier`

A new easing kind on `Keyframe` (engine/keyframes.ts):

```ts
easingOut: "cubicBezier";
bezier: { x1, y1, x2, y2 };   // BezierEasing
```

CSS `cubic-bezier(x1, y1, x2, y2)` semantics: control points normalized to
the segment — x a fraction of its duration (kept in [0,1]), y a fraction of
its value delta (unclamped). `SavedEasing` is the same four numbers plus
`id` / `name`, so a saved easing IS a `BezierEasing`. It evaluates as a
**time remap** `t → t'` (`cubicBezierEase`: solve x(u) = t, return y(u)),
then feeds the parameter type's normal interpolation — scalar lerp, vec
lerp, OKLab / RGB color, spline-anchor morph. That is what makes it
type-agnostic: the old `customBezier` stores handles in the parameter's
value units and therefore only ever worked on scalars; `cubicBezier` works
on every interpolable type. On a scalar the two are numerically identical
for the same shape (the check script asserts it), and the shape survives a
later change of either key's value (a `customBezier` handle in value units
would not).

- A `cubicBezier` key missing its `bezier` (hand-edited file) plays as
  linear. `sanitizeBezierEasing` gates untrusted control points: finite
  numbers only, x clamped into [0,1], y kept.
- `cubicBezier` is NOT in `EASING_PRESET_ORDER` — it needs curve data, so
  it isn't a tile in the easing picker grids; it is authored only by this
  editor. It has a label (`Bezier`) so the inspector strip and the Graph
  Editor's dropdown can name it, and the dropdown gains a disabled option
  for it while a `cubicBezier` key is selected so the control shows the
  truth instead of the first preset.
- Persistence is plain JSON on the keyframe (no schema bump — additive).
  A build older than this one has no `cubicBezier` case in `easeOf` and
  would NaN the segment — the failure mode every new preset name has
  always had; this build adds a `default: linear` to `easeOf` so the NEXT
  new kind degrades gracefully here. MCP: `get_keyframes` reports `bezier:
  [x1, y1, x2, y2]` on such keys; `set_keyframes` rejects `cubicBezier`
  the way it rejects `customBezier` (authored in the editor, pick a preset)
  — remote authoring is a follow-up.

## Graph Editor

Draws a `cubicBezier` segment as the real cubic (control points
denormalized onto the segment, same mapping as the preset ghosts) and
shows its handles as **read-only ghosts** like a preset's; its `Save`
button accepts a `cubicBezier` segment (normalizedEasingFromSegment reads
the four numbers straight back). Grabbing those handles to edit in the
graph — converting the segment to `customBezier` on first drag — is the
planned follow-up; today the shape is edited in the overlay. Applying a
saved easing from the graph still writes `customBezier` handles (so the
result is immediately draggable there); unifying that on `cubicBezier`
rides the same follow-up.

## Where things live

- `engine/keyframes.ts` — `BezierEasing`, `cubicBezierEase`,
  `LINEAR_BEZIER`, `EASING_PRESET_BEZIER`, `sanitizeBezierEasing`,
  `normalizedBezierOfSegment`, `bezierHandlesFor` (denormalize), the
  `cubicBezier` branch in `interpolate()`.
- `components/effects/timeline/easing-editor.ts` — the pure half:
  `easingPairsFor` (the adjacency rule), `firstEasingPair`,
  `seedForPair` (seed / ghost), `pairsUniform`, `applyBezierToLane` /
  `applyPresetToLane`, the view math (`fitEasingView`, `zoomEasingView`,
  `panEasingView`, `clampEasingView`, unit↔px), `clampHandle`,
  `bezierPathD` / `ghostPathD`, the shelf helpers `sameBezier` /
  `autoEasingName`, and the layout / fit (`trayHeightFor`,
  `overlayHeightFor`, `fitOverlay` → grid or row).
- `components/effects/timeline/EasingEditorOverlay.tsx` — the overlay:
  gestures, resize grip, the shelf (`PresetShelf`, `PresetMenu`).
- `components/effects/timeline/EasingTile.tsx` — gained the `bezier` and
  `onContextMenu` props for the tray.
- `TrackEditor.tsx` — computes the pairs from the selection, seeds the
  shape from the first pair, fans a drag out per lane (`easingEditorOpen`
  / `onEasingEditorOpenChange` props) and passes the saved-easing list +
  save / rename / delete through; `EffectsApp.tsx` owns the toggle in the
  dock header and the list (`saveEasing`, `renameEasing`,
  `deleteEasing`; `newSavedEasingId` moved to engine/keyframes.ts so the
  Graph Editor and the tray mint ids the same way).
- Guard: `scripts/check-easing-editor.mts` (in `npm run check`).

## Follow-ups

- Graph Editor: drag a `cubicBezier` segment's handles (convert to
  `customBezier` on grab), and apply saved easings as `cubicBezier`.
- MCP `set_keyframes`: accept `bezier: [x1, y1, x2, y2]` per key.
- Layers editor: the same overlay over its keyframe selection.
