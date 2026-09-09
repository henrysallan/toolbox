-- Toolbox: Asset Library migration (specdocs/090326_asset-library.md)
--
-- A per-user, project-agnostic library of images / SVGs / videos:
--   * public.user_assets — the index (one row per asset; videos point at
--     the existing R2 object, images/SVGs at objects in the bucket below).
--   * storage bucket `user-assets` — public, content-addressed
--     <user_id>/<sha256>.<ext> objects plus <user_id>/thumbs/<asset_id>.jpg
--     thumbnails. Policies copied from project-assets: read by all, write/
--     update/delete only inside the caller's own top-level folder.
--
-- Client-writable on purpose (own-row RLS): unlike media_assets (the R2
-- quota ledger, service-role only) nothing here is quota-relevant — a
-- user editing their own library index is the feature.
--
-- Rollout-safe: the editor treats a missing table (42P01) as an empty
-- library and surfaces insert failures as toasts, so nothing breaks
-- before this runs. Run in the Supabase SQL editor; idempotent.

begin;

-- ============================================================
-- user_assets
-- ============================================================

create table if not exists public.user_assets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null,                  -- 'image' | 'svg' | 'video'
  name        text not null,
  hash        text not null,                  -- sha256 hex of the bytes
  ext         text not null,
  mime        text not null,
  size        bigint not null,
  width       integer,
  height      integer,
  duration    double precision,
  storage     text not null,                  -- 'supabase' | 'r2'
  owner       uuid,                           -- R2 uploader id (video rows)
  thumb_rev   integer not null default 0,     -- 0 = no thumbnail; cache-buster
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, kind, hash)
);

create index if not exists user_assets_user_created_idx
  on public.user_assets (user_id, created_at desc);

create or replace function public.trg_user_assets_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists user_assets_touch on public.user_assets;
create trigger user_assets_touch
before update on public.user_assets
for each row execute function public.trg_user_assets_touch();

alter table public.user_assets enable row level security;
grant select, insert, update, delete on public.user_assets to authenticated;

drop policy if exists "user_assets select own" on public.user_assets;
create policy "user_assets select own" on public.user_assets
  for select using (auth.uid() = user_id);

drop policy if exists "user_assets insert own" on public.user_assets;
create policy "user_assets insert own" on public.user_assets
  for insert with check (auth.uid() = user_id);

drop policy if exists "user_assets update own" on public.user_assets;
create policy "user_assets update own" on public.user_assets
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "user_assets delete own" on public.user_assets;
create policy "user_assets delete own" on public.user_assets
  for delete using (auth.uid() = user_id);

-- ============================================================
-- bucket
-- ============================================================

insert into storage.buckets (id, name, public)
values ('user-assets', 'user-assets', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "user-assets readable by all" on storage.objects;
create policy "user-assets readable by all" on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'user-assets');

drop policy if exists "user-assets upload own folder" on storage.objects;
create policy "user-assets upload own folder" on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'user-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "user-assets update own folder" on storage.objects;
create policy "user-assets update own folder" on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'user-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'user-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "user-assets delete own folder" on storage.objects;
create policy "user-assets delete own folder" on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'user-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

commit;
