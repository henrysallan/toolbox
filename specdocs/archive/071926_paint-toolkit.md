# Paint toolkit (spec, 2026-07-19)

Upgrade the Paint node from a thin Atrament wrapper into a real painting
toolkit: a spline-draw-style tool dock (brush / eraser / blur / fill /
eyedropper), a proper brush model with a Brush Editor window, and a fix
for the cursor↔stroke mismatch under viewport zoom/pan.

## Current state

- **Node** ([paint.ts](../../src/nodes/source/paint.ts)): hidden `paint`
  param `{canvas, snapshot}`; params `color` / `size` / `softness` /
  `erase` / `background`. Compute uploads the snapshot bitmap and
  composites strokes over the background color — output is always
  **opaque** (`alpha = 1`).
- **Overlay** ([PaintOverlay.tsx](../../src/components/effects/PaintOverlay.tsx)):
  mounts the persistent paint canvas into a centered flex container
  (`padding: 12`, `maxWidth/maxHeight: 100%`), invisible (`opacity: 0`) —
  strokes are seen only through the pipeline via the active node. Atrament
  handles pointer→stroke; a rAF loop snapshots mid-stroke so the pipeline
  re-evaluates live. Undo is the dedicated paint lane in
  [history.ts](../../src/state/history.ts) (`pushPaint` with the pre-stroke
  `ImageData`; restore refreshes the snapshot bitmap).
- Gating: painting only while the paint node is **selected**
  (`activePaintNode` in EffectsApp).
- Serialization: the committed **snapshot** bitmap inlines as a data-URL
  (see devguide § Persistence — replace-only media invariant).

### What Atrament can't do

No blur/smudge (only draw/erase/fill/disabled), no brush stamps or
spacing/hardness model, opinionated `adaptiveStroke` width behavior, and
its pointer math divides `offsetX` by `canvas.offsetWidth` — correct only
when its canvas exactly overlays what the user sees. It's the wrong base
for a toolkit; replace it with a small in-house stamp engine (M1).

## Bug: cursor mapping breaks under zoom/pan (fix FIRST — M0)

The preview canvas gets `transform: translate(pan) scale(zoom)`
(EffectsApp v1 viewport). The paint overlay's canvas is a **separate,
untransformed** element centered in a `padding: 12` container — so:

1. Zoomed/panned: strokes land where the *unzoomed* canvas would be.
2. Even at 100%: the 12px padding makes the overlay canvas slightly
   smaller than the preview canvas whenever width/height is the binding
   constraint — a constant offset/scale error.

The infrastructure to do this right already exists: overlays track the
preview canvas's `getBoundingClientRect()` (which *includes* the CSS
transform) via ResizeObserver + the `rectsEqual` guard
([overlay-rect.ts](../../src/components/effects/overlay-rect.ts)), and
EffectsApp dispatches a synthetic `resize` on every v1 zoom/pan change
precisely so overlays refresh. SplineEditorOverlay / TransformGizmo do
this; PaintOverlay never adopted it.

**M0 fix (surgical, ships alone):** PaintOverlay takes the preview
`canvas` element (like the other overlays), tracks its rect, and
positions the atrament canvas `position: fixed` at exactly
`rect.left/top/width/height` (padding removed). Atrament's
`offsetX / offsetWidth × canvas.width` mapping is then correct at any
zoom, because the overlay canvas's layout box coincides with the
transformed preview rect. Clip to the viewport panel
(`overflow: hidden` on a host-rect-sized wrapper) so a zoomed-in canvas
doesn't paint outside the panel. M1 replaces this canvas-mounting scheme
with a pointer surface + explicit client→pixel math, but the rect
tracking carries over unchanged.

## Design

### Module layout — mirror the spline editor

New directory `src/components/effects/paint-editor/` (the spline-editor
M0 decomposition is the template):

