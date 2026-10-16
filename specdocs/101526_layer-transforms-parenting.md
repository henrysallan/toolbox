# Layers: transforms, selection, property shortcuts, blend column, parenting (spec, 2026-10-15)

Make the Layers editor feel like After Effects / Cavalry. Every layer gets
animatable transforms with `transform` sockets in and out. The layer label
becomes a real, selectable row with AE's property-reveal keys
(P / S / R / T, plus A and U). The blend mode moves into the row and onto the
node's bottom edge. The label pane can be resized. Parenting in the timeline
wires the transform sockets for you.

Builds on [layers-groups-attributes.md](archive/layers-groups-attributes.md)
(the strict root chain, layer local time) and
[082826_gizmo-node.md](082826_gizmo-node.md) (the `transform` value and the
parenting model). It doesn't change either one, except for the compose-order
fix in §1.

## Current state

- **Layer node** ([layer.ts](../src/nodes/group/layer.ts)): inputs `stack`,
  hidden `content`, `audio`, hidden `spline`, plus any minted interface
  sockets. Params: `blendMode`, `opacity`, hidden `target`. Compute blends
  `content` over `stack` with Merge's `BLEND_FS`. It has two shortcuts: an
  empty layer passes `stack` through, and the bottom layer at normal blend
  and full opacity returns `content` as-is. No transform of any kind.
- **Root is strict** ([NodeBrowserDropdown.tsx](../src/components/effects/NodeBrowserDropdown.tsx)):
  the root add menu offers only Layer and Render Queue. So at root, the only
  transform producers in practice are other layers.
- **`transform` socket** ([transform-value.ts](../src/engine/transform-value.ts)):
  `TransformValue = { ops: TransformOp[] }`, applied first to last.
  `TRANSFORM_TRS_PARAMS` (translate / scale / rotate / pivot, in canvas01)
  is shared by Gizmo and Transform. Images are moved by inverting
  `composeOpsToAffine` and sampling with `TRANSFORM_MATRIX_FS`.
- **Gizmo parenting is composed backwards (bug, verified).**
  `composeTransform(parent, local)` returns `[...parent.ops, local]`, so the
  parent is applied *before* the child. The spec and the `TransformValue`
  comment both say local first, then parent. Example: a parent rotated 90°
  about the center with a child translated +0.25 x should map the center to
  (0.5, 0.75). Today it maps it to (0.75, 0.5). A child's offset ignores its
  parent's rotation and scale. Pure-translate parents commute, which is
  probably why nobody has noticed.
- **Raster rotation shears on non-square canvases (measured in M0).**
  `trsToAffine` and `TRANSFORM_MATRIX_FS` work in raw canvas01 with no
  aspect term. Geometry gets its roundness back through `aspectCorrectY`
  ([aspect.ts](../src/engine/aspect.ts)), but the image matrix path has no
  equivalent. On 16:9, rotating an image through a wired transform may skew
  it.
- **Evaluation**: flatten ([flatten.ts](../src/engine/flatten.ts)) keeps the
  layer node and dissolves its boundary nodes. `layerOf` maps *interior*
  nodes to their layer for local time. The layer node itself, including its
  opacity keyframes, runs on the **global** clock, so sliding a layer bar
  does not slide its opacity keys. A gated layer passes `stack` through
  ([evaluator.ts](../src/engine/evaluator.ts), the `gated && LAYER_TYPE`
  branch). A bypassed layer (eye off) passes its first input through.
- **Layers editor** ([LayersEditor.tsx](../src/components/effects/LayersEditor.tsx)):
  `GUTTER_CARD_WIDTH = 200`, fixed. A row is name, chevron and eye, plus a
  Skia badge. A click without movement already selects the layer through
  `handleSelectLayer`, but only one at a time, and the highlight is a 4.5%
  lift that's easy to miss. Expanding a row shows Opacity plus promoted
  params (`tracksFor`). The root element sets `data-shortcut-scope="node"`,
  the **same scope as the node editor**.
- **Global shortcut collisions**: Shift+S toggles viewport split and Shift+R
  toggles rulers ([EffectsApp.tsx](../src/components/effects/EffectsApp.tsx)
  global keydown). Both collide with AE's Shift+key additive reveal.
- **Reorder** (`reorderLayers` in [graph-ops.ts](../src/state/graph-ops.ts))
  only touches `in:stack` edges and Output's `image` edge, so transform
  edges between layers survive a reorder.

## Decisions (owner, 2026-10-15)

| # | Question | Decision |
| --- | --- | --- |
| D1 | What does a layer transform move? | **Raster first**: transform the layer's finished `content` image before it's blended. The vector path (passing the transform into the interior so shapes and text stay sharp) is deferred (§9). |
| D2 | Does the child jump on parent / unparent? | **No jump for unanimated children**: rewrite the child's TRS so its world placement holds. **Animated children jump**, with a toast. Rewriting keyframes is out of scope. |
| D3 | What can be a parent? | **Any `transform` source.** Because of the strict root, that means layers in practice. An **Empty layer is the null object**: no content, passes `stack` through, still outputs its transform. The Parent dropdown lists layers; a hand-wired non-layer source shows as `⟨node name⟩` (read-only). |
| D4 | Skia-target layers | **Deferred.** Skia layers get the params, but the exporter reports a problem (§8) if the transform isn't identity or a parent is set. |
| D5 | Clock for the layer's own keyframes (opacity, TRS) | *Confirmed by owner 2026-10-15:* keep evaluating on the global clock, but **move the layer's own keys with its bar** when the bar slides. This matches AE, where a layer's keys travel with it, and keeps eval unchanged. |

## Design

### 1. Prerequisite fixes (M0)

1. **Compose order.** Change `composeTransform` to `[local, ...parent.ops]`
   so world = parent ∘ local, applied local first. Gizmo chains
   (`gizmo → gizmo`) and every consumer (`applyTransformTo*`,
   `composeOpsToAffine`) get the correct order. This changes behavior for
   saved projects whose parent Gizmo rotates or scales. Note it in the
   release changelog; don't add a migration flag, since the old result was
   wrong. Gizmo is the only caller that passes a parent (Transform passes
   `undefined`), so the fix is narrow. Still check the overlays
   ([GizmoTickOverlays.tsx](../src/components/effects/GizmoTickOverlays.tsx),
   [PrimitiveGizmo.tsx](../src/components/effects/PrimitiveGizmo.tsx)) for
   any hand-rolled parent math that copied the old order. Gate: the
   rotating-parent, scaling-parent and three-level cases in
   `check-gizmo-transform.mts`.
