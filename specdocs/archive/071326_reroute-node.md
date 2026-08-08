# Reroute node (devlist #180)

Snapshot 2026-07-13. Replaces the edge-metadata "junction/waypoint" with a
first-class **reroute node** — rendered as a minimal dot, but a real node in
the model so it inherits select / copy-paste / delete / input-swap for free.

## Problem (what's glitchy today)

"The reroute function" is today's **junction waypoint** — pure edge metadata,
not a node:

- Shift-drag across ≥2 wires that share a source stamps
  `data.waypoint = [flowX, flowY]` on each crossed edge
  ([WireActionOverlay.tsx](../../src/components/effects/WireActionOverlay.tsx) →
  `handleCombineWires` in EffectsApp).
- [JunctionEdge.tsx](../../src/components/effects/JunctionEdge.tsx) draws a shared
  trunk + a stacked dot; dragging the dot moves the whole cluster.

Because the dot is **not an object**, the three asks in devlist #180 are
impossible or broken:

1. **"Deleting should remove all wires."** Nothing to select; you'd have to
   marquee the individual edges. Delete one edge of a cluster and the rest keep
   a dangling dot.
2. **"Connect a new wire on the left, switch the input."** A waypoint has no
   input handle — its "input" is just the shared source.
3. **"Select the reroute itself and copy/paste/delete it."** No node exists.

Plus: `SavedEdge` doesn't serialize `data`
([project.ts](../../src/lib/project.ts)) — **waypoints vanish on save**. Junctions
never survived a reload.

## Decision (design Q&A)

