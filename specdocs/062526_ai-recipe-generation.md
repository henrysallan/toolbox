# Spec: AI Recipe Generation (LLM-authored node-group recipes)

A user types "make me a halftone-dots-from-luminance node" on the live
site. A Claude API call returns a **node graph composed entirely of
existing built-in nodes**, wrapped as a node-group ("recipe"), validated,
and dropped onto the canvas. No new code runs. No rebuild. The output is
**data, not code** — every node in the generated graph is a trusted
built-in, so there is no sandbox to build and no untrusted execution.



---

## 0. Current state to build on

Everything this feature needs already exists except (a) the catalog
generator, (b) the server route, (c) an engine-side validator, and (d) a recipe library. The structural machinery is done.

- **Registry is enumerable.** `allNodeDefs()`
  ([registry.ts:16](../src/engine/registry.ts)) returns every registered
  `NodeDefinition`; `getNodeDef(type)` looks one up. Defs are
  self-describing — `name`, `category`, `description`, `inputs`, `params`
  (with `min`/`max`/`default`/`options`), `primaryOutput`, `auxOutputs`
  (types.ts:1032).
- **Node minting is one call.** `makeInstanceNode(type, position)`
  ([graph-ops.ts:82](../src/state/graph-ops.ts)) builds a node with every
  param at `def.default`, resolves + caches `inputs`/`auxOutputs`/
  `primaryOutput`, appends the universal mask input, and stamps
  `terminal`/`active`. **The generator routes every node through this**, so
  the LLM never authors derived/cached fields.
- **Subgraph insertion is one call.** `cloneSubgraph(selection, edges,
  offset, { parentId })` ([graph-ops.ts:1198](../src/state/graph-ops.ts))
  mints fresh ids, remaps edges and `parentId` chains, and retargets
  top-level nodes into a scope. Used by paste, Shift+D duplicate, and
  presets.
- **Presets are the precedent.** `PresetDef`
  ([presets.ts:35](../src/state/presets.ts)) +
  `groupFragment()` ([presets.ts:72](../src/state/presets.ts)) already wrap
  a hand-built interior in a `node-group` shell + `group-input`/
  `group-output` boundary nodes, sync the interface, and promote params.
  Insertion path: [EffectsApp.tsx:1899](../src/components/effects/EffectsApp.tsx)
  detects `preset:*`, calls `build()`, runs `cloneSubgraph`, auto-wraps
  into a layer at root. **A recipe is a preset whose `build()` came from an
  LLM instead of a hand-written function.**
- **Groups dissolve at eval.** `flattenGraph`
  ([flatten.ts:150](../src/engine/flatten.ts)) splices the group's interior
  into the flat graph and discards the shell — a recipe costs exactly its
  constituent nodes, nothing more.
- **Handles have stable builders.** `makeSourceHandleId`/
  `makeTargetHandleId`/`makeParamTargetHandleId`/`newNodeId`
  ([graph.ts:75](../src/state/graph.ts)); `parseTargetHandleKind`
  ([graph-helpers.ts:11](../src/engine/graph-helpers.ts)).
- **Round-trip is automatic.** `serializeGraph`/`deserializeGraph`
  (project.ts, `CURRENT_SCHEMA = 4`) already persist arbitrary node-groups.
  A saved recipe is just a serialized subgraph.

**What does NOT exist yet:**
- Connection validation is React-bound. `isValidConnection`
  ([NodeEditor.tsx:1043](../src/components/effects/NodeEditor.tsx)) and
  `canCoerce` ([NodeEditor.tsx:741](../src/components/effects/NodeEditor.tsx))
  are pure in logic but live inside the component. They must be lifted into
  `src/engine/` to be reused by the validator (and ideally to dedupe the UI).
- No reusable toposort / cycle check. The evaluator orders internally but
  exposes nothing. Net-new (~30 lines).
- No catalog generator, no server route, no recipe storage.


---

## 2. Scope

**In (v1):**
- A node **catalog generator** that emits a machine-readable description of
  every non-hidden node def from the registry.
