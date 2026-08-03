# Blender-style window tiling (split / join / swap)

Date: 2026-07-27 · Status: **complete — M1–M4 shipped** (2026-07-28).

Implementation notes (M5 — user layout presets, 2026-08-02):

- §2's flat "Layout: Default / Timeline" rows became a **Window →
  Layouts** hover flyout (MenuBar's existing `kind: "submenu"`, the one
  File → Open Recent uses): built-ins, divider, the user's saved
  presets, divider, **+ New Preset…**.
- `layout/presets.ts` owns the user list. A preset is
  `{ id, name, layout: SavedLayout }` — the same id-free blob
  `SavedProject.layout` stores, so `fromSavedLayout` is the validator on
  both paths (a preset that fails it is dropped on load and applying it
  no-ops rather than yanking the user to the default). Built-ins stay
  code (`makeDefaultTree` / `makeTimelineTree`), never data.
- Storage mirrors brush presets exactly: localStorage
  (`toolbox:layout-presets`) is always-on, Supabase
  `user_preferences.layout_presets` syncs on top and wins on load;
  accessors are dedicated (`loadCloudLayoutPresets` /
  `saveCloudLayoutPresets`) so an unapplied migration can't take the
  API-key prefs down with it. Migration:
  `user-preferences-layout-presets-migration.sql`.
- The list reloads on `user?.id` change, so signing in mid-session pulls
  the cloud copy over the local-only one. Saving under an existing name
  replaces that preset (case-insensitive); the modal relabels to
  Replace. Cap 40 presets, 40-char names.
- Not built: renaming, deleting, or reordering presets from the menu —
  the list is append/replace-only for now.

Implementation notes (M4):

- `SavedProject.layout` is an ADDITIVE field, schema stays 9 (spec §6's
  recommended option). project.ts types it `unknown` and just carries
  it; the shape (`SavedLayout`, ids stripped, re-minted on load) and
  the untrusted-blob parser (`fromSavedLayout` — validates structure,
  ratios, kinds, and requires ≥1 viewport leaf) live in
  layout/model.ts. EffectsApp attaches it POST-serialize at the two
  project-save sites (cloud + `.toolbox`) so serializeGraph's
  signature and its other callers (fragments, exported apps) are
  untouched; the cloud asset pipeline's `{...graph}` spreads carry it.
- Applied on all three project-load paths (cloud, `.toolbox`, public
  `/p/` — author-imposed per the owner decision); absent/malformed →
  default preset. File → New keeps the current layout.
- Docs round-trip: the editor-session stash carries `layoutTree` +
  `primaryViewportLeafId` by reference (ids survive), and NodeEditor
  grew a module-level per-pane camera stash — a pane whose leaf
  kind-switches away and back (or the docs nav) restores its camera
  via `defaultViewport` instead of re-fitting.
- Divider double-click resets that split to 50/50.
- UI polish that landed alongside during owner review: split preview is
  the rounded-rect tint only (no seam line); returning to the origin
  gutter disarms a locked split (mirrors the join cancel); the kind
  chips are 19×17, hosted in uniform 24px header strips, open on
  mouse-down, and select on mouse-up (press-drag-release works).

Implementation notes (M3):

