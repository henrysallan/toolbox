# Pie menu (Shift+Space quick-actions) — spec

Snapshot 2026-07-13. Backlog item **#170** (devlist.md): "potentially add a
pie menu to easily open projects, assets, save. We swap…".

## Goal

A radial "pie menu" that opens **around the cursor** on **Shift+Space**, giving
one-flick access to the handful of whole-app actions that today live behind the
menu bar. Reference layout = the Figma tool ring (icon chip + adjacent label
pill per item, a central hub, a faint connecting ring, the active item lit in
blue). Look & feel = **our** editor design language (inline-hex zinc/blue,
`ui-monospace`, pills at `borderRadius:999`, house easing
`cubic-bezier(0.4,0,0.2,1)` ~0.14–0.16s) — **not** Figma's light chrome.

Design decisions locked with the owner (2026-07-13):
- **Interaction = hybrid** (Blender-style): flick-and-release OR tap-and-click.
- **Items = 7**: Save · Open Projects · Assets · New Project · Full Canvas ·
  Split Viewport · Add Node.
- **Architecture = config-driven registry** (data array of items, presentational
  component) — groundwork for the "We swap…" ambition (later this could grow
  into or replace parts of the menu bar / a command system).

## Interaction model — hybrid

The pie is a transient, cursor-anchored overlay with two selection paths that
share one open. Let **O** = the cursor position captured at Shift+Space keydown
(the geometric center for all angle math), **DEAD** = a dead-zone radius
(≈ 30px). The item under the cursor is the one whose angular sector the vector
`(cursor − O)` falls into, but **only while `|cursor − O| ≥ DEAD`** — inside the
dead zone nothing is active (center = cancel).

Lifecycle:

1. **Open.** Shift+Space keydown → capture O, mount the pie centered at O
   (clamped to viewport, see Positioning). `preventDefault`. Ignore keyboard
   auto-repeat (`e.repeat`) and ignore if a pie is already open.
2. **Gesture phase** (keys still held). On each `pointermove`, recompute the
   active item from the angle; highlight its chip + label + the wedge. Track a
   `dragged` flag = "cursor left the dead zone at least once".
3. **Commit / fall-through on release.** On the first `keyup` of **Space or
   Shift**:
   - If `dragged` **and** an item is currently active → **fire it**, close.
   - Else (a tap — released inside the dead zone) → **enter persistent phase**
     (menu stays open, now mouse-driven). Do **not** close.
4. **Persistent phase** (mouse-driven). Hovering an item highlights it; a
   **left-click** on an item fires it and closes; a click on the center hub or
   anywhere outside the ring, or **Escape**, cancels. Key releases do nothing
   (already released).
5. **Always:** Escape closes; firing an item closes; disabled items are skipped
   by gesture selection and are unclickable.

This is exactly Blender's pie feel: a confident flick never needs the mouse
button; a hesitant tap gives you a normal point-and-click menu.

## Layout & geometry

