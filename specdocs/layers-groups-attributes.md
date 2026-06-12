# Layers, Node Groups & Attributes — Spec

Status: agreed design, ready to build (2026-06-10)
Builds on: devlist items 133 / 138

## Summary

Three stacked features that together give the app an After Effects-style layer
workflow without giving up the single-graph model:

1. **Node groups** — collapse any selection into a reusable subgraph with a
   defined socket interface, dive in/out with Tab, breadcrumb navigation.
2. **Layers** — the root graph becomes a strict linear chain of *layer nodes*
   (each one a group) feeding Output. A new **Layers editor** (third dock tab)
   is the primary NLE surface. Layers have AE-style **local time**.
3. **Attributes** — Set/Get Attribute nodes form named channels so layers can
   share data. Attribute exports are exempt from layer in/out gating.

The unifying principle: **layers are not a new engine concept.** A layer is a
node group with a fixed interface and merge semantics. The Layers editor is a
lens over the root graph, not a second source of truth. Underneath, evaluation
still happens on one flat graph.

---

## 1. Node groups

### Data model

- Keep the flat `nodes` array. Add `parentId?: string` to node data and to
  `SavedNode` ([project.ts](../src/lib/project.ts)). `parentId === undefined`
  means root. Nesting is arbitrary depth via parentId chains.
- A group is a regular node (`type: "node-group"`). Its external socket
  interface is stored in its params as
  `interface: { inputs: SocketSpec[], outputs: SocketSpec[] }` and resolved via
  `resolveInputs` / `resolveAuxOutputs`, so it serializes for free.
- Interior **Group Input** / **Group Output** nodes are regular nodes living
  inside the group (parentId = group id). Group Input's *outputs* and Group
  Output's *inputs* mirror the group's interface 1:1. They are the single
  source of truth for the interface; the group node's params are kept in sync
  by the group ops module.
- **Extensible sockets** (Blender-style): Group Input/Output render one
  trailing "virtual" socket; wiring into it creates a new typed socket named
  after the source socket. Sockets can be renamed/removed in the ParamPanel
  when the boundary node is selected.

### Naming collision

The existing "Group" node ([group.ts](../src/nodes/effect/group.ts)) — which
bundles homogeneous inputs with `groupIndex` — is renamed **Collect**. The old
type string stays registered as a load alias.

### Operations

- **Cmd+G** — group selection. Boundary edges (selected ↔ unselected) become
  group sockets: incoming edges rewire to new Group Input sockets, outgoing to
  Group Output sockets. Refuse with a toast if grouping would create a cycle
  (a path selected → unselected → selected). **Disabled at root scope** —
  layers cannot be grouped, and Cmd+G never creates a layer. Grouping inside a
  group just creates a deeper level of plain-group hierarchy.
- **Cmd+Shift+G** — ungroup: dissolve the group, restore interior nodes to the
  parent scope, rewire boundary edges directly. Must ship with Cmd+G or groups
  are a one-way door.
- **Tab** — dive into the selected group. **Shift+Tab** — go up one level.
- **Duplicate** (Shift+D / paste) of a group deep-copies the interior with
  fresh node IDs, remapping interior edge refs **and** simulation `zone_id`s
  and any other node-id-keyed `ctx.state`. Without this, two copies share
  feedback state.
- Group node title is renameable (same flow as node rename today).

### Breadcrumbs

Top-left of the NodeEditor: a row of small rounded rectangles. Root crumb is
always the project name; each crumb after is a group in the current path.
Click any crumb to jump to that scope. The NodeEditor renders only nodes with
`parentId === currentGroupId` (React Flow `hidden` flag so positions persist).

### Evaluation: the flatten pass

Groups are **transparent at eval time**. A compile step `flattenGraph(nodes,
edges)` runs before `evaluateGraph` whenever graph structure changes (cache it
by structural fingerprint):

- For each edge `X → (group, in:k)`: rewrite to `X → (groupInputNode, in:k)`.
- For each edge `(group, out:j) → Y`: rewrite to `(groupOutputNode, out:j) → Y`.
- Group Input/Output compute as identity passthroughs; the group node itself
  never computes.

No recursive evaluation, no nested scopes. Topo sort, caching, fingerprints,
needed-set reachability, and undo (which snapshots nodes/edges — parentId
rides along) all keep working unchanged.

### Edge cases

- Undoing a group creation while *inside* that group: if `currentGroupId` no
  longer exists after undo, navigation falls back to root. Navigation state is
  not part of undo history.
- Active/inspect/preview toggles (A, A1/A2, i) on interior nodes keep working;
  the evaluator already accepts any node id from the flat array.
- The canvas always shows the final Output composite regardless of which scope
  is open; use the active toggle to preview interior nodes (current behavior).

---

## 2. Layers

### Groups vs layers

