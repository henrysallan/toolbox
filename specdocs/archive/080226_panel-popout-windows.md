# Panel pop-out windows (multi-monitor)

Date: 2026-08-02 · Status: **M1–M3 shipped** (2026-08-02/03) · M4 open.

Implementation notes (M2 + M3 — params, timeline, node editor):

- `layout/panel-window.tsx` is the shared plumbing the sweep needed:
  a `usePanelWindow()` context (null in the main window, the child
  `Window` inside a pop-out), `ownerWindow`/`ownerDocument` for the
  ref-holding cases, and `broadcastAppEvent`.
- The house pattern, used everywhere: resolve `const win = panelWin ??
  window` **inside** the effect (never during render — `window` is
  undefined under SSR) and keep `panelWin` in the dep list so listeners
  re-bind if a panel changes windows.
- Files swept: ParamPanel (2), `lib/param-controls.tsx` (18 + 2
  portals), TrackEditor (18 + 2 portals), LayersEditor (13 + 1 portal),
  NodeEditor (26 incl. 4 `elementFromPoint` probes and the
  `innerWidth/Height` fallback), EffectNode (5 listeners).
- **Portal targets must come from context, not a ref.** The first cut
  used `ownerDocument(btnRef.current).body`, which the
  `react-hooks/refs` lint correctly rejects — portal targets are
  computed during render. `(panelWin ?? window).document.body` is the
  form that survives.
- **Cross-window app events.** Once either end of one of the app's
  window CustomEvents can be in another window, a plain
  `window.dispatchEvent` only reaches listeners sharing the sender's
  window. `broadcastAppEvent(make)` dispatches to the main window plus
  every registered panel window; direction doesn't matter, because a
  pop-out runs the same module instance (one JS heap). Converted:
  `node-media-loading`, `node-timings`, `viewport-split-changed`,
  `render-queue-progress`, `color-node-palette`, `keyframe-stagger*`,
  `toolbox:open-node-search`. NOT converted: `pipeline-bump` — it is
  dispatched by panels and heard only in EffectsApp, and module-scope
  `window` is already the main one, so it arrives correctly as-is.
- **Pane scope split in two.** `nodes-pane-scope.ts` now answers two
  different questions. Single-window events (keystrokes, paste,
  pointer) scope **per window** — the event already chose a window, so
  the question is only which pane within it; this also fixes the case
  the old global owner got wrong, where the pointer resting over the
  main window's pane left a focused pop-out pane inert. Broadcast
  events scope **globally** (`ownsGlobalNodesPaneScope`) — they hit
  every window, so per-window scoping would open one node-search popup
  per window, the exact double-fire the module exists to prevent.
- A detached panel can now retype to any kind except viewport (that
  would elect a blit target outside the main window while the tree
  still needs one inside it); `handleAssignPanelKind` routes detached
  leaves to the pop-out entry instead of the tree.

Verified by driving the real app in Electron: Node Editor, Parameters
and Timeline each pop out with real content in the child window
(the graph's nodes, "Select a node to edit parameters.", the timeline
ruler + tabs), React synthetic events fire inside each, styles and
theme clone, and closing re-homes the panel with the main window's
panel count restored.

**Known limitation:** the pie menu is a root-level EffectsApp overlay
in the main window, so right-clicking inside a popped-out node editor
gets that pane's own context menu but not the pie. Its "Add Node" item
does reach a detached pane (that path broadcasts).

Implementation notes (M1 — one popped-out watch viewport):

- `layout/PanelPopout.tsx` is the host: opens the same-origin child,
  dresses it, portals into it, and owns close/re-home detection. Panel
  bodies reach it through the SAME `renderLayoutPanel` the tiled grid
  uses — a detached watch viewport registers in the same
  `watchCanvasesRef` and the eval loop blits to it without knowing it
  lives in another document. The engine is untouched, as predicted.
- Tree ops: `removeLeaf` (collapse the parent split into the sibling,
  null on the last leaf) + `attachLeaf` (graft a leaf of a GIVEN kind
  beside a target). `model.largestLeaf(tree, containerAspect)` picks the
  re-home target. Detached panels live in `detachedPanels` state keyed
  by the original leaf id.
- `detachedIdsRef` is the synchronous authority on what's detached: the
  close path can double-fire (the child's `pagehide` racing the
  `win.closed` poll) and re-homing twice would graft a second leaf.
  State alone can't guard it — a render may not happen in between.
