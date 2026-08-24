# User node presets — "Save as Preset" (2026-08-12)

Right-click any node → **Save as Preset…** captures that node exactly as it
stands — name, param values, keyframes, cosmetics, media — into the user's
personal preset list, which surfaces in both add menus (Shift+A search popup
and the menu-bar Add dropdown) under the existing Presets category. Presets
follow the user across devices (Supabase) and work signed-out (localStorage).

## Design decisions

- **Payload = a serialized fragment, not a param snapshot.** The stored
  preset is the same `SavedProject` envelope `serializeGraph` produces for
  the clipboard fragment path (lib/fragment-clipboard.ts). That buys,
  for free: media params inlined as data-URLs, keyframes/clips/cosmetics
  (`animation`, `tint`, `bold`, `uiWidth`…), **schema migration on load**
  (a preset saved at schema v10 still loads correctly after v11 renames a
  param — a raw param snapshot would silently bypass migrations), and
  group support (a group shell saves with its whole interior). Rejected:
  `{defType, params}` snapshots — they need a bespoke JSON-safety filter
  for file/bitmap param types and re-implement what serialize already
  does.
- **Capture = the clicked node + `expandWithDescendants` + internal
  edges** — exactly the copy path's selection expansion, so a group/
  iterate shell brings its interior. External wires are dropped (a preset
  is a self-contained fragment). `selected` / `active` / `active2` are
  stripped at save so inserting a preset never steals the viewport.
- **Storage** follows the brush/layout-preset precedent verbatim:
  - `src/state/node-presets.ts` — model + module store. localStorage key
    `toolbox:node-presets` is the always-on store; Supabase
    `user_preferences.node_presets jsonb` syncs on top when available;
    cloud wins on load; every save writes both.
  - Cloud accessors `loadCloudNodePresets` / `saveCloudNodePresets` in
    lib/supabase/user-preferences.ts, deliberately **outside**
    `loadUserPreferences`' select (unapplied migration must not take the
    API-key prefs down). Migration:
    `specdocs/sql_archive/user-preferences-node-presets-migration.sql`.
  - Unlike layout presets (React state + prop threading), the list lives
    in a **module store with `useSyncExternalStore`**
    (audio-audibility.ts pattern) — both add menus read module-level
    `PRESETS` today and are far from EffectsApp's state; a store lets
    them subscribe directly with zero prop plumbing, and the menus
    refresh the moment a save/delete lands.
- **Limits:** 60 presets, 40-char names, and **4 MB of serialized JSON
  per preset** (media-bearing nodes inline as data-URLs; an oversized
  save is refused with a toast rather than silently degrading the
  `user_preferences` row for every future load). Saving under an
  existing name (case-insensitive) replaces it — same upsert semantics
  as layout presets, and the name modal relabels its button "Replace".
- **Menu placement:** same "Presets" category/column in both menus,
  user presets sorted after the built-ins. Rows carry a hover **×** that
  deletes the preset (store-direct, no confirm — it's one right-click to
  re-save). Search participates automatically in the popup (rows join
  the fuzzy-scored def list).
- **Instantiation:** new `user-preset:<id>` branch in `onAddNode`.
  `deserializeGraph` is async (media fetch), so the branch captures the
  drop position synchronously, then inserts on resolve: `cloneSubgraph`
  with fresh ids into the current scope (root auto-wraps into a new
  layer, exactly like the built-in `preset:` branch), plus the
  `compositionId` re-tag from `insertClonedFragment` — a preset saved in
  another project carries a foreign composition tag that would otherwise
  filter its layer out of the chain. A malformed stored blob toasts and
  inserts nothing.
- **Save entry point:** node context menu (NodeEditor's
  `NodeContextMenu`), item "Save as Preset…" after Duplicate. Gated
  off (handler `undefined`) for reroutes, frames, layer shells, and
  group boundary nodes — none of them is a meaningful standalone
  preset. Group and iterate shells ARE allowed (interior travels).
- **Name modal:** `PresetNameModal.tsx` — NewLayoutPresetModal
  generalized with `title` / `description` / `initialName` props;
  NewLayoutPresetModal stays as a thin wrapper passing the layout copy,
  so its call site is untouched. Node-preset save prefills the clicked
  node's display name.
- **Preset name ≠ node name.** The preset's menu label is what the user
  types in the modal; the node inside the fragment keeps its own
  `data.name` and re-appears with it on insert ("exactly as saved").

## Milestones

- **M1 — storage.** node-presets.ts (types, sanitize, local+cloud
  load/save, upsert/remove, `useUserNodePresets`), user-preferences.ts
  accessors, migration SQL. Offline check `check-node-presets.mts`:
  single-node and group fragments round-trip serialize → sanitize →
  deserialize; sanitize drops malformed rows; upsert replaces by name
  case-insensitively; caps enforced.
- **M2 — save flow.** Context-menu item + gating, PresetNameModal
  generalization, EffectsApp `handleSaveNodeAsPreset` (build fragment →
  serialize → size check → upsert → toast).
- **M3 — menus + insert.** Both add menus list user presets with hover-×
  delete; `user-preset:` branch in onAddNode.

## Follow-ups (not in v1)

- Rename in place (workaround: re-save under the new name, × the old).
- Preset descriptions / thumbnails.
- Exposing user presets to the MCP `add_node` tool and AI Recipe.
