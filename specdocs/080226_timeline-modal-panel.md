# Timeline dock → floating modal + panel kind

Date: 2026-08-02 · Status: **complete — M1–M3 shipped** (2026-08-02).

Implementation notes, where reality deviated from the plan below:

- Resize math works in **edges**, not origin+size. The origin+size
  formulation the plan implied rubber-bands at the boundaries: dragging
  the north handle up past the menu bar clamps `y` but leaves `h`
  grown, so the bottom edge slides down instead of the drag simply
  stopping. Clamping each dragged edge against both the min size and
  the window keeps the opposite edge pinned.
- `DOCK_TOP_INSET` / `DOCK_BOTTOM_INSET` are constants (32 / 44), not
  measurements — MenuBar is `BAR_HEIGHT` 22 (32 frameless) and
  PlaybackBar is a fixed 44, so there's nothing to measure.
- The modal's parked transform is `translateY(calc(100dvh - y))` rather
  than `translateY(100%)`: the resting rect is clamped to sit above the
  playback bar, so a 100% park would leave a sliver of the box visible
  on screen. Offsetting by the actual distance to the bottom edge parks
  it exactly offscreen for any rect.
- Kind-menu items now iterate `PANEL_KINDS` instead of
  `Object.keys(KIND_META)`, so menu order is the array's order rather
  than object-key order.
- No `▼`→`✕` bikeshed: the modal's close glyph became `✕` when it moved
  to the left cluster, since it no longer means "collapse downward".

Two changes to where the timeline dock (Layers / Tracks / Graph) can
live:

1. The button in the PlaybackBar stops opening a strip glued to the
   bottom of the canvas panel. It opens a **free-floating modal** that
   slides up from the bottom of the *window*, draggable by its toolbar
   and resizable from every edge and corner.
2. The tiled layout gains a **`timeline` panel kind**, so the same dock
   can be assigned to any panel via the editor-kind dropdown — and both
   hosts can be open at once.

## Where it lives today