2. **Aspect-rigid image affine.** Measure first: render a square image on a
   16:9 canvas through Transform with a wired 45° transform and check that
   the corners stay at right angles. If it shears, add
   `composeOpsToCanvasAffine(ops, aspect)`, which conjugates every op by
   the same y-scale `aspectCorrectY` uses. The layer compositor uses it, so
   a Gizmo driving a shape and a layer under the same transform land in the
   same place. (Changing Transform / Image Source is a separate decision;
   see M0 results.) Gate: `check-layer-transform-math.mts`.
3. **Affine → TRS decomposition** (`decomposeAffineToTrs(m, pivot)` in
   transform-value.ts) for D2 compensation. Write the linear part as
   `L = R·diag(sx, sy)`. Reject it (return null) when the columns aren't
   orthogonal within ε (that's shear, which TRS can't represent) or when the
   determinant is ≤ ε. Translation is `T = t − p + L·p` for the child's
   existing pivot p. Gate: `check-layer-transform-math.mts` (round trip
   over random TRS stacks, the rejection cases, and compensation).

### 2. Layer transform params and sockets (M1)

- Add `TRANSFORM_TRS_PARAMS` to the layer's params, after `opacity`. They're
  keyframable and visible in the ParamPanel's layer section as a
  "Transform" group. `linkedPairs: [{ a: "scaleX", b: "scaleY" }]` (same as
  Gizmo). The pivot defaults to (0.5, 0.5), the canvas center, which is
  where an AE precomp's anchor sits. Old saves read the defaults, which are
  identity, so they render the same with no migration.
- **Input** `{ name: "transform", type: "transform", required: false,
  label: "Parent" }`. Add it to both `inputs` and the fixed list in
  `resolveInputs`, and reserve the name so a minted interface socket can't
  shadow it. Unlike the Transform node, a wired transform **composes** with
  the layer's own TRS (Gizmo semantics); it doesn't replace it.
- **Aux output** `{ name: "transform", type: "transform" }`: the layer's
  world transform (`parent ∘ local`). Wire it into another layer's `Parent`
  input to parent that layer.
- Update `facts` for the new params (space `canvas01`, the
  "composes, not replaces" gotcha) with the `node-facts` skill, so
  `check-node-facts` and the MCP catalog stay accurate.

### 3. Evaluation: split the transform out of the compositor (M1)

**The cycle.** In AE, parenting ignores stacking order: a child below its
parent is normal. Here, if the child sits below the parent, the child's
image feeds the parent's `stack`, and the parent's `transform` aux feeds
the child. Child → parent → child is a cycle in the flat graph, because a
node computes all its outputs from all its inputs.

**Fix.** At flatten time, synthesize an eval-only node with type
`layer-xform` and id `<layerId>__xform` (no colons: MCP and state keys
parse `id:aux:name`) for each layer that **uses** its transform: a
transform wire in or out, a wired TRS param, a non-identity TRS, or TRS
keyframes. A layer that doesn't is left exactly as before. The rest of the
engine stays unaware of the node.

```
{ id: L.id + "__xform", type: LAYER_XFORM_TYPE,
  params: L.params,        // by reference: the fingerprint sees the same object
  animation: L.animation } // by reference: same keyframes, same clock as L
```

Flatten rewrites:

| Raw edge | Flat edge |
| --- | --- |
| `X → (L, in:transform)` | `X → (L__xform, in:parent)` |
| `X → (L, in:param:<trs>)` | `X → (L__xform, in:param:<trs>)` |
| `(L, out:aux:transform) → Y` | `(L__xform, out:primary) → Y` |
| (synthesized) | `(L__xform, out:primary) → (L, in:__xform)` (hidden compositor input) |

`layer-xform` compute is `composeTransform(inputs.parent, opFromParams(params))`.
It's CPU-only, with no GL. Transform-only paths now form their own DAG
through the `__xform` nodes, separate from the stack chain, so stacking
order no longer matters.

Rules:

- **Never gated, never bypassed.** `__xform` nodes get no `clips` and no
  `bypassed` flag, so a parent keeps driving its children when it's hidden
  or outside its window (AE behavior). Only the compositor gates. A gated
  layer also drops its own `in:__xform` edge (next to `in:content` and
  `in:spline`), so its `__xform` node runs only while a child pulls it.
- **Clock.** The layer node runs on the global clock, and so does
  `__xform`. D5 handles keys sliding with the bar on the editor side.
- **Cycles.** The UI (§7) refuses parenting loops. The evaluator has
  *no* cycle error: its Kahn topo sort silently drops every node on or
  downstream of a cycle, which for a layer loop blanks the whole frame. So
  flatten walks each split layer's parent chain and **cuts the link that
  closes each loop**, and a hand-mangled file still renders.
- **Who sees it.** Export manifest, live-viewer knobs and wedge batch
  walk the raw nodes and use the flat graph only for reachability, so
  `__xform` never appears there. The profiler records it honestly as a
  `layer-xform` row (microseconds of CPU). Hiding it would misattribute
  real work.

**Compositor** (layer compute):

- Read `inputs.__xform`. If it's missing or identity, run today's code
  unchanged, including both shortcuts. That makes the result byte-identical
  for every existing project (parity gate, M1).