- **7 items, even ring.** Item *i* angle = `-90° + i·(360/7)` (first item at
  12 o'clock, clockwise). Even distribution means every direction owns a clean
  ~51.4° sector — good for flick accuracy.
- **Ring radius** (O → chip center) ≈ 96px. **Dead-zone / hub radius** ≈ 30px.
  Total interactive footprint ≈ 250px across; labels extend it ~120px per side.
- **Per item** = an **icon chip** on the ring + a **label pill** offset further
  outward along the same radius (so labels read away from center and don't
  collide with the hub). Right-hemisphere labels sit to the chip's right,
  left-hemisphere to its left, top/bottom centered — decided by
  `sign(cos θ)` / proximity to vertical, mirroring the reference.
- **Center hub** = a circle at O (the dead zone / cancel target). Neutral; may
  carry a faint Toolbox glyph. No label readout in the hub (labels live on the
  chips, like the reference).
- **Connecting ring + active wedge** (SVG underlay): a faint full ring stroke
  through the chips, plus a low-opacity wedge from hub → active item that
  tracks the selection (the blue "pointer" flourish from the reference).

Order around the ring (12 o'clock CW), grouping related actions:
`Save → Open Projects → Assets → Add Node → Split Viewport → Full Canvas →
New Project`. (Order is data — trivially reorderable.)

## Visual design (house style — exact values)

Portal to `document.body`, `position:fixed`, `zIndex:9000` (above editor chrome
and the node-search popup's 3000; below the 10000 portaled color popovers — and
irrelevant vs node-search anyway since the pie closes *before* it spawns one).

- **Scrim**: `position:fixed; inset:0` transparent hit-catcher (click = cancel).
  No dark dim — the canvas stays visible (reference has none). Optional
  `rgba(0,0,0,0.12)` if it reads too weak in testing.
- **Icon chip** (rounded square like the reference): `40×40`,
  `borderRadius:10`, `background:#18181b`, `border:1px solid #27272a`, icon
  `20px`, `color:#a1a1aa`. **Active/hover** → `background:#1e3a8a`,
  `border-color:#3b82f6`, icon `color:#dbeafe`, plus a soft blue ring
  (`boxShadow:0 0 0 3px rgba(59,130,246,0.25)`).
- **Label pill**: `background:#0a0a0a`, `border:1px solid #27272a`,
  `borderRadius:999`, `padding:3px 9px`, `fontSize:11`, `fontFamily:ui-monospace`,
  `color:#a1a1aa`. **Active** → `background:#1e3a8a`, `border-color:#1e3a8a`,
  `color:#dbeafe`. Optional per-item **shortcut hint** as a dim
  (`#71717a`) mono glyph in a tiny inset box on the pill's trailing edge (e.g.
  Full Canvas = `F`, Split = `⇧S`, Add Node = `⇧A`, Save = `⌘S`).
- **Hub**: `56×56` circle, `border:1px solid #27272a`,
  `background:rgba(10,10,10,0.55)`.
- **Connecting ring**: SVG `<circle>` `stroke:#27272a` `stroke-width:1`
  `fill:none`. **Active wedge**: SVG `<path>` `fill:rgba(30,58,138,0.35)`.
- **Disabled item** (e.g. Save when signed out): chip/label at `opacity:0.4`,
  `color:#52525b`, no hover/active treatment.
- **Mount animation**: scale `0.92 → 1` + opacity `0 → 1` over `0.14s`
  `cubic-bezier(0.4,0,0.2,1)`; items may radiate from O with a tiny per-index
  delay (≤ 30ms) for the "bloom". CSS transitions only (the editor ships no
  Framer Motion). Unmount is instant (matches every other popover).

Icons are **hand-drawn inline `<svg>`** per house convention (`fill="none"
stroke="currentColor"` so `color` flows from chip state, `viewBox="0 0 24 24"`,
`stroke-width≈1.6`, round caps): Save = tray+down-arrow; Projects = grid/folder;
Assets = stacked images; New Project = document+plus; Full Canvas = 4 expand
arrows; Split Viewport = two panes; Add Node = plus-in-circle / node glyph.

## Item registry (config-driven)

```ts
// PieMenu.tsx — presentational, knows nothing about the app
export type PieMenuItem = {
  id: string;
  label: string;
  hint?: string;            // shortcut glyph, e.g. "⌘S"
  icon: React.ReactNode;    // inline <svg>
  disabled?: boolean;
  run: () => void;          // fired on select
};
```

EffectsApp builds the array (a `useMemo` over the real handlers), keeping the
component pure:

| id | label | run() | disabled |
|----|-------|-------|----------|
| `save` | Save | `handleSave()` | `!signedIn` |
| `projects` | Open Projects | *(onOpenLoad logic)* `suppressNextSelectionViewFlipRef.current = true; clearSelection(); setParamView("load")` | — |
| `assets` | Assets | `suppressNextSelectionViewFlipRef.current = true; setParamView("assets")` | — |
| `new` | New Project | `handleNewProject()` | — |
| `full-canvas` | Full Canvas | `setFullCanvas(v => !v)` | — |
| `split` | Split Viewport | `setViewportSplit(v => !v)` | — |
| `add-node` | Add Node | dispatch `toolbox:open-node-search` (see below) | — |

All handlers already exist in EffectsApp.tsx (Save 6826, paramView 578,
fullCanvas 598, viewportSplit, handleNewProject). The pie just calls them.

## Wiring

### Keyboard binding (EffectsApp.tsx global keydown, ~654–700)
- **Guard the existing Space branch**: change `else if (e.key === " ")` to also
  require `!e.shiftKey` so Shift+Space no longer toggles playback (it currently
  falls through to `setPlaying`).
- **Add a Shift+Space branch**:
  ```ts
  else if (e.key === " " && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.repeat || pieOpen) return;
    e.preventDefault();
    setPieMenu({ x: lastPointerRef.current.x, y: lastPointerRef.current.y });
  }
  ```
- **Cursor source**: add a window `pointermove` listener in EffectsApp that
  stashes raw `clientX/clientY` into `lastPointerRef` (the keydown event carries
  no mouse coords). EffectsApp already flips DOM→UV for `ctx.cursor`; this is a
  separate raw-screen ref for the pie origin.
- **Defensive guards on Space-pan**: GraphEditor (line ~713) and TrackEditor
  (line ~680) space-pan don't check `shiftKey`. Add `&& !e.shiftKey` to both so
  a Shift+Space over the graph can't start a pan. Low-risk, keeps the chord
  clean.

### State & mount (EffectsApp.tsx)
- `const [pieMenu, setPieMenu] = useState<{x:number;y:number}|null>(null);`
- Render `{pieMenu && <PieMenu origin={pieMenu} items={pieItems}
  onClose={() => setPieMenu(null)} />}`.
- The **gesture lifecycle lives inside PieMenu** (it owns its own window
  `pointermove` / `keyup` / `pointerdown` / `keydown(Esc)` listeners while
  mounted). EffectsApp only opens/closes it.

### Add Node cross-component channel
The node-search picker is **NodeEditor-owned** state (`nodePopup`, opened by the
Shift+A handler at NodeEditor.tsx ~1317). The pie lives at the app shell, so:
- Pie's `add-node` `run()` dispatches
  `window.dispatchEvent(new CustomEvent("toolbox:open-node-search", { detail: { x, y } }))`
  with the pie origin (this fits the app's existing window-event idiom —
  `pipeline-bump`, `effect-node-param`, `effect-node-toggle`).
- **NodeEditor** adds a listener for it that runs the same body as the Shift+A
  handler: seed `onPanePointer(screenToFlowPosition({x,y}))` and
  `setNodePopup({ x:x+4, y:y+4 })`, clamping the point into the flow wrapper's
  bounds if the pie origin was outside the editor (so it always lands somewhere
  sensible). Reuses the existing picker verbatim — no new picker code.

## Positioning & viewport clamping

Center at O, but clamp the **rendered** center so the full footprint (ring
radius + label reach, ≈ 150px each side) stays on-screen — same technique as
`ColorSwatchPicker` (color-picker-popover.tsx ~395–409: measure, clamp, flip).
Angle math and the cursor-delta for gesture selection both use the **rendered**
center (not the raw cursor), so a clamped-away-from-edge open still tracks
correctly. Near a corner the ring shifts inward; the cursor still sits at O
inside the dead zone at open, so no item is pre-selected. 

## Edge cases

- **Auto-repeat**: keydown repeats while held → guard with `e.repeat` + the
  `pieOpen` check so we open exactly once.
- **Release order**: commit on the first `keyup` of Space *or* Shift (both are
  required to hold; whichever lifts first ends the gesture).
- **Tap with no move** → persistent phase, not a cancel (that's the whole point
  of hybrid). A tap that *did* cross the dead zone and returned → still commits
  the active item if one is active at release, else persistent.
- **Signed out**: Save renders disabled (mirrors MenuBar's `disabled:!signedIn`).
- **Focus in an input/textarea/contentEditable**: the EffectsApp keydown already
  bails on those (654–664) — Shift+Space won't open the pie while typing.
- **Full-canvas mode**: the pie must still open (it's a global overlay, portaled
  to body, independent of the hidden chrome). "Full Canvas" from the pie toggles
  back out.
- **Add Node from a cursor not over the node editor**: NodeEditor clamps the
  drop point into its bounds (picker opens at the editor edge/center).

## Files

- **New** `src/components/effects/PieMenu.tsx` — presentational radial menu +
  gesture lifecycle. ~250–320 lines. Self-contained (inline styles, inline
  SVG icons, no new deps).
- **Edit** `src/components/effects/EffectsApp.tsx` — `pieMenu` state,
  `lastPointerRef` + pointermove, keydown Space guard + Shift+Space branch,
  `pieItems` useMemo, render the overlay.
- **Edit** `src/components/effects/NodeEditor.tsx` — listen for
  `toolbox:open-node-search` and open `nodePopup` (refactor the Shift+A body
  into a shared `openNodeSearchAt(x,y)` so both paths share it).
- **Edit (defensive)** `GraphEditor.tsx`, `TrackEditor.tsx` — `!e.shiftKey`
  guard on space-pan.

No engine/nodes/state touches; no schema, no serialization, no invariants
affected (pure UI, invariant #1 untouched).

## Milestones

1. **Core component + open/close.** `PieMenu.tsx` (layout, styling, mount
   anim), `pieMenu` state + `lastPointerRef` + Shift+Space binding (guard
   playback). Renders the 7 items around the cursor; Escape/scrim closes.
2. **Hybrid gesture.** Dead-zone + angle selection, `dragged` tracking,
   commit-on-release, tap→persistent fallthrough, hover+click in persistent.
3. **Wire the 6 direct actions** (Save/Projects/Assets/New/FullCanvas/Split) +
   disabled states.
4. **Add Node channel** — `toolbox:open-node-search` event + NodeEditor
   listener (shared `openNodeSearchAt`).
5. **Polish** — active wedge/ring SVG, label sides, shortcut hints, viewport
   clamp, in-browser feel pass (flick accuracy, timings).

## Future / "We swap…"

Because items are a data array, this can grow into a broader command surface:
per-item single-key shortcuts, nested/submenu items ("More…" like the
reference), a second pie on a different chord, or driving the same registry from
the menu bar. Out of scope now; the shape is ready for it.
