# Multi-select viewport gizmos (2026-07-08)

Goal: arrange several layers in the viewport without round-tripping to the
node graph. Multi-select nodes in the editor → every selected node that has
on-canvas transform handles shows them, all at once, each independently
draggable.

## What already existed (no node-editor work needed)

Multi-select in the node editor was already fully wired:

- `multiSelectionKeyCode={["Shift","Meta","Control"]}` on the ReactFlow
  canvas (NodeEditor.tsx), so modifier+click adds to the selection.
- The Shift-drag fuzzy-connect interceptor (capture-phase, NodeEditor.tsx)
  swallows Shift+pointerdown on a node body, and on release **without**
  a drag it additively toggle-selects that node — so plain Shift+click
  multi-select behaves correctly despite the interception.
- Marquee (drag on empty pane, `selectionOnDrag`) already multi-selects.

The gap was entirely on the viewport side: `onSelectionChange` collapsed
the selection to `sel.nodes[0]` → `selectedId`, and every overlay keyed
off that single id, so only one gizmo ever rendered.

## Design

- **Independent handles, not a group transform.** Each selected node
  renders its own gizmo and edits only its own params. No Figma-style
  combined bounding box (explicitly out of scope for now).
- **Selection source of truth**: the `selected` flags on EffectsApp's
  `nodes` state (the same source Cmd+G uses), unioned with `selectedId`
  as a fallback so programmatic selects that haven't echoed through
  ReactFlow yet still show their gizmo (parity with the old behavior).
- Two target lists, derived per render:
  - `transformGizmoNodes` — selected nodes whose def has
    `supportsTransformGizmo` (Transform, SVG Source) → TransformGizmo.
  - `primitiveGizmoNodes` — selected nodes with a
    `PRIMITIVE_GIZMO_ADAPTERS` entry (Circle, Rectangle, Liquid Glass,
    Text, Auto Layout) → PrimitiveGizmo.
- Each list maps to one gizmo (+ its MotionPathOverlay) per node, keyed by
  node id, in `nodes`-array order — later nodes paint on top and win
  pointer events where handles overlap. Accepted imperfection; there is no
  cross-gizmo hit arbitration.
- **TransformGizmo translate surface**: single selection keeps today's
  canvas-wide grab-anywhere-to-translate rect. In multi-gizmo mode
  (total targets ≥ 2) that rect would stack N deep and only the topmost
  would ever receive a drag, so each TransformGizmo gets a new
  `boxTranslate` prop that swaps the canvas-wide rect for the gizmo's own
  bounds polygon — click inside a box to move that layer. PrimitiveGizmo
  is already box-scoped, so it needs no changes.
- MotionPathOverlay stacks safely (pointer events only on the keyframe
  diamonds), so each gizmo keeps its motion path in multi mode.
- Undo coalescing is already per node (`gizmo:<id>`), so drags on
  different gizmos stay separate undo entries.

## Unchanged / out of scope

- **Spline Draw** stays single-selection (pen overlay keyed off
  `selectedId`) — deferred, the multi-subpath editor is a bigger lift.
- Gradient, Paint, Segment-dots overlays stay single-selection.
- ParamPanel still shows `selectedId` (ReactFlow's first selected node);
  the TransformContextBar (flip H/V) likewise stays bound to the
  `selectedId` transform node.
- No serialization, engine, or node-def changes.

## Files touched

- `TransformGizmo.tsx` — new optional `boxTranslate` prop.
- `EffectsApp.tsx` — derive the two selected-gizmo lists; map the two
  gizmo render blocks over them (bodies otherwise unchanged).
