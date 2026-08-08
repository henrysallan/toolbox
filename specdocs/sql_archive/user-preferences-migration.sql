-- Toolbox: user preferences migration
-- Adds:
--   * public.user_preferences — one row per auth user, holds editor-wide
--     prefs that aren't tied to a specific project. v1 carries an
--     OpenAI API key (BYO model — used by the Image Generate node and
--     any future AI-driven nodes); reserved `meta jsonb` for future
--     low-stakes prefs without a fresh migration.
--   * Trigger to keep `updated_at` honest on every UPDATE.
--   * RLS: a user can only read / write their own row. No one else
--     (including anon) can touch it. Plaintext storage is intentional —
--     we trust RLS + the user's choice to enter their key here, same
--     threat model as a desktop app.
--
-- Run in the Supabase SQL editor. Wrapped in a transaction; every
-- statement is idempotent — safe to re-run.

begin;

create table if not exists public.user_preferences (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  openai_api_key text,
  meta           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Keep updated_at fresh.
create or replace function public.trg_user_preferences_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_preferences_touch on public.user_preferences;
create trigger user_preferences_touch
before update on public.user_preferences
for each row execute function public.trg_user_preferences_touch();

alter table public.user_preferences enable row level security;

-- Read your own row.
drop policy if exists "user_preferences select own"
  on public.user_preferences;
create policy "user_preferences select own"
  on public.user_preferences
  for select to authenticated
  using (auth.uid() = user_id);

-- Insert your own row (initial save).
drop policy if exists "user_preferences insert own"
  on public.user_preferences;
create policy "user_preferences insert own"
  on public.user_preferences
  for insert to authenticated
  with check (auth.uid() = user_id);

-- Update your own row.
drop policy if exists "user_preferences update own"
  on public.user_preferences;
create policy "user_preferences update own"
  on public.user_preferences
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Delete your own row (clearing all prefs).
drop policy if exists "user_preferences delete own"
  on public.user_preferences;
create policy "user_preferences delete own"
  on public.user_preferences
  for delete to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.user_preferences
  to authenticated;

commit;
