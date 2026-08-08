-- Toolbox: social/share migration
-- Adds:
--   * public.profiles (id -> auth.users) for author attribution
--   * public.projects.is_public column
--   * RLS policies so anyone can read public projects + profile names
--   * Signup trigger that mirrors OAuth metadata into profiles
--
-- Run this whole script in the Supabase SQL editor. Wrapped in a
-- transaction and every statement is idempotent — safe to re-run.

begin;

-- ============================================================
-- profiles
-- ============================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Readable by everyone — author attribution on public projects has to
-- work for signed-out visitors too.
drop policy if exists "profiles readable by all" on public.profiles;
create policy "profiles readable by all" on public.profiles
  for select using (true);

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

grant select on public.profiles to anon, authenticated;
grant insert, update on public.profiles to authenticated;

-- Signup trigger: mirror OAuth metadata into a profile row. Prefers
-- full_name, falls back to name, finally the local-part of the email.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for every existing auth user. Idempotent via
-- ON CONFLICT.
insert into public.profiles (id, display_name, avatar_url)
select
  u.id,
  coalesce(
    u.raw_user_meta_data ->> 'full_name',
    u.raw_user_meta_data ->> 'name',
    split_part(coalesce(u.email, ''), '@', 1)
  ),
  u.raw_user_meta_data ->> 'avatar_url'
from auth.users u
on conflict (id) do nothing;

-- ============================================================
-- projects: is_public + policies
-- ============================================================

alter table public.projects
  add column if not exists is_public boolean not null default false;

create index if not exists projects_is_public_idx
  on public.projects (is_public) where is_public;
create index if not exists projects_user_id_idx
  on public.projects (user_id);

-- Drop any legacy select policies that only allowed own rows. If your
-- project has a differently-named policy, add a drop for it here.
drop policy if exists "Enable read access for own projects" on public.projects;
drop policy if exists "Users can view their own projects" on public.projects;
drop policy if exists "projects select own" on public.projects;

drop policy if exists "projects select own or public" on public.projects;
create policy "projects select own or public" on public.projects
  for select using (auth.uid() = user_id or is_public = true);

drop policy if exists "projects insert own" on public.projects;
create policy "projects insert own" on public.projects
  for insert with check (auth.uid() = user_id);

drop policy if exists "projects update own" on public.projects;
create policy "projects update own" on public.projects
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "projects delete own" on public.projects;
create policy "projects delete own" on public.projects
  for delete using (auth.uid() = user_id);

grant select on public.projects to anon, authenticated;
grant insert, update, delete on public.projects to authenticated;

commit;