```
paint-editor/
  PaintOverlay.tsx   state, effects, rect tracking, pointer surface,
                     brush cursor, ALL rendering. Replaces the current
                     PaintOverlay.tsx.
  engine.ts          the stamp pipeline: pointer samples → spaced stamps
                     → 2D-canvas composite. Pure-ish; no React.
  tools/             per-tool pointer logic (brush.ts, eraser.ts,
                     blur.ts, fill.ts, eyedropper.ts).
  brushes.ts         BrushSettings model, built-in presets, stamp cache.
  BrushEditor.tsx    the floating Brush Editor window.
  dock.tsx           the paint tool dock (reuses shared pill/toggle).
```

The generic dock chrome (`ModeSlider`, `IconToggle`) is extracted from
`spline-editor/dock.tsx` into a shared
`src/components/effects/tool-dock.tsx` and consumed by both docks —
mechanical refactor, zero behavior change to Spline Draw.

### Pointer surface & coordinate mapping

No DOM-mounted paint canvas anymore. The overlay renders one absolutely
positioned **pointer surface** div covering the intersection of the
canvas rect and the viewport panel rect, `cursor: none`, with the brush
cursor (SVG circle, radius = `size × rect.width / canvasRes[0]` — scales
with zoom for free) following the pointer. Mapping:

```
px = (clientX - rect.left) / rect.width  * paintCanvas.width
py = (clientY - rect.top)  / rect.height * paintCanvas.height
```

`rect` is the transformed preview-canvas rect, so zoom/pan are inherently
correct. Only primary-button strokes are captured (`setPointerCapture`);
middle-click pan and wheel zoom pass through to `useViewportGestures`
untouched. `getCoalescedEvents()` feeds the engine so fast strokes don't
polygonize; `PointerEvent.pressure` rides along per sample.

The persistent paint canvas itself becomes an offscreen
`HTMLCanvasElement` (still the `paint` param's `canvas` — same
resize-preserve behavior, same snapshot/commit protocol, same undo lane).

### The stamp engine (engine.ts)

Classic stamp pipeline (Photoshop/Procreate model):

- A **stroke** is a polyline of `{x, y, pressure}` samples, smoothed by
  an exponential stabilizer (`smoothing` 0..1 — replaces today's
  Atrament `softness` param, same feel).
- Stamps are laid along the smoothed path at `spacing` (fraction of
  brush diameter, default ~0.15), interpolating position/pressure.
- One **stamp bitmap** per (diameter, hardness, color) — a radial
  gradient (hardness 1 = hard disc, 0 = full gaussian falloff), cached
  and re-rendered only when settings change; `drawImage` per stamp.
- **Opacity vs flow**: flow = per-stamp alpha; opacity = per-stroke cap,
  implemented by stamping into a stroke-local scratch canvas and
  compositing it onto the paint canvas at `opacity` once per rAF (this
  also gives correct eraser preview). The existing mid-stroke rAF
  snapshot loop stays — it's what makes the pipeline show the stroke
  live.
- Pressure toggles: `pressureSize`, `pressureOpacity`.

Per-tool composite ops on the scratch→canvas composite:
brush = `source-over`, eraser = `destination-out`.

### Tools (v1 dock, top to bottom)

| Tool | Key | Behavior |
| --- | --- | --- |
| Brush | B | stamp engine, current brush + color |
| Eraser | E | stamp engine, `destination-out`; own size, shares brush hardness |
| Blur | — | per-stamp: `ctx.filter = blur(N)` re-draw of the region under the stamp, masked by stamp alpha (soft local blur, Photoshop-blur-tool feel) |
| Fill | G | scanline flood fill w/ `tolerance` param, contiguous; replaces Atrament's fill worker (ours, sync — canvas-res fills are fast; worker later if 4K profiling says so) |
| Eyedropper | I (+ Alt-click in any tool) | samples the **composited pipeline** pixel via `readImagePixels` (not just the paint canvas) → sets `color` param |

