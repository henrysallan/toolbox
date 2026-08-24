-- Toolbox: shared projects — M1 (collaborators + safe shared saves)
-- Spec: specdocs/081426_shared-projects.md
--
-- Adds:
--   * public.project_collaborators — membership rows ('editor' role only
--     in v1; owner is NOT stored here, projects.user_id stays the owner)
--   * public.projects.updated_by — who last made a CAS-participating
--     write; stamped by trigger (client can't forge it), feeds the
--     "Alice saved 5 minutes ago" conflict dialog
--   * trigger guard keeping owner-only columns (name, is_public,
--     public_slug, folder_id, user_id) out of collaborator UPDATEs —
--     RLS can't distinguish columns within one UPDATE policy
--   * RLS deltas: collaborators can SELECT + UPDATE shared projects;
--     Storage write policies on both buckets gain a collaborator clause
--     so collaborator saves land under the OWNER's prefix (the
--     ref-resolution path assumes owner-keyed asset paths)
--
-- RLS recursion note: projects policies reference project_collaborators
-- and vice versa. Cross-referencing policies directly recurses (Postgres
-- errors), so membership checks go through SECURITY DEFINER helper
-- functions that bypass RLS internally. auth.uid() still resolves to the
-- request JWT inside them.
--
-- Run in the Supabase SQL editor. Wrapped in a transaction and every
-- statement is idempotent — safe to re-run.

begin;

-- ============================================================
-- membership table
-- ============================================================

create table if not exists public.project_collaborators (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  -- single role in v1; column exists so view-only can be added later
  -- without a schema change
  role       text not null default 'editor',
  invited_by uuid,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- "Shared with me" listing walks this index.
create index if not exists project_collaborators_user_id_idx
  on public.project_collaborators (user_id);

alter table public.project_collaborators enable row level security;
grant select, insert, delete on public.project_collaborators to authenticated;

-- ============================================================
-- RLS helper functions (security definer — see recursion note)
-- ============================================================

create or replace function public.is_project_collaborator(pid uuid, uid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.project_collaborators
    where project_id = pid and user_id = uid
  );
$$;

create or replace function public.is_project_owner(pid uuid, uid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects
    where id = pid and user_id = uid
  );
$$;

-- Storage-policy helper: does the authed user collaborate on the project
-- at this bucket path? Path segments arrive as text; comparisons stay in
-- text so a malformed path can never throw on a uuid cast.
create or replace function public.is_collaborator_asset(
  owner_folder text, project_key text
)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects p
    join public.project_collaborators c on c.project_id = p.id
    where p.user_id::text = owner_folder
      and p.id::text = project_key
      and c.user_id = auth.uid()
  );
$$;

grant execute on function public.is_project_collaborator(uuid, uuid)
  to authenticated, anon;
grant execute on function public.is_project_owner(uuid, uuid)
  to authenticated, anon;
grant execute on function public.is_collaborator_asset(text, text)
  to authenticated;

-- ============================================================
-- project_collaborators policies
-- ============================================================

-- Members (owner + collaborators) can read the member list.
drop policy if exists "collaborators select members" on public.project_collaborators;
create policy "collaborators select members" on public.project_collaborators
  for select using (
    user_id = auth.uid()
    or public.is_project_owner(project_id, auth.uid())
    or public.is_project_collaborator(project_id, auth.uid())
  );

-- Owner manages membership. (M2's invite redemption inserts through a
-- security-definer RPC, so no self-insert policy is needed here.)
drop policy if exists "collaborators insert owner" on public.project_collaborators;
create policy "collaborators insert owner" on public.project_collaborators
  for insert with check (
    public.is_project_owner(project_id, auth.uid())
  );

-- Owner removes anyone; a collaborator can remove themself (leave).
drop policy if exists "collaborators delete owner or self" on public.project_collaborators;
create policy "collaborators delete owner or self" on public.project_collaborators
  for delete using (
    user_id = auth.uid()
    or public.is_project_owner(project_id, auth.uid())
  );

-- ============================================================
-- projects: updated_by + triggers
-- ============================================================

alter table public.projects add column if not exists updated_by uuid;

-- Stamp on `before update of updated_at`: fires exactly for
-- CAS-participating writes (graph saves, renames, visibility flips —
-- they all set updated_at explicitly). The ratings-aggregate refresh
-- only touches ratings_avg/ratings_count, so raters never pollute
-- "who last saved". Null-uid contexts (service role) leave the old
-- value in place.
create or replace function public.stamp_projects_updated_by()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists projects_stamp_updated_by on public.projects;
create trigger projects_stamp_updated_by
before update of updated_at on public.projects
for each row execute function public.stamp_projects_updated_by();

