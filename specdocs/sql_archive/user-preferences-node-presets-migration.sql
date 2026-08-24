-- User node presets — right-click a node → "Save as Preset…"
-- (specdocs/081226_user-node-presets.md). One jsonb array of
-- { id, name, fragment: SavedProject } objects per user, where fragment
-- is the clipboard-fragment envelope serialized by
-- src/lib/project.ts (serializeGraph) — the same schema-migrated payload
-- the copy/paste path uses.
--
-- Rollout-safe: the editor reads/writes this column through dedicated
-- accessors (loadCloudNodePresets / saveCloudNodePresets in
-- src/lib/supabase/user-preferences.ts) that treat errors as "cloud
-- unavailable" and fall back to localStorage — so nothing breaks before
-- this migration is applied, and preset sync switches on automatically
-- after it.

alter table public.user_preferences
  add column if not exists node_presets jsonb;
