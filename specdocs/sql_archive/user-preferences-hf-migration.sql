-- Toolbox: add hf_token to user_preferences
-- Adds an optional HuggingFace read-only token to user_preferences.
-- Used by AI nodes (Background Remove) to download GATED models
-- like briaai/RMBG-2.0. Non-gated models continue to work without
-- a token.
--
-- RLS already locks the row to its owner — adding a column doesn't
-- change that. Idempotent + wrapped in a transaction. Safe to
-- re-run.

begin;

alter table public.user_preferences
  add column if not exists hf_token text;

commit;