-- Owner-only column guard. RLS now lets collaborators UPDATE the row
-- (for graph saves), but rename / visibility / slug / folder moves /
-- ownership transfer stay owner-only — enforced here, mirrored in UI.
-- Null-uid contexts (service role, SQL editor as admin) pass through so
-- dashboard fixes aren't blocked.
create or replace function public.guard_projects_owner_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is not null and auth.uid() <> old.user_id then
    if new.name        is distinct from old.name
    or new.is_public   is distinct from old.is_public
    or new.public_slug is distinct from old.public_slug
    or new.folder_id   is distinct from old.folder_id
    or new.user_id     is distinct from old.user_id then
      raise exception 'only the project owner can change name, visibility, folder, or ownership';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists projects_guard_owner_columns on public.projects;
create trigger projects_guard_owner_columns
before update on public.projects
for each row execute function public.guard_projects_owner_columns();

-- ============================================================
-- projects RLS deltas (baselines: sql_archive/social-migration.sql)
-- ============================================================

drop policy if exists "projects select own or public" on public.projects;
create policy "projects select own or public" on public.projects
  for select using (
    auth.uid() = user_id
    or is_public = true
    or public.is_project_collaborator(id, auth.uid())
  );

drop policy if exists "projects update own" on public.projects;
create policy "projects update own" on public.projects
  for update using (
    auth.uid() = user_id
    or public.is_project_collaborator(id, auth.uid())
  )
  with check (
    auth.uid() = user_id
    or public.is_project_collaborator(id, auth.uid())
  );

-- INSERT / DELETE policies unchanged: owner only.

-- ============================================================
-- Storage: collaborator writes under the OWNER's prefix
-- (baselines: project-assets-migration.sql, thumbnails-migration.sql)
-- ============================================================

-- project-assets paths: <ownerId>/<projectId>/<hash>.<ext>
--   owner   = (storage.foldername(name))[1]
--   project = (storage.foldername(name))[2]

drop policy if exists "project-assets upload own folder" on storage.objects;
create policy "project-assets upload own folder" on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'project-assets'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_collaborator_asset(
        (storage.foldername(name))[1], (storage.foldername(name))[2]
      )
    )
  );

drop policy if exists "project-assets update own folder" on storage.objects;
create policy "project-assets update own folder" on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'project-assets'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_collaborator_asset(
        (storage.foldername(name))[1], (storage.foldername(name))[2]
      )
    )
  )
  with check (
    bucket_id = 'project-assets'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_collaborator_asset(
        (storage.foldername(name))[1], (storage.foldername(name))[2]
      )
    )
  );

-- Delete too: a collaborator's won-CAS save prunes orphaned assets from
-- the owner's prefix (projects.ts pruneProjectAssets).
drop policy if exists "project-assets delete own folder" on storage.objects;
create policy "project-assets delete own folder" on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'project-assets'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_collaborator_asset(
        (storage.foldername(name))[1], (storage.foldername(name))[2]
      )
    )
  );

-- project-thumbnails paths: <ownerId>/<projectId>.jpg — the project id
-- is the FILENAME (minus extension), not a folder segment.

drop policy if exists "project-thumbnails upload own folder" on storage.objects;
create policy "project-thumbnails upload own folder" on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'project-thumbnails'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_collaborator_asset(
        (storage.foldername(name))[1],
        split_part(storage.filename(name), '.', 1)
      )
    )
  );

drop policy if exists "project-thumbnails update own folder" on storage.objects;
create policy "project-thumbnails update own folder" on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'project-thumbnails'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_collaborator_asset(
        (storage.foldername(name))[1],
        split_part(storage.filename(name), '.', 1)
      )
    )
  )
  with check (
    bucket_id = 'project-thumbnails'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_collaborator_asset(
        (storage.foldername(name))[1],
        split_part(storage.filename(name), '.', 1)
      )
    )
  );

drop policy if exists "project-thumbnails delete own folder" on storage.objects;
create policy "project-thumbnails delete own folder" on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'project-thumbnails'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_collaborator_asset(
        (storage.foldername(name))[1],
        split_part(storage.filename(name), '.', 1)
      )
    )
  );

commit;