- Guards: the primary viewport can't detach, nor can any move that
  would leave the main window without a viewport; a detached panel's
  kind menu is viewport-only until M2/M3 do those panels' window sweep.
- Style/theme cloning went as specced, with one correction: the theme
  ramp is only *sometimes* inline on `<html>` (theme.ts writes the
  `--tb-n-*` trim there, but a user who never trims has an empty style
  attribute and gets the ramp from the stylesheet). Mirroring is
  still required — it just can't be asserted as always-present.
- `PanelKindMenu`'s own dismiss listeners had to move to
  `ownerDocument.defaultView` too: the chip is the only interactive
  chrome a detached panel has, and module-scope `window` never saw its
  clicks.
- Electron: pop-outs are matched by **frame name**, not origin.
  `window.open("")` is about:blank, whose origin parses to `"null"`, so
  the existing same-origin check would have handed the panel window to
  the system browser. Native frame, per §8.
- StrictMode: the open effect's cleanup only SCHEDULES the close (0ms)
  and an immediate re-mount cancels it, so React's double-invoke reuses
  the window instead of flashing a new one.

Verified end-to-end by driving the real app in Electron (harness, not
committed — it needs a live dev server and a GUI, so it doesn't belong
in the `npm run check` chain): pop-out opens only from the non-primary
viewport, the portal mounts, **React synthetic events fire inside the
child** (§11's load-bearing unknown — dispatching on the child's kind
chip opened its menu), a canvas minted in the opener draws into the
child's canvas and reads back exactly (`#ff00ff` round-trip, the
`blitToCanvas` path), stylesheets and `data-theme` clone, and closing
the child re-homes the panel (2 panels → 3). NOT covered: the app
actually painting a composition into the detached window — the harness's
own GL produces no frames, so that still needs a normal run.

Direct extension of 072726_window-tiling.md. That spec made panels
multi-instance and decoupled inside one document; this one lets a leaf
leave the document entirely and live in its own OS window, so a second
monitor can hold the viewport (or the node editor) full-screen while the
main window keeps the rest.

## 1. Why this is cheap

The tiling work already did the hard part. Three facts carry the
feature:

1. **Panels never nest.** `LayoutRegion` renders leaves as flat
   absolutely-positioned siblings, and `renderPanel(leafId, panel)`
   ([EffectsApp.tsx:10735](../../src/components/effects/EffectsApp.tsx#L10735))
   is already the single routing point for panel bodies. A detached leaf
   is the same call with a different container.
2. **Non-primary viewports are already remote.**
   [WatchViewport](../../src/components/effects/EffectsApp.tsx#L11637) owns
   its own pan/zoom and registers a canvas by leaf id into
   `watchCanvasesRef`
   ([EffectsApp.tsx:1114](../../src/components/effects/EffectsApp.tsx#L1114));
   the eval loop blits the terminal image to every registered canvas
   ([EffectsApp.tsx:2434](../../src/components/effects/EffectsApp.tsx#L2434)).
3. **The blit crosses documents for free.** `blitToCanvas` ends in a
   plain `ctx2d.drawImage(hiddenCanvas, 0, 0)`
   ([gl.ts:522-526](../../src/engine/gl.ts#L522-L526)). A canvas owned by a
   different **same-origin** document is a legal `drawImage` target and
   is not tainted. **The engine needs zero changes.** One evaluation,
   one WebGL context, one rAF loop, N windows.

## 2. Mechanism: same-origin `window.open` + React portal

A same-origin `window.open()` child is script-connected to its opener:
same JS heap, same event loop, synchronous DOM access both ways. So the
detached panel is not a second app — it is the *same React tree*,
portalled into another document:

```tsx
const win = window.open("", `tb-panel-${leafId}`, features);
createPortal(renderPanel(leafId, kind), win.document.body);
```

Same state, same context providers, same handlers, no serialization, no
sync protocol, no second evaluator, no double GPU cost, no CAS save
races.

**Rejected: a genuinely independent second tab.** Separate JS context
means serializing the whole graph (including data-URL media) and
diffing it over `BroadcastChannel`, a second WebGL context and evaluator
(double GPU), and two editors racing the same `updated_at`
compare-and-swap on cloud save. Only worth it for a second *machine* —
`/live/[slug]` already covers that read-only.

**Rejected: Document Picture-in-Picture.** `documentPictureInPicture`
is Chromium-only and always-on-top, which is a floating-preview feature,
not a monitor-spanning one. Revisit separately if a pinned mini-preview
is ever wanted.

## 3. The actual work: window/document coupling

This is the whole cost of the feature. Module-scope `window` and
`document` always resolve to the **opener's**, so any panel code that
reaches for them breaks when portalled.

[useViewportGestures](../../src/components/effects/EffectsApp.tsx#L11393-L11437)
is the canonical case: it listens on `window` and hit-tests
`getBoundingClientRect()`. In a detached panel that is doubly wrong — it
never hears the child's wheel events, *and* it tests the opener's
pointer coordinates against a rect from another window's coordinate
space.

The fix is mechanical:

```ts
const win = viewportRef.current?.ownerDocument.defaultView ?? window;
win.addEventListener("wheel", onWheel, { passive: false });
```

**Rule: any component that can be detached resolves its window/document
from an element's `ownerDocument`, never from module scope.** Scope by
file (`window.addEventListener` counts):

| File | Count | Milestone |
|---|---|---|
| ParamPanel.tsx | 2 | M2 |
| TrackEditor.tsx | 18 | M2 |
| NodeEditor.tsx | 21 | M3 |
| EffectsApp.tsx | 26 | stays in the main window — shell/global shortcuts, not detachable |

Only listeners reachable from a detachable panel need converting. The
shell's are untouched, which is why M1 is small.

Two more coupling classes to sweep alongside the listeners:

- **Rect math mixed with viewport size** — `getBoundingClientRect()`
  returns child-relative coords (correct), but anything comparing it to
  `window.innerWidth/innerHeight` or `scrollX/Y` must read those off the
  same window. Popups, menus, and drag ghosts that portal to
  `document.body` must portal to the *panel's* document.
- **`document.body` / `document.documentElement` writes** (~40 sites in
  components) — cursor overrides, `user-select` suppression during
  drags, and overlay hosts all have to target the owning document.

## 4. Chrome & UX

- **Detach**: an entry in the existing per-panel kind chip menu
  (`PanelKindMenu.tsx`) — "Pop Out". Must be a direct user gesture so
  the popup blocker allows it (a chip click qualifies).
- **Re-home**: closing the OS window returns the panel. There is no
  drag-back gesture in v1.
- **Window chrome**: the child gets a minimal header — the kind chip
  (so it can retype in place) and nothing else. No menu bar; the main
  window stays the app's command surface.
- **Title**: `<project name> — <Panel kind>`, so the OS window switcher
  is readable.

## 5. Data model

A detached leaf is **removed from the main tree** and tracked
separately:

```ts
interface DetachedPanel {
  id: string;        // the leaf id it was minted from — camera stashes keep working
  panel: PanelKind;
  win: Window | null;
}
```

Removal reuses `ops.ts` join semantics, so the main tree stays a
well-formed split tree with no holes and ratios stay meaningful. On
close, re-home = `splitLeaf` on the **largest leaf** in the current main
tree. Deterministic, and it avoids bookkeeping a parent that may have
been joined away while the panel was detached.

**Invariants** (both extend the tiling spec's last-viewport rule):

- The main window's tree must remain valid after a detach — that means
  ≥1 leaf, and ≥1 **viewport** leaf. `fromSavedLayout`'s existing
  "requires ≥1 viewport" check now means *in the main window*.
- **The primary viewport cannot be detached** (M1–M3). It is sticky
  state and exclusively owns `canvasRef`, every overlay and gizmo, the
  tracks dock, and the Shift+S A/B split — all the pointer-heavy code.
  The kind menu refuses it the same way it refuses retiring the last
  viewport. Revisit only if wanted after M4.

## 6. Bootstrapping the child document

`window.open("")` yields an empty document; it must be dressed before
the portal mounts:

- **Styles**: clone every `<style>` and `<link rel="stylesheet">` from
  the opener's head. `<link>` clones re-fetch (from cache) *async* — keep
  the child body hidden until they load, or it flashes unstyled. A
  `MutationObserver` on the opener's head keeps dev HMR style injection
  flowing.
- **Theme**: mirror `data-theme` onto the child's `documentElement`
  (globals.css keys off `:root[data-theme="light"]`) and observe it, so
  toggling the theme in the main window follows.
- **Cleanup**: close all children on the opener's `pagehide`/unload
  (orphaned popouts are dead windows referencing a torn-down heap), and
  unregister the watch canvas on unmount so the blit loop drops it.

## 7. Persistence

**Popouts are NOT persisted into the project.** `SavedProject.layout`
stays exactly as M4 of the tiling spec left it — a shared or public
project must not spawn OS windows on someone else's machine, possibly
off-screen.

Restore is per-machine and opt-in: `toolbox:panel-popouts` in
localStorage, keyed by project id, holding kind + geometry. On load,
only re-open a window whose saved rect intersects a currently-attached
screen. Same local-first strategy as recent-projects.

The docs round-trip (`EditorSessionSnapshot`) carries the detached list
by reference alongside `layoutTree`, so navigating to `/docs` and back
doesn't drop the windows.

Optional progressive enhancement: `getScreenDetails()` (Window
Management permission) to remember *which monitor* a panel was on rather
than a bare rect. Behind a permission prompt, so it must degrade to the
rect path. Electron needs no permission.

## 8. Electron

Already permitted: `setWindowOpenHandler` returns `{action:"allow"}` for
same-origin URLs ([main.js:47-55](../../electron/main.js#L47-L55)), so a
popout opens as a native in-app window instead of bouncing to the system
browser. Two adjustments:

- Pass `overrideBrowserWindowOptions` for `backgroundColor` and frame
  style. The main window is frameless with a custom title bar; the
  popout should take the **native** frame — it has no menu bar to host
  window controls, and a native frame gets OS snapping for free.
- The child inherits the parent's `webPreferences`, including the
  preload. The `toolboxNative` bridge is origin-gated, and the child is
  same-origin, so it stays available — harmless, since detached panels
  don't call it.

## 9. Milestones

- **M1 — one popped-out watch viewport.** The whole mechanism end to
  end on the smallest slice: popout host (open/dress/portal/close),
  detach + re-home tree ops, `WatchViewport` through a portal, its
  gesture hook converted to `ownerDocument.defaultView`, kind-menu
  entry, Electron window options. **This is the risk gate** — §11's
  React-portal and drawImage questions are both answered here, before
  any per-panel conversion work exists.
- **M2 — Parameters + Timeline.** ParamPanel (2 listeners) then
  TrackEditor (18). Timeline is the real multi-monitor payoff after the
  viewport.
- **M3 — Node Editor.** 21 listeners plus xyflow's own document-level
  drag and measurement assumptions, and `nodes-pane-scope.ts` +
  `shortcut-scope.ts` become per-window (a pane in another window must
  be able to own the scope, and focus follows the OS window).
- **M4 — Persistence + polish.** localStorage restore with
  screen-bounds validation, session stash, window titles, devguide +
  in-app docs update.

Each milestone ships independently. M1 is deliberately one panel kind:
if portalling turns out to fight React or xyflow, that surfaces before
the conversion sweep is written.

## 10. Verify (per milestone)

- Detached viewport blits at the same rate as an attached one; pan/zoom
  gestures act only on the window under the cursor.
- Main-window overlays, gizmos, paint, and spline editing still anchor
  correctly after a detach and after a re-home (both change the main
  tree's rects — dispatch `resize`, per the tiling spec's stale-rect
  risk).
- Closing the popout, closing the *main* window, and reloading mid-detach
  all leave no orphan windows and no stale canvas registrations.
- Theme toggle and dev HMR both propagate into the child.
- Detaching is refused for the primary viewport and for any move that
  would leave the main window without a viewport.

## 11. Risk inventory

- **React portal into a foreign document.** React 19 attaches events at
  the root container rather than `document`, and registers separately
  for portal containers. Cross-document portals are a known-working
  pattern, but this is load-bearing — **verify synthetic events
  (`onClick`, `onPointerDown`) actually fire in the child before
  building M2+ on it.** M1 exists to answer this.
- **Opener occlusion freezes popouts.** The opener owns the rAF loop; if
  the main window is minimized or fully occluded, rAF throttles and the
  detached viewport stops updating — exactly when a user parks the main
  window to look at the second monitor. Mitigation: when the opener is
  `document.hidden` *and* a popout is open, drive the render tick from a
  timer instead of rAF.
- **Wrong-window coordinates** — the §3 class of bug. Symptoms are
  subtle (gestures that work but land in the wrong place), so convert by
  audit, not by symptom.
- **Portalled popups and menus** inside a detached panel that mount to
  `document.body` will appear in the *main* window. Every `createPortal`
  target inside a detachable panel needs the panel's document (16
  `createPortal` sites exist today; not all are in detachable panels).
- **Blit cost** — unchanged from the tiling spec: skip canvases whose
  window is closed or whose leaf is 0-sized.
- **Popup blockers** — detach must stay on a direct user gesture. Never
  restore popouts automatically on load without a click; §7's restore is
  opt-in for this reason.
