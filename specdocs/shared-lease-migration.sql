-- Toolbox: shared projects — M3 (advisory editing lease)
-- Spec: specdocs/081426_shared-projects.md · Requires the M1 migration
-- (specdocs/shared-projects-migration.sql) — it reuses the
-- is_project_owner / is_project_collaborator helpers.
--
-- The lease is ADVISORY: it prevents most save conflicts before work is
-- invested, but correctness always lives in the save path's updated_at
-- CAS. Nothing here ever blocks an open or a save — a stale or stolen
-- lease costs at worst a conflict dialog. That's why take-over is
-- unconditionally allowed (owner decision, 08/14/26): the previous
-- holder is protected by the CAS, not the lease.
--
-- Constants: expiry 8 minutes, client heartbeat 2 minutes (interaction-
-- gated — an idle tab stops renewing and the lease lapses). The expiry
-- interval is inlined in acquire_project_lease AND mirrored client-side
-- as LEASE_EXPIRY_MS in lib/supabase/project-editing.ts — keep in sync.
--
-- Writes go exclusively through the three SECURITY DEFINER RPCs (no
-- table write grants): acquisition must be one atomic statement — a
-- SELECT-then-INSERT client race would let two editors both believe
-- they hold it. Members can SELECT the table directly for the load
-- grid's "● editing" badges.
--
-- Run in the Supabase SQL editor. Wrapped in a transaction and every
-- statement is idempotent — safe to re-run.

begin;

-- ============================================================
-- lease table — at most ONE row per project (PK), the current holder
-- ============================================================

create table if not exists public.project_editing (
  project_id  uuid primary key references public.projects(id) on delete cascade,
  user_id     uuid not null,
  acquired_at timestamptz not null default now(),
  renewed_at  timestamptz not null default now()
);

alter table public.project_editing enable row level security;
grant select on public.project_editing to authenticated;

-- Badges: members of a project may see who holds its lease. No
-- INSERT/UPDATE/DELETE grants — writes only via the RPCs below.
drop policy if exists "editing select members" on public.project_editing;
create policy "editing select members" on public.project_editing
  for select using (
    public.is_project_owner(project_id, auth.uid())
    or public.is_project_collaborator(project_id, auth.uid())
  );

-- ============================================================
-- RPCs
-- ============================================================

-- Acquire (or re-acquire) the lease. One atomic upsert: succeeds when
-- the lease is free, expired, already ours, or `steal` is set. When it
-- stays with someone else, the current holder (+ display name +
-- last-renewed stamp) comes back so the client can show "Alice, active
-- 3 min ago" with Open-anyway / Take-over.
create or replace function public.acquire_project_lease(
  pid uuid,
  steal boolean default false
)
returns table (
  acquired boolean,
  holder_id uuid,
  holder_name text,
  holder_renewed_at timestamptz
)
language plpgsql security definer
set search_path = public
as $$
declare
  cur record;
begin
  if auth.uid() is null then
    raise exception 'sign in to edit projects';
  end if;
  if not (
    public.is_project_owner(pid, auth.uid())
    or public.is_project_collaborator(pid, auth.uid())
  ) then
    raise exception 'not a member of this project';
  end if;

  insert into public.project_editing as pe (project_id, user_id)
  values (pid, auth.uid())
  on conflict (project_id) do update
    set user_id = excluded.user_id,
        acquired_at = now(),
        renewed_at = now()
    -- Keep in sync with LEASE_EXPIRY_MS (project-editing.ts).
    where pe.user_id = excluded.user_id
       or pe.renewed_at < now() - interval '8 minutes'
       or steal;

  select pe.user_id, pe.renewed_at into cur
  from public.project_editing pe
  where pe.project_id = pid;

  -- The row can only be missing on a delete race; treat as acquired-by-
  -- nobody and let the client retry on its next beat.
  if not found then
    return query select false, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  if cur.user_id = auth.uid() then
    return query select true, null::uuid, null::text, null::timestamptz;
  else
    return query
      select
        false,
        cur.user_id,
        (select display_name from public.profiles where id = cur.user_id),
        cur.renewed_at;
  end if;
end;
$$;

-- Heartbeat. TRUE = still the holder; FALSE = the lease lapsed or was
-- taken over — the client shows the "X took over" banner and can call
-- acquire (steal=false) to learn who.
create or replace function public.renew_project_lease(pid uuid)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  n int;
begin
  if auth.uid() is null then
    return false;
  end if;
  update public.project_editing
  set renewed_at = now()
  where project_id = pid and user_id = auth.uid();
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- Clean release on close (pagehide keepalive / project switch). Only
-- ever deletes the caller's own lease; expiry is the crash backstop.
create or replace function public.release_project_lease(pid uuid)
returns void
language sql security definer
set search_path = public
as $$
  delete from public.project_editing
  where project_id = pid and user_id = auth.uid();
$$;

grant execute on function public.acquire_project_lease(uuid, boolean)
  to authenticated;
grant execute on function public.renew_project_lease(uuid)
  to authenticated;
grant execute on function public.release_project_lease(uuid)
  to authenticated;

commit;