- The join drag rides the M2 gesture's `outward` lock. The hovered
  LEAF is hit-tested against rects frozen at gesture start (the tree
  can't change mid-gesture). Center zone (inner 45%) = swap — both
  panels tint lightly with a ⇄ glyph; side zone = merge — the doomed
  region (union of every leaf that ops.joinAt would close, via
  `joinRemovedLeaves` in model.ts) darkens with an arrow pointing from
  the source. Retargeting glides via short CSS geometry transitions on
  the imperative preview elements.
- Merges that would swallow EVERY viewport leaf are refused (preview
  hides, release no-ops) — same invariant as the kind menu's
  last-viewport guard. Swap covers that territory instead.
- Cursor back over the source leaf (or off the region) clears the
  target → release is a clean no-op, per §4b.

Implementation notes (M2):

- The gesture preview (seam + emerging-half tint) is painted
  IMPERATIVELY into refs — pointermove never re-renders the panel tree
  (the useTileDrag ghost rule); React only mounts/unmounts the preview
  layer. The tree is untouched until pointer-up, so Esc-cancel is
  trivially clean (it just drops the gesture object; the Esc is
  swallowed so it doesn't also exit full-canvas).
- Corner hotspots are 12px squares INSIDE each leaf section (they move
  with it for free), z 20 — above the gutter dividers (z 10), below
  the panel-kind chips (z 30, so clicking a chip never starts a
  gesture where they overlap).
- A drag that locks OUTWARD (across the leaf edge) is recorded on the
  gesture but inert — that slot is where M3's join/swap goes.
- Primary-viewport election became STICKY (state, falls back to first
  viewport leaf in tree order only when the current primary stops
  being a viewport leaf) — otherwise splitting the primary from a
  west/north corner would re-elect the new clone and remount the
  canvas + overlays mid-gesture.

Implementation notes (M1), where reality deviated from the plan below:

- The primary viewport's ~400-line JSX stays inline in EffectsApp's
  return — LayoutRegion's `renderPanel` wrapper routes the primary
  viewport leaf to it and everything else to `renderLayoutPanel`. Same
  architecture, less code motion.
- Node Editor instance gating is a sticky "pane the pointer last
  entered" module ([nodes-pane-scope.ts](../src/components/effects/nodes-pane-scope.ts)),
  not a hover prop — with one pane (the common case) it always owns the
  scope, so shortcuts work with the cursor anywhere, exactly as before.
  The shell-level ReactFlowProvider moved INTO each pane so duplicate
  panes get independent xyflow stores/cameras.
- The kind menu refuses to reassign the LAST viewport leaf (engine blit
  target + overlays + dock must anchor somewhere); §5's "no viewport
  leaves" case is therefore unreachable for now.
- Pane cameras are per-instance but not yet persisted across a leaf's
  kind round-trip — the per-leaf camera map is M4 polish.

Replace the two hard-coded editor layouts (default + AE-style
`timelineLayout`) with a Blender-style tiled window system: every panel
region can be split, joined, swapped, and re-assigned to show any editor
(Viewport, Node Editor, Parameters). Corner-drag gestures with a fade-in
preview overlay drive split/join, gutter dividers drive resize.

Owner decisions (Q&A 2026-07-27):

- Tiling **replaces both existing layouts**; they become "reset layout"
  presets in the Window menu. Panel kinds are **Viewport / Node Editor /
  Parameters** only. The tracks editor stays the slide-up dock; the
  playback bar stays a fixed global strip.
- Join gesture resolves by **where the cursor lands in the target**:
  near the center → **swap** the two panels; toward a side → **merge**
  (source swallows).
- **N viewport panels allowed**, each an independent blit target with
  its own pan/zoom (today's v1/v2 machinery generalized). Overlays/
  gizmos anchor to the primary (first) viewport.
- Layout **persists per-project in the save file**.

## 1. Why care / glitch philosophy

The user-visible failure modes of tiling UIs are all reparenting and
stale-rect bugs: panels remounting mid-drag (canvas flashes black,
xyflow loses its camera), overlays anchored to a rect that moved, resize
handlers fighting React. Three structural rules prevent the whole class:

1. **The tree is data; the DOM is flat.** Panels never nest in the DOM.
   A single pure module owns the tree; rendering maps each leaf to an
   absolutely-positioned sibling `<section>` keyed by stable leaf id.
   Split/join/swap changes *styles*, never DOM ancestry → nothing
   remounts unless its panel actually closes.
2. **Structural ops are pure functions** (the graph-ops pattern):
   `layout-ops.ts` exports `splitLeaf / joinAt / swapLeaves /
   setRatio / assignKind / …`, each `LayoutTree → LayoutTree`. EffectsApp
   holds one `layoutTree` state and applies results. Trivially
   unit-testable when a runner lands (devguide §tests).
3. **Every committed layout change dispatches `window.resize`** — the
   established signal overlays already subscribe to for rect refresh
   (EffectsApp ~line 1136).

## 2. Data model

```ts
// components/effects/layout/model.ts  (types + pure helpers)
export type PanelKind = "viewport" | "nodes" | "params";

export type LayoutNode =
  | { kind: "leaf"; id: string; panel: PanelKind }
  | {
      kind: "split";
      id: string;
      dir: "row" | "col";     // row = children side-by-side
      ratio: number;          // 0..1, share of the first child
      a: LayoutNode;
      b: LayoutNode;
    };

export interface LayoutTree { root: LayoutNode; }
```

- Leaf ids are minted once (`crypto.randomUUID()` style, same as node
  ids) and survive every op except the leaf closing. All per-panel
  session state (viewport pan/zoom, xyflow camera, params scroll) keys
  off leaf id.
- Invariants (enforced by ops, checked by a dev-mode `validateTree`):
  ratios clamped so both sides ≥ `MIN_PANEL_PX` (~200px, measured at
  clamp time); a split's children are never both the *same leaf*; the
  tree always has ≥ 1 leaf.
- **Derived rects**: `computeRects(tree) → Map<id, {x,y,w,h}>` in
  **0..1 fractions** of the tiling region. Rendering uses percentage
  positioning + `calc()` for the `PANEL_GAP` insets — no measurement
  needed, so SSR/hydration renders deterministically (same reason
  `rightColWidth` has its SSR note today). Pixel measurement happens
  only inside drag handlers (min-size clamping, gesture thresholds).

### Presets

`DEFAULT_TREE` reproduces today's default layout exactly: `row(canvas
· col(nodes · params) @ ~65/35)` at the current 50/50-ish proportions;
`TIMELINE_TREE` reproduces the AE-style arrangement (params-left,
canvas-right — tracks stay the dock, so the old bottom strip is out of
scope). Window menu: the `timelineLayout` toggle is replaced by
**Layout → Default / Timeline** preset entries that just
`setLayoutTree(preset)`. `timelineLayoutTab`, `rightColWidth`,
`bottomRowHeight`, and the `row-reverse` body flip are deleted.

## 3. Region + chrome

The tiling region is exactly today's body wrapper (between MenuBar and
the playback bar; EffectsApp ~line 9176). Inside it, one relatively-
positioned container renders, as flat siblings:

- **Leaves**: `<section>` per leaf — `position:absolute`, rect from
  `computeRects`, `PANEL_FRAME` chrome, content = the existing panel
  JSX (see §5). Keyed by leaf id.
- **Dividers**: one per split node, positioned over the shared edge —
  the existing `Divider` gutter styling (invisible `GUTTER_HIT`-wide
  grab zone, `PANEL_GAP` visible gap). Drag = `setRatio` on that split,
  rAF-coalesced setState (same cost profile as today's `rightColWidth`
  drags), `window.resize` dispatched on move (overlays track live, as
  they do for today's dividers) and on release.
- **Corner zones**: per leaf, four ~14×14px invisible hotspots at its
  corners. Cursor: `crosshair`. These start the split/join gesture (§4).
  Corner zones sit *above* dividers in z-order (a corner is where
  gutters meet; the crosshair wins there, matching Blender).
- **Preview overlay**: a single absolutely-positioned div (zIndex above
  all panels), driven by gesture state — see §4.
- **Panel-kind dropdown**: every leaf gets a small icon button in its
  top-left corner opening the 3-entry kind menu (icons: canvas /
  graph / sliders). For viewport leaves it integrates as the leftmost
  item of the existing `ViewportMenuBar`; nodes/params leaves get a
  floating chip overlaying the corner (NodeEditor already floats
  breadcrumbs top-left — the chip slots left of them). Picking a kind =
  `assignKind(leafId, kind)`; the leaf id (and rect) is unchanged, so
  only that panel's content swaps.

`fullCanvas` (F) is orthogonal and unchanged: it hides the tiling
container and shows the primary viewport edge-to-edge, exactly as it
hides the right column today.

## 4. Gestures

All gestures use pointer capture on the corner hotspot, live entirely in
the layout container's coordinate space, commit on pointer-up, and
cancel on **Esc** (restores pre-gesture tree, no-ops if nothing
committed). During a gesture the tree state is *not* mutated — a
`gesture` state object drives previews; the op applies once on commit.
That means a cancelled gesture cannot leave a half-applied tree.

### 4a. Split (drag inward)

From a corner of leaf S, drag **into** S. The dominant axis of the drag
picks the split direction (horizontal motion → vertical seam → `row`
split; vertical motion → `col`), locked once the drag passes a ~12px
threshold. Preview: a 1px seam line following the cursor across S plus
a subtle tint fade-in (~120ms opacity transition) on the half being
created. Release commits `splitLeaf(S, dir, ratioAtCursor)` — the new
leaf is a **clone of S's kind** (Blender semantics; the dropdown is how
you change it after). Ratio clamps to min panel size; a release inside
the threshold is a no-op.

### 4b. Join / swap (drag outward)

From a corner of leaf S, drag **across the shared edge** into neighbor
territory. The hovered *leaf* T under the cursor is the live target.
Zones inside T (owner's center/side rule):

- **Center** (inner ~45% box of T's rect): **swap** — S and T trade
  `panel` kinds. Geometry untouched, nothing closes. Preview: both
  panels tint + a ⇄ glyph centered in T.
- **Side** (outside the center box): **merge** — S expands to swallow.
  Preview: the doomed region tints darker with an arrow glyph pointing
  from S (Blender's join look), fade-in 120ms.

Merge resolution in tree terms: find the lowest split node W separating
S from T. The side of W containing S replaces W. When T is the entire
other side of W, that reads as "S's region swallows T" — the exact
Blender case. When the other side is subdivided (S's edge touches
several panels), the preview covers **everything that will close** (the
whole other side of W), so the destructive scope is always visually
explicit before release. You can never get stuck (any layout can be
collapsed), and swap covers the "I just wanted that panel here" case
that Blender join-refusals frustrate.

Hover moving between zones/targets retargets the preview (opacity/rect
transitions, no layout change until release). Releasing back inside S
near the origin: no-op.

## 5. Panel content & multi-instance semantics

EffectsApp already builds the panel bodies as variables
(`editorPanelJsx`, `paramPanelJsx`, viewport JSX inline). M1 extracts a
`renderPanel(leaf: {id, panel}): ReactNode` that routes to them; the
existing multiplexing *inside* each body is untouched (`paramView`
project/node/load/ai/assets keeps living in the Parameters panel;
`view === "project"` keeps living in the Node Editor panel).

Duplicates are legal for every kind ("2 params panels won't serve a
function" — accepted). Per-kind notes:

- **Parameters**: N instances render the same `paramPanelJsx`. Shared
  `paramView` state means they mirror each other — fine per owner.
  (ParamPanel is memoized; N instances = N× render cost of one panel.
  Acceptable; they're mostly scroll containers.)
- **Node Editor**: N xyflow instances over the same controlled
  `nodes`/`edges` state — each keeps its own camera (persisted per leaf
  id via `defaultViewport`/`onViewportChange` into a module map, so
  split/join don't lose framing). **Key-scope gate required**:
  NodeEditor attaches ~10 window-level `keydown`/`paste`/`mousedown`
  listeners (copy/paste, node search, marquee, etc.) — two instances
  would double-fire (paste → two nodes). Rule (Blender's): shortcuts go
  to the editor under the cursor. Implementation: EffectsApp tracks the
  hovered nodes-leaf (`onPointerEnter` per instance → ref) and passes
  `keyScopeActive` to each NodeEditor; every window-level handler
  early-returns when its instance isn't the scope. One prop + a guard
  line per listener; `shortcut-scope.ts` is precedent for the pattern.
  `frameSignal` / fitView fire on all instances (harmless — each frames
  its own camera).
- **Viewport**: a new `ViewportPanel` component owns per-instance
  concerns — its own `useViewportPanZoom()` (the hook moves inside),
  canvas element, zoom chip, touch handling. Canvases register in a
  `Map<leafId, HTMLCanvasElement>` (callback ref); the eval loop blits
  the terminal image to **every** registered canvas (the `blitToCanvas`
  site, ~line 1846) — same image, independent pan/zoom. The **primary
  viewport** = first viewport leaf in tree order; it exclusively hosts:
  all editing overlays/gizmos (they anchor to one canvas rect), the
  tracks dock, the Shift+S in-panel A/B split (v2 stays a child of the
  primary panel), `fullCanvas`, and readback helpers (`getRefImageBlob`
  paths already use the engine, not the preview canvas — unaffected).
  Non-primary viewports are pure watch windows (pan/zoom + zoom chip
  only). If the primary closes, the next viewport leaf inherits; if no
  viewport leaf exists, eval continues (engine renders headless), and
  overlays/dock simply don't mount — same as `fullCanvas` hiding today.

## 6. Persistence (per-project, owner decision)

- `SavedProject.layout?: SavedLayout` — the tree (leaf kinds + split
  dirs/ratios; ids re-minted on load) at the project top level (one
  layout per project, not per composition). **No schema bump**:
  additive optional field, `CURRENT_SCHEMA` stays 9 — older builds pass
  the version check and ignore the field (a resave from an old build
  drops the layout; project content is untouched — acceptable
  degradation, and it keeps viewers/`.toolbox`/live paths loading
  files from new builds. Flag: if the owner prefers strictness, this is
  a one-line v10 bump instead).
- Save: serialize the live tree. Load: apply `layout` if present +
  valid (`validateTree` rejects malformed → default preset); absent →
  default preset. Public `/p/` loads apply it too (owner accepted
  author-imposed layouts). Live viewer / exported apps ignore it.
- `EditorSessionSnapshot` gains `layoutTree` (+ the per-leaf camera
  map) so the docs round-trip restores panels exactly.
- File → New: keep the current layout (don't yank the user's
  arrangement); the fresh project simply saves it forward.

## 7. What gets deleted

`timelineLayout`, `timelineLayoutTab`, `rightColWidth`,
`bottomRowHeight`, `startVResize`, `startHResize`, the `row-reverse`
body flip, the tabbed left pane, and the timeline-layout bottom strip
(tracks stay the dock in all layouts now). `viewportSplit` /
`viewportSplitRatio` / `v2` survive as primary-viewport-internal
state. The MenuBar's layout toggle becomes the preset entries.

## 8. Milestones

- **M1 — engine of the thing.** `layout/model.ts` + `layout/ops.ts`
  (pure) + `LayoutRegion` renderer (flat absolute leaves, dividers,
  percentage rects) + `renderPanel` extraction + panel-kind dropdown +
  divider resize + presets replacing the old layout modes (§7
  deletions). Node Editor key-scope gate. ViewportPanel extraction with
  N-blit + primary election. No gestures yet — the dropdown alone
  already makes any arrangement reachable. Verify: both presets pixel-
  match today's layouts; duplicate panels of each kind behave per §5;
  overlays/g gizmos/dock/paint/spline editing all still anchor right
  after resizes.
- **M2 — split gesture.** Corner hotspots, axis lock, seam preview +
  tint fade, Esc cancel, min-size clamping.
- **M3 — join/swap gesture.** Target-leaf hit test, center/side zones,
  swap + merge ops, doomed-region preview, retargeting transitions.
- **M4 — persistence + polish.** SavedProject.layout + session stash +
  `.toolbox` round-trip; double-click divider → 50/50; cursor states;
  devguide + in-app docs update.

Each milestone is independently shippable; M1 is the risk gate — if
duplicate-instance behavior surfaces problems, they surface before any
gesture code exists.

## 9. Risk inventory (things that will glitch if ignored)

- **Remounts**: any DOM reparenting of a leaf remounts canvas/xyflow.
  The flat-sibling renderer is the fix; never wrap leaves in
  per-split containers.
- **Double key handling** in duplicate NodeEditors — the §5 scope gate;
  audit *every* window listener in NodeEditor.tsx (~10) when wiring it.
- **Stale overlay rects** after layout changes — dispatch `resize` on
  every divider move, gesture commit, and preset application.
- **SSR/hydration**: percentage rects from the tree are deterministic;
  never read `window` dimensions during render (only in drags).
- **Pointer races**: gestures use `setPointerCapture` on the hotspot;
  divider drags keep the window-listener pattern the codebase already
  uses. Only one gesture object can exist at a time.
- **Min sizes**: clamp in ops (not CSS) so the tree itself can never
  encode an unusable layout — a loaded project's tree re-clamps on
  apply.
- **Blit cost**: N viewports = N `blitToCanvas` calls per frame. Cheap
  (GPU copy), but skip blitting canvases whose leaf is 0-sized or
  hidden (`fullCanvas`).