The dock is `dockBodyJsx` ([EffectsApp.tsx:10138](../src/components/effects/EffectsApp.tsx#L10138))
— a toolbar (tab toggle, stagger control, per-tab tools, `▼` close)
over one of LayersEditor / TrackEditor / GraphEditor. It is rendered at
[EffectsApp.tsx:10797](../src/components/effects/EffectsApp.tsx#L10797)
as an absolutely-positioned child *inside the primary viewport panel*,
`zIndex: 5`, anchored to that panel's bottom edge, height in
`trackEditorHeight`, resized by a 6px strip overlaid on its top edge.
The slide-in uses the `trackDockMounted` / `trackDockShown` pair
([EffectsApp.tsx:1602](../src/components/effects/EffectsApp.tsx#L1602)).

All three editors already size themselves from a `ResizeObserver`
([TrackEditor.tsx:504](../src/components/effects/TrackEditor.tsx#L504),
[GraphEditor.tsx:375](../src/components/effects/GraphEditor.tsx#L375),
[LayersEditor.tsx:653](../src/components/effects/LayersEditor.tsx#L653)),
so dynamic resize inside a panel needs no work in the editors
themselves.

## 1. One body, two hosts

`dockBodyJsx` becomes `renderDockBody({ host, instanceId, leafId })`,
still a closure inside EffectsApp — it reads ~30 values from the
component scope (nodes, edges, timeline, every handler), and extracting
it to its own file would mean threading all of them as props for no
benefit. Same call as the window-tiling spec's decision to leave the
primary viewport's JSX inline (072726 §M1 notes).

`host` is `"modal" | "panel"` and drives only the toolbar's left
cluster:

| slot | modal | panel |
| --- | --- | --- |
| left of the tab toggle | `✕` close | panel-kind chip (`PanelKindMenu`) |
| tab toggle → | `DockTabToggle`, then `StaggerControl` | same |
| right cluster | per-tab tools (selected only / fit / normalize / ↻) | same |

The `▼` close button moves out of the right cluster into that left
slot. A panel has no close button — panels close through the tiling
join gesture — and the modal has no kind chip, since it isn't a leaf.

### Per-instance tab

`dockTab` ([EffectsApp.tsx:1614](../src/components/effects/EffectsApp.tsx#L1614))
becomes a record keyed by instance id (`"modal"` and `leaf:<leafId>`),
so a Graph panel and a Tracks modal can be open side by side without
fighting. Default stays `"layers"`.

Everything else stays global and shared between instances: they are
either preferences (`tracksSelectedOnly`, `graphNormalizeY`,
`collapsedTrackNodes`) or one-shot action counters (`trackFitVersion`,
`graphRefitVersion`). A "fit" from either host fits both — desirable,
and it keeps the state surface flat.

## 2. The modal

Rendered as a **root-level sibling** in EffectsApp's return (after
`LayoutRegion`, before the PlaybackBar wrapper), `position: fixed`. No
ancestor on that path carries a `transform`/`filter`, so `fixed`
resolves against the viewport as intended.

### Z-order

Existing stack, and where the modal slots in:

| z | what |
| --- | --- |
| 2000 | blocking dialogs — Save, Export App, Preferences, Media Relink, New Project, Public/Private, MCP pairing |
| 1000 | MenuBar; transient fixed dropdowns/popovers (`PanelKindMenu`, ParamPanel menus) |
| **950** | **PlaybackBar wrapper** (gains `position: relative; zIndex: 950`; it has none today) |
| **900** | **the timeline modal** |
| ≤ 50 | everything inside panels — gutters (10), corner hotspots (20), kind chips (30), LayersEditor overlays (50) |

So the modal covers all panel content and their overlays, and sits
behind the PlaybackBar, the MenuBar and every blocking dialog, per the
owner decision. Known consequence: a dropdown opened from a panel
*underneath* the modal (z 1000, `position: fixed`) paints over it until
dismissed. Accepted — those are transient menus.

### Geometry, drag, resize

State is one `{ x, y, w, h }` rect in CSS px, replacing
`trackEditorHeight`.

- **First open ever**: bottom-anchored, inset `PANEL_GAP` from the left
  and right window edges, `h = 280` — i.e. visually where the dock
  opens today, minus the canvas-panel inset.
- **Slide-in**: keep the `trackDockMounted` / `trackDockShown` pattern
  as-is; `shown === false` parks it at `translateY(100%)` of its own
  box, so it slides up from below the window edge to its resting rect.
- **Drag**: `mousedown` on the toolbar row where `e.target` is the
  toolbar element itself (its empty middle) — not a descendant button —
  starts a window-listener drag. Clamped so the toolbar row stays fully
  on screen: below the MenuBar, above the PlaybackBar, and at least
  ~80px of width inside each side edge.
- **Resize**: 8 handles — 4 edges (6px) + 4 corners (12px). Min
  320 × 160; max the window minus the MenuBar and PlaybackBar strips.
  Dragging a top/left handle moves the opposite anchor, as usual.
- The old top-edge resize strip at
  [EffectsApp.tsx:10823](../src/components/effects/EffectsApp.tsx#L10823)
  is deleted along with the in-canvas dock.

### Full-canvas

`fullCanvas` hides the modal, matching the PlaybackBar's rule at
[EffectsApp.tsx:10294](../src/components/effects/EffectsApp.tsx#L10294).
`trackEditorOpen` is left alone, so leaving full-canvas brings it back.
A timeline *panel* needs no special case — full-canvas solos the
primary viewport leaf and `display: none`s every other leaf already.

## 3. The `timeline` panel kind

- `PanelKind` ([model.ts:10](../src/components/effects/layout/model.ts#L10))
  gains `"timeline"`. The literal kind list is currently duplicated in
  `fromSavedLayout` ([model.ts:294](../src/components/effects/layout/model.ts#L294))
  and `validateTree` ([model.ts:340](../src/components/effects/layout/model.ts#L340));
  both switch to a single exported `PANEL_KINDS` array so a future kind
  is a one-line change.
- `KIND_META` + `KindIcon` ([PanelKindMenu.tsx:9](../src/components/effects/layout/PanelKindMenu.tsx#L9))
  gain a "Timeline" entry — icon: a ruler tick row with a keyframe
  diamond.
- `renderLayoutPanel` ([EffectsApp.tsx:9843](../src/components/effects/EffectsApp.tsx#L9843))
  gains a `timeline` branch returning `renderDockBody({ host: "panel",
  leafId })` in the standard flex-column wrapper.
- `MIN_PANEL_PX` (200) already bounds how small a timeline panel gets.
- The last-viewport guard is untouched: `timeline` is just another
  non-viewport kind the menu refuses to assign the final viewport leaf
  to.

### Back-compat

`fromSavedLayout` in an **older build** rejects any tree containing a
`timeline` leaf and falls back to the default preset — the project's
content is untouched, only its layout. Accepted per the owner decision;
no unknown-kind degradation path.

## 4. Persistence

| what | where | why |
| --- | --- | --- |
| modal rect + open state | `localStorage` — `timeline.modal.rect`, `timeline.modal.open` | per-machine window furniture, not project content. Same call as `viewport.previewScale` ([EffectsApp.tsx:766](../src/components/effects/EffectsApp.tsx#L766)) |
| timeline panels | the project layout tree (`SavedProject.layout`) | already automatic — `SavedLayout` round-trips panel kinds |
| per-instance tab | not persisted | session state, defaults to Layers |

Reads are guarded and clamped to the current window on load, so a rect
saved on a large display doesn't restore offscreen on a laptop.

## Milestones

**M1 — refactor, no visible change.** `dockBodyJsx` →
`renderDockBody({ host, instanceId, leafId })`; `dockTab` → per-instance
record; toolbar left cluster restructured (close button moves left).
Dock still renders in the canvas panel exactly as today. Verify by
using the timeline normally and seeing nothing differ but the close
button's position.

**M2 — the modal.** Root-level fixed host, z-stack (incl. the
PlaybackBar's new `zIndex: 950`), slide-up, toolbar drag, 8-way resize,
localStorage rect + open state, full-canvas hide. Delete the in-canvas
dock and `trackEditorHeight`.

**M3 — the panel kind.** `PANEL_KINDS` in model.ts, `timeline` kind +
icon in PanelKindMenu, `renderLayoutPanel` branch, panel-form chrome
(kind chip, no close). Verify: assign a panel to Timeline, resize it by
its gutters, and confirm a modal and a panel coexist with independent
tabs and survive save → reload.
