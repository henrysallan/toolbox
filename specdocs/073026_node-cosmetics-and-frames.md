# Node cosmetics (tint / bold) + Frames — spec (2026-07-30)

Two cosmetic organization features for the node graph, both purely
editor-side (the engine never reads any of it):

1. **Tint + Bold** — right-click a node → pick one of 7 tint colors
   (washes the node body) and/or toggle Bold (a thick outline ring).
2. **Frames** — Blender-style frame zones: a shaded rect behind a set
   of member nodes that auto-fits them as they move. `Shift+F` frames
   the selection; drop a node in to join; Cmd-drag it out to leave;
   drag the frame's edges to move it and everything inside; click the
   top-left label to rename.

## Data model (all additive, schema stays 9)

`NodeDataPayload` (state/graph.ts) grows three optional fields, and
`SavedNode` (lib/project.ts) mirrors them — same convention as
`uiWidth`/`uiHeight` (additive/optional, no schema bump, engine-blind):

- `tint?: string` — one of the 7 preset hexes (any hex renders).
- `bold?: boolean` — thick outline emphasis.
- `frameId?: string` — id of the frame node this node belongs to.
  Membership is a member→frame pointer (like `parentId`), so deleting
  a frame just strands ids that every consumer ignores when the frame
  node no longer exists; undoing the delete restores membership for
  free. Stale ids are tolerated everywhere, never crashed on.

**The frame is a real node** (`defType: "frame-zone"`, FRAME_TYPE in
engine/graph-helpers.ts next to REROUTE_TYPE) so selection, delete,
copy/paste, undo, scoping (`parentId`) and serialization are all free —
the same reasoning as the reroute node. The def
(nodes/effect/frame-zone.ts) is `hidden: true`, `noMaskInput`, has no
sockets and a `compute` that returns `{}`; nothing ever wires to it so
the evaluator's needed-set never includes it. The engine def type
"frame" was already taken by the Auto-Layout sizing adapter — hence
`frame-zone`.

Frame nodes render through a dedicated xyflow node type `"frame"`
(FrameNode.tsx), mapped wherever defType→xyflow-type is decided
(makeInstanceNode + project.ts deserialize). Frame node objects carry
xyflow-level props (`FRAME_XY_PROPS` in state/graph.ts):

- `dragHandle: ".frame-drag-handle"` — only the edge bands + label
  start a drag.
- `zIndex: -1` — renders behind regular nodes.
- `style: { pointerEvents: "none" }` — the node wrapper is
  click-through, so marquee/pane gestures work over the frame's
  interior; the edge bands / label re-enable `pointerEvents: "auto"`.

The frame's own box persists via the existing `uiWidth`/`uiHeight` +
`position` (used verbatim when it has no members); its label is
`data.name` (rename infra reused). Frames may not contain frames
(`frameId` is never written to a frame node).

## Tint + bold rendering (EffectNode.tsx)

Palette (components/effects/node-tints.ts): 7 Tailwind-400 hues chosen
against socketColor.ts — `#f87171 #fb923c #a3e635 #34d399 #38bdf8
#a78bfa #f472b6` — applied as low-alpha washes so they never read as a
wire type.

- Background: tint wash layered over the node base
  (`linear-gradient(rgba(tint,.13)…), #18181b`) — stays opaque.
- Border color precedence: `selected > error > tint > layerAccent >
  default` (tint slots below selection/error so state stays legible).
- Bold: an extra `box-shadow` ring (`0 0 0 2px`, tint-colored, neutral
  `#d4d4d8` when untinted) — border width never changes, so no layout
  shift and no `updateNodeInternals` churn. Composes with the
  selection ring.
- Reroute dots ignore tint/bold (context-menu rows hidden for them).
  Frames DO honor both: tint = the zone's hue, bold = thicker border.

## Context menu (NodeEditor.tsx → NodeContextMenu)

