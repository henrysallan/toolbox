-- Toolbox: project slugs on every row
-- Supersedes the "is_public = false ⇒ public_slug is null" invariant from
-- specdocs/sql_archive/live-link-migration.sql.
--
-- Every project (private and public) now has a stable /p/<slug> editor URL.
-- Visiting a private slug does not leak the graph: RLS still hides the row
-- from anyone who isn't the owner or a collaborator. The /p/[slug] page
-- distinguishes "private" from "not found" via project_slug_exists(), a
-- security-definer RPC that returns only a boolean.
--
-- /live/<slug> stays public-only (loadPublicProjectBySlug still filters
-- is_public = true).
--
-- Run in the Supabase SQL editor. Idempotent — safe to re-run.

begin;

-- Stop wiping the slug when a row goes private. The editor URL should
-- survive a visibility flip; only the live viewer stays gated on public.
drop trigger if exists projects_clear_slug_on_private on public.projects;
drop function if exists public.trg_projects_clear_slug_on_private();

-- Safety net: any INSERT that forgets a slug gets one. Client writers
-- mint first (12-char base36); this covers old clients and SQL-editor
-- inserts. 16 hex chars from gen_random_bytes — same recipe as the
-- original live-link backfill.
create or replace function public.trg_projects_mint_slug()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.public_slug is null then
    new.public_slug := encode(gen_random_bytes(8), 'hex');
  end if;
  return new;
end;
$$;

drop trigger if exists projects_mint_slug on public.projects;
create trigger projects_mint_slug
before insert on public.projects
for each row execute function public.trg_projects_mint_slug();

-- Backfill existing private (and any other slug-less) rows one at a time
-- so a unique-index collision can't abort the whole update.
do $$
declare
  r record;
begin
  for r in select id from public.projects where public_slug is null loop
    update public.projects
    set public_slug = encode(gen_random_bytes(8), 'hex')
    where id = r.id;
  end loop;
end $$;

-- Existence probe for /p/<slug>. Returns true when a row has this slug,
-- regardless of visibility — never the graph, name, or owner. Anon and
-- authenticated both get EXECUTE so a logged-out visitor hitting a
-- private URL sees the login gate instead of a 404. Guessing a 12-char
-- base36 slug is not a practical leak.
create or replace function public.project_slug_exists(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects where public_slug = p_slug
  );
$$;

revoke all on function public.project_slug_exists(text) from public;
grant execute on function public.project_slug_exists(text)
  to anon, authenticated;

commit;
