# Spec: Node-Group Reuse & Sharing (recipes beyond one project)

How a node-group (a "recipe" — including AI-generated ones) becomes reusable
**across projects and users**, elegantly, without copying every node into every
user's account. Builds on the AI Recipe Generation work
([062526_ai-recipe-generation.md](062526_ai-recipe-generation.md)) and the
cross-instance clipboard that just shipped.

---

## 0. The reframe (why this is mostly plumbing)

Because the engine is self-contained (invariant #1) and a group serializes
through the normal `serializeGraph` path, **a group is portable data, not
code.** Every sharing mechanism just needs to move the same JSON envelope —
`{ schemaVersion, nodes, edges }` — and re-instantiate it with `cloneSubgraph`.

So there is **one primitive**, and every transport is a thin layer over it:

```
serializeFragment(selection)        → portable envelope   (text / file / DB row / URL)
instantiateFragment(envelope, scope) → cloneSubgraph + insert  (+ migration + validation)
```

Two more things make this safe and robust:
- **Trust:** a shared group is **trusted built-in nodes only** — data, not
  code — so importing one is exactly as safe as loading a public project. No
  sandbox, no new attack surface. (Contrast with the custom-code path in
  `customnodespec.md`.)
- **Validation:** `validateGraph` ([graph-validation.ts](../src/engine/graph-validation.ts))
  vets an incoming fragment before insert — it cleanly flags a recipe that
  references a node type the current build doesn't have.

**Storage model — the answer to "don't duplicate to every user":** a recipe is
stored **once**, owned by its author. Consuming it **copies the fragment into
the consuming project at insert time** (which the project needs anyway to stay
self-contained and exportable). Storage is O(recipes), not O(recipes × users).
This is Blender's *append* semantics, and it's the right default (see §8).

---

## 1. Already shipped (the foundation)

- **Cross-instance copy/paste** — [fragment-clipboard.ts](../src/lib/fragment-clipboard.ts):
  `serializeFragmentToText` / `parseFragmentText` / `looksLikeFragmentText` /
  `writeFragmentToClipboard`. Copy writes the envelope to the OS clipboard;
  paste (NodeEditor's `paste` event) routes a fragment envelope to
  `EffectsApp.handlePasteFragmentText` → `insertClonedFragment` (shared with
  the in-memory paste). Works across tabs, instances, and as a shareable text
  snippet. Proven by `scripts/check-fragment-roundtrip.mts`.
- **`insertClonedFragment`** — the shared "clone with fresh ids + drop into the
  current scope (auto-wrap into a layer at root)" insert, reused by paste, the
  preset path, and AI Recipe insertion.

These are the `serializeFragment`/`instantiateFragment` primitive in concrete
form. **Everything below is additional transports + a storage/discovery layer
over the same envelope.**

---

## 2. Scope

**In:**
- A **Recipe Library** — a `recipes` table; save any group as a named,
  reusable recipe; browse + instantiate like a preset; private by default,
  shareable as public.
- **Validate-on-import** of any incoming recipe (reuse `validateGraph`).
- **Discovery** — recipe tags + search (by name / tag / interface type).
- **`.recipe` file** export/import (the durable sibling of the clipboard).
- **Share links** — `/r/[slug]` instantiates a public recipe.
- **Thumbnails + interface cards** for browsability.
- The **AI-generator flywheel** — save generated recipes; feed good public
  recipes back as few-shots.

**Out (v1):**
- **Linked / instanced** recipes (edit the source → all uses update). v1 is
  copy-on-insert (§8). Linked is a much bigger feature; park it.
- A moderated **marketplace** / ratings / featured gallery. Public recipes
  exist; curation is later.
- **Media-heavy** recipes. Procedural groups (the common recipe) carry no
  media and round-trip perfectly. Groups with image sources inline data-URLs
  (heavy); video/audio/fonts relink. Ship procedural-first; treat media
  recipes as best-effort.
- Cross-version handling beyond a **clear error** when a recipe uses a node
  type this build lacks (the validator already produces it).

---

## 3. The Recipe Library (the core)

A recipe is a **standalone, named artifact** — a user-defined preset — stored
once and instantiated on demand. This is the elegant home for reuse; presets
([presets.ts](../src/state/presets.ts)) are the exact precedent, just hardcoded
instead of DB-backed.

### 3.1 Schema (Supabase `recipes`)

```sql
create table public.recipes (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,           -- for /r/[slug]
  owner_id    uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  description text,
  fragment    jsonb not null,                 -- the envelope: { schemaVersion, nodes, edges }
  interface   jsonb not null default '{}',    -- { inputs:[{name,type}], outputs:[...], exposed:[...] }
  tags        text[] not null default '{}',
  visibility  text not null default 'private', -- 'private' | 'public'
  thumbnail   text,                            -- data-URL or storage path (§7)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
```

RLS mirrors `projects`: owner can CRUD their rows; **anyone can `select` rows
where `visibility = 'public'`**. (Migration convention: `specdocs/*-migration.sql`,
idempotent, `begin/commit`, RLS policies + grants — see the projects/user-prefs
migrations.)

`interface` is extracted at save time from the group's boundary nodes
(`readGroupInterface` / `readBoundarySockets`, [groups.ts](../src/engine/groups.ts))
so the browser can show input/output socket types and search can filter by them
without parsing the whole fragment.

### 3.2 Save-as-recipe

"Save selection as recipe" (context menu on a selected `node-group`, or a
button on the group's param panel):
1. `expandWithDescendants` the group → fragment nodes + internal edges.
2. `serializeFragmentToText` → the envelope (reuse the shipped primitive).
3. Extract `interface` from the group's boundary sockets.
4. Insert a `recipes` row (private, owner = current user).

Only a **non-layer `node-group`** is saveable (layers are root-only composition,
not reusable units).

### 3.3 Browse + instantiate

A recipe browser — simplest first cut: a **"Recipes" section in the Shift+A
palette** (parallel to "Presets"), listing the user's recipes + (later) public
ones. Picking one:
1. Fetch the row, `parseFragmentText`(`fragment`) → SavedProject.
2. `deserializeGraph` → `{ nodes, edges }`.
3. **`validateGraph`** — if it references missing node types, show the error
   instead of inserting a broken group.
4. `insertClonedFragment` — identical to how presets/paste insert.

This is **store-once / copy-on-insert** in action: the recipe row is untouched;
the consuming project gets its own clone.

---

## 4. Discovery: tags + search

- **Recipe-level tags** (preferred): free-form `tags[]` on the row; the
  save dialog suggests tags from the recipe's node types / category.
- **Search** by name, tag, and **interface type** — "recipes that output
  `spline`", "that take an `image` input" — straight off the `interface`
  column.
- **Project-level `has_groups` flag (optional stepping stone):** if we want
  discovery *before* committing to the `recipes` table, auto-set a boolean (or
  a `groups jsonb` summary) on the `projects` row when a non-layer group is
  created, and filter public/private projects by it. This is the user's
  original tagging idea; it's a coarse unit (a *project that contains a group*,
  not the group itself) and only solves discovery — extraction still means
  open-project → copy the group out (now trivial via the clipboard). Treat it
  as a bridge to §3, not the destination.

---

## 5. `.recipe` file export / import

The durable sibling of the clipboard: write the same envelope to a file
(`.recipe`, JSON; or a zip if it carries media, reusing
[project-file.ts](../src/lib/project-file.ts) machinery). Import = file picker →
`parseFragmentText` → validate → `insertClonedFragment`. Good for
git-committing recipes, email, and offline sharing.

---

## 6. Share links

A public recipe's `slug` powers `/r/[slug]` — opening it (or a "use this
recipe" button) instantiates it into the current project. For tiny procedural
recipes we *could* URL-encode the envelope directly (`#<base64>`), but a slug
pointing at a row is better for anything non-trivial (size, updatable,
analytics). Mirrors the existing `/p/[slug]` public-project flow.

---

## 7. Thumbnails + interface cards

On save, render the recipe's output **offline** (reuse the export render path /
`ctx.offline`) to a small PNG, and surface the extracted `interface`
(input/output socket types, exposed knobs) on the browser card. Turns the
library from a flat list into something visually browsable. Optional polish —
the library works without it.

---

## 8. Decisions

- **Copy-on-insert (append), not linked.** Instantiating drops an independent
  copy; later edits to the recipe do **not** ripple into projects already using
  it. The alternative — linked/instanced recipes (AE precomps / Blender "link",
  update-propagates) — needs instance identity, update propagation, and
  break-link-to-edit, and is a much larger feature. Append is the right default
  for a reuse library; flag linked as maybe-later.
- **Trust = public-project trust.** Importing a recipe runs only trusted
  built-in nodes (data, not code). Same model as loading a public project; no
  sandbox. Document it on the public-recipe flow like public projects.
- **Procedural-first on media.** Recipes are best for procedural groups (no
  media). Image sources inline as data-URLs (heavy but works); video/audio/font
  sources relink on insert (same as projects). Don't block media recipes, but
  don't optimize for them in v1.

---

## 9. The AI-generator flywheel

The library and the generator reinforce each other:
- **Generate → tweak → Save as recipe** makes the AI feature a fast way to
  *author* reusable recipes.
- **Public recipes become the generator's few-shot examples** and its
  "vocabulary" of common patterns (the spec's §5 few-shots, sourced from real
  saved recipes instead of hand-written ones).
- When the generator hits the node-vocabulary wall (§4 caveat of the AI spec),
  popular hand-built recipes fill the gap as composite building blocks.

---

## 10. Milestones

Each leaves a working app.

1. **`recipes` table + RLS migration.** Schema, owner-only write, public read.
   No UI yet.
2. **Save-as-recipe + browse + instantiate (private).** Context-menu/panel
   "Save as recipe"; a "Recipes" section in the Shift+A palette; insertion via
   `parseFragmentText` → `deserializeGraph` → **`validateGraph`** →
   `insertClonedFragment`. This is the core loop — reuse across your own
   projects, end to end.
3. **Public recipes + share links.** `visibility: public`; `/r/[slug]`; a
   one-time "this runs custom node graphs" confirm (same as public projects).
4. **Tagging + search.** Tags on save; search by name/tag/interface type.
5. **`.recipe` file export/import.** Durable offline transport.
6. **Thumbnails + interface cards.** Offline-render preview; interface display.
7. **Generator flywheel.** "Save as recipe" from the AI panel; feed public
   recipes into the generator's few-shots.

---

## 11. Open questions

- **Browser home:** Shift+A "Recipes" section vs. a dedicated library panel
  (the latter scales better once there are many recipes + search + thumbnails).
  Start in the palette; graduate to a panel if it gets crowded.
- **Recipe versioning:** editing a saved recipe — overwrite the row, or version
  it? (Overwrite is simplest; copy-on-insert means existing uses are unaffected
  either way.)
- **Media recipes:** how far to support non-procedural groups before it's worth
  a media-aware envelope (vs. the current inline/relink behavior).
- **Public-recipe moderation:** none in v1 (same as public projects today);
  revisit if it becomes a vector.
- **Linked/instanced recipes:** genuinely useful (fix a recipe → all uses
  improve) but a separate, larger spec. Park until there's demand.
