-- Toolbox: named live links (specdocs/092126_vanity-live-links.md)
--
-- Adds:
--   * public.profiles.handle — a unique, lowercase, URL-safe user handle.
--     Seeded from the email local part for every existing profile and at
--     signup; users can change it from the account menu.
--   * public.projects.vanity_slug — an optional per-project slug derived
--     from the title, unique per owner. When set on a PUBLIC project the
--     live viewer also answers at /@<handle>/<vanity_slug>. The random
--     public_slug stays and keeps resolving, so old links never break.
--
-- No RLS changes: the vanity route reads `profiles` (already readable by
-- all) and then `projects` through the existing "public projects readable
-- by anyone" policy. Private rows with a vanity slug stay hidden.
--
-- Run in the Supabase SQL editor. Idempotent — safe to re-run.

begin;

-- ============================================================
-- handles
-- ============================================================

alter table public.profiles
  add column if not exists handle text;

-- Mirror of src/lib/vanity-slug.ts (HANDLE_RE, HANDLE_MIN/MAX,
-- RESERVED_HANDLES). Keep both lists in sync.
create or replace function public.is_valid_handle(h text)
returns boolean
language sql
immutable
as $$
  select h is not null
    and length(h) between 3 and 32
    and h ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
    and h <> all (array[
      'toolbox','admin','administrator','support','help','staff','team',
      'official','brex','root','system','moderator','mod','null',
      'undefined','anonymous','api','live','docs','www'
    ]);
$$;

alter table public.profiles
  drop constraint if exists profiles_handle_valid;
alter table public.profiles
  add constraint profiles_handle_valid
  check (handle is null or public.is_valid_handle(handle));

create unique index if not exists profiles_handle_uniq
  on public.profiles (handle)
  where handle is not null;

-- Pick a free handle near `base`: base, base-2, base-3 … Runs as the
-- caller (the seed loop below and the signup trigger are both privileged).
create or replace function public.mint_handle(base text)
returns text
language plpgsql
as $$
declare
  root text;
  candidate text;
  n int := 1;
begin
  root := regexp_replace(lower(coalesce(base, '')), '[^a-z0-9]+', '-', 'g');
  root := trim(both '-' from root);
  if length(root) < 3 then
    root := rpad(coalesce(nullif(root, ''), 'user'), 3, '0');
  end if;
  if length(root) > 28 then
    root := trim(both '-' from left(root, 28));
  end if;
  if not public.is_valid_handle(root) then
    root := root || '-1';
  end if;
  candidate := root;
  loop
    exit when public.is_valid_handle(candidate)
      and not exists (select 1 from public.profiles where handle = candidate);
    n := n + 1;
    candidate := root || '-' || n;
    if n > 500 then
      -- Pathological; fall back to a random suffix rather than spin.
      candidate := root || '-' || encode(gen_random_bytes(3), 'hex');
      exit;
    end if;
  end loop;
  return candidate;
end;
$$;

-- Seed every profile that has no handle yet from its email local part.
-- One row at a time so a collision can't abort the whole update.
do $$
declare
  r record;
begin
  for r in
    select p.id, u.email
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.handle is null
  loop
    update public.profiles
    set handle = public.mint_handle(split_part(coalesce(r.email, ''), '@', 1))
    where id = r.id and handle is null;
  end loop;
end $$;

-- Signup trigger: also seed a handle. Wrapped so a handle problem can
-- never block account creation.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  seeded text := null;
begin
  begin
    seeded := public.mint_handle(split_part(coalesce(new.email, ''), '@', 1));
  exception when others then
    seeded := null;
  end;
  insert into public.profiles (id, display_name, avatar_url, handle)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    new.raw_user_meta_data ->> 'avatar_url',
    seeded
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ============================================================
-- project vanity slugs
-- ============================================================

alter table public.projects
  add column if not exists vanity_slug text;

alter table public.projects
  drop constraint if exists projects_vanity_slug_valid;
alter table public.projects
  add constraint projects_vanity_slug_valid
  check (
    vanity_slug is null
    or (
      length(vanity_slug) between 1 and 64
      and vanity_slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
    )
  );

-- Unique per OWNER, not globally: two users can both have /@me/orbit.
create unique index if not exists projects_vanity_slug_uniq
  on public.projects (user_id, vanity_slug)
  where vanity_slug is not null;

commit;
