-- Toolbox: shared projects — M2 (invite links)
-- Spec: specdocs/081426_shared-projects.md · Requires the M1 migration
-- (specdocs/shared-projects-migration.sql) to have been run first — it
-- reuses public.is_project_owner and inserts into project_collaborators.
--
-- Adds:
--   * public.project_invites — bearer-token invite links. Tokens are
--     minted client-side (16-char base36, ~82 bits — same recipe as
--     public slugs, longer because a token GRANTS membership rather
--     than just naming a public row). Default expiry 7 days; revocation
--     is a flag flip so a revoked link fails closed even if cached.
--   * get_project_invite(token) — safe preview for the /join/<token>
--     page: project name + owner + status. SECURITY DEFINER because the
--     redeemer can't read the invites table (or, pre-membership, the
--     project row) directly. Callable by anon so the page renders
--     before sign-in; a token is a bearer secret, so holders seeing the
--     project name is the intended behavior.
--   * redeem_project_invite(token) — validates, inserts the membership
--     row, returns the project id. Authenticated only; owner/existing-
--     member redeems are no-op successes.
--
-- The invites table has NO redeemer-facing policies: redemption goes
-- through the RPC, so a token never has to be SELECTable to be used —
-- that keeps token enumeration impossible even if a future policy on
-- the table gets loosened.
--
-- Run in the Supabase SQL editor. Wrapped in a transaction and every
-- statement is idempotent — safe to re-run.

begin;

-- ============================================================
-- invites table
-- ============================================================

create table if not exists public.project_invites (
  token      text primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  revoked    boolean not null default false
);

-- The manage popover lists a project's invites through this index.
create index if not exists project_invites_project_id_idx
  on public.project_invites (project_id);

alter table public.project_invites enable row level security;
grant select, insert, update on public.project_invites to authenticated;

-- Owner-only on every verb the client uses. Delete is deliberately not
-- granted — revocation flips the flag, so a "dead" link keeps its row
-- and can never be re-minted by someone else guessing a freed token.
drop policy if exists "invites select owner" on public.project_invites;
create policy "invites select owner" on public.project_invites
  for select using (public.is_project_owner(project_id, auth.uid()));

drop policy if exists "invites insert owner" on public.project_invites;
create policy "invites insert owner" on public.project_invites
  for insert with check (
    public.is_project_owner(project_id, auth.uid())
    and created_by = auth.uid()
  );

drop policy if exists "invites update owner" on public.project_invites;
create policy "invites update owner" on public.project_invites
  for update using (public.is_project_owner(project_id, auth.uid()))
  with check (public.is_project_owner(project_id, auth.uid()));

-- ============================================================
-- RPCs
-- ============================================================

-- Preview for /join/<token>. Zero rows = token doesn't exist. `status`:
--   'valid'   — redeemable by the caller
--   'expired' / 'revoked' — dead link
--   'owner'   — caller owns the project (redeem would be a no-op)
--   'member'  — caller is already a collaborator
create or replace function public.get_project_invite(invite_token text)
returns table (
  project_id uuid,
  project_name text,
  owner_name text,
  status text
)
language sql stable security definer
set search_path = public
as $$
  select
    i.project_id,
    p.name as project_name,
    prof.display_name as owner_name,
    case
      when i.revoked then 'revoked'
      when i.expires_at < now() then 'expired'
      when p.user_id = auth.uid() then 'owner'
      when exists (
        select 1 from public.project_collaborators c
        where c.project_id = i.project_id and c.user_id = auth.uid()
      ) then 'member'
      else 'valid'
    end as status
  from public.project_invites i
  join public.projects p on p.id = i.project_id
  left join public.profiles prof on prof.id = p.user_id
  where i.token = invite_token;
$$;

create or replace function public.redeem_project_invite(invite_token text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  inv record;
begin
  if auth.uid() is null then
    raise exception 'sign in to accept an invite';
  end if;
  select * into inv from public.project_invites where token = invite_token;
  if not found then
    raise exception 'invite not found';
  end if;
  if inv.revoked then
    raise exception 'this invite has been revoked';
  end if;
  if inv.expires_at < now() then
    raise exception 'this invite has expired';
  end if;
  -- Owner redeeming their own link: fine, but never insert a membership
  -- row for the owner (the owner is implicit via projects.user_id).
  if exists (
    select 1 from public.projects p
    where p.id = inv.project_id and p.user_id = auth.uid()
  ) then
    return inv.project_id;
  end if;
  insert into public.project_collaborators (project_id, user_id, invited_by)
  values (inv.project_id, auth.uid(), inv.created_by)
  on conflict (project_id, user_id) do nothing;
  return inv.project_id;
end;
$$;

grant execute on function public.get_project_invite(text)
  to authenticated, anon;
grant execute on function public.redeem_project_invite(text)
  to authenticated;

commit;
