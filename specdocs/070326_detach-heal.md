# Detach-heal: reconnect neighbors when a node leaves the chain

Devlist #166: "In the node editor when i drag a node away, it doesn't
maintain the connection / relink the adjoining nodes — can we fix that?"

## Behavior

Detaching a node that sits **cleanly inline** — one incoming edge from an
upstream node A, one outgoing edge to a downstream node C — now heals the
chain by reconnecting **A→C** as the node pops out, instead of leaving
both neighbors dangling. This is the exact inverse of the existing
auto-splice-in (drop a fresh node on a wire → A→N→C).

- **Trigger:** the existing detach gesture — **Cmd/Ctrl + drag** a node,
  and the node's right-click **Detach** menu item. Plain drag still just
  moves the node with its wires attached (unchanged); we deliberately did
  **not** auto-sever on ordinary drags.
- **Scope — clean inline only.** Heals only when the node has exactly one
  incoming and exactly one outgoing edge **and** A's output type can
  coerce straight into C's input socket (`canCoerce`, the same check
  `isValidConnection` / splice use). Branches, multi-input nodes, and
  type-incompatible A→C pairs just detach with dangling ends — we don't
  guess an ambiguous rewire.
- Works uniformly for effect-node chains and mid-stack **root layers**:
  a middle layer's `A.out:primary → C.in:stack` bridge is exactly the
  shape `reorderLayers` maintains, so no special layer path is needed.

## Implementation

Mirrors the splice split of responsibility: NodeEditor resolves the
handles + type-compat, EffectsApp applies the edge surgery.

- `NodeEditor.findDetachBridge(nodeId)` — returns
  `{ source, sourceHandle, target, targetHandle }` for a clean-inline
  node, else `null`. Sibling of `findSpliceCandidate`.
- `onDetachNode(nodeId, bridge?)` — prop signature gained the optional
  `bridge`. Both call sites (Cmd/Ctrl+drag in `onNodeDragStart`, the
  context-menu Detach item) pass `findDetachBridge(id)`.
- `EffectsApp.handleDetachNode(nodeId, bridge?)` — strips every edge on
  the node (as before), then, when a bridge is given, appends the healed
  A→C edge. An `occupied` guard skips the add if C's target socket
  already holds a wire (protects the Alt+Cmd duplicate-on-drag combo,
  where the clone already took `clone→C`). One undo entry via `pushGraph`.

Undo-safe (edges live in history). No schema/serialization impact —
purely an editor interaction.