New section above Copy: a 8-slot swatch row (7 tints + a "clear" slot)
and a "Bold" toggle row with a check when active. When the right-clicked
node is part of the selection the change applies to every selected
node (Blender's rule); otherwise just that node. NodeEditor gets an
`onStyleNodes(ids, {tint?: string|null, bold?: boolean})` prop;
EffectsApp's handler is one `pushGraph` + one `setNodes` (one undo
step), deleting the field on clear.

## Frames — geometry & interactions

`FrameNode.tsx` exports the shared geometry (the
computeIterateZoneRects pattern — render and hit-test must be the same
rect by construction):

- `collectFrameMemberIds(nodes, frameId)` — direct members
  (`frameId` match, same `parentId` scope as the frame, not hidden)
  plus zone-expansion: any node whose parentId chain reaches a member
  (so an Iterate shell member brings its inline zone members along).
- `computeFrameRects(nodes, excludeMemberId?)` — per frame: with ≥1
  member, bbox = union of member boxes + 28px padding (the frame's own
  box is deliberately EXCLUDED so the rect also shrinks back — Blender
  shrink-to-fit); with none, the frame's stored position/size.
  `excludeMemberId` is the Iterate trick that lets a dragged member
  actually leave.

**Auto-fit reconciliation** (EffectsApp): an effect on `nodes` writes
each membered frame's `position` + `uiWidth`/`uiHeight` to its computed
rect when they differ by >0.5px. Plain `setNodes`, no `pushGraph` —
it's derived state; it converges because the rect doesn't depend on the
frame's own box, and undo restores members whose rect then re-derives.

**Gestures** (NodeEditor drag handlers, mirroring the Iterate zone):

- Dragging a frame (edges/label only, via `dragHandle`) snapshots its
  members into the existing `zoneDragRef` — the same absolute
  start+delta replay moves everything inside; members already in the
  drag selection are skipped. Frames never splice/reparent (early
  return in drag-stop, like Iterate shells).
- Drop-in: a single dragged node whose center lands in a same-scope
  frame's rect (computed without it) joins it — innermost smallest
  frame wins. Skipped when the drop just reparented into/out of an
  Iterate zone (`frameId` on an Iterate member would be inconsistent).
- Cmd-drag ending outside every frame clears `frameId` (composes with
  Cmd-drag detach + Iterate-leave, same modifier convention). A plain
  drag out just stretches the frame.
- `Shift+F` (NodeEditor shortcut, node-scope + pane-scope gated):
  frames the selection. Selected nodes outside the current scope
  resolve up their parent chain to their scope-level ancestor (so
  selecting Iterate members frames the shell); frames themselves are
  excluded. Empty selection spawns an empty default-size frame at the
  cursor. **Conflict fix:** EffectsApp's full-canvas `F` handler now
  bails on `e.shiftKey` (it previously swallowed Shift+F).
- Label: top-left chip, drag-handle + click-to-edit (a ≤3px pointer
  travel check tells the two apart); commits through a
  new `effect-node-rename` window event → `handleRenameNode` (undo,
  breadcrumbs etc. for free). Enter/blur commit, Esc cancels.

**Copy/paste/duplicate:** cloneSubgraph remaps `frameId` when the
frame is in the cloned set (same second pass as `parentId`);
duplicating a member alone keeps it pointing at the original frame
(same reading as the half-a-sim-zone rule).

Known v1 limits (deliberate): G-move on a frame moves only the frame
(reconciliation snaps it back — use edge-drag instead); marquee over a
frame's interior selects the frame too (Blender behaves the same);
frame membership is same-scope-siblings only.

## Touched files

graph-helpers.ts (FRAME_TYPE) · nodes/effect/frame-zone.ts + index.ts ·
state/graph.ts (fields + FRAME_XY_PROPS) · state/graph-ops.ts
(makeInstanceNode mapping, cloneSubgraph remap) · lib/project.ts
(SavedNode + both literals + type mapping) · EffectNode.tsx ·
node-tints.ts + FrameNode.tsx (new) · NodeEditor.tsx (nodeTypes, menu,
Shift+F, drag handlers, props) · EffectsApp.tsx (Shift+F fix, style /
frame / rename handlers, reconciliation) · docs KeyboardShortcuts.
