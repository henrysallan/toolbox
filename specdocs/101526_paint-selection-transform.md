# Paint: image input, selections, move & transform (spec, 2026-10-15)

Turn the Paint node from "a brush over a transparent canvas" into a
Photoshop-style pixel editor: pipe an image in, then marquee / lasso /
magic-wand select, move pixels, copy / cut / paste, and free-transform
the selection. Builds on [071926_paint-toolkit.md](archive/071926_paint-toolkit.md)
(stamp engine, tool dock, Brush Editor), which this spec does not change.

## Current state

- **Node** ([paint.ts](../src/nodes/source/paint.ts)): no inputs. Hidden
  `paint` param `{canvas, snapshot}`; compute uploads `snapshot` and blits
  it (over `background` when `bg_mode = color`). That's the whole render.
- **Editor** ([paint-editor/PaintOverlay.tsx](../src/components/effects/paint-editor/PaintOverlay.tsx)):
  mounted while the node is selected; pointer surface over the preview
  canvas's transformed rect; the paint canvas itself is never shown, so you
  see the end-of-chain result. Tools: brush / eraser / blur / fill /
  eyedropper + Clear. Every action snapshots the canvas into an
  `ImageBitmap` (straight alpha — load-bearing) and commits the
  pre-action `ImageData` to the paint undo lane.
- **Undo** ([history.ts](../src/state/history.ts)): `PaintSnapshot =
  {nodeId, canvas, imageData}` — one full-resolution canvas per entry,
  `MAX_HISTORY = 50`. At 4K that's ~64 MB per entry, so the lane can
  already reach multiple GB.
- **Readback**: nodes can pull a pipeline image to CPU in compute with
  `ctx.readImagePixels(img, w, h)` (y-down, row 0 = top — the same
  orientation as a 2D canvas).
- **Shortcuts**: Cmd+C copies nodes (EffectsApp); Cmd+V is a `paste`
  listener in NodeEditor that turns OS-clipboard files into source nodes;
  Delete/Backspace deletes nodes. The paint overlay currently only binds
  bare keys (B/E/G/I/[ ]).

What's missing for the request: the node can't take an image, there's no
selection of any kind, and every pixel operation is a stamp.

## Design

### 1. Image input: live input under an edit layer (recommended)

Add an optional input `{ name: "image", type: "image", required: false }`.
The node now owns three CPU surfaces at canvas resolution:

| Surface | What it holds | Serialized |
| --- | --- | --- |
| `edit` (today's `canvas`) | straight-alpha pixels painted / pasted / moved on top | yes (existing envelope) |
| `knockout` (new) | alpha mask; 1 = hide the input here | yes — its own hidden `paint`-typed param, so the existing envelope, cloud-asset and `.toolbox` extraction paths carry it unchanged; null = empty |
| `selection` (new, editor-side) | 8-bit selection mask | no — editor session only |

Compute: `out = over(edit, input × (1 − knockout.a))`, then the existing
`bg_mode` step. With nothing wired, `input` is transparent and the output
is byte-identical to today (parity gate, M0).

Why this model and not "copy the input into the canvas": unedited pixels
stay **live**. Change the upstream image, scrub a video, tweak an
adjustment, and everything you didn't touch updates. Only pixels you
actually picked up (moved / copied / blurred) are frozen at the moment you
picked them up, which is the one gotcha to document.

For the fully destructive Photoshop workflow, there's a **Flatten input**
action: composite input into `edit`, fill `knockout`. One model, and
"bake" is just an action on it. **Clear** doubles as reset-to-input: it
wipes `edit` and `knockout` together (no separate button).

How existing tools behave with an input:

- **Brush**: draws on `edit` (unchanged).
- **Eraser**: erases `edit` *and* paints `knockout`, so it erases what you
  see, input included.
- **Blur / Fill / Magic wand / Eyedropper**: read the *composite* (input
  + edit, "sample all layers"); blur and fill write to `edit`.
- **Clear**: clears `edit` + `knockout` (= Reset to input).

#### Getting input pixels to the editor

The overlay can't read the input from the preview (the preview shows the
end of the chain, not Paint's input), and pooled pipeline textures don't
outlive an eval. So: an engine-side **paint-input registry** (module-level
bridge, same pattern as [three-viewport-registry.ts](../src/engine/three-viewport-registry.ts)):

- Overlay calls `requestPaintInput(nodeId): Promise<ImageData>` and bumps
  an eval.
- Paint's compute sees a pending request, calls
  `ctx.readImagePixels(input)`, resolves it, and caches it until the
  input changes.
- The overlay **prefetches** as soon as a selection exists, so by the time
  you drag, the pixels are already there. A lift that beats the readback
  shows the ants moving immediately and fills the pixels in one frame
  later.

No readback ever happens unless the editor asks for one, so a Paint node
just sitting in a graph costs one extra texture sample.

### 2. Selection model

- One `selection` mask canvas (alpha = selectedness; soft edges are real
  partial selection, which is how feathering works).
- Combining selections uses 2D-canvas composite ops on the mask: **new**
  (replace), **add** (`source-over`), **subtract** (`destination-out`),
  **intersect** (`destination-in`). Modifiers follow Photoshop: Shift =
  add, Alt = subtract, Shift+Alt = intersect, and there are mode buttons
  on the selection shelf for pen users.
- **Marching ants**: while dragging a rect / ellipse / lasso, draw the
  vector shape directly. Once committed, trace the mask's 0.5 contour
  (marching squares, cached per selection change) into SVG paths in canvas
  px, mapped through the preview rect like the brush ring, with an
  animated `stroke-dashoffset`. Dual stroke (dark under light) like the
  existing ring and connect line.
- **Selection gates painting**: every pixel op clips to the mask. In
  `StrokeSession.renderLive`, apply `destination-in` with the mask to the
  scratch layer before compositing; fill / blur / delete do the same. No
  selection = everything is selected (Photoshop semantics).
- Ops: Select All (Cmd+A), Deselect (Cmd+D), Reselect (Cmd+Shift+D),
  Inverse (Cmd+Shift+I), Delete (clear pixels in selection: `edit`
  `destination-out` + `knockout` add), Fill with color (Alt+Backspace),
  **Feather** N px (blur the mask), **Expand / Contract** N px (blur +
  threshold, good enough for v1), Select alpha of `edit`
  (Cmd-click-style "select painted pixels").

### 3. Selection tools

| Tool | Key | Behavior |
| --- | --- | --- |
| Rectangular marquee | M (Shift+M cycles) | drag; Shift = square, Alt = from center, Space-drag repositions mid-drag |
| Elliptical marquee | M | same modifiers; anti-aliased edge |
| Lasso | L (Shift+L cycles) | freehand; closes on release |
| Polygonal lasso | L | click vertices; double-click / Enter / click start closes; Backspace removes last vertex; Shift snaps to 45° |
| Magic wand | W | tolerance + contiguous toggle + anti-alias, samples composite; reuses `floodFill`'s scanline, refactored into `floodRegion() → mask` that both fill and wand call |
| Move | V | see §4 |

The dock gets a second mode group above the paint tools, and the
top-right shelf becomes context-sensitive: brush tools show Size /
Hardness (as today); selection tools show mode buttons + feather (+
tolerance / contiguous for the wand); Move / Transform show the transform
readout (§5).

### 4. Move, floating selections, clipboard

A **floating selection** is editor state: `{ bitmap, mask, matrix,
origin }`, with `bitmap` being the composite pixels under the selection at
lift time (cropped to the selection bbox).

- **Move tool drag inside the selection** lifts: copies composite pixels
  into the floating bitmap, then clears them from `edit` and adds them to
  `knockout` (the hole). **Alt-drag** duplicates (no hole). Arrow keys
  nudge 1 px, Shift+arrow 10 px.
- While floating, the display path is `edit` + floating drawn with its
  matrix → snapshot → pipeline, so you see the move through the whole
  graph live.
- **Commit** (drawn into `edit` with `imageSmoothingQuality: "high"`)
  happens on Enter, on deselect, on switching to a non-selection tool, or
  on deselecting the node. **Esc** cancels (restores the hole, drops the
  float). One undo entry per committed move.
- **Copy** (Cmd+C) puts the composite pixels under the selection on an
  internal pixel clipboard **and** on the OS clipboard as PNG
  (`navigator.clipboard.write`), so you can paste into Figma / Photoshop.
  **Cut** (Cmd+X) = copy + Delete.
- **Paste** (Cmd+V): internal clipboard pastes in place; an OS-clipboard
  image pastes centered, scaled down to fit if it's bigger than the canvas.
  Either way it arrives as a floating selection with transform handles
  showing (one step fewer than Photoshop's paste → Cmd+T). Paste works
  across Paint nodes and projects in the same tab.

### 5. Free transform

Cmd+T on a selection (lifts it if it isn't floating yet), or
automatically on paste.

- Bounding box with 8 handles + center reference point. Drag a handle to
  scale, drag outside a corner to rotate, drag inside to move.
  **Shift** toggles proportional scaling (proportional by default, as in
  Photoshop 2019+), **Alt** scales from the reference point, Shift while
  rotating snaps to 15°.
- Shelf readout with editable W / H % · angle · X / Y, plus Flip H / Flip
  V buttons.
- **Non-destructive until commit**: the floating keeps its original
  bitmap and accumulates the matrix, so scaling down then back up, or
  several Cmd+T rounds before committing, never resample more than once.
- Enter commits, Esc reverts to pre-transform.
- Handles are drawn in screen space (fixed size at any zoom), mapped
  through the preview rect like the other overlays.
- Affine only in v1. Skew (Cmd-drag a side handle) is still affine, so
  it's cheap to include. Distort / perspective / warp aren't possible in
  canvas 2D and need a WebGL warp, so they're M5.

### 6. Undo

Generalize the paint lane from "one canvas" to a list of surfaces:

```ts
type PaintSnapshot = {
  nodeId: string;
  surfaces: { canvas: HTMLCanvasElement; rect: [x, y, w, h]; imageData: ImageData }[];
};
```

- An action records only the surfaces it touched (`edit`, `knockout`,
  `selection`) and only its **dirty rect**, which every operation here
  knows (stroke bbox, selection bbox, transform's before ∪ after bounds).
  That also fixes the existing full-canvas-per-entry memory blowup.
- Selection changes are undoable (an accidental Cmd+D is undo-able, as in
  Photoshop). Selection-only entries are cheap since they're one 8-bit
  mask crop.
- A floating selection is a single in-flight action. Undo while floating
  = cancel the float.

### 7. Shortcut ownership

Cmd+C / X / V, Delete, arrows, Enter and Esc already mean something to
the graph. Rule: the paint overlay claims them **only when the viewport
has focus**, meaning the last pointerdown was on the paint surface (a small
"focus zone" flag, cleared when the user clicks into the node editor or
param panel), and in addition:

- Copy / Cut / Delete / arrows: a pixel selection exists.
- Paste: always, while the viewport has focus. An OS image pasted while
  the viewport has focus goes to the canvas, not into a new source node.
- Enter / Esc: a floating selection or lasso-in-progress exists.

The overlay listens in the capture phase and calls `stopImmediatePropagation`
when it claims a key, and NodeEditor's `paste` handler checks the same
focus-zone flag. Text fields stay exempt, as now.

### 8. Node / persistence / export changes

- `paint.ts`: optional `image` input; compute samples input + knockout;
  facts block refreshed (node-facts skill): live-input semantics, frozen
  lifted pixels, eraser cutting the input.
- `knockout` is a second hidden param of type `paint` (same
  `PaintParamValue` shape), so project.ts's type-keyed serializer and the
  asset extractors handle it with no new code. It's additive: old saves
  load with `knockout: null` and no migration. `PAINT_SURFACE_PARAMS`
  (engine/types.ts) lists both surfaces for the places that special-case
  them (graph-undo exclusion, undo-restore snapshot refresh).
- `ensureCanvasRes` resizes all surfaces together.
- **Export template**: shares the node defs via Vite aliases, so it picks
  up the composite automatically; the checked-in bundle refreshes at the
  release commit (`npm run build:export-template`).
- Optional aux output **`selection`** (mask), M5: lets a marquee drive a
  downstream node (e.g. restrict an adjustment). It would require
  persisting the selection, so it's not in v1.

### Module layout

```
paint-editor/
  PaintOverlay.tsx   grows the tool router; delegates per-tool pointer logic
  selection.ts       mask ops, combine modes, feather/expand, contour trace
  floating.ts        lift / commit / cancel, matrix math, clipboard I/O
  transform-handles.tsx  handle rendering + hit-testing (screen space)
  engine.ts          + selection clip in StrokeSession, floodRegion()
src/engine/paint-input-registry.ts
```

If PaintOverlay.tsx grows past ~1k lines, split per-tool controllers out
the way spline-editor did.

## Milestones

- **M0 — Input + knockout (foundation). ✅ BUILT 2026-10-15 (uncommitted).**
  See *M0 results* below. Optional image input, knockout
  surface + persistence, compute composite, input readback registry,
  eraser cuts input, Flatten input / Reset to input, multi-surface + dirty-rect
  undo, export template. Gates: no-input parity (byte-identical render),
  `npm run check`, the save → load round trip with a knockout. Useful by
  itself: pipe an image in, paint and erase over it.
- **M1 — Selections. ✅ BUILT 2026-10-15 (uncommitted).** See *M1
  results* below. Selection mask, rect + ellipse marquee,
  add / subtract / intersect, Cmd+A / D / Shift+D / Shift+I, marching ants,
  selection clips all paint tools, Delete, Alt+Backspace fill, focus-zone
  shortcut ownership.
- **M2 — Move + clipboard. ✅ BUILT 2026-10-15 (uncommitted).** See *M2
  results* below. Move tool, lift / Alt-duplicate / nudge,
  commit / cancel, copy / cut / paste (internal + OS both ways), paste in
  place.
- **M3 — Free transform. ✅ BUILT 2026-10-15 (uncommitted).** See *M3
  results* below. Cmd+T, handles (scale / rotate / move / skew),
  modifiers, shelf readout, flips, non-destructive accumulation, paste →
  transform.
- **M4 — More selection tools. ✅ BUILT 2026-10-15 (uncommitted).** See
  *M4 results* below. Lasso, polygonal lasso, magic wand,
  feather / expand / contract / select-painted-alpha.
- **M5 — Stretch** (pick with owner): distort / perspective / warp (WebGL
  warp), `selection` aux mask output, transform the whole layer without a
  selection, GPU-side floating preview if 4K moves profile slow.

## M0 results (2026-10-15)

- **Node** ([paint.ts](../src/nodes/source/paint.ts)): optional `image`
  input; hidden `knockout` param; unwired renders through the untouched
  `paint/blit-v2` path; wired renders `paint/composite`
  (`PAINT_COMPOSITE_FS`). `fingerprintExtras` folds the input-request epoch.
- **Registry** ([paint-input-registry.ts](../src/engine/paint-input-registry.ts)):
  `requestPaintInput(nodeId, w, h)` → compute serves it with
  `readImagePixels` at the edit-canvas size; 3 s timeout → null (the node
  isn't on the rendered chain). The editor dispatches `pipeline-bump`.
  No prefetch/cache yet; M2's lift adds that.
- **Editor**: eraser mirrors into `knockout` only while an image is wired
  (`StrokeSession` `knockout` option — one scratch, two composites); Clear
  wipes both; Flatten button in the dock (only when wired, pressed while
  the readback is in flight). Snapshots no longer drop a request that lands
  while one is in flight (trailing re-snapshot) — previously an action's
  final pixels could miss the pipeline.
- **Undo**: `PaintSnapshot = {nodeId, surfaces[]}` with per-surface rects;
  strokes record only their bbox from the session's pre-stroke clone (no
  full `getImageData` per stroke any more); fill / clear / flatten stay
  full-canvas.
- **Gates**: `check-paint-input` (new, in `npm run check`): def shape,
  unwired parity, wired switch, registry semantics. `check:shaders` grew a
  paint stage: both shaders compile; no strokes + no knockout = input
  (max Δ 0.0002); full knockout → alpha 0; half knockout scales alpha by
  (1 − k); composite over a transparent input ≡ the blit in both bg modes
  (Δ 0).
- **Not verified live**: the eraser cutting the input, Flatten and undo
  across both surfaces. No editor was connected (and the dev app needs a
  Google sign-in), so those gestures still need a hands-on pass.
- **Known edge**: the overlay's `hasInput` is read from EffectsApp's
  `edges` (an `in:image` edge into the node). Not checked: whether that
  holds for a Paint inside a group fed through the group boundary. If it
  misses, the editor treats the node as unwired (eraser won't cut, no
  Flatten button) while the render still composites, which is safe.

## M1 results (2026-10-15)

- **Mask store** ([selection.ts](../src/components/effects/paint-editor/selection.ts)):
  one mask canvas per node in a module-level map (editor session, never
  saved), created on first selection (`peekSelectionMask` never allocates),
  rescaled with the canvas. An empty mask *is* "no selection", so deselect
  = clear and undo only restores mask pixels. Reselect keeps a copy taken
  at Deselect.
- **Tools**: Rectangular + Elliptical marquee at the top of the tool pill
  (M; Shift+M toggles shape). Modifiers follow Photoshop: Shift / Alt /
  Shift+Alt held at press = add / subtract / intersect; pressed after the
  press = square / from-center; Space-drag repositions; Esc cancels; a click
  without a drag in "new" mode deselects. Rects snap outward to whole
  pixels; ellipses are antialiased.
- **Shelf** (marquee tools): new / add / subtract / intersect for an
  unmodified drag, Select all, and Deselect + Inverse when a selection
  exists.
- **Ants**: pixel-edge runs of the mask at the 50% threshold (`alphaEdges`,
  merged H/V runs, no loop chaining), mapped through the preview rect, light
  solid under an animated dark dash. Recomputed once per selection change,
  from the bbox region only.
- **Clip**: brush / eraser / blur strokes go through scratch ∩ mask (the
  knockout mirror too); blur also masks each stamp; Fill runs the flood fill
  then `restoreOutsideSelection` (premultiplied `lighter` cross-fade, so soft
  edges blend).
- **Edits**: Delete / Backspace clears the edit layer inside the selection
  and, with an image wired, knocks the input out there. Alt+Backspace fills
  the selection with the color (no selection = the whole canvas).
- **Shortcuts (§7)**: canvas focus = the last pointerdown was inside an
  element marked `data-paint-overlay` (the pointer surface + both docks).
  While focused: Cmd+A / Cmd+D / Cmd+Shift+D / Cmd+Shift+I, Delete /
  Backspace (claimed even with nothing selected so a stray Delete can't
  delete the Paint node), Alt+Backspace. Capture-phase window listener +
  `stopImmediatePropagation`. Paste ownership (NodeEditor's `paste`
  handler) lands with M2.
- **Undo**: every selection change is one paint-lane entry (mask pixels in
  the old ∪ new bbox, padded 2 px for the antialiased fringe). EffectsApp's
  `onPaintRestore` now broadcasts `paint-surfaces-restored`, and the overlay
  re-derives the ants when its mask is among the restored canvases.
- **Gates**: `check-paint-selection` (pure geometry, in `npm run check`)
  and the new Electron gate `check:paint-canvas` (27 real-Canvas2D pixel
  assertions; mutation-tested: swapping the clip's `lighter` for
  `source-over` fails the soft-edge case).
- **Deferred within the plan**: Fill and the magic wand still sample the
  edit layer only, not the composite (that needs input pixels on the CPU,
  which M2's lift prefetch brings). Feather / expand / contract are M4.
- **Not verified live**: everything gesture-side (marquee drag feel, ants
  under pan/zoom, shortcut ownership against the real graph handlers,
  undo/redo of selection steps).

## M2 results (2026-10-15)

- **Float model** ([floating.ts](../src/components/effects/paint-editor/floating.ts)):
  `{source, mask, matrix, base, before, touched, edges}`. `matrix` is a
  full 2D affine (source px → canvas px) from day one. M2 only translates
  it, plus a fit-scale for big pastes, so M3's transform edits the same
  matrix and resamples once at commit. While floating, edit = `base` (the
  hole already cut) + source drawn through the matrix, re-rendered once
  per frame (rAF-coalesced) and snapshotted, so the move shows through the
  whole graph live.
- **Move tool** (V, top of the pill): a drag of ≥ 2 screen px lifts the
  selection (no selection = everything, as in Photoshop), picking up the
  composite under it ("sample all layers": edit over input minus knockout,
  × mask). It then cuts the hole: edit cleared and input knocked out.
  Alt-drag lifts without a hole, or stamps a copy when already floating.
  Arrows nudge (Shift = 10 px): the Move tool lifts first, and a marquee
  tool moves just the outline. The pointer path is tracked independently of
  the lift, so a drag that outruns the input readback still lands where the
  pointer ended.
- **Lifecycle**: Enter / the shelf ✓ / any other edit / tool switch /
  deselecting the node → commit. The selection moves with the pixels, and
  ONE undo entry covers edit + knockout + selection over everything the float
  touched (original ∪ every placement). Escape / ✕ / Cmd+Z cancel; Cmd+Z
  while floating never reaches the history lane. Delete while floating drops
  the floating pixels and keeps the hole.
- **Input readback**: the registry takes an optional rect; an input at
  canvas size is cropped on the GPU (`readImageRegion`), anything else
  resampled and cropped on the CPU. No standing prefetch/cache. Each
  lift/copy reads its bbox fresh, one eval late (so a video input is read
  at the frame you lift on).
- **Clipboard**: Cmd+C / Cmd+X (canvas focused, with a selection or float)
  capture the composite under the selection into a module-level pixel
  clip and start a PNG write to the OS clipboard inside the gesture (the
  blob is a promise). Cmd+X deletes after the capture lands. Cmd+V
  (capture-phase `paste`, canvas focused): an OS image pastes centered and
  scaled down to fit; the internal clip, or an OS image the same size as it
  (our own copy round-tripping through the OS), pastes in place at its
  exact copied matrix. Either way it arrives as a float with the Move tool
  active, and NodeEditor never sees it, so no stray source node. With
  nothing image-like and no internal clip, paste falls through to the graph.
- **Deviation**: pastes land as a plain float in M2. Transform handles
  arrive with M3, and per decision 3 pastes will open in transform mode
  then.
- **Gates**: `check-paint-input` +5 (region crop paths),
  `check-paint-selection` +8 (affine math), `check:paint-canvas` +10
  (float compositing in real Canvas2D).
- **Not verified live**: drag feel, the Move cursor, OS clipboard
  permissions in Electron vs browser, paste ownership against NodeEditor in
  practice, the input-readback latency on a lift.

## M3 results (2026-10-15)

- **Owner change (2026-10-15): no Cmd+T.** The transform handles simply
  appear around the selection (or the float) whenever the Move tool is
  active, and grabbing one lifts a plain selection first. A paste switches to
  Move, so it lands in transform mode with no extra step (decision 3).
- **Math** ([transform.ts](../src/components/effects/paint-editor/transform.ts),
  DOM-free): each drag rebuilds the float's matrix from the matrix at press.
  The float's source is never touched until commit, so a whole session
  resamples once. The handles frame the float's `content` rect (the
  selected bbox inside the padded source), so they sit on the marquee's
  real edges before and after a lift.
  - Corners scale proportionally by default; Shift frees them.
  - Edges scale one axis; dragging through the anchor flips.
  - Alt scales about the center.
  - The 26 px ring outside each corner rotates about the content center;
    Shift snaps to 15°.
  - Cmd/Ctrl on an edge handle skews, keeping the opposite edge.
  - Inside the box (or anywhere else) moves; Alt-move duplicates.
  - Shift/Alt changes mid-drag re-apply without moving the pointer.
- **Gizmo**: frame + 8 handles + center mark in screen px (fixed size at
  any zoom). Cursors follow the box's rotation (resize cursors picked from
  each handle's on-screen direction), plus a custom rotate cursor. A second
  pointer surface hugs the gizmo (+30 px) so handles hanging off the canvas
  (select-all) stay grabbable without covering the rest of the viewport.
- **Shelf** (Move tool): W % · H % (of native size; negative = flipped) ·
  angle · X / Y of the content center, all editable (Enter/blur applies,
  Escape reverts). Matrix ⇄ readout uses R(θ)·[[sx, m], [0, sy]], so typed
  values keep an existing skew. Flip H / V buttons; ✓ / ✕ while floating.
- **Gates**: `check-paint-selection` +24 (transform math, hit-testing,
  cursors, readout round trip); `check:paint-canvas` +5 (scaled / rotated /
  flipped floats land where their matrix says).
- **Deferred to M5 as planned**: distort / perspective (Cmd-drag a
  corner, currently a plain scale), a movable reference point, and a W/H
  link toggle in the shelf.
- **Not verified live**: handle feel, cursor choice on rotated boxes,
  typing into the shelf while floating, commit quality of large rotations.

## M4 results (2026-10-15)

- **Lasso** (L): a freehand drag closes on release.
- **Polygonal lasso** (L, Shift+L, or click the active slot):
  - Click to place vertices.
  - It closes when you click the first vertex (an enlarged square marks the
    snap zone), double-click, or press Enter.
  - Backspace drops the last vertex; Escape cancels.
  - Shift snaps the next segment to 45° (length = projection).
  - A tool switch cancels it.

  Both lassos take their combine mode from the modifiers at the first press,
  like the marquee. A click with no area deselects in "new" mode.
- **Magic wand** (W): settings in a shelf row (session state):
  - Tolerance 0–255, default 31 (`0.12`), on max RGBA channel distance,
    alpha included.
  - Contiguous toggle.
  - Anti-alias toggle.

  The anti-alias is a 3×3 coverage pass clamped either side of 50%, so the
  ants and bbox never move. A `blur(0.5px)` canvas filter was tried first,
  and Chromium drops blurs that small (caught by `check:paint-canvas`).
- **Composite sampling** (the M1 deferral, now done): the wand AND Fill
  match against what you see — the input (minus knockout) under the strokes
  — via a full-canvas input readback when an image is wired (one eval
  late). Fill still writes opaque color into the edit layer, clipped to the
  selection. `floodFill` now takes an optional `sample`; the scan itself
  moved to the shared, pure `floodRegion` (selection.ts).
- **Modify** (a shelf row while a selection exists):
  - The px amount field (default 4).
  - **Feather**: canvas Gaussian, σ = r/2.
  - **Expand** / **Contract**: exact Euclidean distance transform
    (Felzenszwalb), so corners round correctly, with a 1 px antialiased
    edge, computed only over bbox + r.
  - **Select painted**: a button on the first row; the mask = the edit
    layer's alpha.

  Each is one undo step.
- **Dock**: marquee and lasso families share a slot each, showing the last
  used variant; clicking the active slot (or Shift+M / Shift+L) flips it.
  The pill is Move · Marquee · Lasso · Wand · Brush · Eraser · Blur · Fill ·
  Eyedropper (9 slots).
- **Gates**: `check-paint-selection` +25 (floodRegion, EDT vs brute force,
  grow/shrink, wand AA invariants, snap45, pointsBBox);
  `check:paint-canvas` +12 (lasso combine, wand region ± AA, feather,
  expand/contract, select painted, fill-by-sample).
- **Not verified live**: lasso feel and point density, polygon close /
  double-click timing, wand speed at 4K (floodRegion + the 3×3 pass are JS
  over the full canvas), and the composite readback latency on Fill / wand
  clicks.

## Risks / things to measure

- **4K live move cost**: each frame redraws the full `edit` + floating and
  then `createImageBitmap` + upload. Measure first (see TESTING.md: keep
  the window foregrounded). The fallback is to pass the floating bitmap +
  matrix to compute as a second texture and transform it on the GPU.
- **Preview ≠ commit resampling**: if the GPU fallback above is used, the
  shader filter and the canvas's "high" smoothing differ slightly. That's
  fine during the drag, but the committed pixel is the truth.
- **Clipboard permissions**: `navigator.clipboard.read` needs a user
  gesture and permission. Use the `paste` event's `clipboardData` (no
  prompt) as the primary path.
- **Stale lifted pixels with video input** are by design, and documented as
  a gotcha.

## Non-goals

Layers inside the node (wire several Paints into Merge; the floating
selection is the only "temporary layer"), vector selections / paths (Spline
Draw), content-aware fill, crop (the canvas is pinned to canvas
resolution), adjustment layers (the graph does that).

## Decisions (owner, 2026-10-15)

1. **Input model**: live input + knockout, with a Flatten action. ✅
2. **Selection persistence**: editor-session only for v1. ✅
3. **Paste lands in transform mode**. ✅
4. **Milestone order**: M0 → M5 as listed. ✅
