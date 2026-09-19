# Live Link pan / zoom — the editor's viewport gestures in the live link (2026-09-18)

Status: owner request 2026-09-18, implemented the same day.
Prereq reading: 081426_live-link-designer.md (the LiveDesign block, the
designer, how `/live` and the exported app share `lib/live-viewer/`),
091726_live-gizmos.md (the on-canvas handles the view must carry along),
archive/061726_mouse-input-ux.md (mouse vs trackpad wheel intent).

## What this is

The editor's preview viewport pans and zooms: trackpad scroll pans, pinch
or ⌘/Ctrl-scroll zooms about the cursor, a mouse wheel zooms (input-device
decides which device is active), middle-drag pans (⌘/Ctrl + middle-drag
zooms), one finger / pen pans and two fingers pinch. The live link had a
fixed framing. This lets the author **opt a link into** those gestures, and
lets the **visitor switch them on** from the panel.

- **Designer**: a "Pan / zoom control" checkbox in the Layout section.
  Off by default — existing links are unchanged.
- **Live panel**: when the design enables it, the title row gains a small
  magnifier button **directly left of the Editor link**. It is a toggle:
  on = the gestures are live over the canvas; off = the gestures detach
  and the view resets to the default framing. That reset doubles as the
  visitor's way back after zooming in.
- **Zoom readout + reset chip** (owner request, same day): while the view
  is off the default framing a `125% · reset` chip sits over the canvas —
  the editor's ViewportZoomChip in live-link chrome. Click = back to fit
  with the capability still on. It sits on the side opposite the panel so
  a floating card never covers it.
- **Both surfaces**: the hosted `/live/[slug]` page and the exported app,
  through `manifest.design`. The exported app passes no title, so its row
  holds the button alone.

## Data model

```ts
// lib/live-viewer/design.ts — LiveDesign.layout (additive, version stays 1)
panZoom: boolean;   // default false; fromSavedLiveDesign: `=== true`
```

## Implementation

- **`src/lib/viewport-gestures.ts`** (new) — `useViewportPanZoom` (ref +
  zoom / pan state + reset) and `useViewportGestures` (the wheel,
  middle-drag and touch bindings), **moved verbatim out of EffectsApp**,
  which now imports them for its v1 / v2 / WatchViewport viewports. The
  one addition is an `enabled` flag (default true) that detaches every
  listener when false. Lives in `lib/` because `lib/live-viewer/` is
  bundled into the exported app; its two editor-tree imports are
  React-free leaves the template aliases (`input-device`,
  `layout/panel-window-dom`; `input-device` is a new alias).
- **LiveViewer** binds the hooks to `.canvas-area` with
  `enabled = design.layout.panZoom && panZoomOn`, composes
  `translate(pan) scale(zoom)` on the canvas exactly as the editor does,
  sets `touch-action: none` on the area only while on, mounts the same
  capture-phase `feedWheel` listener the editor has (so a mouse wheel
  zooms), and fires a synthetic window `resize` on every view change so
  the gizmo overlays refresh their cached canvas rect — the editor's own
  trick. Cursor capture reads the canvas box per commit, so
  cursor-aware nodes see the zoomed canvas correctly.
- **`ZoomChip.tsx`** (new, shared by the viewer and the preview) renders
  `Math.round(zoom × 100)% · reset` when `!isDefault`; styles.css
  `.canvas-area .zoom-chip` (the area is `position: relative` for it;
  the gizmo overlays are fixed and unaffected), `z-index: 3` so it stays
  clickable over a full-bleed canvas whose transform gizmo owns the
  canvas-wide translate surface, and `[data-panel-side="left"]` flips it
  to the right.
- **ControlPanel** renders the title row for a title OR the button; the
  button is `.panel-title .panzoom` (the Editor link's ghost styling in a
  22px square, accent-lit via `aria-pressed`), inside a right-aligned
  `.actions` group with the Editor link. The host owns the state
  (`panZoomOn` / `onTogglePanZoom`).
- **DesignerPreview** binds the same hooks to the poster canvas, so the
  preview's button really pans and zooms the poster with the editor's
  gestures (the hooks resolve their window from the element, so they
  listen on the iframe's window). Ephemeral, like the slider audition;
  with the author's switch off the poster sits at its default framing.

## Gates

- `scripts/check-live-presets.mts`: `panZoom` reads false when absent or
  junk, true only for `true`.
- `npm run typecheck`, `npm run lint:ratchet` (the EffectsApp move drops
  two now-unused imports), `npm run build:export-template` (the new alias).
- The gestures themselves are a live-app question: enable the checkbox,
  press the button in the preview, scroll / pinch / middle-drag the poster;
  publish for the real canvas with handles on.

## Deferred / open

- Persisting the visitor's view, or an author-set initial framing.
- Keyboard shortcut (the editor's `0`) — the live link has no shortcut
  layer beyond Space for play / pause.