- A **server route** (`POST /api/generate-recipe`) that calls the Claude
  API with the catalog + few-shot examples + the user's request and returns
  a minimal graph in an intermediate **RecipeGraph** format.
- A **builder** that turns RecipeGraph → real nodes/edges via
  `makeInstanceNode` + `groupFragment`, then inserts via `cloneSubgraph`.
- An **engine-side validator** (`src/engine/graph-validation.ts`) reusing
  the editor's connection rules + a new toposort, run server-side in a
  **generate → validate → repair** loop before anything reaches the client.
- A **recipe library**: save a generated (or any) node-group as a reusable
  recipe; instantiate it like a preset.
- Param authoring restricted to the **plain-JSON param types** (§7).

**Out (v1):**
- Generating new node *code* of any kind (that's `customnodespec`).
- Authoring media/structured params from the LLM (`paint`, `curves`,
  `merge_layers`, file types — §7).
- Editing the user's existing graph in place ("refactor my selection"). v1
  generates a **self-contained** recipe the user wires in themselves.
- A sharing marketplace for recipes (local/Supabase library only).
- On-canvas screenshot verification as a *blocking* gate (it's an optional
  polish loop — §10).

---

## 3. Architecture (three artifacts + a loop)

```
 CLIENT (has the engine)                    SERVER (thin Claude proxy)
 ───────────────────────                    ──────────────────────────
 buildCatalogDsl() ─┐
 user prompt ───────┼─▶ POST /api/generate-recipe ─▶ Claude API
                    │       {catalog, request, repair?}    │ system = preamble
                    │                                       │   + cached catalog
                    │   ◀──────── RecipeGraph ◀────────────┘   forced emit_recipe tool
                    ▼
   buildRecipe(RecipeGraph) ─▶ {nodes, edges}  (groupFragment-wrapped)
                    ▼
   validateGraph(...) ──errors?──▶ re-POST with {repair:{recipe,errors}} ⟲ (≤N)
                    │ ok
                    ▼
   cloneSubgraph(...) ─▶ insert at scope ─▶ canvas   /   "Save as recipe" ─▶ library
```

**Architecture decision (forced by the prototype):** build + validate + the
repair loop run **client-side**, not on the server. The engine (`src/engine` +
`src/nodes`) is browser-oriented — ~10 node modules touch `document`/WebGL at
import — so importing it in the Node server runtime crashes. The route is
therefore a **thin Claude proxy**: it only assembles the prompt and calls
Claude. The client already hosts the full engine, so it owns `buildRecipe` +
`validateGraph` and drives the repair loop by re-POSTing prior errors. Trade-off:
each repair is a round trip, but the proxy stays trivial and the catalog (which
*can't* be generated server-side without the node tree) is built once on the
client and sent in — prompt-cached as the system suffix so it's still cheap.

---

## 4. The node catalog (Claude's context)

Generated from `allNodeDefs()` — **never hand-maintained, never drifts.**

For each def where `!def.hidden` (this filter excludes back-compat aliases
**and** the structural internals `node-group`/`group-input`/`group-output`/
`layer`, which the LLM must never place directly — the builder adds the
wrapper):

```jsonc
{
  "type": "halftone",
  "name": "Halftone",
  "category": "image", "subcategory": "modifier",
  "description": "<def.description>",
  "inputs":  [ { "name": "image", "type": "image", "required": true },
               { "name": "mask",  "type": "mask",  "required": false } ],
  "outputs": { "primary": "image",
               "aux": [ { "name": "element", "type": "element" } ] },
  "params":  [ { "name": "dotSize", "type": "scalar", "min": 0, "max": 1,
                 "default": 0.2, "settable": true },
               { "name": "pattern", "type": "enum",
                 "options": ["dots","lines"], "default": "dots",
                 "settable": true },
               { "name": "texture", "type": "file", "settable": false } ]
}
```

Notes:
- **`settable`** marks whether the LLM may set the param (plain-JSON types,
  §7) or only place the node and leave the param at its default (media /
  authoring types). The catalog still lists non-settable params so the LLM
  understands the node, but it's told never to emit values for them.
- **Inputs** use the static `def.inputs`. Polymorphic nodes
  (`resolveInputs`/`resolvePrimaryOutput`) carry a `"dynamic": true` flag
  and a short note (e.g. "output type follows the wired input"); the
  validator resolves their real types during the topo pass (§6).
- The universal **`mask` input** and the universal **`opacity` param** are
  documented once globally, not repeated per node (they're appended by the
  evaluator, not the def).
- **Coercion rules** (§6) are included as a short global table so the LLM
  knows e.g. `scalar → vec3` and `image ↔ element` wires are legal.

**Token budget — measured (milestone 1 prototype).** The generator
(`src/engine/node-catalog.ts`, dumped via `scripts/dump-node-catalog.mts`)
emits **159 visible nodes** (167 registered − 8 hidden) carrying **1,156
params**. Weight by serialization (approx tokens, char heuristic):

| Format | ~tokens |
|---|---|
| Full JSON w/ descriptions, minified | 40k–49k |
| Minified JSON, no descriptions | 33k–40k |
| **Compact line-DSL** (sockets + settable params, no descriptions) | **12k–14k** |
| Sockets only | 8k–10k |

The **compact DSL** — one line per node, e.g.
`displace (Displace) [image/modifier] ~dyn: in image:image!,displacement:image! -> image | amountX:scalar=0.05(-1..1) channelX:enum="r"[r|g|b|a|luminance] …`
— is ~3.4× denser than minified JSON and carries everything the LLM needs
to pick and wire nodes. **Use it as the cached prompt prefix, not JSON.**
Adding one-line descriptions back lands ~20k–22k — still cheap once
prompt-cached (full price once per ~5-min window, ~10% on hits).
Descriptions cost ~8k–9k tokens but materially help node selection; keep
them trimmed to one line.

**Conclusion: a full cached catalog is affordable — no retrieval pre-pass is
needed for cost.** Retrieval may still sharpen accuracy by narrowing the
model's attention, but it's optional, not a token necessity.

**Dynamic-fan-in caveat (measured).** 43/159 nodes (27%) are polymorphic
(`~dyn`). Most retype existing sockets and the validator's topo pass handles
them. But a subset build their *socket count* from a non-settable array
param — **Merge** (`merge_layers` → N `layer:<id>` inputs), **Auto Layout**
(`autolayout_items` → N `item:<id>` slots). Their catalog baseline shows
only the first socket (`merge (Merge): in base:image! -> image`), so the LLM
literally cannot express "combine these 5 layers" through params alone.
Since compositing is fundamental, v1 must **special-case this handful in the
builder**: let the RecipeGraph declare N inputs on such a node and have the
builder synthesize the matching `merge_layers`/`autolayout_items` array +
dynamic sockets. Nodes not special-cased and not single-input are excluded
from the LLM palette in v1. (This is the first concrete "vocabulary gap"
the prototype surfaced — see §9.)

---

## 5. The RecipeGraph contract (what the LLM emits)

The LLM does **not** emit `NodeDataPayload` or `SavedProject` — too much
derived state to get wrong. It emits a minimal graph keyed by **local
ids**; the builder fills everything mechanical.

```jsonc
{
  "name": "Halftone From Luminance",
  "description": "Converts image luminance into halftone dots.",
  "nodes": [
    { "id": "n1", "type": "halftone", "params": { "dotSize": 0.15 } },
    { "id": "n2", "type": "levels",   "params": { "gamma": 1.4 } }
  ],
  "edges": [
    { "from": "n1:out",            "to": "n2:in:image" },
    { "from": "n2:out",            "to": "n1:in:image" }
  ],
  "inputs":  [ { "name": "image", "from": "n2:in:image", "type": "image" } ],
  "outputs": [ { "name": "image", "from": "n1:out",      "type": "image" } ],
  "exposed": [ { "name": "Dot Size", "node": "n1", "param": "dotSize" } ]
}
```

Edge endpoint grammar (the builder translates to real handles):
- `"<localId>:out"` → `out:primary`
- `"<localId>:aux:<name>"` → `out:aux:<name>`
- `"<localId>:in:<socket>"` → `in:<socket>`
- `"<localId>:param:<name>"` → `in:param:<name>` (and the builder adds
  `<name>` to the target's `exposedParams`)

`inputs`/`outputs` declare the recipe's **external interface** — which
interior sockets become the group's boundary sockets. `exposed` declares
which interior params surface on the group (promoted params,
[graph-ops.ts:42](../src/state/graph-ops.ts)).

### Builder (`buildRecipe`)

1. For each RecipeGraph node: `makeInstanceNode(type, autoPos)` → real node
   with defaults + cached sockets. Apply `params` overrides on top (only
   `settable` keys; reject others). Map `localId → realId`.
2. For each edge: translate endpoint grammar to handle ids via the
   `makeSourceHandleId`/`makeTargetHandleId`/`makeParamTargetHandleId`
   builders; emit `{ id: newEdgeId(), source, sourceHandle, target,
   targetHandle }`. For `param` targets, push the param onto the target
   node's `exposedParams`.
3. Wrap the interior with **`groupFragment(interiorNodes, interiorEdges,
   { inputs, outputs, exposed })`** — the exact helper presets use
   ([presets.ts:72](../src/state/presets.ts)) — synthesizing the
   `node-group` shell + `group-input`/`group-output` boundary nodes,
   wiring boundary edges (`in:<sock>` / `out:aux:<sock>`), syncing the
   interface (`syncGroupInterface`), and promoting `exposed` params.
4. Return `{ nodes, edges }` exactly like `PresetDef.build()`. Insertion
   reuses the existing preset path (`cloneSubgraph` + root-layer wrap).

The builder is the **trust boundary**: even malformed RecipeGraph can only
produce nodes via `makeInstanceNode` and edges between named handles. It
cannot inject behavior.

---

## 6. Validation & repair

Runs server-side on RecipeGraph (and again on the built nodes/edges as a
backstop) before the client sees anything.

New module **`src/engine/graph-validation.ts`** (engine-side per invariant
#1, so it runs server-side *and* dedupes the UI's copy):

1. **Type exists** — `getNodeDef(node.type)` for every node; reject hidden/
   structural types.
2. **Params conform** — each `params` key exists on the def, is `settable`,
   and its value matches the param type / `min`/`max` / `options`.
3. **Handles exist** — every edge endpoint resolves to a real socket: the
   source output (`primary` or an `aux` name) and the target input or param
   exist on their def.
4. **Resolution-first typing (as built).** Instead of porting the editor's
   `isValidConnection` and its hardcoded defType exceptions, resolve the
   whole graph in topological order: for each node, call
   `resolveInputs`/`resolvePrimaryOutput`/`resolveAuxOutputs` with a
   `connectedTypes` map built from already-resolved upstream outputs (the
   evaluator's own pattern), and append the universal mask input via
   `withMaskInput`. This yields each socket's **real** type — polymorphic
   nodes (Math, Copy-to-Points `instance`, Displace, Array) and group
   boundary nodes (sockets from `params.sockets`) all resolve uniformly, so
   the exception list is unnecessary.
5. **Types compatible** — with real types in hand, a single `coercible(src,
   tgt)` check is the only rule. Canonical table (matching coerce.ts):
   `mask ↔ image`, `scalar → vec2|vec3|vec4|uv`, `image|mask → scalar`,
   `audio → scalar`, `image ↔ element`. A param target (`in:param:<name>`)
   is drivable only if `paramSocketType(p.type)` is non-null (rejects
   enum/string/structured params with `PARAM_NOT_DRIVABLE`).
6. **Acyclic** — new `topologicalSort(nodes, edges): string[] | null`
   (Kahn's algorithm). Note recipes are typically small DAGs; the *feedback*
   cases real graphs allow (via simulation zones) are out of scope for v1
   recipes — reject cycles.
7. **Required inputs** — warn (not reject) when a `required` input has no
   incoming edge and no recipe-boundary input feeding it.

Validation returns a structured error list. On any error, run a **repair
turn**: feed the errors back to the model (max ~3 iterations), then give up
with a user-facing "couldn't build a valid recipe" rather than inserting a
broken graph. This loop is entirely server-side and needs no browser.

**"Valid but wrong"** — static validation proves the graph *runs*, not that
it *looks right*. That gap is the optional screenshot loop (§10) and,
failing that, the user's eyes.

**Addendum (2026-07-09) — per-def param checks.** `validateGraph` step 1 now
also calls the def's optional `validateParams(params)` hook (types.ts) and
reports each returned message as a `PARAM_INVALID` error. First implementer:
Point Expression, which compiles + smoke-runs its per-point kernel so
expression code that would fail *silently* at runtime (strict-mode
ReferenceErrors, `return`-style blocks) reaches the repair loop. Relatedly,
the generate preamble's "You never write code" rule was dropped (expression
params are authored code), `buildRecipe`/`applyRecipeEdit` auto-mint
ch()/pick() channels for authored expressions since `expr_inputs` isn't
settable, and channel sockets are addressable by channel NAME in recipe
edges/inputs (`pe:in:speed` — `resolveChannelHandle` aliases onto the
id-based socket, since ids are minted at build time and unknowable to the
LLM) — see 070726_point-expression-node.md, addendum.

---

## 7. Param authoring constraints

The LLM may set only **plain-JSON param types** (those ParamPanel renders
generically and that serialize as `out[key] = val`):

> `scalar`, `vec2`, `vec3`, `vec4`, `color`, `boolean`, `enum`, `string`

Walled off (`settable: false` in the catalog; builder rejects values):

- **Media / handle-bearing:** `file`, `font`, `font_variations`,
  `video_file`, `image_sequence`, `svg_file`, `audio_file`, `lut_file`,
  `model_file`. These don't round-trip JSON (project.ts strips them to
  relink envelopes) and the LLM has no file to point at.
- **Authoring-heavy structured:** `paint`, `color_ramp`, `curves`,
  `spline_anchors`, `merge_layers`, `autolayout_items`, `gradient_points`,
  `render_queue`. No LLM should hand-author bezier control points or a
  paint bitmap as raw JSON.

A node with a non-settable param is still **placeable** — it just keeps the
param at `def.default`, and the user fills the artistic value afterward
(the recipe sets up structure; the human supplies the art). The model is
told this explicitly.

---

## 8. Recipes as saved node-groups

A **recipe = a serialized node-group subgraph** + metadata
(name/description/thumbnail). No new persistence format:

- **Save:** select a group (or the just-inserted recipe), serialize its
  subgraph (the `serializeGraph` machinery already handles node-groups),
  store under a `recipes` Supabase table (mirrors the `projects` table) or
  a local library. Stash the RecipeGraph JSON alongside for editability and
  as a future few-shot example.
- **Instantiate:** load the subgraph, run it through `cloneSubgraph` with
  fresh ids — identical to the preset insertion path. Recipes can even be
  surfaced in the same Add menu as a `recipe:*` category beside `preset:*`.
- **Round-trip / back-compat:** a recipe references node `type` strings and
  param names; invariant #2 (never repurpose a type/param without a
  migration) already guarantees recipes keep loading. A node whose params
  *expanded* simply fills new defaults.

The hand-built `PRESETS` ([presets.ts:428](../src/state/presets.ts)) double
as the **seed few-shot set** and a validation oracle — they're known-good
RecipeGraphs by construction.

---

## 9. The vocabulary-gap signal (the virtuous loop)

When the repair loop fails because no node can express what the user asked
(e.g. "Voronoi shatter" with no Voronoi node), the server logs the
unsatisfiable request as a **missing-primitive signal**. These aggregate
into a ranked backlog of real nodes worth hand-building (the
`customnodespec` / dev-node path). Each new primitive shipped widens the
recipe vocabulary for every future generation. Recipes handle the long tail
of *compositions*; humans handle the short head of *primitives*.

---

## 10. Verification (optional polish)

Static validation guarantees validity, not correctness. Optional loop:
after building, evaluate the recipe headlessly against a stock test image
and return a thumbnail (the engine already renders offline via
`ctx.offline`, export pipeline) so the user — or a vision check — confirms
it *looks* right and iterates in chat. Not a blocking gate for v1; the user
can just look at the canvas.

---

## 11. Security & trust

Dramatically smaller than the code-gen path, but not zero:

- **No code executes.** A recipe is data; every node is a trusted built-in.
  Loading a shared recipe is exactly as safe as loading any shared project.
- **The server route is the only new attack surface** — standard LLM-app
  hygiene: authenticate, rate-limit, cap output size, never `eval` the
  model's output (the builder only ever calls `makeInstanceNode` + handle
  builders), and validate before insertion.
- No public-project sandbox/confirm modal is needed (contrast
  `customnodespec` §12) — there is nothing to sandbox.

---

## 12. Where the LLM runs

On the **live site**, this is a normal server route (a Vercel function)
calling the **Claude API** — *not* an MCP server. MCP extends Claude Code /
agents in a dev loop; it has no role in a deployed product feature. Use the
AI SDK through the Vercel AI Gateway (or a direct Anthropic call) with:

- the generated catalog as a **prompt-cached** system prefix,
- few-shot RecipeGraphs (from `PRESETS` + curated saves),
- a **forced structured output** matching the RecipeGraph schema (so the
  model returns validated JSON, not prose),
- the repair loop as additional turns on validation failure.

Default to the latest Claude model. Keep the engine-side validator and
catalog generator pure/Node-safe so the same code runs in the function and
in the browser.

---

## 13. Implementation milestones

Each leaves a working app.

1. **Catalog generator.** ✅ *Prototyped.* `src/engine/node-catalog.ts`
   (pure `buildNodeCatalog(defs, opts)`) + `scripts/dump-node-catalog.mts`
   (browser-global shims → `registerAllNodes()` → measure). 159 visible
   nodes, ~12k–14k tokens as the compact DSL (§4). Remaining: trim
   descriptions to one line, decide the final wire format, sanity-check the
   catalog against the live Add menu.
2. **Validator + toposort.** ✅ *Prototyped.* `src/engine/graph-validation.ts`
   (`validateGraph(nodes, edges)` + `topologicalSort`), proven by
   `scripts/check-validator.mts`: all 5 `PRESETS` pass with **0 errors / 0
   warnings** (group structure, promote edges, and polymorphic
   `copy-to-points`/`array` sockets included); 5 broken fixtures each fail
   with the expected code (`NODE_UNKNOWN_TYPE`, `GRAPH_CYCLE`,
   `EDGE_UNKNOWN_INPUT`, `EDGE_TYPE_MISMATCH`, `PARAM_NOT_DRIVABLE`).
   **Design note:** rather than port the editor's `isConnectionValid` +
   its hardcoded defType exceptions, the validator resolves the whole graph
   in topological order, calling each def's `resolveInputs`/
   `resolvePrimaryOutput` with a `connectedTypes` map (the evaluator's own
   approach). Polymorphic sockets and group boundary nodes resolve to their
   *real* types, so the exception list disappears and only the genuine
   coercion table remains — more correct and less to maintain. Engine-pure,
   lint-clean.
3. **Builder + manual insertion.** ✅ *Prototyped (data path).*
   `src/state/recipe-builder.ts` (`buildRecipe(RecipeGraph)` → `{nodes,
   edges, issues}`). To honor "reuse `groupFragment`", that helper was
   extracted from presets.ts into `src/state/group-fragment.ts` and extended
   to wire real **data inputs** (presets only needed promoted-param inputs);
   presets re-import it and still validate clean (no regression).
   `scripts/check-builder.mts` proves the **round trip headlessly**: a
   well-formed RecipeGraph builds with 0 issues and `validateGraph` returns
   green (group wrapper synthesized, exposed param recorded); bad wiring
   still builds (trust boundary) but the validator flags `EDGE_TYPE_MISMATCH`;
   a malformed recipe (unknown type, non-settable param, dangling edge)
   surfaces the right build issues and still yields a valid survivor graph.
   Engine/state-pure, lint-clean. **Canvas insertion: ✅ wired** — see the UI
   bullet under milestone 4. **Deferred to §4 caveat:** the Merge / Auto-Layout
   dynamic-fan-in special-case (declare N inputs → synthesize `merge_layers`/
   `autolayout_items`); not yet in `buildRecipe`.
4. **Server route + generate loop.** ✅ *Prototyped (offline-proven).*
   - `src/lib/ai/recipe-prompt.ts` — pure preamble + the `emit_recipe` tool
     schema + system/user builders (`import type` only, so the route never
     loads the engine).
   - `src/app/api/generate-recipe/route.ts` — Next 16 route handler, **thin
     Claude proxy**: `@anthropic-ai/sdk`, `claude-opus-4-8`, forced
     `tool_choice` on `emit_recipe`, catalog cached as the system suffix.
   - `src/lib/ai/generate-recipe-client.ts` — `generateRecipe(request)`:
     builds the catalog DSL (via `formatCatalogDsl`, exported from
     node-catalog), POSTs, then `buildRecipe` + `validateGraph` + the repair
     loop (re-POST with prior errors, ≤N). `post` is injectable.
   - `scripts/check-recipe-loop.mts` proves the loop **without a live call**
     (fake model): good→1 attempt, bad→good→2 attempts (the validator's
     `Incompatible wire` error reaches the repair turn), always-bad→gives up
     after 3 and surfaces the error. Lint-clean; `@anthropic-ai/sdk` added.
   - **UI + insertion: ✅ wired.** `src/components/effects/RecipePromptModal.tsx`
     (prompt box: textarea, example chips, busy/error states, ⌘/Ctrl+Enter).
     `NodeSearchPopup` gets an "AI Recipe…" entry (Shift+A → under Presets,
     searchable, shown at root too) whose `ai-recipe` pseudo-type opens the
     modal via an `onAddNode` sentinel. `EffectsApp.handleGenerateRecipe`
     runs `generateRecipe` → on success inserts the built fragment through the
     exact preset path (`cloneSubgraph` + root-layer wrap + select + toast);
     on failure the modal shows the first validator error so the user can
     refine. Whole project typechecks clean; new files lint-clean.
   - **Remaining (only blocker for live use):** set `ANTHROPIC_API_KEY` in the
     server env (`.env.local` today only has Supabase keys), then a real
     in-app generation. The adaptive-thinking option on the route is omitted
     for now (forced tool + no-thinking is the lowest-risk untested config) —
     easy to add once the key is in place to test against.
5. **Recipe library.** Save/load recipes (Supabase `recipes` table or local
   store); surface as a `recipe:*` Add-menu category. Feed good saves back
   as few-shots.
6. **Polish.** Retrieval pre-pass if the catalog is too heavy; optional
   headless thumbnail verification; missing-primitive logging (§9).

---

## 14. Open questions

- **Catalog token weight.** ✅ *Resolved (milestone 1).* Full catalog is
  ~12k–14k tokens as the compact DSL (~20k–22k with one-line descriptions) —
  cheap enough to cache wholesale; no retrieval pre-pass needed for cost
  (§4). Open sub-question: keep descriptions inline vs. fetch on demand.
- **Feedback / simulation zones.** Real graphs allow cycles through
  simulation zones. v1 recipes reject cycles; revisit if users want
  generated feedback loops.
- **Recipe editing.** Does "edit this recipe" re-prompt with the prior
  RecipeGraph as context, or just open the group for manual editing? Lean
  on manual editing for v1 (it's a normal node-group).
- **In-place graph edits.** "Apply X to my current selection" is a strictly
  harder problem (the model must read existing graph state). Deferred; v1
  generates self-contained recipes.
- **Determinism / caching.** Identical prompts could be cached to a known
  recipe to save tokens and guarantee a known-good result. Nice-to-have.

---

## 15. Things explicitly NOT in this spec

- Generating node *code* (JS/GLSL) — see `customnodespec.md` and the GPU
  follow-up. This doc is data-only.
- A sandbox of any kind. Recipes need none.
- Authoring media or structured params from the model.
- A recipe marketplace / cross-user sharing system beyond the library.
- Editing the user's existing graph in place.
- MCP integration (that's a Claude-Code dev-loop concern, not a product
  feature).