Below the pill, standalone buttons (IconToggle-style): **Clear canvas**
(undoable — commits through the same before-`ImageData` protocol; every
tool including fill/blur commits through it, so undo covers everything).

A second dock piece, the **brush shelf**, pins to the canvas's top-right
(`DockShell` grew `row` + `right` pinning): two `DockHSlider`s — the
param panel's bar slider (`MiniBarSlider`: track + fill + leading-edge
line + dampened native range, Shift fine-tune included) with a tiny
label + readout. **Size** spans the panel ParamDef's min..softMax
(1..120, same value the `[`/`]` shortcuts step; larger values pin the
bar but keep the readout); **Hardness** (0..100 readout) patches the
brush blob. Plus an **Edit Brush** button, which toggles the floating
Brush Editor window via a `paint-brush-editor-toggle` window event,
since the window (and preset state) is owned by the ParamPanel's
PaintBrushSection.

`erase` (boolean param) is superseded by the dock; the ParamDef is
dropped (stored values in old saves are ignored harmlessly — params are
additive/defaulted, no schema bump). `softness` maps to the new
`smoothing` brush field on load (`migrateLoadedParams`).

### Brush model & Brush Editor

New hidden param on the paint node: `brush` (`type: "brush_settings"`,
plain-JSON blob — serializes for free, NOT keyframable/exposable, hidden
from the generic ParamPanel renderer like `paint` itself):

```ts
interface BrushSettings {
  size: number;        // px, 1..400 (softMax 120)
  hardness: number;    // 0..1
  opacity: number;     // 0..1 stroke cap
  flow: number;        // 0..1 per-stamp
  spacing: number;     // 0.02..1 fraction of diameter
  smoothing: number;   // 0..1 stabilizer
  pressureSize: boolean;
  pressureOpacity: boolean;
}
```

The node stores the **full settings blob** (not a preset reference) so
projects stay self-contained. `size` stays a visible top-level param too
(slider in panel, `[`/`]` shortcuts) mirrored into the blob — it's the
one brush field users touch constantly.

**Built-in presets** (brushes.ts): Hard Round, Soft Round, Airbrush
(low flow, 0 hardness), Marker (high spacing tolerance, full flow),
Pencil (small, hard, pressureSize). Picking a preset copies its values
into the node's blob. User-saved presets: localStorage v1
(name + blob); cloud sync via user prefs later.

