-- Toolbox: public live-link migration
-- Adds a stable public_slug to public.projects so a public project gets a
-- shareable /live/<slug> URL. The slug is minted client-side when a user
-- toggles a project public; cleared when toggled private. Existing public
-- rows are backfilled with random slugs at migration time so links can ship
-- immediately.
--
-- Also tightens the public-SELECT RLS so anonymous visitors hitting the
-- /live route can only read rows that are both `is_public = true` AND have
-- a non-null `public_slug` — same surface as before, just keyed on the
-- additional invariant.
--
-- Run in the Supabase SQL editor. Wrapped in a transaction and every
-- statement is idempotent — safe to re-run.

begin;

-- ============================================================
-- column
-- ============================================================

alter table public.projects
  add column if not exists public_slug text;

-- Backfill: any existing public row without a slug gets a random one.
-- 16 hex chars from gen_random_bytes — collision-free at this scale and
-- doesn't require pgcrypto extras (gen_random_bytes is in pgcrypto, which
-- Supabase enables by default). If the extension isn't available, swap
-- this for `substr(md5(random()::text || clock_timestamp()::text), 1, 16)`.
update public.projects
set public_slug = encode(gen_random_bytes(8), 'hex')
where is_public = true
  and public_slug is null;

create unique index if not exists projects_public_slug_uniq
  on public.projects (public_slug)
  where public_slug is not null;

-- Drop a slug whenever a row goes private, in case the client forgot to
-- clear it. Keeps the invariant "is_public = false ⇒ public_slug is null"
-- so anonymous SELECT can never leak a private project even if the slug
-- is guessed.
create or replace function public.trg_projects_clear_slug_on_private()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_public is distinct from true then
    new.public_slug := null;
  end if;
  return new;
end;
$$;

drop trigger if exists projects_clear_slug_on_private on public.projects;
create trigger projects_clear_slug_on_private
before update of is_public on public.projects
for each row execute function public.trg_projects_clear_slug_on_private();

-- ============================================================
-- RLS: anonymous SELECT on public-by-slug rows
-- ============================================================
-- The existing "public projects readable by anyone" policy (from earlier
-- migrations) already grants anon SELECT on public rows. We replace it
-- with a slightly stricter version that ALSO requires a non-null slug —
-- private projects (slug is null) and "soft-published" rows without a
-- minted slug stay invisible to anon. Authors keep full read access via
-- their own owner policy.

drop policy if exists "public projects readable by anyone" on public.projects;
create policy "public projects readable by anyone" on public.projects
  for select
  to anon, authenticated
  using (is_public = true and public_slug is not null);

commit;
