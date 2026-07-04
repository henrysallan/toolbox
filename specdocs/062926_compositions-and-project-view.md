# Compositions & the Project view (spec, 2026-06-29)

Devlist origin: **#163** ("address a motion brief that needs various exports of
the same content") and the note below it. Read the current hierarchy in
[061226_devguide.md](061226_devguide.md) §"Groups & layers" and
[layers-groups-attributes.md](layers-groups-attributes.md) first.

## Goal

Insert two levels above the existing layer graph so one file can hold several
independently-renderable variants of the same work:

```
Project  (.toolbox file / Supabase row)   ← NEW: gets a file-browser "Project view"
  └─ Composition  (renamed today's root)  ← NEW level; a project holds many; the export unit
       └─ Layer    (today's root layer chain, unchanged — now scoped under a comp)
            └─ Nodes (the layer's nodegraph, unchanged)
```

This is After Effects' Project → Composition → Layer model, with the toolbox
twist that each layer is itself a nodegraph. A fresh project boots with **1
composition → 1 layer → default nodes** (today's default, wrapped in a comp).

## Decisions (locked with owner, 2026-06-29)

1. **Precomps: flat now, design for later.** Compositions ship independent (you
   cannot yet drop one inside another). But the schema + scoping must give each
   composition a stable identity and a self-contained subgraph so a future
   `composition` reference node (precomp) inlines like a group dissolves — **no
   migration required to add it later**.
2. **Per-composition = the export unit.** Render resolution, fps, duration/loop,
   and the Output/render chain move from **project-global** onto each
   **composition**. One project → several independent renderables. This is what
   makes #163 work.
3. **Navigation via the top breadcrumb crumb.** The breadcrumb grows to
   `Project ▸ Composition ▸ Layer ▸ (group…)`. Clicking **Project** swaps the
   node editor out for the file-browser panel.
4. **Project-view preview = last-active composition.** Opening the browser does
   not blank the viewport; preview/timeline keep rendering the comp you were
   last in (`activeCompositionId` persists; the browser is a view swap, not a
   scope change).
5. **A very thin comp tab bar** sits at the top of the node-editor panel for
   fast switching between compositions. Only **open** comps appear, each with an
   `x` to close (close = remove from the bar, never delete the comp). The bar is
   two-finger scrollable on overflow.
6. **Render at any level of the tree** (ties in devlist **#159**). An *output
   node is a renderable terminal scoped to its subtree*, and there's one at each
   level:
   - **Composition Output** — the comp root's terminal (today's `Output` node,
     contextually renamed). Renders the whole composition.
   - **Layer Output** — the layer's interior terminal (today's `group-output`
     boundary node, renamed from "Group Output" and given the full render UI).
     Renders just that layer's interior, so you can export from inside a layer
     without going up to the comp root.

   **Resolution / ratio / fps / loop are still set per composition.** Layer
   Outputs **inherit their parent composition's** settings (no own scene). Plain
   *groups* keep an inert "Group Output" (no render UI) — only **layers** get the
   render-capable Layer Output.

## Current model (what we're extending)

From [project.ts](../src/lib/project.ts) and the scope/nav code (grounded):

- `SavedProject = { schemaVersion: 4, nodes: SavedNode[], edges: SavedEdge[],
  scene?: SavedScene }`. **Flat** node array; group/layer nesting is by optional
  `parentId` ([graph.ts](../src/state/graph.ts) `NodeDataPayload.parentId`,
  `undefined` = root). `scene = { loopFrames, fps, width, height }` is
  **project-global**.
- **Root scope** is a strict chain of `defType:"layer"` nodes (`!parentId`)
  feeding Output; `getLayerChain()` ([graph-ops.ts](../src/state/graph-ops.ts))
  walks Output's `in:image` down through layers' `in:stack`. Root only permits
  Layer / Output / Render Queue nodes.
- **Editor scope** is a single `currentGroupId: string | undefined`
  (`undefined` = root) in EffectsApp; Tab dives, Shift+Tab ascends, breadcrumb
  jumps. `defaultScopeFor()` opens single-layer projects inside the layer.
- **Breadcrumb** = `[{ id: null, name: currentProject?.name ?? "Untitled" },
  ...chain]` — root crumb is the project name.
- **LayersEditor** is a *lens over the same root node graph*, not separate data.
- **`.toolbox`** zip = manifest.json (name, scene, asset list) + project.json
  (`SavedProject`) + thumbnail.jpg + content-hashed assets/. Supabase stores the
  same `project.json` in a `projects` row.

## Data model (schema v5)

