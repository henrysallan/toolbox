-- Toolbox: project-assets-to-Storage migration (save optimization Tier 2)
-- Creates a public bucket for content-addressed project media, plus the
-- storage.objects policies that let each user upload/update/delete only
-- within their own top-level folder (<user_id>/…).
--
-- Objects are named <user_id>/<project_id>/<sha256>.<ext>. Reads are
-- unrestricted — the bucket is `public: true`, so its public URLs work for
-- signed-out /live visitors and ride the CDN cache. See
-- specdocs/071426_cloud-asset-storage.md for the privacy trade-off (a
-- private project's media is unguessable-path public, same trust level as
-- thumbnails today).
--
-- Existing projects keep working without migration: their `graph` still
-- holds inline `data:` URL envelopes; the client loads them inline until
-- the project is next saved, at which point its media naturally moves to
-- Storage as refs.
--
-- Run this in the Supabase SQL editor. Wrapped in a transaction and
-- idempotent — safe to re-run.

begin;

-- ============================================================
-- bucket
-- ============================================================

insert into storage.buckets (id, name, public)
values ('project-assets', 'project-assets', true)
on conflict (id) do update set public = excluded.public;

-- ============================================================
-- storage.objects policies, scoped to this bucket
-- ============================================================

-- Read: anyone. Matches `public: true`; an explicit policy documents intent
-- and prevents a future flip of the bucket to private from silently locking
-- out reads.
drop policy if exists "project-assets readable by all" on storage.objects;
create policy "project-assets readable by all" on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'project-assets');

-- Write: authenticated users only, and the file's top-level folder must
-- match the user's own id — one user can't overwrite another's assets by
-- crafting the path.
drop policy if exists "project-assets upload own folder" on storage.objects;
create policy "project-assets upload own folder" on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'project-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "project-assets update own folder" on storage.objects;
create policy "project-assets update own folder" on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'project-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'project-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "project-assets delete own folder" on storage.objects;
create policy "project-assets delete own folder" on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'project-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

commit;
