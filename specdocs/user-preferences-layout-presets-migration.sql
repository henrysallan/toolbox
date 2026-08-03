-- Saved window-layout presets for the Window → Layouts menu
-- (specdocs/072726_window-tiling.md). One jsonb array of
-- { id, name, layout: SavedLayout } objects per user, where SavedLayout is
-- the id-free split tree serialized by
-- src/components/effects/layout/model.ts (toSavedLayout).
--
-- Rollout-safe: the editor reads/writes this column through dedicated
-- accessors (loadCloudLayoutPresets / saveCloudLayoutPresets in
-- src/lib/supabase/user-preferences.ts) that treat errors as "cloud
-- unavailable" and fall back to localStorage — so nothing breaks before
-- this migration is applied, and preset sync switches on automatically
-- after it.

alter table public.user_preferences
  add column if not exists layout_presets jsonb;