- Otherwise, skip the bottom-layer passthrough shortcut (it's invalid once
  the content moves). Sample `content` through the inverse pixel affine
  inside the blend pass, rather than adding a separate canvas-sized
  transform pass. Add a layer-only variant of the blend shader
  (`layer/blend-xform-v1`) whose `u_layer` lookup goes through
  `u_invA` / `u_invT`, with transparent outside [0,1]². Merge's
  `BLEND_FS` and its key stay untouched. If sharing the blend math makes
  the fused variant awkward, fall back to two passes (transform, then
  today's blend) and record the cost.
- Known raster limits, to document in the node gotchas: upscaling softens
  (that's D1), and heavy downscaling aliases because there are no mips.
  The vector path (§9) addresses both.

### 4. Canvas gizmo for layers (M1)

Set `supportsTransformGizmo: true` on the layer def. Selecting a layer row
then shows the existing on-canvas TransformGizmo, which edits the layer's
TRS. For parented layers, the handles edit **local** TRS in canvas space,
the same limitation the Gizmo node has today
([082826_gizmo-node.md](082826_gizmo-node.md) M2 tracks parent-space
handles). That's acceptable for v1, but say so in the tooltip.

### 5. Row selection and property reveal (M2)

**Selection** becomes first-class:

- Click selects one row. Cmd+click toggles a row. Shift+click selects a
  range in display order. Clicking empty gutter clears the selection.
- Selection is **node selection** (`n.selected`), so the node editor, the
  ParamPanel and the canvas gizmo all follow. `selectedId` stays the
  primary row (the last one clicked). Extend `handleSelectLayer(id, mode)`
  with `"replace" | "toggle" | "range"`.
- Make the selected row's highlight clearly visible, both the row fill and
  the label weight. Use theme tokens and run `check:theme-css`.
- Escape clears the selection, but only when no keyframes are selected.
  Otherwise Escape clears the keyframe selection first, as it does today.

**Property lanes.** Expanding a row now shows the layer's own properties as
**grouped AE properties**, then the promoted params:

| Property | Params | Key |
| --- | --- | --- |
| Anchor Point | `pivotX`, `pivotY` | A |
| Position | `translateX`, `translateY` | P |
| Scale | `scaleX`, `scaleY` (linked) | S |
| Rotation | `rotate` | R |
| Opacity | `opacity` | T |
| *(animated only)* | any property with keys | U |

A grouped lane shows a diamond wherever **any** of its params has a key.
Toggling a key at the playhead keys **all** of its params at their current
values. Dragging or deleting a diamond moves or deletes every member key at
that tick, as one history entry. That's how AE treats Position: one
property with two values. This reuses `upsertKeyframe` / `removeKeyframeAt`
per member; the `LayerTrack` model gains `params: string[]`.

**Reveal keys** (AE semantics) apply to the selected layers, or to all
layers when none are selected:

- A bare **P / S / R / T / A / U** shows *only* that property on those
  rows. Pressing the same key again collapses them.
- **Shift+key** adds or removes that property from what's already shown.
- The chevron still means "show everything".
- Store per-row state as `revealed: Map<layerId, Set<PropertyKey> | "all">`,
  replacing today's `expanded: Set`. It lives in editor session state, not
  the saved project.

**Shortcut ownership.** Give LayersEditor its own scope,
`data-shortcut-scope="layers"`. Today it shares `"node"` with the node
editor.

- Move the editor's existing handlers (Delete, B, Shift+D, Escape) from
  `getShortcutScope() !== "node"` to `"layers"`.
- The global Shift+S (viewport split) and Shift+R (rulers) handlers yield
  when the scope is `"layers"`. Bare P/S/R/T/A/U have no global binding.
  The bare-P `place_mode` handler (EffectsApp, around line 11082) only fires
  when a Tracker Point is selected, so it can't collide with a selected
  layer.
- Audit everything that reads `"node"` and assumed a click in Layers kept
  node shortcuts alive (Delete, copy/paste, Cmd+G). The decision is that
  Delete with layers selected **deletes those layers** (with children
  compensated, §7), and Cmd+C/V copy and paste layers as they do from the
  node editor at root. List the audit result in the M2 results.

**D5, keys slide with the bar.** When a bar move commits (in and out move
together, from the bar body), shift every key on the layer's own params
(opacity and TRS) by the same Δtick, in the same history entry. Trims don't
shift keys. Promoted params live inside the layer and already slide, via
local time.

### 6. Resizable label pane and blend column (M3)

- The pane width becomes state. Default **280** (up from 200, to fit the
  new columns), clamped to [140, 560], saved per viewer in `localStorage`
  under `toolbox.layers.labelWidth`. Wrap every read and write in
  try/catch, and fall back to the default. The layout tree has no per-panel
  state, and this is a per-viewer convenience, not project data.
- A 6px drag handle on the card's right edge (`ew-resize`); double-click
  resets the width. While dragging, the lane origin follows, and the
  timeline view's `viewTickOffset` stays put. Pointer capture and window
  listeners go through `ownerWindow(...)` so a popped-out timeline window
  works (`usePanelWindow`).
- **Columns**, left to right: chevron · eye · name (flex) · **Blend** (96px)
  · **Parent** (96px, M4) · Skia badge. Collapse thresholds: Blend hides
  below 300px of width, then Parent below 220px. The name never hides.
  Hidden columns keep their values; the row tooltip shows them.
- **Blend select.** Compact, borderless until hovered. Lists
  `BLEND_MODE_ORDER` grouped like the param panel. Changing it is one
  history entry (`set_param` semantics). Its popover portals into the
  panel's own window.
- **Node bottom edge.** The Layer node card in the node editor gets a
  footer strip with the same blend select (class `nodrag nopan` so React
  Flow doesn't drag the node) and a read-only parent chip once M4 lands.
  Implement it as a layer-only footer in
  [EffectNode.tsx](../src/components/effects/EffectNode.tsx), next to the
  existing layer wash (#159).

### 7. Parenting (M4)

**The wire is the source of truth.** A layer's parent is whatever feeds its
`in:transform`. The Parent column reads it. Setting it from the timeline
writes the edge `(P, out:aux:transform) → (C, in:transform)`; choosing
"None" deletes it. A wire drawn by hand in the node editor at root shows up
in the column too.

- **Parent dropdown**: "None", then every other layer by name, in display
  order. Layers that would create a loop (C itself, or anything that has C
  as an ancestor) are disabled, with the tooltip "would create a loop".
  A non-layer source shows `⟨node name⟩` as a read-only item.
- **Compensation (D2)**, done when the parent is set or cleared:
  - If none of C's TRS params has keys, compute
    `newLocal = inverse(P_world(t)) ∘ C_world_old(t)` at the playhead
    (P_world comes from evaluating P's `__xform` chain on the CPU, using
    `opFromParams` plus keyframes at `t`), then
    `decomposeAffineToTrs(newLocal, C.pivot)`. If that succeeds, write the
    TRS and the edge as **one** history entry.
  - If C is animated, or decomposition fails (shear from a non-uniformly
    scaled, rotated parent), wire it without compensation and show a toast:
    "Parented without holding position (animated layer / non-uniform
    scale)". Alt-select in the dropdown always jumps, as in AE.
- **Structural ops**:
  - Deleting a parent unparents its children, with compensation, before the
    delete, in the same history entry.
  - Split (Cmd+Shift+D): both halves keep the original's parent. Children
    stay on the first half.
  - Duplicate or paste: the copy keeps its parent if the parent is in the
    target composition; otherwise it's dropped.
  - Reorder doesn't touch transform edges (already true).
- **Parent column chip**: a small link glyph plus the parent's name, and
  hovering it highlights the parent row. Pick-whip dragging is deferred
  (§9).
- **MCP**: `get_graph` already shows the edge. Add `parentLayerId` to the
  layer rows in the scope or layer listing in
  [mcp-handlers.ts](../src/components/effects/mcp-handlers.ts), so agents
  don't have to infer it from the wiring.

### 8. Persistence and export

- No schema bump. The new params default to identity, and the edges are
  ordinary edges. Old files load as identity, with no parents.
- Web export, live viewer and export template all share the engine, so the
  `__xform` split rides along. Run `check:export-pipeline` and the
  export-manifest checks (flatten consumer) on M1, and keep `__xform`
  out of manifest knobs (§3).
- **Skia (D4)**: in
  [scene-emit.ts](../src/lib/skia-export/scene-emit.ts) / the
  `plan_skia_export` problem list, a Skia layer with a non-identity
  transform or a parent reports "Layer transforms aren't exported to Skia
  yet; the export ignores them". The planned follow-up wraps the layer's
  scene in a `Group transform` and is a small change.

### Module layout

| Piece | Where |
| --- | --- |
| Compose fix, pixel affine, decomposition | `src/engine/transform-value.ts` |
| `LAYER_XFORM_TYPE`, `layer-xform` def (hidden, eval-only) | `src/engine/groups.ts`, `src/nodes/group/layer-xform.ts` |
| Flatten split | `src/engine/flatten.ts` |
| Compositor sampling + shader | `src/nodes/group/layer.ts` |
| Parent set/clear + compensation, delete/split/duplicate rules | `src/state/graph-ops.ts` (new `setLayerParent`), not EffectsApp |
| Property model (grouped lanes, reveal keys) | `src/components/effects/timeline/layer-properties.ts` (new, pure, testable) |
| Row UI, columns, resize | `src/components/effects/LayersEditor.tsx` |
| Node footer | `src/components/effects/EffectNode.tsx` |

## Milestones

| M | Scope | Gates |
| --- | --- | --- |
| **M0** ✅ | §1: compose-order fix, aspect check (and fix if it shears), decomposition helper | `check-gizmo-transform.mts` (extended), `check-layer-transform-math.mts` (new); typecheck; changelog note for the Gizmo behavior change at release |
| **M1** ✅ (gizmo → M2) | §2–§4: params and sockets, `__xform` split, compositor sampling, canvas gizmo, facts | `check-layer-transform.mts`: identity parity (byte-identical eval graph and outputs), a child below its parent produces no cycle, a gated or bypassed parent still drives its child, three-level chains. `check:shaders` for the new variant. `check:export-pipeline`. `npm run check` (background). |
| **M2** ✅ (+ gizmo) | §5: multi-select, grouped lanes, reveal keys, `"layers"` scope, D5 key sliding | `check-layer-properties.mts` (reveal state machine, grouped key ops, slide Δ); shortcut-scope audit in the results |
| **M3** ✅ | §6: resizable pane, columns and collapse, blend select in row and on the node | typecheck + lint ratchet; UI verified by hand (see below) |
| **M4** ✅ | §7: Parent column, compensation, loop guard, structural ops, MCP field | `check-layer-parenting.mts`: compensation keeps world placement within ε, the animated or shear case jumps and flags it, loop refusal, delete/split/duplicate rules |

**UI verification limit.** The editor at localhost:3000 needs Google
sign-in, and the toolbox MCP screenshot captures only the canvas. Row
chrome, columns, resizing and the node footer (M2–M3) can't be
screenshotted by an agent. Verify them with typecheck and the pure-logic
checks above, and have the owner click through. Canvas results (M1, M4)
*can* be checked with MCP `screenshot` / `compare_renders`.

## M0 results (2026-10-15)

**1. Compose order: fixed.** `composeTransform` now returns
`[local, ...parent.ops]`. Gizmo is the only caller that passes a parent,
and nothing else in `src/` indexes into `TransformValue.ops`. Every
consumer goes through `applyTransformTo*` / `composeOpsToAffine`, so no
other code changed. The overlays (GizmoTickOverlays, PrimitiveGizmo,
TransformGizmo) have no parent math of their own.

- The old gate couldn't see the bug: its only parent case was pure
  translations, which commute. `check-gizmo-transform.mts` now has a
  rotating parent (checked through the affine, spline and points paths), a
  scaling parent, and a three-level Gizmo chain. Two assertions that
  pinned the old array layout were updated. All seven new or changed
  assertions **fail on the pre-fix code** (checked by swapping in
  `HEAD`'s transform-value.ts) and pass on the fix. 43/43 now.
- Behavior change for saves: a Gizmo whose parent Gizmo rotates or
  scales now places its geometry differently (correctly). Parents that
  only translate are unchanged. Release changelog line: "Gizmo parenting
  now applies the parent's rotation and scale to the child's offset (it
  was applied in the wrong order)."

**2. Aspect skew: measured; the layer path is fixed, existing nodes are
not.** Offline affine math on 1920×1080: a 45° rotate through the canvas01
image path (`composeOpsToAffine` → `TRANSFORM_MATRIX_FS`, and equally
`TRANSFORM_FS` / `bindTrsUniforms`) leaves the image's pixel axes at
**121.28°** (rigid = 90°), with an axis-length ratio of **0.563** (rigid =
1). This is the documented per-axis uv gotcha (092326_figma-import.md,
092226_per-glyph-text.md), and it affects Transform's image mode, Image /
Video Source TRS, and Text.

- New `composeOpsToCanvasAffine(ops, aspect)` = `C · M · C⁻¹` with
  `C(x, y) = (x, aspectCorrectY(y))`. Gated: rigid in pixels on 16:9
  (exact for a 45° rotate and for 200 random uniform-scale chains), equal
  to `composeOpsToAffine` at aspect 1, and it lands a canvas-sized image
  exactly where the geometry path puts a shape under the same ops (200
  random chains, error < 1e-6). The M1 layer compositor uses it.
- Semantics to keep in mind for M1: `translateY` here is
  **width-relative**, like shapes (0.1 = 0.1·W pixels down), not 0.1·H as
  in Transform's image mode. Pivot (0.5, 0.5) is the canvas center either
  way.
- **Not changed here:** Transform / Image Source / Text kept their per-axis
  rotation in M0. The owner approved the switch as its own change:
  [101526_aspect-rigid-rotation.md](101526_aspect-rigid-rotation.md)
  (schema v13, `legacySkew` pins old saves).

**3. Decomposition: added.**
`decomposeAffineToTrs(m, pivotX, pivotY, nearRotateDeg?)` →
`TransformOp | null`. It refuses shear (non-orthogonal columns), mirror
(det < 0; layer and Gizmo params clamp scale positive), and collapse. The
rotation snaps to the 360° turn nearest the hint, so a child at 350°
re-parents to ~350°, not −10°. Gated: exact round trip over 500 random
non-uniform TRS ops, re-expressing about a different pivot, the three
refusals, parenting compensation (300 random uniform-scale parent chains:
world placement held to < 1e-6, with no refusals), and unparenting
(bakes the parent in, rotation 90 + 15 = 105).

**Gates.** `npm run typecheck` is clean. `check-gizmo-transform`,
`check-layer-transform-math` (new, added to `npm run check` after the
gizmo gate) and `check-transform-pivot` pass. TESTING.md gained a
"which check guards what" entry. Full `npm run check` exits 0 (run
alongside the uncommitted Paint M0–M2 work in the same tree).
`check-skia-shapes` failed once while it was competing with the full suite
and passed when rerun alone and inside the full run. It looks
load-sensitive and is unrelated (it doesn't import the transform code).

## M1 results (2026-10-15)

**Built:**

- **Layer def** ([layer.ts](../src/nodes/group/layer.ts)): `TRANSFORM_TRS_PARAMS`
  after `opacity`, plus `linkedPairs` scale. A `transform` input labelled
  "Parent" and a hidden `__xform` input, both added to the static `inputs`
  and the fixed list in `resolveInputs`, so a minted interface socket can't
  shadow them. An `aux:transform` output.
- **`layer-xform`** ([layer-xform.ts](../src/nodes/group/layer-xform.ts),
  hidden, registered beside `iterate-feed`): `composeTransform(parent,
  opFromParams(params))`. It declares the TRS params because the evaluator
  resolves keyframes by walking `def.params`.
- **Flatten** (`splitLayerTransforms`, last step of `flattenGraph`): the
  rewrites in §3, splitting only layers that use their transform, plus the
  loop cut. Constants (`LAYER_XFORM_TYPE`, `LAYER_XFORM_INPUT`,
  `layerXformId`) live in engine/groups.ts. The evaluator's gated-layer edge
  filter also drops `in:__xform`.
- **Compositor**: when `__xform` isn't identity under
  `composeOpsToCanvasAffine(ops, W/H)`, it skips the bottom-layer
  passthrough and draws with `LAYER_BLEND_XFORM_FS` (key
  `layer/blend-xform-v1`). That's Merge's `compositeOver` with `u_layer`
  sampled through the inverse affine, and the frame-edge coverage passed as
  the matte. A non-invertible transform shows no content. `BLEND_MODE_GLSL`
  is now exported from merge.ts; Merge's own shader and key are untouched.

**Deviations from the design, with reasons:**

- Ids are `<layerId>__xform`, not `::xform`: MCP and `ctx.state` keys
  parse `id:aux:name` / `type:id:…` on colons.
- Only layers that use their transform are split. Every existing
  project's flat graph is therefore unchanged, which is a stronger parity
  guarantee than identity math alone.
- Cycles: see §3. The evaluator has no cycle error, so flatten cuts loops.
- Perf rows: the profiler shows `layer-xform` rather than hiding it.
- **Canvas gizmo (§4) moved to M2.** TransformContextActions' Flip H/V
  writes negative scale, and `opFromParams` clamps scale to ≥ 0.0001, so a
  flip would collapse the layer to a dot. It needs a flip-aware path
  (allow negative scale for layers, or hide flip for them) before the
  gizmo opts in.
- **Facts:** none needed. Layer and layer-xform are both `hidden`, and
  `check-node-facts` covers only visible defs. The authored-space note
  (translateY width-relative) sits on the param block in layer.ts.

**Gates:**

- `check-layer-transform.mts` (new, in `npm run check`): 34 assertions on
  a stub GL context that records each layer's shader key and uniforms.
  They cover parity (no split, no `__xform` edge, the bottom layer returns
  its content object untouched, pairwise blend above, pivot-only changes
  don't split); a transformed layer (width-relative inverse translation,
  the aspect-rigid inverse for 45°, `u_res` bound); parenting with the
  child **below** the parent (no errors, child inherits, parent still
  moves); gated and bypassed parents still driving; a gated child not
  evaluating its own `__xform`; a three-level chain (op order and the
  composed inverse); 2- and 3-layer loops (one link cut, frame renders);
  and keyframes (split with identity static params, midpoint value, back to
  the untouched path at the identity key). The four loop assertions **fail
  with the cut disabled**: the Output doesn't compute at all.
- `check:shaders` (stage 5, new): `layerBlendXform` compiles. Identity ≡
  pairwise in all 29 modes, **max |Δ| = 0**. +2 px right and +3 px down
  shifts ≡ pairwise over a pre-shifted layer, **max |Δ| = 0**, which proves
  the y-down mapping and that the edge AA is exactly 0 or 1 at pixel
  centers.
- `npm run typecheck` is clean. `lint:ratchet` is green (113 vs 114
  baseline; the fixed error isn't from this change, so the baseline wasn't
  updated). Full `npm run check` exits 0. The three transform gates were
  rerun green after the parallel aspect-rigid-rotation work
  (101526_aspect-rigid-rotation.md) started editing transform-value.ts in
  the same checkout.

**Not verified (UI, needs the owner):** the Parent input and transform
output handles on Layer nodes in the node editor, and the TRS rows in the
ParamPanel's layer section. The editor needs Google sign-in, so an agent
can't open it. Rendering a transformed layer in the real app is also
unchecked: that's possible over MCP `screenshot` once the editor is paired,
by setting `translateX` on a layer with `set_param`.

## M2 results (2026-10-15)

**Built:**

- **Property model** ([timeline/layer-properties.ts](../src/components/effects/timeline/layer-properties.ts),
  pure): `LAYER_PROPERTIES` in AE order (Anchor Point = pivotX/Y, Position
  = translateX/Y, Scale = scaleX/Y, Rotation, Opacity); `applyRevealKey` /
  `toggleRevealAll` / `revealedProperties`; `animatedProperties` (U);
  `mergeLaneBlocks` (a grouped lane's display block: the union of member
  ticks, with `value` the member tuple so dashed/solid compares every
  member); `memberKeysAt`; and `shiftBlocks` (D5).
- **Grouped lanes** (LayersEditor): `LayerTrack` gained `params`. A
  diamond click, Shift-click, right-click, segment click or marquee
  resolves to every member's per-param `SelectionKey` at that tick, so
  move / scale / stagger / space / easing / delete and the Graph Editor
  hand-off need no grouped variant. The lane-label diamond toggles all
  members as one undo step. Lane lookups (stagger order, selection box)
  match by membership. Promoted params stay single-member lanes, shown
  only under the chevron's "all".
- **Reveal keys:** bare A / P / S / R / T / U solo that property on the
  selected rows (every row when none is selected), and a second press
  collapses. Shift adds or removes; U resolves per row to its keyed
  properties. The state is `revealed: Map<layerId, "all" | PropKey[]>`,
  replacing `expanded`, and lives in editor session state only.
- **Row selection:** plain click replaces, Cmd/Ctrl-click toggles,
  Shift-click selects a range from the last plain/Cmd click
  (`selectRow` → new `onSelectLayers(ids, primaryId)` →
  `handleSelectLayers` in EffectsApp, which writes `n.selected` +
  `selectedId`). The bar area and bar drags use the same modifiers. The
  highlight is now a 14% accent wash plus a semibold name (it was a 4.5%
  lift). Escape clears the row selection when no keyframes or clip are
  selected.
- **D5:** a bar **move** of a single-window layer (or ghost) shifts the
  layer's own keys (all TRS params plus opacity) by the window's snapped
  Δ, from a drag-start snapshot. The clip and key writes share one
  gesture key, so they undo as one step. Trims and sliced (multi-window)
  layers don't shift keys.
- **Canvas gizmo (§4, moved here from M1):** the layer def sets
  `supportsTransformGizmo: true`; with nothing on `in:image`, the gizmo's
  box defaults to the frame. TransformContextActions (Flip H/V) isn't
  mounted for layers.

**Deviations from §5:**

- **Kept the shared `"node"` shortcut scope.** A separate `"layers"`
  scope would have broken Delete-a-layer, Cmd+C/V and Shift+D from the
  Layers editor. Those run through the node editor's React Flow handlers,
  which gate on `"node"`. The reveal keys reuse the guard this editor's
  Delete handler already has instead: `activeRef` (the last mousedown was
  inside the Layers editor), capture phase, and `stopPropagation`, so
  Shift+S / Shift+R don't also reach EffectsApp's window handler. Audit
  result: the only other bare-letter handlers on these keys are those two
  plus Tracker Point's P (gated on a selected tracker point).
- **No "click empty gutter clears".** Escape clears instead; the gutter
  card is a passive backdrop behind the rows.

**Gates:**

- `check-layer-properties.mts` (new, in `npm run check`): 34 assertions
  covering letters and property order; bare solo / collapse / mixed
  targets / non-targets; Shift add / remove / canonical order / collapse
  on empty; "all" interplay; U per row and Shift+U; chevron and revealed
  sets; the animated filter (disabled / empty blocks don't count);
  grouped merge (ticks, tuple values, single-member passthrough); member
  keys; and shift (Δ, empty blocks skipped, snapshot immutability, no
  compounding).
- `npm run typecheck` is clean. `lint:ratchet` is green (it flagged a ref
  write during render in the first draft, which I fixed). The full `npm
  run check` exits 0 on the final tree, review fixes included.

**Independent review (subagent, read-only) — fixed:**

- *Stagger fanned grouped lanes apart.* `staggerKeyframes` steps once per
  base (param), so Alt-dragging one Position diamond split X from Y. It
  now takes an optional `laneOf(base)` ordinal. LayersEditor passes the
  rank of each base's visual lane (Alt-drag and the dock stagger), and
  `selectionSpansLanes` counts visual lanes. TrackEditor keeps the
  default, which is unchanged (gated both ways).
- *Cmd-click deselecting a non-primary row moved the primary* (the
  ParamPanel jumped). The primary is now kept.
- Also from the review: grouped-segment dashes now compare evaluated
  member values (a member keyed only at one end no longer reads as
  "changing"). A lane-diamond key falls back to the def default when an
  older layer has no stored TRS value (it was `undefined`). A Shift-click
  range anchor that's no longer selected falls back to the primary.
- *Known, left as is:* with Scale's link lock on and only scaleX keyed, a
  D5 slide landing a scaleX key on the playhead lets `onAnimationChange`'s
  linked-pair mirror add a scaleY key (it's harmless when both are keyed).
  macOS Ctrl-click on a row now toggles, matching Windows Ctrl.

**Not verified (UI, needs the owner):** all row and lane interactions
above, the gizmo's handles on a selected layer, and the absence of the
flip buttons for layers. The editor needs Google sign-in. Worth checking
by hand: Position / Scale diamonds selecting and dragging both members;
P then Shift+R then P; Cmd/Shift-click ranges; sliding a bar with
opacity keys; and the gizmo's translate matching the render on a 16:9
comp.

## M3 results (2026-10-15)

**Built:**

- **Pane model** ([timeline/layer-pane.ts](../src/components/effects/timeline/layer-pane.ts),
  pure): the card width defaults to 280 and is clamped to [140, 560].
  `paneColumns(width, hasParent)` drops optional columns in priority
  order, Blend first and then Parent (Parent is M4; until then
  `hasParent` is false and only Blend competes). Row anatomy constants
  are `ROW_FIXED` 49, `NAME_MIN` 72 and 94 px per slot. Blend fits at
  ≥ 215, and both columns fit at ≥ 309 once M4 lands, which may justify
  raising the default. `readCardWidth` / `writeCardWidth` persist under
  `toolbox.layers.labelWidth` and survive a missing or throwing storage.
- **Resizable pane** (LayersEditor): the old `GUTTER_CARD_WIDTH` /
  `LABEL_WIDTH` consts are now `cardWidth` / `labelWidth`, threaded
  through every lane offset (header, card fill and stroke, frame grid,
  row and lane labels, selection box, playhead, hover line). A 6 px grip
  sits on the card's right edge: drag to resize (window listeners
  through `ownerWindow`, so a popped-out timeline works), double-click to
  reset. The saved width arrives through `useSyncExternalStore`, with the
  default as the server snapshot (the editor server-renders, so a
  first-render storage read would mismatch hydration). Every mounted
  Layers editor, and other tabs via `storage` events, follows a resize.
  A live drag overrides locally and saves on release.
- **Blend column:** [LayerBlendSelect.tsx](../src/components/effects/LayerBlendSelect.tsx)
  is a native `<select>`, so the OS draws its list (no portal, works in
  popped-out windows). It's borderless until hovered or focused,
  `nodrag nopan`, and stops pointer, mouse and double-click events. The
  options are `BLEND_MODE_ORDER` with `blendModeLabel`; `mix` (the
  legacy alias) is offered only to a layer already using it. In the row
  it sits after the name and writes `blendMode` through a new optional
  `onParamChange` prop (EffectsApp passes its `onParamChange`, so undo
  and side effects match the param panel). It's hidden when it doesn't
  fit.
- **Node bottom edge:** Layer nodes get a footer strip ("Blend" plus the
  same select) above the resize grip. It writes through
  `effect-node-param` like the header enum controls.

**Gates:**

- `check-layer-pane.mts` (new, in `npm run check`): 19 assertions on
  clamping (min, max, rounding, NaN / ∞); column thresholds exact to the
  px; Blend dropping before Parent; monotonicity across every width; and
  storage (round trip, clamp-on-read, junk, a throwing storage, a
  missing storage).
- `npm run typecheck` is clean. `lint:ratchet` is green, with no new
  warning in touched files. Two first-draft lint hits were fixed:
  `set-state-in-effect` (which led to the useSyncExternalStore design)
  and an exhaustive-deps warning after `setHoverLineX` began closing
  over the live width. Full `npm run check` exits 0.

**Not verified (UI, needs the owner):** dragging the grip (including in a
popped-out timeline), the Blend column appearing and disappearing as the
pane narrows, picking a mode from the row and from the node footer
(including undo), and the footer not starting a node drag on touch.

## M4 results (2026-10-15)

**Built:**

- **Parenting ops** ([state/layer-parenting.ts](../src/state/layer-parenting.ts),
  pure): `layerParentOf` / `layerChildrenOf` / `parentEdgeOf`;
  `wouldLoop`; `worldOpsAt(nodes, edges, id, tick)`, the same
  composition the engine's `layer-xform` evaluates, with layer-own keys on
  the global clock; `setLayerParent(…, {keepInPlace})`;
  `unparentChildrenOf`; `carriedParentEdges`; and `jumpReasonText`.
  Keep-in-place computes `P_world⁻¹ ∘ C_world` at the playhead and
  decomposes it about the child's own pivot, with the rotation hint taken
  from its current rotate. It jumps, with a reason, when the child's TRS
  is animated (`animated`), on shear (`shear`), or when a parent in the
  chain isn't a layer (`unknown-parent`).
- **Parent column** (LayersEditor): `LayerParentSelect`, a native select
  built on the new shared `QuietSelect`, offers None plus every other
  layer, with loop-closing layers disabled and labelled "(loop)". A
  hand-wired non-layer parent shows read-only as ⟨name⟩. **Alt-pick
  jumps**: Alt is read from the select's own pointerdown, because the
  change event carries no modifiers, and kept in a ref because the hover
  highlight re-renders between open and pick. Hovering the control tints
  the parent row. The column drops after Blend as the pane narrows
  (`paneColumns(…, hasParent: true)`). The default pane width went from
  280 to **320**, so name + Blend + Parent fit out of the box.
- **EffectsApp:** `handleSetLayerParent` (one `pushGraph`; a toast when a
  hold couldn't happen). At the root-layer delete chokepoint,
  `unparentChildrenOf` runs on the full graph before survivors are
  filtered (with a toast if any child jumped). Duplicate carries an
  outside parent onto cloned **layers** only; other nodes' outside
  `in:transform` wires still drop, as before.
- **Split** (`splitLayer`): the clone no longer takes over the original's
  `aux:transform` edges, so children stay on the first half, and it gets
  a copy of the original's parent edge.
- **MCP:** root `get_graph` layer rows carry `parentLayerId`
  (`GroupSpecNode`, set in `graphToSpec`), and the tool description says
  so.

**Checked and found OK:** nothing on the editor side refuses the
raw-graph cycle a below-parent link makes. `isValidConnection` has no
cycle check, and `validateGraph` only ever sees MCP / AI fragments (a
group's subtree), never root parenting edges. The loader rebuilds node
socket lists from the def, so older saves get the new handles.

**Not done:** the read-only parent chip on the node footer. The node
editor already shows the parent as a visible wire, and EffectNode has no
edge access. Paste drops the parent: the clipboard holds no outside
edges, which matches the "otherwise dropped" rule.

**Gates:**

- `check-layer-parenting.mts` (new, in `npm run check`). Covers: basics
  and the loop guard; parent / unparent with placement held to 1e-6 and
  a round trip restoring the TRS exactly; re-parenting with the child
  stacked below both parents; a keyframed parent held at the playhead;
  the animated, shear and Alt jumps; refusals (loop, non-layer, same
  parent no-op); deleting a mid-chain parent (child unparented, not
  adopted, held); duplicate carry and no double-carry; split rules; MCP
  `parentLayerId`; and `worldOpsAt` vs the engine's evaluated
  `layer-xform` (three levels, keyed rotate, tick 1500).
- `check-layer-pane` gained "the default shows Blend AND Parent".
- `npm run typecheck` is clean, `check:mcp` exits 0, `lint:ratchet` is
  green, and the full `npm run check` exits 0 on the final tree (review
  fixes included).

**Independent review (subagent, read-only) — fixed:**

- *Wired TRS params were ignored by keep-in-place.* A wire into a
  layer's `in:param:<trs>` beats its keys and static value, so rewriting
  the static value can't hold. The result was a silent jump that reported
  `held`, or a wrong result when the wire was on an ancestor. Now
  `hasWiredTrs` makes a wired child jump with reason **`wired`**, and
  `worldOpsAt` returns null for a wired layer, so a wired ancestor reports
  `unknown-parent`. Wired opacity doesn't block the hold.
- *Duplicate could double-wire a clone* when its non-layer parent (a
  hand-wired Gizmo) was duplicated alongside. `carriedParentEdges` now
  takes the full `idMap` (it decides "outside") plus a `carries` filter
  (layers only).
- Also from the review: a parent that's a layer outside this chain shows
  read-only as ⟨name⟩ instead of a blank entry. Alt is read on keydown too
  (keyboard picks). Parent options are memoized on the chain plus edges.
- *Known, left as is:* solved TRS can exceed slider ranges (the evaluator
  doesn't clamp; a slider may show it pinned). Also pre-existing: the
  root-layer delete branch returns before `onNodesChange`, so non-remove
  changes in that same batch are dropped.

**Not verified (UI, needs the owner):** picking a parent and seeing the
child hold, Alt-pick jumping, the "(loop)" entries, the parent-row tint
on hover, deleting a parent layer from the Layers editor, Cmd+Shift+D
split and Shift+D duplicate of a parented layer, and the toasts.

## Owner feedback pass (2026-10-15)

From the first hand test:

- **Dropdowns always look like controls.** `QuietSelect` now rests with
  the fill and border it used to show only on hover (`--tb-n-3` /
  `--tb-n-7`). Hover brightens the border (`--tb-n-10`), focus turns it
  blue.
- **Right margin:** the row label cell gained `paddingRight: 8`. The
  column math (`ROW_FIXED`) already reserved those 8 px, but the cell
  ended flush with the card frame.
- **Two-finger pan like Tracks:** the wheel handler now follows the
  Tracks model. On a trackpad, vertical scrolls the layer list and
  horizontal pans time; Cmd/Ctrl or pinch zooms. A mouse wheel zooms over
  the timeline, and Shift or the labels column scrolls the list. The old
  handler sent vertical deltas to time panning, so the list could never
  scroll.
- A viewer whose pane width was saved at the old 280 default sees Parent
  but not Blend, because Blend drops first. Double-clicking the pane edge
  resets to 320, where both fit.
- **Easing chip in Layers (2026-10-16):** the dock's "easing" chip now
  shows on the Layers tab too, sharing Tracks' flag. LayersEditor mounts
  the same `EasingEditorOverlay`, pinned top-right under the ruler, with
  Tracks' pair model. A grouped lane feeds every member param, so easing
  a Position pair eases X and Y together. It's applied per param with the
  overlay's gesture key (one undo).
- **Graph Editor ghost curves now follow pan / zoom (2026-10-16):** with
  two or more lanes visible, the non-active curves were drawn through
  their own fixed auto-fit, so vertical pan and zoom moved only the active
  curve (the shared time axis already moved all of them). The view now
  remembers the window its last fit set (`yRest`: activation, refit, F),
  and each ghost applies the active view's relative pan and zoom to its
  own fit. At rest nothing changes; while panning, every curve moves
  together.

## Risks / things to measure

- **The compose fix changes existing renders** for rotated or scaled parent
  Gizmos. List the affected fixtures when M0 lands. It's a correctness fix,
  so don't add a flag.
- **The `__xform` id convention** must not collide with real ids or leak
  into saves, undo, or the MCP node list. The M1 gate covers it.
- **The fused blend + transform** shader adds a dependent texture read. Run
  `bench:nodes` on the layer before and after, at 4K. Identity layers must
  show no change, because the shortcut path is unchanged.
- **Shortcut-scope move**: Layers no longer keeps the node scope alive. Test
  that Delete, Cmd+C/V and Cmd+G behave as decided in §5, not by accident.
- **D5 key sliding** changes how opacity keys behave on existing projects
  when a bar is moved (from now on, not retroactively). The owner should
  confirm.

## Non-goals / deferred (§9)

- **Vector transform path** (D1 phase 2): expose the layer's world
  transform on the interior Layer Input, so primitives and text inside can
  apply it and re-rasterize sharply. Add a per-layer toggle
  ("Continuously rasterize"). With it on, the compositor skips its raster
  transform.
- Skia export of layer transforms (D4).
- Pick-whip dragging, parent-space gizmo handles, 3D layers, motion blur,
  inheriting opacity from a parent (AE doesn't either), and keyframe
  compensation when parenting animated layers.
- Track mattes. They're a natural next column (AE's TrkMat), and the layer
  matte uniforms already exist in `BLEND_FS`. This would be its own spec.
