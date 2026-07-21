-- Brush presets for the Paint node's Brush Editor
-- (specdocs/071926_paint-toolkit.md). One jsonb array of
-- { id, name, size, brush: {hardness, opacity, flow, spacing, smoothing,
--   pressureSize, pressureOpacity} } objects per user.
--
-- Rollout-safe: the editor reads/writes this column through dedicated
-- accessors (loadCloudBrushPresets / saveCloudBrushPresets in
-- src/lib/supabase/user-preferences.ts) that treat errors as "cloud
-- unavailable" and fall back to localStorage — so nothing breaks before
-- this migration is applied, and preset sync switches on automatically
-- after it.

alter table public.user_preferences
  add column if not exists brush_presets jsonb;
