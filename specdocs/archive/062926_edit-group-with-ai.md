# Spec: Edit a Node-Group with AI

Right-click a node-group → **"Edit with AI"** → the AI panel opens with that
group attached as context → you type an instruction ("make the dots bigger near
the center", "add a blur after the stroke", "expose the rotation") → an LLM call
returns a **patch** that's applied to the group in place, validated, and
undo-able. Iterative: each instruction is a turn in a short chat.

Builds directly on AI Recipe **Generation**
([062526_ai-recipe-generation.md](062526_ai-recipe-generation.md)) and reuses
almost all of its machinery. The difference is editing, not authoring — and
that one difference drives the whole design.

---

## 0. The one new problem: editing means *preservation*

Generate is "empty → recipe." Edit is "existing group + instruction → modified
group." The hard part isn't producing the change — it's **not destroying what
you didn't ask to change**:

- interior **keyframes / animation** (`data.animation`, `data.clips`),
- carefully-tuned **param values**,
- **node identity** (so undo/history and any per-node state survive),
- the **external wires** feeding the group from the rest of the project.

Every decision below follows from "preserve by default, change by exception."

---

## 1. The core decision — what the LLM emits

Two paradigms:

**A. Full re-emit (replace).** Show the group as a RecipeGraph; the model emits
a *new* full RecipeGraph; we rebuild the group. Reuses the entire generate
pipeline (`emit_recipe` tool, `buildRecipe`, `validateGraph`) almost unchanged.
- ✅ Lowest effort.
- ❌ **Loses animation/keyframes** — the RecipeGraph format only carries static
  param values, not `animation`/`clips` — and needs a reconcile pass to map
  stable ids back to live nodes; risks the model silently changing unrelated
  parts. Fragile for editing real work.

**B. Patch / operations — RECOMMENDED.** The model emits a small list of **edit
ops** against the current group; we apply them to the live interior, leaving
everything else untouched.
- ✅ **Preserves untouched work by construction** — animation, ids, external
  wires all survive because we never rebuild a node an op didn't touch. Smaller
  output for small edits. Models reason about explicit deltas well.
- ❌ New machinery: an op schema + an apply function.

For an *editor*, preserve-by-default (patch) is the correct semantics. **Build
B.** A is the "ship in a day, lose keyframes" fallback only if groups are mostly
un-animated.

---

## 2. Scope

**In (v1):**
- "Edit with AI" on `node-group` nodes (context menu) → AI panel in **edit
  mode** with the group as a context chip.
- An `edit_recipe` LLM call that returns `{ summary, ops[] }`.
- Interior ops: `set_param`, `add_node`, `remove_node`, `add_edge`,
  `remove_edge`, plus `expose_param` / `unexpose_param`.
- Apply → `validateGraph` → repair loop → commit **in place** (group shell id +
  interface preserved), one undo snapshot per turn.
- A lightweight chat transcript (instruction → the model's one-line summary) for
  iterative refinement.

**Out (v1):**
- **Full re-emit** as the primary path (kept only as a documented fallback).
- **Raw interface ops** — adding/removing a brand-new data input/output socket
  (touches boundary nodes + `syncGroupInterface`; orphan-wire risk). `expose_param`
  already mints interface inputs; defer the rest.
- **Animation-authoring** ops (the model can't keyframe in v1; it edits static
  structure/params and is *told* which params are already keyframed).
- Editing plain nodes or layers (groups only).

---

## 3. Current state to build on (mostly reuse)

Everything from the Generation feature carries over:

- **Catalog DSL + prompt caching** — `formatCatalogDsl` over `buildNodeCatalog`
  ([node-catalog.ts](../../src/engine/node-catalog.ts)); the cached system suffix.
- **Validator** — `validateGraph` ([graph-validation.ts](../../src/engine/graph-validation.ts))
  vets the edited interior; identical to generate.
- **Repair loop** — the generate→validate→repair pattern
  ([generate-recipe-client.ts](../../src/lib/ai/generate-recipe-client.ts)) applies
  verbatim, with "errors fed back → corrected patch."
- **Thin-proxy route** — same shape as
  [generate-recipe/route.ts](../../src/app/api/generate-recipe/route.ts) (Claude
  call, key resolved server-side from prefs); add an edit mode/tool.
- **AI panel** — [AiRecipePanel.tsx](../../src/components/effects/AiRecipePanel.tsx)
  gains an `editTarget` + transcript; "generate" mode is unchanged.
- **Group helpers** — `readGroupInterface` / `readBoundarySockets`
  ([groups.ts](../../src/engine/groups.ts)); `makeInstanceNode` /
  `refreshNodeSockets` / `syncGroupInterface` and the promote logic
  ([group-fragment.ts](../../src/state/group-fragment.ts)) for apply.
- **Endpoint grammar** — `id:out` / `id:aux:name` / `id:in:sock` /
  `id:param:name` (recipe-builder §5).
- **Trust model** — unchanged: trusted built-in nodes, data-not-code, no sandbox.

**New:** `groupToSpec`, the `edit_recipe` tool + edit system prompt,
`applyRecipeEdit`, the panel edit mode, the context-menu item.

---

## 4. The LLM call

Same thin-proxy shape as generate; the differences are the **context**, the
**tool**, and that we **apply in place** rather than insert.

### 4.1 Request (per turn)

- `model: claude-opus-4-8`, forced `tool_choice` on `edit_recipe`.
- **system** (cached prefix): the node-catalog DSL + edit-mode rules + the op
  grammar.
- **messages**: a short conversation history (prior instructions + the model's
  one-line change summaries) **plus the current group state re-sent every
  turn** as the ground truth — so "a bit less" edits the *actual current graph*,
  not a stale memory.

### 4.2 The group context — `groupToSpec(groupId)`

The inverse of `buildRecipe`: serialize the live group to an editable spec the
model can reference and patch. Uses **real node ids** (apply runs client-side,
so no local-id remapping is needed):

```jsonc
{
  "name": "Cover · Envelope",
  "nodes": [
    { "id": "points-on-path-a1b2", "type": "points-on-path",
      "params": { "count": 160 }, "exposed": ["count"], "keyframed": [] },
    { "id": "string-art-c3d4", "type": "string-art",
      "params": { "k": 2 }, "exposed": ["k"], "keyframed": ["k"] }
    // …
  ],
  "edges": [ { "from": "circle-x:out", "to": "points-on-path-a1b2:in:path" } /* … */ ],
  "interface": { "inputs": [], "outputs": [ { "name": "image", "type": "image" } ],
                 "exposed": [ { "label": "Points", "node": "points-on-path-a1b2", "param": "count" } ] }
}
```

- `params` lists only **settable** values (catalog §6).
- `keyframed` flags tell the model "changing this static value won't take
  effect — it's animated," so it avoids no-op edits (§7).
- `interface` comes from `readGroupInterface` + the promote edges.

### 4.3 Output — the `edit_recipe` tool

Forced tool, input `{ summary, ops }`. `summary` is the one-liner shown in the
transcript ("Added a blur after the stroke; exposed its radius").

| op | meaning |
|---|---|
| `set_param {node, param, value}` | retune a settable param on an existing node |
| `add_node {id, type, params?}` | new interior node (`id` is a fresh local id) |
| `remove_node {node}` | delete a node + its incident edges |
| `add_edge {from, to}` / `remove_edge {from, to}` | wire/unwire (endpoint grammar; new nodes referenced by their local id) |
| `expose_param {node, param, label?}` / `unexpose_param {node, param}` | surface/hide a knob on the group interface |
| `rename_node {node, name}` | optional cosmetic |

Open-object `params` (same reasoning as `emit_recipe` — strict schemas can't
express an arbitrary param map; the apply + validator are the real guarantee).

---

## 5. Apply → validate → repair → commit

A new client-side `applyRecipeEdit(groupId, ops)`; everything around it is reused.

1. **Apply** onto a clone of the group's interior nodes/edges:
   - `set_param` → merge into `node.data.params` (reject non-settable/unknown →
     issue).
   - `add_node` → `makeInstanceNode(type)` + `parentId = groupId` +
     `refreshNodeSockets`; map the op's local id → the real new id.
   - `remove_node` → drop the node and its incident edges.
   - `add_edge` / `remove_edge` → translate endpoint grammar → handles (new
     nodes via the local→real id map).
   - `expose_param` → toggle `exposedParams` + add the interface input via the
     existing promote logic; `unexpose_param` → the inverse.
   - Re-sync the group interface (`syncGroupInterface`).
2. **Validate** the edited interior with `validateGraph` (same as generate).
3. **Repair loop** — on validator errors, feed them back for a corrected patch
   (≤N turns, identical to generate).
4. **Commit in place** — replace the group's interior in the live graph,
   **keeping the group shell's id and interface socket names stable** so
   external wires survive, with **one undo snapshot per turn**. Apply
   optimistically (already validated); the user undoes if unhappy.

Untouched interior nodes are never rebuilt and the shell id never changes →
animation + external wires preserved for free.

---

## 6. UX

- **Context menu:** add "Edit with AI" to `NodeContextMenu`, gated to
  `node-group` (not layers, not plain nodes).
- **Panel edit mode:** clicking it opens `AiRecipePanel` with an `editTarget`
  and a context chip — "✦ Editing: Cover · Envelope ×" (the attachment-chip
  pattern from the reference UI). The prompt becomes an instruction, not a
  from-scratch generate.
- **Transcript:** the panel grows a lightweight conversation (your instruction →
  the model's `summary`), so refinement reads as a chat. Each turn applies
  immediately and is one undo step.
- **Generate vs edit:** "Generate" mode (no `editTarget`) is unchanged; edit
  mode just carries a target + history and calls the edit path.
- **Re-entrancy:** re-running "Edit with AI" on the same group resumes the same
  transcript; selecting a different group starts fresh.

---

## 7. Sharp edges & decisions

- **Keyframed params:** changing a keyframed param's static value won't take
  effect (keyframes win at eval). The `keyframed` flags in the context tell the
  model to avoid those; if it tries, surface a note rather than a silent no-op.
  Animating params is out of scope for v1.
- **Interface changes stay additive:** v1 allows exposing new params and adding
  nodes; it does **not** rename/remove interface sockets (which could orphan
  external wires). Raw add/remove input/output is a later, careful op.
- **Op validation:** an op referencing a missing node, a non-settable/unknown
  param, or a bad handle becomes an issue in the apply step and feeds the repair
  loop (same model as `buildRecipe`'s issue list).
- **External-wire preservation:** guaranteed by keeping the shell id +
  interface socket names stable; the only way to break a wire is an interface
  rename/remove, which v1 disallows.
- **Conversation drift:** always re-send `groupToSpec` (current truth) each
  turn; the history carries intent, the spec carries state.
- **Trust:** unchanged — trusted built-in nodes only.

---

## 8. Milestones

Each leaves a working app.

1. **`groupToSpec` + `edit_recipe` tool + `applyRecipeEdit` (interior ops).**
   ✅ *Shipped.* [recipe-edit.ts](../../src/state/recipe-edit.ts) —
   `set_param`/`add_node`/`remove_node`/`add_edge`/`remove_edge`/`rename_node`;
   structural (boundary) nodes protected; endpoint helpers shared from
   recipe-builder. Proven by `scripts/check-edit.mts`: a real patch (retune +
   insert node + rewire the output chain) applies clean, the group still
   validates, the param changed, untouched ids are preserved, and bad patches
   (type mismatch / missing node / protected node) are caught.
2. **Edit route + client orchestrator.** ✅ *Shipped.*
   [edit-recipe/route.ts](../../src/app/api/edit-recipe/route.ts) (thin proxy,
   `edit_recipe` tool, key resolved server-side via the shared
   [anthropic-key.ts](../../src/lib/ai/anthropic-key.ts)) +
   [edit-recipe-client.ts](../../src/lib/ai/edit-recipe-client.ts)
   (`editGroupRecipe` = build spec → POST → apply → `validateGraph` → repair
   loop, `post` injectable). Proven by `scripts/check-edit-loop.mts`
   (good→1 attempt; bad→good→2, the validator error reaching the repair turn).
3. **Panel edit mode + context menu.** ✅ *Shipped.* "✦ Edit with AI" on the
   group context menu (gated to `node-group`) → `AiRecipePanel` in edit mode
   (context chip "Editing: …", "Apply" button, edit examples) →
   `handleEditGroup` extracts the group fragment, runs `editGroupRecipe`, and
   **commits in place** (swap the interior, keep external wires via the
   unchanged shell id), one undo step per edit; the panel stays open for the
   next instruction. Whole project typechecks clean; new files lint-clean.
   *Needs an `ANTHROPIC_API_KEY` (same as generate) for a real in-app edit.*
4. **`expose_param` / `unexpose_param`.** ✅ *Shipped.* Interface-via-promote
   ops in `applyRecipeEdit`: `expose_param` adds a group-input socket
   (`paramSocketType`), the `out:aux:<label> → in:param:<param>` promote edge,
   and `exposedParams`/`controlParams`, then `syncGroupInterface` updates the
   shell; `unexpose_param` reverses it. Non-socketable params, duplicate labels,
   and unexposed targets are rejected (→ repair). Tool enum + preamble updated;
   `check-edit.mts` covers expose → validate → unexpose round-trip.
5. **Chat transcript + multi-turn history.** ✅ *Shipped.* A **local-cache**
   transcript ([recipe-chat.ts](../../src/state/recipe-chat.ts): localStorage +
   in-memory mirror, keyed by group id — never leaves the browser). Each
   successful edit appends `{instruction, summary}`; the last ~8 turns thread to
   the model as `history` for follow-up continuity. `AiRecipePanel` renders the
   transcript as a chat (instruction bubble → summary) above the composer, with
   a "clear". `check-edit-loop.mts` proves the store round-trips and history
   threads turn-to-turn.
6. **(Maybe) raw interface ops** — add/remove group input/output, carefully.

---

## 9. Open questions

- **Route shape:** a sibling `/api/edit-recipe`, or unify generate+edit under
  one `/api/recipe` with a `mode` (shares the cached catalog more cleanly)?
- **Re-emit fallback:** worth keeping a "rewrite the whole group" escape hatch
  for very large edits where a patch is awkward, or commit fully to patches?
- **Preview vs immediate apply:** v1 applies immediately + undo. Is a
  diff-preview ("3 changes — apply?") worth it before commit for risky edits?
- **History persistence:** ✅ *Resolved* — a **local cache** (localStorage,
  keyed by group id). Survives reloads, stays on the device, no server
  persistence.
- **Cross-feature:** "Edit with AI" on a group that's also saved as a recipe
  ([062926_node-group-reuse-and-sharing.md](062926_node-group-reuse-and-sharing.md))
  — edit the instance, or offer "update the saved recipe too"?
