-- Toolbox: add Anthropic API key to user preferences.
--   Adds public.user_preferences.anthropic_api_key — a BYO Claude key used by
--   AI Recipe generation (/api/generate-recipe reads it server-side for the
--   authenticated user; falls back to the ANTHROPIC_API_KEY server env).
--   Plaintext storage is intentional — same RLS + threat model as the existing
--   openai_api_key / hf_token columns (a user can only read/write their own
--   row; see user-preferences-migration.sql).
--
-- Run in the Supabase SQL editor. Idempotent — safe to re-run.

begin;

alter table public.user_preferences
  add column if not exists anthropic_api_key text;

commit;
