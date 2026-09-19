# Viewport rulers + guides (2026-09-17)

Photoshop / After Effects-style rulers on the preview viewport, guides
dragged out of them, and guide snapping for everything that already snaps.
Built 2026-09-17.

## What it does

- **Shift+R** toggles the overlay (also Window → Show/Hide Rulers, and a
  ruler chip in the viewport bar beside gizmos / checker / snapping). The
  toggle is a per-machine view preference (`viewport.rulers` in
  localStorage), off by default like both reference apps.
- **Rulers** run along the **top** and the **right** edge of the primary
  viewport panel (the owner asked for right, not the reference apps'
  left — `VERTICAL_RULER_SIDE` in ViewportRulers.tsx flips it). They are
  graduated in **project pixels**, re-graduate on pan / zoom / panel
  resize, band the canvas's extent, and carry a marker that follows the
  pointer. The corner square reads `px`.
- **Drag out of a ruler** to drop a guide: the top ruler gives a horizontal
  guide, the side ruler a vertical one. Guides span the whole panel, land
  on the **whole-pixel grid**, and show an `X 960 px` / `Y 540 px` readout
  while dragging. A press-and-release that never leaves the ruler adds
  nothing.
- **Reach a guide** (added after the first live pass — with a Transform
  selected there was nothing to grab, see § Overlay placement). One
  capture-phase window listener intercepts a press within ~4px of a guide
  line, before the overlay underneath and before React's root handlers,
  when either:
  - what's on top owns no click of its own: the preview canvas, the
    guide's own strip, or a surface tagged **`data-guide-grab`** — the
    transform and primitive gizmos' move surfaces (Photoshop's Move-tool
    rule: on a guide line, the guide wins). Handles are never tagged, so a
    handle snapped onto a guide is still the thing you grab; the pen /
    paint / 3D surfaces are never tagged, so a pen click lands an anchor
    ON a guide instead of moving it;
  - or **⌘ / Ctrl is held** — over anything but HTML controls. Photoshop's
    "move a guide with any tool" chord.
  Plus every guide's **marker on the ruler** it crosses (a small cyan
  triangle; the bar's cursor flips to the guide's drag direction over it).
  Hovering anywhere a press would grab highlights the guide.
- **Move**: left-drag by any of the above. Drop a guide back on the ruler
  it came out of — the one PARALLEL to it — or off the panel to delete it;
  **Esc** mid-drag puts it back. The perpendicular ruler carries the
  guide's marker, and sliding the marker along it is a move, so a release
  there commits (the first live pass deleted here — wrong).
- **Right-click** a guide (any of the above) → **Edit position…** (a
  pixel field; Enter / Set commits, Esc cancels, any finite value incl.
  off-canvas), **Mirror across centre** (a one-off copy at `1 − pos` on the
  same axis; nothing added for the centre line or an existing mirror),
  **Delete guide**. A bare ruler right-click offers **Clear all guides**;
  Window → **Clear Guides** does the same. The menu reuses the spline
  editor's `SplineContextMenu` and portals to `<body>` so the panel's
  clip-path can't cut it off at the side ruler.
- **Snapping.** With the rulers up, guides join the snap targets of:
  - `TransformGizmo` (Transform, SVG Source, Gizmo node): the translate
    drag's box **edges and centre** compete for the nearest guide exactly
    as they do for the canvas edges / centre, with the same red indicator.
  - `PrimitiveGizmo` (Circle, Rectangle, Polygon, Star, Text, Auto Layout,
    the SDF primitives…): a move snaps edges / centre; an edge or corner
    resize snaps the **dragged edge**. Point-handle primitives (SDF Line
    Segment, Triangle) snap the dragged **point** per axis. Primitives
    never snapped before — guides are their only snap target.
  - The spline editor's snap service (pen clicks, anchor drags, rectangle /
    ellipse draws): guides join `snapPoint`'s extra lines next to the
    node's own guidelines, so anchors both land on and align with them.
  The lock chip and Cmd/Ctrl suppress guide snapping like every other
  snap. Hidden rulers (Shift+R off) also hide the guides AND stop the
  snapping — a lock onto an invisible line reads as a stuck handle.
