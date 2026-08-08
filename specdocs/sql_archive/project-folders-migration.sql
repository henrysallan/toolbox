-- Toolbox: project folders migration
-- Adds:
--   * public.project_folders — per-user, arbitrarily nestable folders for
--     organizing private projects in the load grid
--   * public.projects.folder_id — which folder a project lives in
--     (null = root)
--   * RLS: owner-only for every verb — folders are a private-tab concept
--     and are never exposed publicly
--   * a guard trigger rejecting self-parenting, cycles, and cross-user
--     parents (the client also guards; this is the backstop)
--
-- Delete semantics: the client re-parents a deleted folder's contents to
-- its parent before deleting the row. The `on delete set null` FKs below
-- are the safety net — anything orphaned outside that path falls to root,
-- never gets deleted.
--
-- Run in the Supabase SQL editor. Wrapped in a transaction and every
-- statement is idempotent — safe to re-run.

begin;

-- ============================================================
-- folders table
-- ============================================================

create table if not exists public.project_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null default 'New Folder',
  parent_id uuid references public.project_folders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_folders_user_id_idx
  on public.project_folders (user_id);

create index if not exists project_folders_parent_id_idx
  on public.project_folders (parent_id);

alter table public.project_folders enable row level security;

drop policy if exists "folders select own" on public.project_folders;
create policy "folders select own" on public.project_folders
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "folders insert own" on public.project_folders;
create policy "folders insert own" on public.project_folders
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "folders update own" on public.project_folders;
create policy "folders update own" on public.project_folders
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "folders delete own" on public.project_folders;
create policy "folders delete own" on public.project_folders
  for delete to authenticated using (auth.uid() = user_id);

grant select, insert, update, delete on public.project_folders to authenticated;

-- ============================================================
-- guard trigger: no self-parent, no cycles, no cross-user parents
-- ============================================================

-- Runs as INVOKER (not security definer) on purpose: the ancestor walk
-- reads project_folders under the caller's RLS, so another user's folder
-- id simply reads as nonexistent — the "parent must be yours" check and
-- RLS are the same check.
create or replace function public.trg_project_folders_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  cur uuid;
  parent_owner uuid;
  depth int := 0;
begin
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'folder cannot be its own parent';
  end if;
  select user_id into parent_owner
  from public.project_folders where id = new.parent_id;
  if parent_owner is null then
    raise exception 'parent folder does not exist';
  end if;
  if parent_owner <> new.user_id then
    raise exception 'parent folder belongs to a different user';
  end if;
  -- Walk up from the new parent; hitting ourselves means a cycle.
  cur := new.parent_id;
  while cur is not null loop
    depth := depth + 1;
    if depth > 100 then
      raise exception 'folder nesting too deep';
    end if;
    select parent_id into cur
    from public.project_folders where id = cur;
    if cur = new.id then
      raise exception 'folder move would create a cycle';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists project_folders_guard on public.project_folders;
create trigger project_folders_guard
before insert or update of parent_id on public.project_folders
for each row execute function public.trg_project_folders_guard();

-- ============================================================
-- projects.folder_id
-- ============================================================

alter table public.projects
  add column if not exists folder_id uuid
    references public.project_folders(id) on delete set null;

create index if not exists projects_folder_id_idx
  on public.projects (folder_id);

commit;