- **Model:** a real node, rendered as a dot ("dot in the UI, node in the
  background"). All three asks fall out of existing node machinery.
- **Creation:** repurpose the Shift-drag-across-wires gesture to drop a reroute
  node on the crossed wire(s); also double-click a wire to insert one inline.

## Model

A reroute is a normal `Node<NodeDataPayload>` with `defType: "reroute"`:

- One input socket `value` (Left handle, `in:value`), one output
  (`out:primary`, Right handle). No params.
- **Polymorphic / wildcard.** Its input accepts any source type; its output
  type mirrors whatever is wired in (added to `CONNECTED_TYPE_RETYPE_NODES`,
  like Transform/Displace — its `data.primaryOutput` is recomputed from
  `connectedTypes` by the dedicated retype `useEffect` in EffectsApp).
- **Dissolved at flatten time** (editor-only topology). The evaluator never
  sees a reroute: `flattenGraph` splices `S → R → {T…}` down to direct
  `S → {T…}` edges, exactly like a group boundary. So evaluation, coercion,
  caching, and texture ownership are **byte-identical to today's direct
  wires** — a reroute costs nothing at render time and needs no passthrough
  compute in the hot path.

Why dissolve instead of a passthrough `compute`? A passthrough would need
`ownsTextures:false` bookkeeping, a cache entry, and per-socket-type coercion
for every value kind (image/spline/points/scalar/sdf/particles/…). Dissolution
sidesteps all of it and matches the junction's original "just visual" spirit —
now with a real, selectable object.

### xyflow rendering (the dot)

- New xyflow node type `"reroute"` → `RerouteNode.tsx` (a ~12px dot with a Left
  target handle + Right source handle, selection ring, colored by the socket
  type flowing through it via `socketColor`). Registered in NodeEditor's
  `nodeTypes` alongside `effect: EffectNode`.
- `makeInstanceNode` sets the xyflow `type` to `"reroute"` for the reroute
  defType (all other nodes stay `"effect"`).

## How each ask is satisfied

1. **Delete removes all wires** — plain node delete already strips every
   incident edge (`onNodesChangeWithHistory` cascade). No chain-heal (unlike
   layers): deleting a reroute kills `S→R` and every `R→T`, exactly as asked.
   (Cmd/Ctrl-drag-out detach-heal can optionally reconnect `S→T` as a bonus,
   reusing the existing detach bridge — nice-to-have, not required.)
2. **Connect a new wire on the left → swap input** — `in:value` is a
   single-input socket; `onConnect` already **replaces** an occupied target
   handle ("onConnect replaces an occupied target," NodeEditor). Dropping a new
   source on the reroute swaps the input for free.
3. **Select / copy / paste / delete** — the reroute is a selectable node;
   `handleCopyNodes`/`insertClonedFragment`/`cloneSubgraph` already carry
   arbitrary nodes + their internal edges. And it now **persists** (nodes
   serialize; edges dissolve at eval only, not on disk).

## Creation gestures

- **Shift-drag across wires** (repurposed). On release, group crossed edges by
  `(source, sourceHandle)`. For each group: create one reroute `R` at the
  crossing point, add `S → R`, and re-point every crossed `S → Tᵢ` to
  `R → Tᵢ`. A fan-out collapses through one reroute; a single crossed wire
  gives `S → R → T`. Multiple source groups → one reroute each (offset so they
  don't stack). One undo entry.
- **Double-click a wire** → insert a single reroute at the click point,
  splicing `S → R → T` (mirrors the node-splice path, handles fixed to
  `in:value` / `out:primary`).

The Shift-drag cyan combine line stays as the affordance; only its *result*
changes (reroute node instead of waypoint metadata).

## Files

Engine (self-contained — invariant #1):
- `src/nodes/utility/reroute.ts` — the def. `hidden: true` (created via
  gesture, not the catalog). Defensive passthrough `compute` returning
  `inputs.value` verbatim with `ownsTextures:false`, in case it ever survives
  flatten; normal path never calls it.
- `src/nodes/index.ts` — register it.
- `REROUTE_TYPE = "reroute"` constant engine-side (graph-helpers.ts).
- `src/engine/flatten.ts` — dissolve reroutes: add to the `hasStructure`
  gate + an `isDissolved(type)` helper (structural ∪ reroute), a reroute case
  in `resolveBoundarySource` (source `out:primary` → the edge into
  `(R,"value")`), `sourceNeedsResolve`, the outNodes filter, and the
  "edge into a dissolved node is consumed" drop. Chains/​fan-outs collapse via
  the existing iteration.
- `src/engine/graph-validation.ts` — `editorCanCoerce`: a `reroute` target
  input accepts any src; a reroute source is permissive when still untyped.

Editor:
- `src/components/effects/RerouteNode.tsx` — the dot.
- `NodeEditor.tsx` — `nodeTypes`; `resolveSource/TargetSocketType` +
  `isValidConnection` reroute wildcard; double-click-wire insert.
- `EffectsApp.tsx` — `"reroute"` into `CONNECTED_TYPE_RETYPE_NODES` and its
  retype `useEffect`; repurpose `handleCombineWires` → reroute creation +
  rewire; retire waypoint drag handlers.
- `graph-ops.ts` — `makeInstanceNode` xyflow `type`; a `createReroute` /
  rewire helper (structural edits live here, invariant #5).
- Retire the waypoint branch of `JunctionEdge` (keep its base bezier — it's the
  default edge renderer) and the combine path of `WireActionOverlay`.

Docs:
- KeyboardShortcuts.tsx / EditorBasics.tsx currently say "Shift+drag a wire —
  Merge two wires at a junction." → "…drop a reroute on the wires."
- Update the devguide's NodeEditor + flatten notes.

No schema bump (reroute serializes via the normal node path; keep the
`"reroute"` type string forever — invariant #2). No saved-data migration
(junction waypoints were never persisted).

## Milestones

- **M1 — Foundation.** DONE. reroute def
  ([reroute.ts](../../src/nodes/effect/reroute.ts)) + registration +
  `REROUTE_TYPE`; flatten dissolution ([flatten.ts](../../src/engine/flatten.ts));
  validation wildcard ([graph-validation.ts](../../src/engine/graph-validation.ts));
  `CONNECTED_TYPE_RETYPE_NODES` + retype wiring. Verified: passthrough /
  fan-out / chain / unwired all dissolve correctly (pure-function test);
  typecheck + `npm run check` green.
- **M2 — Dot UI.** DONE. [RerouteNode.tsx](../../src/components/effects/RerouteNode.tsx)
  (edge handles + selectable centre gap so the dot is both clickable and
  wireable), `nodeTypes`, `makeInstanceNode` + deserialize xyflow type,
  type-colored dot (neutral when empty), selection ring.
- **M3 — Creation gestures.** DONE. Repurposed Shift-drag
  (`insertReroutesOnEdges` in graph-ops — group-by-source rewire, any count,
  no ≥2 rule) + double-click-a-wire insert; retired the waypoint/junction
  combine + drag code (JunctionEdge slimmed to a splice-highlight edge,
  waypoint-context tombstoned). Delete-removes-all / input-swap / copy-paste /
  select all inherited from node machinery.
- **M4 — Polish + docs.** DONE. Preview remap (selecting/Active-ing a reroute
  previews its source, not black — `resolvePreviewProducer`); in-app docs
  (KeyboardShortcuts, EditorBasics) + devguide updated; lint ratchet clean.
  Remaining nice-to-have: detach-heal passthrough (Cmd-drag a reroute out →
  reconnect S→T) — deferred, not required by #180.

## Verification status

Automated: typecheck, `npm run check`, lint ratchet (no new errors), flatten
dissolution unit-check, and dev-server compile (editor route serves 200, no
errors) all pass. Interactive gestures (dot select/drag, Shift-drag create,
double-click insert, delete-removes-wires, left-drop input swap, copy/paste)
are best verified by eye in the running editor.

## Open questions / risks

- **Untyped reroute → target validation.** Before anything feeds a reroute, its
  output type is unknown. Shift-drag/double-click always wire from a real
  source (type known immediately), so the common path is fine; manual
  "reroute→target first" is permissive and, worst case, dissolves to a coerced
  direct edge (evaluator coerces per target; incompatible ⇒ empty, never a
  crash). Acceptable; documented.
- **Preview.** A dissolved reroute can't be set Active — but previewing a
  reroute = previewing its source, already one click away. No loss worth the
  passthrough-compute cost.
- **Handle vs. body hit-testing.** The dot must stay click-selectable while its
  two handles remain grabbable for wiring (M2 detail).