Chosen approach: **keep the single flat `nodes[]`/`edges[]` array** and **tag
each node with a `compositionId`**, plus a small composition registry on the
project. This is the smallest diff that preserves the existing flat-array +
`parentId` machinery, undo/redo snapshots, and serialization — and it mirrors
how scope already works (filter the flat array by a scope key).

> Alternative considered: `compositions: Composition[]` each owning its own
> `nodes`/`edges`. Cleaner isolation, but it forces every reader/writer of the
> single `nodes`/`edges` pair (EffectsApp state, history, every graph-op
> signature) through an active-composition indirection — a much larger, riskier
> diff. Rejected for v1; the tagged-flat-array model can be refactored into it
> later if needed.

### Shapes

- `NodeDataPayload` / `SavedNode` gain `compositionId: string`. A composition's
  **root** nodes are `compositionId === C && !parentId`; interior nodes inherit
  their owner's `compositionId` (a layer and its `parentId` children share it).
  Edges need **no** tag — endpoints are globally-unique node ids, so an edge
  belongs to whichever comp its nodes are in.
- New `SavedComposition = { id: string; name: string; scene: SavedScene }` and
  `SavedProject` becomes:
  ```ts
  interface SavedProject {
    schemaVersion: 5;
    compositions: SavedComposition[];   // ordered; [0] is the default
    activeCompositionId: string;        // last-edited comp (restores on load)
    nodes: SavedNode[];                 // flat, every node carries compositionId
    edges: SavedEdge[];
    // `scene` removed from the top level (now per-composition). v4 loader maps it in.
  }
  ```
- `scene` (resolution/fps/loop/duration) is now **per composition**, stored on
  `SavedComposition.scene`. The project no longer has a global scene.

### Migration (v4 → v5), and keep loading ≤v4 forever

Mirror the v4 "auto-wrap into Layer 1" precedent (invariant #2):

1. Mint one composition `C1 = { id, name: "Composition 1", scene: <old project
   scene, or current defaults> }`.
2. Tag **every** loaded node with `compositionId: C1.id`.
3. `compositions = [C1]`, `activeCompositionId = C1.id`.

A migrated single-comp project renders pixel-identically and behaves exactly as
today. ≤v4 and ≤v3 (no `parentId`) and ≤v2 (no `scene`) loaders stay intact.

## State & navigation (EffectsApp)

New state alongside the existing `currentGroupId`:

- `activeCompositionId: string` — which comp the editor/preview/timeline target.
  `currentGroupId` continues to scope **within** the active comp.
- `view: "editor" | "project"` — when `"project"`, the file-browser panel
  *replaces* the node-editor canvas (preview/timeline keep rendering the active
  comp — decision 4).
- `openCompositionIds: string[]` (ordered) — drives the thin tab bar.

Navigation wiring:

- **Breadcrumb** prepends two crumbs:
  `Project ▸ <Composition name> ▸ <existing chain>`. Clicking **Project** sets
  `view:"project"`. Clicking the **Composition** crumb opens a quick comp
  switcher (or just re-enters the comp root). The old project-name root crumb is
  replaced by these two.
- **Comp tab bar** — a *very thin* strip at the top of the node-editor panel
  (decision 5). Open comps render as tabs; active highlighted; click to switch
  (`activeCompositionId = …`, `view:"editor"`); a `+` mints a new comp;
  double-clicking a comp in the browser opens its tab and enters it. Closing a
  tab removes it from `openCompositionIds` only (never deletes the comp).
- **Entering/leaving the browser**: Project crumb (or a persistent affordance on
  the tab bar) toggles `view`. Entering a comp from the browser sets `view`,
  `activeCompositionId`, and a sensible `currentGroupId` via the existing
  `defaultScopeFor()` (scoped to that comp).

Switching `activeCompositionId` **swaps scene settings**: write the outgoing
comp's scene (it's edited in place in the registry as the user changes res/fps),
then load the incoming comp's scene → resize the engine canvas, set
fps/loopFrames, clamp the playhead. EffectsApp's scene state becomes a synced
view of `compositions[active].scene` (registry is source of truth).

## Evaluation & engine scoping (keep the engine agnostic)