Connected but distinct: a **group** is the general nesting mechanism; a
**layer** is a root-only group with fixed properties. Layer nodes may exist
only at root scope and are created only through layer-specific actions (the
Layers editor's add-layer button, the root add-node menu) — never via Cmd+G.
Conversely, groups never convert into layers, and the add-node menu inside a
group does not offer the Layer type. Because layers are root-only, there is
exactly **one level of time offset** in the system; plain groups never touch
the clock at any depth.

### Layer node

`type: "layer"` — a group subtype with a **fixed external interface**:

- Input `stack` (image): the composite of everything below it.
- Input `audio` (optional passthrough) — audio rides the chain so Output's
  audio input needs no root-level audio nodes.
- Output: image (+ audio passthrough).
- Params: `blendMode` (the existing 29-mode enum) and `opacity` (keyframable).
  Compositing is exactly `merge(stack, interiorResult, mode, opacity)`,
  reusing BLEND_FS from [merge.ts](../src/nodes/effect/merge.ts).
- Clips (`ClipBlock[]`) on the layer node are its in/out bars.

Interior interface: Group Output has an image input ("the layer's content")
and optional audio. Group Input exposes an optional **`backdrop`** image
output — the stack below the layer — enabling backdrop effects (e.g. a glass
layer distorting what's beneath it).

### Strict root, by convention in the schema, enforced in the UI

Root scope permits only: layer nodes in a single chain, Output, Render Queue.
Enforcement lives in **UI mutation paths**, not schema validation:

- The add-node menu at root offers only Layer.
- Pasting nodes at root auto-wraps them into a new layer.
- Splice-on-drag and AI node generation are disabled/redirected at root.
- Cmd+G at root is disabled (see Groups vs layers).

A hand-mangled file still loads; the Layers editor manages the chain it finds.

### Local time (AE-style)

Layers introduce **scoped time**. For nodes inside a layer:
`localTick = globalTick − layer.inTick` (plus `sourceInTick` slip on trim).

- The local clock is a pure offset and **never stops**: defined before the
  in-point (negative ticks — keyframe eval clamps to first keyframe) and after
  the out-point. Sliding a layer slides all interior animation with it.
- Plain (non-layer) groups do **not** offset time; only layer nodes do, and
  since layers are root-only, offsets never compose — every node's local clock
  is at most one offset from the global clock.
- Implementation: the flatten pass annotates each node with its time context
  (chain of layer offsets). Keyframe evaluation and `ctx.tick/time/frame`
  reads inside `evaluateGraph` use the node's scoped tick. Cache fingerprints
  already incorporate the tick used for animation, so they stay correct as
  long as the *local* tick is what's fingerprinted.
- Outside its in/out window a layer is gated: its interior leaves the needed
  set (except attribute exports, §3) and the layer node passes `stack` through
  unchanged.

### Migration & scaffold

- `schemaVersion` bumps (v3 = parentId/groups, v4 = layers). Loading a v2/v3
  project **auto-wraps** the whole graph into "Layer 1" chained into Output.
  Done in the loader — no batch script. Saving writes the new version.
- New projects scaffold `Output + Layer 1` and open **inside** Layer 1, so a
  fresh project feels exactly like the current app.

### Layers editor (v1)

Third dock tab: **Tracks | Graph | Layers**. Layers is the default tab once
shipped. AE-style stack:

- Rows top-to-bottom = visual stacking top-first (the editor displays the
  chain reversed; the chain itself runs bottom layer → top layer → Output).
- Each row: editable name, visibility toggle (= bypass: layer passes stack
  through), blend mode dropdown, opacity scrubber, attribute-export badge
  (small tag icon when the layer contains live Set Attribute nodes).
- Bar on the shared timeline: drag to move (in/out together — this is the
  time-slide), trim either end, same razor/selection conventions as Tracks
  where they apply.
- Drag rows to reorder → rewires the root chain.
- Double-click a row → NodeEditor dives into that layer's group.
- Selecting a row selects the layer node (existing selection sync path).

**v1 explicitly excludes** twirl-down per-layer keyframe lanes (fast-follow,
§5). Tracks remains the keyframe editor. Tracks scope follows the NodeEditor's
current group scope so the two stay coherent.

---

## 3. Attributes (Set / Get Attribute)

Named channels for cross-layer data — the "one graph" semantics preserved
across the strict root.

- **Set Attribute**: polymorphic value input + `name` (string) param.
- **Get Attribute**: `name` param; output type resolves from the matching
  Set's resolved type at compile time. Unmatched Get emits the typed default.
- The flatten pass converts each matched Set/Get pair into a **real edge** in
  the flat graph. Topo sort orders producers before consumers; cycles are
  detected and surfaced as a node error.
- Get has a mode: `current frame` (default, edge-based) or `previous frame`
  (reads `ctx.state` like simulation zones — no edge, enables cross-layer
  feedback and breaks cycles deliberately).

### Gating rule

**A layer's in/out gates what it shows, not what it knows.** The needed-set
pass additionally includes the upstream subtree of any Set whose name is
consumed by a live Get — recursively, so chained data layers stay alive
end-to-end. Sets with no consumer are skipped (no cost for dead exports).

### Time rule

Attribute exchange always happens **within one global frame**; only keyframe
lookup is layer-local. A Get receives whatever the producer computed this
frame on the producer's clock. For global-clock data, host the Set in a layer
with in-point 0 (where local == global) — the organic "drivers layer" pattern,
made discoverable by the attribute badge in the Layers editor.

---

## 4. Explicitly deferred

- **Node instancing / linked duplicates** — shares *definition* not *data*;
  mid-chain instances reduce to Get Attribute; lifecycle (master deletion,
  stateful nodes across time contexts) is a minefield. The future shape is
  **linked parameters** (param/keyframe blocks shared by reference), noted as
  a designed-for extension.
- **Control/null layer type** — rejected; the in-point-0 drivers layer covers
  it with zero new concepts.
- **Precompose / nested layer chains** — wrapping several layers into one
  layer (AE precompose) would mean layer semantics below root, reintroducing
  composed time offsets. If wanted later, it becomes an explicit Layers-editor
  action ("Precompose selection"), never a Cmd+G behavior.
- **Time remap / Time Offset node** (evaluate an upstream subtree at a shifted
  tick) — would require multi-time evaluation with tick-keyed caching. Real
  feature, separate project.
- **Twirl-down keyframe lanes in the Layers editor** — fast-follow after v1.

---

## 5. Implementation plan

### Phase 0 — Prep (small, independently mergeable)

1. Rename Group node → **Collect**; keep old type string as load alias.
2. Extract a graph-ops module (`src/state/graph-ops.ts`) from
   [EffectsApp.tsx](../src/components/effects/EffectsApp.tsx) (6.4k lines) to
   host group/layer/chain mutations. New structural logic must not land in the
   monolith.

### Phase 1 — Groups (shippable alone)

1. `parentId` on node data + `SavedNode`; `schemaVersion 3` (no wrap yet).
2. `node-group` def + Group Input/Output defs with extensible sockets;
   interface sync in graph-ops.
3. `flattenGraph` compile pass in [evaluator.ts](../src/engine/evaluator.ts)
   (+ structural-fingerprint cache); evaluator consumes flattened graph.
4. Cmd+G (with cycle refusal) / Cmd+Shift+G ungroup, in
   [NodeEditor.tsx](../src/components/effects/NodeEditor.tsx) key handling →
   graph-ops. (Cmd+G works everywhere in Phase 1; the root-scope restriction
   arrives with layers in Phase 2.)
5. Scope-filtered rendering (`currentGroupId`), Tab / Shift+Tab, breadcrumb
   component (top-left, rounded rects, root = project name).
6. Duplicate/paste deep-copy with ID + zone-id remap.
7. Undo edge case: stale `currentGroupId` → root.

Exit criteria: group/ungroup/dive round-trips losslessly; a grouped graph
renders identically to its ungrouped form; duplicated groups simulate
independently; save/load round-trips v3.

### Phase 2 — Layer node & strict root

1. `layer` node def (stack/audio interface, blendMode + opacity via BLEND_FS,
   backdrop output, clips).
2. Scoped time in the evaluator: per-node time context from flatten pass;
   keyframe eval + ctx reads use local tick; verify fingerprint correctness.
3. Layer gating (passthrough outside window) wired into needed-set.
4. Root-scope UI enforcement (add menu, paste-wrap, splice/AI guards,
   Cmd+G disabled at root, Layer type unavailable inside groups).
5. `schemaVersion 4` + v2/v3 auto-wrap migration; new-project scaffold
   (Output + Layer 1, open inside layer).

Exit criteria: legacy projects load pixel-identical as 1-layer projects; a
layer slid in time slides its interior animation; trim/out gating correct.

### Phase 3 — Layers editor

1. New dock tab in EffectsApp (`dockTab: "tracks" | "graph" | "layers"`).
2. Layer rows (name, visibility/bypass, blend, opacity, badge), bar
   move/trim on the shared timeline, drag-reorder → chain rewire, double-click
   dive, selection sync.
3. Tracks editor scope follows current group.

Exit criteria: full NLE loop (add layer, sequence, blend, reorder, dive,
edit, return) without touching the root node graph.

### Phase 4 — Attributes

1. Set/Get Attribute node defs (polymorphic in, compile-time-typed out).
2. Flatten pass: pair matching, virtual edges, cycle detection, previous-frame
   mode via `ctx.state`.
3. Needed-set exemption ("shows vs knows" rule) incl. recursive chains.
4. Layers-editor badge; name autocomplete in the Get/Set name field.

Exit criteria: a drivers layer at in-point 0 modulates two time-offset layers
in sync; a clipped-out layer keeps exporting; cycle produces a clear error.

### Risks

- **Scoped time × fingerprint cache** is the subtlest engine change (Phase 2
  step 2); budget for a correctness pass with cache deliberately disabled as
  the oracle.
- **EffectsApp growth** — mitigated by Phase 0.2; hold the line in review.
- **Shortcut conflicts** — Tab/Shift+Tab must respect `shortcut-scope.ts` so
  they don't fire while text inputs or other panes have focus.
- **React Flow hidden nodes at scale** — verify perf with a few hundred hidden
  nodes; fall back to array filtering if `hidden` flag churns.