- **Persistence.** Guides are per-project data: `SavedProject.viewportGuides`
  (additive, opaque in project.ts, omitted when empty), attached at the
  cloud / .toolbox / autosave save sites and applied on every load path,
  cleared by File → New, carried across the docs round-trip by the editor
  session stash. Older builds ignore and drop the field.

## Model

```ts
interface ViewportGuide { axis: "x" | "y"; pos: number }
```

`axis: "x"` is a vertical line at `x = pos·W`, `axis: "y"` a horizontal one
at `y = pos·H`. **`pos` is a fraction of the canvas in screen space** —
Y-down, no aspect correction — so 0.5 is the canvas centre at any
resolution and guides ride a Project Settings resolution change the way
every normalized coordinate in the engine does (Photoshop keeps absolute
pixels instead; in a tool whose geometry is all `[0,1]²` that would
un-snap everything on a resize). The rulers *read out* in pixels; the
fraction is the truth. Off-canvas positions are legal.

Space conversions live at the consumer:

| consumer | drag space | `x` guide | `y` guide |
|---|---|---|---|
| TransformGizmo | authored `[0,1]²`, aspect-corrected Y | as is | `aspectUncorrectY(pos, W/H)` |
| PrimitiveGizmo / point handles | screen-normalized UV | as is | as is |
| spline snap service | client px | `rect.left + pos·rect.width` | `rect.top + pos·rect.height` |

Shared helpers (`src/lib/viewport-guides.ts`, pure, gated by
`scripts/check-viewport-guides.mts`):

- `fromSavedViewportGuides(unknown)` — the persistence gate.
- `snapValueToLines(v, lines, threshold)` / `snapSpanToLines(min, max, lines,
  threshold)` — nearest line within threshold; a span's min / centre / max
  compete and the smallest correction wins.
- `rulerTickPlan(pxPerUnit)` — 1 / 2 / 5 × 10ⁿ ladder, labels ≥ 64px apart,
  minors only while ≥ 6px apart.
- `guidePosFromClient` (pixel-grid rounding) and `formatGuidePx`.

## Overlay placement (why it is where it is)

`ViewportRulers` is a `position: fixed` sibling of the viewport panels inside
the clip-path container — the arrangement every other on-canvas overlay uses
— **not** a child of the viewport div. The viewport div carries the touch
pan / pinch handler, which `setPointerCapture`s any touch or pen press that
lands inside it; a ruler drag started there would turn into a pan. As a
sibling it also inherits the container's clip (no painting over neighbour
panels) and its stacking context.

Stacking inside that context: guide lines at **z 1**, editing overlays at
**z 2**, ruler bars + the in-flight guide at **z 3** (the Track Editor dock
is z 5). Guides UNDER the gizmos is deliberate: a handle that has just been
snapped onto a guide sits exactly on it, and the handle must stay the thing
you grab. A lone Transform gizmo's canvas-wide translate surface covers the
guides — which is why reaching a guide is a window-level interception with
the `data-guide-grab` allow-list rather than a z-order question (§ What it
does). The `ViewportLabel` (split mode) and the zoom chip shift clear of
the bars.

The drag runner uses window pointer listeners (like the gizmos), not
element pointer capture: the ⌘-grab starts from a window-level listener
with no element to capture on. Every gesture claims its pointer
(`claimPointerGesture`) so the Pointer node never sees a guide drag as a
canvas press.

Rulers ride viewport 1 only (overlays never ride the split's second canvas)
and are gated on `backendReady`, not on the gizmo toggle — guides are a way
of looking at the canvas, not a node's GUI.

## Shortcut collision

Plain **R** is the spline editor's rotate (it already ignores every
modifier) and the graph editor's key-rotate; the latter did not check
Shift, so Shift+R with two or more keys selected in the curve editor would
have rotated them AND toggled the rulers. GraphEditor now requires
`!e.shiftKey` for rotate.

## Not done / follow-ups

- Guide edits are not on the undo stack (same as layout and saved easings;
  the history is a graph-snapshot history).
- No guide lock, no guide colour preference, no "snap to guide only" mode.
- Gradient handles, motion-path keyframe dots, segment / keyer dots and the
  3D viewport do not snap to guides (they never snapped to anything).
- The existing Transform-gizmo canvas "top / bottom" snap targets sit at
  authored y = 0 / 1, which on a non-square canvas is not the canvas edge
  (authored Y is aspect-corrected). Pre-existing; guides are unaffected
  because they convert through the same correction.