The engine stays composition-unaware (invariant #1). All composition logic is
structural and lives editor-side:

- Before `evaluateGraph`, resolve the target comp to a **node/edge subset**:
  today simply `nodes.filter(n => n.compositionId === target)` + edges between
  them. The engine receives a normal node set and runs flatten → toposort →
  needed-set exactly as now. Each comp has its own Output/terminal, so
  `computeNeededSet` already stays inside the comp.
- This resolve step is the **precomp seam**: later, a `composition` reference
  node expands into its referenced comp's subset here (with cycle detection),
  the way groups dissolve in flatten. Designing the resolve as
  `resolveComposition(compId, nodes, edges) → { nodes, edges }` now means the
  precomp node slots in without touching call sites.

Root-scope queries get a composition filter (mechanical):
`getLayerChain`, `defaultScopeFor`, the root add-node menu (Layer/Output/Render
Queue only), paste-auto-wrap, and Cmd+G-disabled-at-root all key off
"root **of the active comp**" = `compositionId === active && !parentId`.

## Per-composition settings & outputs at every level

**Settings are per composition.** Each comp owns resolution/ratio/fps/
duration/loop on `compositions[active].scene`; the controls that are
project-global today now edit the active comp's scene. Nothing below the
composition carries its own scene — **Layer Outputs inherit the parent comp's
settings**.

**Outputs are renderable terminals, and there's one at each level** (decision 6
/ #159). Unify the existing Output node and the layer boundary node under one
idea — *evaluate the subgraph terminating at output node X, at composition C's
scene settings, and export*:

- **Composition Output** = today's `Output` node at the comp root (strict layer
  chain → Output). Keep the `output` **type string** (invariant #2); just
  display "Composition Output" in the comp scope. Renders the whole comp.
- **Layer Output** = the layer's interior `group-output` boundary node. When its
  `parentId` resolves to a `defType:"layer"` node, render it as **"Layer
  Output"** (and its partner as **"Layer Input"**) and surface the **full Output
  render UI** on it — `exportMode` (video / sequence / gif), the video tiers,
  `startFrame`/`endFrame`, ProRes/alpha, etc. (reuse Output's `ParamDef`s and
  the EffectsApp export entry points verbatim). It keeps its existing job too —
  feeding the layer's content up the blend stack — so render params are purely
  additive. A `group-output` whose parent is a *plain group* stays inert "Group
  Output" (no render UI); groups dissolve at eval.

**The render target is the output node you're at / have selected.** Triggering a
render resolves: which output node → its subtree → its composition → that comp's
scene settings → export. A Layer Output renders the layer's interior; a
Composition Output renders the comp. Both use the comp's resolution/fps/loop.

**Export across comps** (Render Queue enumerating Composition Outputs of several
comps = "render all variants" for #163) is the natural batch path — *stretch
goal*, not v1. v1 Render Queue still batches outputs within the active comp.

> Bundled cosmetic from #159: layer nodes (Layer node + Layer Input/Output)
> tinted blue to distinguish layer scope from group scope. Secondary; can land
> with the rename.

## Project view (file-browser panel)

Replaces the node editor when `view:"project"`. v1 affordances:

- Grid/list of compositions: per-comp **thumbnail**, name, and a settings line
  (e.g. `1920×1080 · 30fps · 5s`).
- **Create / rename / delete / duplicate / reorder** compositions. Duplicate
  deep-copies the comp's tagged nodes/edges with fresh ids under a new
  `compositionId` (reuse graph-ops clone helpers). **No delete guard** — deleting
  the active comp just drops the user into the Project view; a project may hold
  **zero** comps (empty browser with a `+` to create one).
- **Double-click → enter** (opens a tab + node editor). Single-click =
  select/preview.
- Structured as a tree from the start (even though it's one flat level today),
  so precomp nesting and folders drop in later without a rewrite.

All composition CRUD goes in [graph-ops.ts](../src/state/graph-ops.ts) as pure
functions (invariant #5); EffectsApp applies results and snapshots undo.

## Persistence

- **`.toolbox`**: manifest.json gains a `compositions` summary (id, name, scene,
  thumbnail ref) for fast browser listing + per-comp thumbnails
  (`assets/thumb-<compId>.jpg` or `thumbnails/<compId>.jpg`); project.json holds
  the authoritative registry + tagged nodes. The single top-level thumbnail.jpg
  stays as the project poster (active/first comp).
- **Supabase**: unchanged DB schema — a `projects` row still stores one
  multi-comp `project.json`. Project poster = active/first comp thumbnail.

## Invariants touched (and respected)

- **#1 engine self-containment** — engine never learns about compositions;
  resolve-to-subset happens editor-side. ✔
- **#2 back-compat** — schema v5 with a v4→v5 auto-wrap; never repurpose
  `compositionId`/handles; keep ≤v4 loaders. ✔
- **#5 structural edits in graph-ops.ts** — composition CRUD = pure functions. ✔
- Per-comp scene means the timeline/canvas resize on comp switch — verify clip
  windows / keyframes (tick-based, exact) survive the fps/loop swap.

## Milestones

1. **Data model + migration.** ✅ **DONE (2026-06-29).** `compositionId` on
   `NodeDataPayload` + `SavedNode` ([graph.ts](../src/state/graph.ts),
   [project.ts](../src/lib/project.ts)); `newCompositionId()` helper;
   `SavedComposition` + `compositions`/`activeCompositionId` on `SavedProject`;
   schema bumped to **v5**. `serializeGraph` writes the registry and tags every
   node (self-healing the comp id from existing node tags so a v5 round-trip is
   stable even before the editor manages the registry); `deserializeGraph` reads
   v5 and synthesizes a single **"Composition 1"** from the project scene for any
   save without a `compositions` field (≤v4, graph-only fragments) — tagging all
   nodes (incl. autoWrap boundary nodes) into it. Top-level `scene` retained as a
   **compat mirror** of the active comp's scene, so the `.toolbox` manifest, live
   viewer, and export template need no change. `tsc` + `eslint` clean; no
   EffectsApp behavior change — single-comp projects round-trip and render
   identically to today.
2. **Composition registry foundation.** ✅ **DONE (2026-06-29).** EffectsApp now
   holds `compositions` + `activeCompositionId` (state + refs), initialized from
   `buildStarterGraph` (which mints + tags a comp id and returns it) or the
   rehydrate/load. Threaded through all three save sites (registry handed to
   `serializeGraph` via `opts`, active comp's scene materialized from the live
   loop/fps/resolution by `compositionsForSave`), all three load sites (registry
   read from `deserializeGraph`), `resetToFreshProject` (fresh comp), and the
   `editor-session` docs-round-trip snapshot. graph-ops gained
   `belongsToComposition` (defensive: untagged **or** matching), `resolveComposition`
   (the eval/precomp seam, unused yet), and optional `activeCompositionId` on
   `getLayerChain` + `defaultScopeFor`; the editor wires the active comp into both
   layer-chain call sites and the post-load `defaultScopeFor`. Cross-project
   fragment pastes are **re-tagged** onto the active comp in `insertClonedFragment`.
   `tsc` clean; no new lint problems. **Perfect no-op for the single composition
   that exists today** — the defensive predicate means an untagged or
   active-tagged node always passes, so single-comp can't blank.

   *Deferred to M3 (only observable once switching exists):* the eval hot-path
   `resolveComposition` filter + active-node resolution scoped to the active comp;
   tightening the membership predicate from defensive to strict; create / switch /
   delete composition operations + per-comp scene **swap on switch**; tagging the
   lazy-init `currentGroupId` `defaultScopeFor` (line ~919) and node-creation
   paths at the moment switching can move you off the active comp.
3. **Composition tab bar + switching.** ✅ **DONE (2026-06-29).** New
   [CompositionTabBar](../src/components/effects/CompositionTabBar.tsx) at the top
   of the node-editor panel: open comps as tabs, active highlighted, `x` to close
   (close ≠ delete; last tab can't close until the Project view exists), `+` to
   create, horizontally scrollable on overflow. graph-ops gained
   `createComposition` + `buildEmptyComposition` (Output + one empty "Layer 1",
   tagged) + `nextCompositionName`. EffectsApp got `openCompositionIds` state and
   `handleCreateComposition` / `handleSwitchComposition` / `handleCloseComposition`.
   **Switching** commits the outgoing comp's still-untagged nodes (a tag-on-switch
   sweep, so nothing leaks across comps via the defensive predicate) + its live
   scene, activates the target, loads its scene, re-scopes via `defaultScopeFor`,
   and **clamps the playhead** into the incoming loop. The comp filter is now
   **active**: `scopedNodes` (node-editor view) and `renderFrame`'s
   `resolveComposition` both restrict to the active comp, so switching changes what
   renders. Composition state rides in the **undo snapshot** (`GraphSnapshot` +
   `getGraphSnapshot`/`applyGraphSnapshot`), so create/delete undo/redo stays
   consistent (with currentGroupId re-scoped when the comp changed or its scope
   node vanished). `tsc` clean; no new lint problems; single-comp path is an exact
   no-op (1 tab, no close button). *Deferred:* `Project ▸ Composition` breadcrumb
   crumbs (land with the Project view in M4); membership stays defensive (the sweep
   makes it behave strictly between visited comps).
4. **Project view panel.** ✅ **DONE (2026-06-29).** New
   [ProjectView](../src/components/effects/ProjectView.tsx) (a `view:
   "editor"|"project"` swap of the editor panel via `editorPanelJsx`): a grid of
   composition cards (thumbnail / name / settings line), with **create**,
   **delete**, **duplicate**, **rename** (double-click the name), and
   **drag-to-reorder**. Double-click a card to enter it. Entered via the new
   **`Project ▸ Composition ▸ …`** breadcrumb — the Project crumb
   (`PROJECT_CRUMB_ID` in [NodeEditor](../src/components/effects/NodeEditor.tsx))
   calls `onOpenProject`, the Composition crumb is the comp root. graph-ops gained
   `deleteCompositionNodes` + `cloneCompositionNodes` (node-level; EffectsApp owns
   the registry array); all CRUD sweeps untagged nodes into the active comp first
   and is undoable (create/delete/duplicate/rename push the comp-aware snapshot).
   Delete has **no guard** — deleting the active/last comp drops into the Project
   view; a **zero-composition project is legal**. Per-comp **thumbnails captured on
   save** (`thumbnail?` on `SavedComposition`, the active comp's 256px poster
   stamped by `compositionsForSave` at the cloud + file save sites). The
   preview/timeline keep rendering the **last-active composition** while the
   browser is open (decision 4). `tsc` clean; no new lint problems. *Deferred:*
   per-comp thumbnails for inactive comps (only the active comp updates on save);
   `.toolbox` manifest `compositions` summary + asset-extracted thumbnails (today
   they inline in project.json).
5. **Multi-level outputs + per-comp export (#159).**
   - **M5a — labels + blue tint.** ✅ **DONE (2026-06-29).** Editor-only display
     overrides computed in `scopedNodes` (`layerDisplayFor`) and read by
     [EffectNode](../src/components/effects/EffectNode.tsx): a layer's boundary
     nodes read **Layer Input / Layer Output** (parent-is-layer; only overriding a
     default name so renames win), the comp-root `output` reads **"Composition
     Output,"** and layer nodes + their boundaries get a **blue wash**
     (`layerAccent` → blue border + faint blue bg). New `displayName?` /
     `layerAccent?` on `NodeDataPayload` are display-only (never serialized).
     `tsc` + lint clean.
   - **M5b — Layer Output render.** ✅ **DONE (lean, 2026-06-29).** A Layer Output
     (fixed `group-output` inside a layer) now shows the Output node's **Image +
     Video** export buttons ([EffectNode](../src/components/effects/EffectNode.tsx)
     `isLayerOutput`). Clicking one fires the existing `effect-node-export` event
     with the layer-output id; the export handlers set `forcedTerminalRef =
     layerOutputId`, which `resolvePreviewProducer` remaps (before flatten) to the
     layer's **interior producer** — so it renders that layer's content over
     transparency at the **layer-local clock**, no engine change.
     `getOutputParams` returns the **active comp's Output settings** for a layer
     output (the render *borrows* comp settings rather than carrying its own set —
     avoids invasive ParamPanel/def surgery); `exportImage` force-renders the layer
     to the canvas before snapshotting. `tsc` + lint clean. **Needs in-browser
     verification** (offline video/frame capture).
     *Follow-up:* a **per-layer-output param set** (own filename / frame range /
     tier) — which also unlocks the **sequence/gif** tiers from a layer (the button
     reads the layer output's own `exportMode`, absent today → Video only).
   - *(Render Queue across comps = stretch.)*
6. **Later (not v1):** `composition` reference node (precomp) via the
   `resolveComposition` seam + cycle detection.

## Resolved decisions (open questions, answered)

- **Tab bar** = open comps only, each with an `x` to close (close ≠ delete),
  two-finger-scrollable on overflow.
- **Thumbnails** captured **on save** (per comp).
- **No delete guard** — deleting the active/last comp drops the user into the
  Project view; a project may hold zero compositions.
- **Comp switch clamps** the playhead into the incoming comp's loop (no reset).

### Still to settle during build

- Layer-Output render clock: render the layer interior over the comp's frame
  range using the **layer-local clock** (matches what the comp sees) vs a raw
  frame-0 interior render. Lean: layer-local, to match comp appearance.

## Process

On ship, update [061226_devguide.md](061226_devguide.md) (§"Groups & layers",
§"Persistence", §"Core mental model" — the project-is-`Node[]+Edge[]` line, plus
the Output/Layer-Output render model) and mark **#163**, **#159**, and the
composition note in [devlist.md](devlist.md). Implement in the milestone order
above; each milestone is independently verifiable in the browser.
