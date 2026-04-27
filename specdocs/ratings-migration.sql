-- Toolbox: project ratings migration
-- Adds:
--   * public.project_ratings — one row per (project, user) with a 1–5 rating
--   * public.projects.ratings_avg + ratings_count — denormalized aggregates,
--     kept in sync by a trigger so the load grid can show them without
--     joining + grouping every list query
--   * RLS: anyone can read ratings (for public listings); only the
--     rating's author can write or delete it
--
-- Run in the Supabase SQL editor. Wrapped in a transaction and every
-- statement is idempotent — safe to re-run.

begin;

-- ============================================================
-- ratings table
-- ============================================================

create table if not exists public.project_ratings (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index if not exists project_ratings_project_id_idx
  on public.project_ratings (project_id);

alter table public.project_ratings enable row level security;

-- Public read so anonymous visitors see avg ratings on public projects.
drop policy if exists "ratings readable by all" on public.project_ratings;
create policy "ratings readable by all" on public.project_ratings
  for select to anon, authenticated using (true);

drop policy if exists "ratings insert own" on public.project_ratings;
create policy "ratings insert own" on public.project_ratings
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "ratings update own" on public.project_ratings;
create policy "ratings update own" on public.project_ratings
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "ratings delete own" on public.project_ratings;
create policy "ratings delete own" on public.project_ratings
  for delete to authenticated using (auth.uid() = user_id);

grant select on public.project_ratings to anon, authenticated;
grant insert, update, delete on public.project_ratings to authenticated;

-- ============================================================
-- aggregate columns on projects
-- ============================================================

alter table public.projects
  add column if not exists ratings_avg numeric(3,2),
  add column if not exists ratings_count integer not null default 0;

create index if not exists projects_ratings_avg_idx
  on public.projects (ratings_avg desc nulls last);

-- Recalculates avg + count for a single project from the source of
-- truth (project_ratings). Called by the after-row trigger below on
-- insert/update/delete. Marked SECURITY DEFINER so RLS on projects
-- doesn't block the trigger when it runs as the rating author.
create or replace function public.refresh_project_ratings(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  agg record;
begin
  select avg(rating)::numeric(3,2) as avg_rating, count(*)::int as cnt
  into agg
  from public.project_ratings
  where project_id = p_id;

  update public.projects
  set ratings_avg = agg.avg_rating,
      ratings_count = coalesce(agg.cnt, 0)
  where id = p_id;
end;
$$;

create or replace function public.trg_project_ratings_refresh()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.refresh_project_ratings(old.project_id);
    return old;
  else
    perform public.refresh_project_ratings(new.project_id);
    return new;
  end if;
end;
$$;

drop trigger if exists project_ratings_aggregate on public.project_ratings;
create trigger project_ratings_aggregate
after insert or update or delete on public.project_ratings
for each row execute function public.trg_project_ratings_refresh();

-- One-shot backfill: any pre-existing rating rows seed their parent's
-- aggregate. Idempotent — running it on a clean install is a no-op.
update public.projects p
set ratings_avg = sub.avg_rating,
    ratings_count = sub.cnt
from (
  select project_id, avg(rating)::numeric(3,2) as avg_rating, count(*)::int as cnt
  from public.project_ratings
  group by project_id
) sub
where p.id = sub.project_id;

commit;
