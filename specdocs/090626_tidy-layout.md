# Tidy, Align, Distribute — wire-aware node layout (2026-09-06)

Owner ask: MCP-built graphs come out either as one horizontal strip
(`insert_recipe` lays the interior at `y = 0, x += 260`) or as a pile at
the origin (`edit_group add_node` mints every node at `(0,0)`), and fast
hand-building gets messy. Wanted: select nodes → right-click → **Tidy**
and have them lerp into a readable layout that follows the wires, not a
grid. Ship **Align** / **Distribute** alongside.

Decisions (owner, 2026-09-06):

- Tidy **ignores unselected nodes** — the selection is laid out as if it
  were alone, then re-anchored on its old bounding-box centre. Unselected
  nodes are neither obstacles nor anchors.
- The main chain (spine) sits at the **vertical middle**; side chains hang
  above and below.
- Column / row gaps are constants to tune later (`COLUMN_GAP = 72`,
  `ROW_GAP = 24` in node-layout.ts).
- Align + Distribute ship in the same menu.

## What "tidy" means here

The editor is a strict left→right flow (inputs on the left handle side,
outputs on the right, bezier wires), so this is a layered-DAG layout with
the rules that make it read as hand-drawn:

1. **Columns from the wires.** Longest-path rank from sources; then every
   unit that is not a pinned boundary is pulled right to the column just
   before its first consumer (a Noise feeding a far-downstream Displace
   tucks beside the Displace instead of dangling at the far left).
2. **Straight wires beat short wires.** Vertical placement aligns a
   producer's output handle with the input handle it feeds, using the real
   handle offsets (React Flow `internals.handleBounds`), so the wire is a
   horizontal line whenever nothing collides. Spine edges (longest path
   into the sink) carry extra weight so the main chain stays straight and
   secondary inputs bend instead.
3. **Fan-in order follows socket order.** Producers of a multi-input node
   are placed in the order of the rows they feed (Layer 1 above Layer 2).
4. **Sources right-align, everything else left-aligns** within a column, so
   source outputs line up and satellites hug their consumer.
5. **Containers are compound units.** An inline zone (Iterate / Repeat /
   For Each: shell + Input + members, recursively) and a frame's members
   are laid out first as their own layered graph, then the resulting box
   (plus the zone/frame padding) is one big unit in the outer layout. The
   zone Input pins the first column of its zone and the shell the last.
   Frame and zone rects follow automatically — both already hug their
   members (`computeFrameRects`, `computeIterateZoneRects`).
6. **Boundary pillars pin.** Group Input / zone Input → first column;
   Group Output / Output / zone shell → last column.
7. **Reroutes** are pass-through for ranking and are re-placed in the
   column gap on their source's output row. Tidy never adds or removes
   them.
8. **Idempotent and stable.** Column order is seeded from current `y`, so a
   tidy graph tidies to itself (gate: second run moves nothing) and a
   small edit gives a small change — the agent can tidy after every batch.

## Where the code lives

- `src/state/node-layout.ts` — PURE. `tidyLayout`, `alignLayout`,
  `distributeLayout`, `placeNewNodes`, `estimateNodeBox`. Input is a
  reduced `LayoutNode` (box, kind, parentId/frameId, port offsets) +
  `LayoutEdge`; output is `Map<id, {x, y}>` for the nodes that move.
  Guarded by `scripts/check-node-layout.mts` (in `npm run check`).
- `src/components/effects/node-layout-adapter.ts` — xyflow → LayoutNode.
  Takes an optional handle-offset getter (NodeEditor passes React Flow's
  internal handle bounds; EffectsApp/MCP fall back to the row-geometry
  estimate for nodes that have never been measured).
- NodeEditor — right-click **Tidy** (selection if the clicked node is
  selected, otherwise the clicked node's connected neighbourhood), the
  align / distribute strip, **L** (tidy selection; whole scope when
  nothing is selected), pane right-click → **Tidy All**. Owns the lerp:
  one rAF loop (320 ms, ease-out cubic) emitting `position` changes with
  `dragging: true`, then a `dragging: false` flush — so EffectsApp's
  existing drag-history path yields ONE undo entry for free. A user drag
  or a new tidy request cancels an in-flight animation at its current
  frame.
- MCP — `tidy {nodes?, scope?}` tool (mutates). Visible scope → the same
  animated path via the `node-editor-tidy` event; hidden scope → immediate
  placement with estimated boxes. `insert_recipe` tidies a new group's
  interior at build time; `edit_group add_node` places each new node with
  `placeNewNodes` (beside its first consumer, aligned to the row it feeds,
  dropping down the column past occupied slots) and never moves existing
  nodes.

## Milestones

- **M1** pure module + gate — DONE with this doc.
- **M2** editor wiring (menu, strip, L, lerp, pane menu) — DONE.
- **M3** MCP `tidy` tool + insertion placement — DONE.
- **M4** docs (shortcuts page, TESTING.md, devguide) — DONE.
- Later: per-user gap preferences; "straighten wire" on a single edge;
  optional reroute insertion for long fan-outs.