**Brush Editor**: ParamPanel gets a bespoke block for
`defType === "paint"` (precedent: the ML nodes' custom panels, the
channel Sync button) — a preset **dropdown** (the shared param-controls
`Dropdown`; shows the matched preset, or a transient "Custom" entry
once slider edits diverge the blob) + an **"Edit Brush…"** button that
opens a floating, draggable window (portal to body; window chrome
modeled on MessageConsole's console window): sliders for every
BrushSettings field, a live stroke-preview strip (a small canvas running
the real engine over a canned wiggle path — re-renders on any change),
and Save-as-preset. One editor window at a time, bound to the selected
paint node; closes on deselect.

### Node compute changes

- **Transparent background**: new enum `bg_mode: color | transparent`
  (default `color` — old saves render byte-identical). `transparent`
  outputs straight alpha (`outColor = s`), making Paint composite over
  other layers properly and — via the existing image→mask
  luminance×alpha coercion — usable directly as a painted **mask**
  (strokes matte by silhouette). This is the single highest-leverage
  node-side change.
- Everything else (blur/fill/etc.) is CPU-side on the 2D canvas; compute
  stays a snapshot blit.

## Milestones

- **M0 — Coordinate fix. ✅ SHIPPED with this spec.** PaintOverlay now
  takes the preview canvas, rect-tracks it (ResizeObserver + the
  synthetic-resize hook + `rectsEqual`), and mounts atrament's canvas in
  a React-positioned div at exactly the transformed rect, clipped to the
  viewport panel (pointer-events pass through the wrapper, so the zoom
  chip and window-level gestures keep working). Deliberate semantics
  change riding along: brush `size` now means **canvas pixels** (weight
  is compensated by `rect.width / canvas.width`) — stroke width no
  longer varies with window size or zoom level; previously it was
  display-px and silently depended on both.
- **M1 — Stamp engine + dock.** `paint-editor/` module; brush + eraser
  tools; shared tool-dock extraction; brush cursor; pressure +
  coalesced events; keep param set (color/size/smoothing) with `erase`
  dropped and `softness` migrated. Atrament dependency removed.
- **M2 — Brush model + editor.** `brush` settings blob, presets,
  ParamPanel block, Brush Editor window, `[`/`]` size keys.
- **M3 — Full toolkit.** Blur, fill (+ `tolerance`), eyedropper
  (+ Alt-click), Clear button, `bg_mode: transparent`.
- **M4 — Stretch.** Pick from Future directions below with the owner.

## Future directions (brainstorm)

- **Frame-by-frame paint animation** — keyframe the paint state like
  `spline_anchors` keyframes the path (Keyframe.value is already
  `unknown`); onion-skin ghosting of adjacent frames. Rotoscoping and
  hand-drawn-animation energy; the single biggest unlock, deserves its
  own spec (memory cost of per-frame bitmaps, snapshot-per-key model).
- **Symmetry painting** — mirror X/Y and radial-N repeat; near-free in
  the stamp engine (emit N transformed stamps per sample).
- **Stamp-image brush tips + grain textures** — user image as tip, angle
  jitter/scatter; the engine's stamp-bitmap seam is designed for it.
- **Smudge tool** — pick up the region under the stamp and drag it;
  same sample-and-restamp scheme as blur.
- **Reference input** — optional `image` input drawn only as an overlay
  backdrop (not into the output): paint *over* video/renders while the
  node outputs strokes alone. (Today you see the pipeline result, which
  covers the common case; a true reference input covers rotoscoping.)
- **Straight-line helpers** — ✅ SHIPPED. Shift-click connects a straight
  line from the previous stroke's end (dashed preview while Shift is
  held; repeated Shift-clicks chain a polyline; works for brush / eraser
  / blur via `StrokeSession.lineTo`, which bypasses the stabilizer);
  Shift-drag locks the stroke to its dominant axis (anchor re-arms when
  Shift is released mid-stroke). The overlay is keyed per node so the
  line anchor never leaks across paint nodes.
- **Per-stroke blend modes** — multiply/screen via
  `globalCompositeOperation` on the stroke composite.
- **Supersampled paint surface** — 2× canvas-res option so zoomed-in
  strokes stay crisp (paint canvas already resizes independently).
- **Tilt support** — `tiltX/Y` → stamp angle for shaped tips.
- **Recent-colors row / palette** under the color swatch.

## Non-goals (this spec)

Layers inside the paint node (wire multiple Paint nodes into Merge —
that's the graph's job), vector/editable strokes (that's Spline Draw +
Stroke), pressure curves UI, cloud brush sync.

## Decisions (owner, 2026-07-20)

1. **Preset storage** — Supabase user prefs (new `brush_presets jsonb`
   column, migration in
   `specdocs/user-preferences-brush-presets-migration.sql`), with
   localStorage as the always-on cache/fallback (signed-out, offline, or
   migration-not-yet-applied all degrade gracefully to local). Separate
   accessors from `loadUserPreferences` so a missing column can't break
   the API-key prefs load.
2. **Transparent bg default** — YES: new Paint nodes default
   `bg_mode: "transparent"`. Old saves pin `bg_mode: "color"` in
   `migrateLoadedParams` so they render identically.
3. **Blur quality** — per-stamp `ctx.filter` blur approved.
4. **Fill scope** — contiguous flood fill with tolerance is enough.
5. **Frame-by-frame animation** — deferred (no spec yet).
