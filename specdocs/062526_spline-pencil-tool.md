# Spline Draw — Pencil (freehand) tool (spec)

Snapshot 2026-06-25. Owner-requested feature: add a **Pencil tool** to the
Spline Draw node's on-canvas editor. The user drags freehand over the preview
canvas; on release the captured stroke is approximated as a chain of cubic
béziers with **slight smoothing**, committed as a new editable subpath.

Today the editor has three tools (`SplineEditorOverlay.tsx`): **Pen** (click to
place anchors), **Path Select**, **Sub-path Select**. Pencil becomes the fourth.

## Design decisions (settled with owner)

- **Fixed slight smoothing.** One hardcoded fit tolerance (~2.5px in canvas-px
  space). No slider, no node param — the request was "slightly smoothing" taken
  literally. The fit is structured so a tolerance slider could be added later
  without reworking the math.
- **Auto-close.** If the stroke ends within ~12px of where it started, the new
  subpath is marked `closed: true` (the user can still toggle Close-loop off).
- **Each stroke = one new subpath**, made active on release (so its anchors /
  handles are immediately editable, and a second pencil stroke starts a fresh
  subpath rather than extending). Matches the existing multi-subpath model.
- **One undo entry per stroke.** The live drag draws a preview from local
  component state only; the single `onChange` fires on pointer-up, so the whole
  stroke is one history snapshot / one re-eval (same as Pen placing a point).

## Curve fitting (`src/engine/spline-math.ts`)

New pure helper — Schneider's algorithm ("An Algorithm for Automatically
Fitting Digitized Curves", *Graphics Gems* 1990): least-squares fit of a cubic
to a chord-length-parameterized point run, Newton-Raphson reparameterization
when close, recursive subdivision at the point of max error otherwise.

```ts
// Fit a chain of cubic béziers to a sampled polyline. Points and `error` are
// in one consistent metric space (callers pass canvas px so the tolerance is
// isotropic on non-square canvases); returns SplineAnchor[] in that SAME space.
// Coincident/near-duplicate points are pruned internally (chord-length
// parameterization divides by segment length, so duplicates would blow up).
export function fitSplineToPolyline(
  points: Array<[number, number]>,
  error: number
): SplineAnchor[]
```

Output anchors: interior join anchors carry mirrored in/out handles from the
two adjacent cubics' control points (`broken: false` — the fit produces G1
joins at split points). The chosen-tolerance fit naturally yields smooth
tangents, so handle dragging afterward behaves like any pen-drawn anchor.

Implemented with plain math (no `bezier-js`) — the algorithm is self-contained
and `bezier-js`'s `{x,y}` point format would just need translating.

## Overlay changes (`src/components/effects/SplineEditorOverlay.tsx`)

- `ToolMode` union gains `"pencil"`. Keyboard shortcut **N** (Illustrator's
  Pencil); added to the P/V/A keydown switch and the `ModeSlider` items array
  (a fourth segment — the sliding highlight math already generalizes). New
  `PencilIcon`.
- Background-rect cursor: `crosshair` for `pen || pencil`.
- New `DragState` kind `"pencil"`. `onBackgroundPointerDown` branches to it
  before the Pen logic; the existing window `pointermove`/`pointerup` effect
  gains a `case "pencil"`.
- **Capture:** raw client-px points accumulate in a ref (`pencilPtsRef`), only
  appending when >~2px from the last sample (jitter / duplicate filter). A
  `pencilVersion` counter bumps each move to refresh the live preview.
- **Live preview:** a cyan polyline (`COL_PATH`, dashed) through the captured
  points, drawn from the ref — no `onChange`, no graph re-eval mid-stroke.
- **Commit (pointer-up):** feed `pencilPtsRef` to `fitSplineToPolyline` in
  client-px space → anchors in client px → convert each anchor `pos` via
  `clientToNorm` and each handle offset via the per-axis linear scale
  (`dx/rect.width`, `dy/rect.height/aspect`) so a non-square canvas stays
  correct. Auto-close test in px. Append as a new subpath via the existing
  `subpaths` array path, set it active, clear capture state.
- Strokes with <2 retained samples (a tap) are discarded — no degenerate
  1-anchor subpath. Falls through to nothing (Pen already covers single clicks).

Delete semantics: pencil counts as a non-Pen drawing mode, so the existing
contextual-Delete branch (`tool !== "pen" && subpaths > 1` → delete active
subpath) removes the just-drawn stroke, which is the natural unit. No change
needed there beyond the union widening.

- **`activeSubpath` clamp (undo robustness).** `activeSubpath` is component
  state that undo/redo (and node switches) don't touch, so after drawing
  several strokes then undoing back toward empty it can point past the end of
  the shrunken `subpaths`. Every write keys on `activeSubpathRef`
  (`withSubpathPatch`, `commitPencilStroke`, `addAnchorAt`…), so a stale index
  silently no-ops *every* edit — the symptom was "draw a few strokes, undo to
  nothing, drawing stops working" (and the Pen was equally dead). Fixed with an
  effect that clamps `activeSubpath` to the last subpath whenever the count
  drops below it, plus a bounds guard in `commitPencilStroke`'s reuse-empty
  test so a stale index can't swallow a stroke even before the effect runs.

## Coordinate / invariant notes

- Fit runs in **canvas px** (isotropic, matches what the user sees), not
  normalized space — keeps the tolerance and tangents from skewing on
  non-square canvases (§ aspect-correct geometry, invariant #4).
- Handle offsets are deltas, so they convert with the *linear* part of
  `clientToNorm` only (the affine origin cancels): subtracting two
  `clientToNorm` results would also work and is equivalent.
- Engine self-containment (invariant #1) holds: the fit lives in
  `src/engine/spline-math.ts`; the overlay (UI) imports it. No engine→UI import.
- No new socket type, no schema bump, no node-def change — the Pencil only
  authors the same `spline_anchors` param the Pen already writes.

## Out of scope (for now)

- Adjustable smoothing slider / per-node tolerance param (structure left ready).
- Extending an existing open subpath by drawing from its endpoint.
- Pressure / velocity-weighted stroke thickness.
- Closed-path-aware fitting (auto-close just sets the flag; the fit stays open
  and the tiny closing segment between near-coincident endpoints is negligible).
