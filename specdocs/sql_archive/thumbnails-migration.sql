-- Toolbox: thumbnails-to-Storage migration
-- Creates a public bucket for project thumbnails, plus the storage.objects
-- policies that let each user upload/update/delete only within their own
-- top-level folder (<user_id>/…).
--
-- Reads are unrestricted — the bucket is `public: true`, so its public
-- URLs work for signed-out visitors and benefit from the CDN cache.
-- We also add an explicit SELECT policy so the bucket staying public
-- isn't the only thing holding reads open.
--
-- Existing projects keep working without migration: their `thumbnail`
-- column still holds a `data:` URL, and the client renders that
-- inline until the project is next saved, at which point the thumbnail
-- naturally moves to Storage.
--
-- Run this in the Supabase SQL editor. Wrapped in a transaction and
-- idempotent — safe to re-run.

begin;

-- ============================================================
-- bucket
-- ============================================================

insert into storage.buckets (id, name, public)
values ('project-thumbnails', 'project-thumbnails', true)
on conflict (id) do update set public = excluded.public;

-- ============================================================
-- storage.objects policies, scoped to this bucket
-- ============================================================

-- Read: anyone. Matches `public: true` on the bucket; having an
-- explicit policy documents intent and prevents a future flip of the
-- bucket to private from silently locking out reads.
drop policy if exists "project-thumbnails readable by all" on storage.objects;
create policy "project-thumbnails readable by all" on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'project-thumbnails');

-- Write: authenticated users only, and the file's top-level folder
-- must match the user's own id. That guarantees one user can't
-- overwrite another user's thumbnail by crafting the path.
drop policy if exists "project-thumbnails upload own folder" on storage.objects;
create policy "project-thumbnails upload own folder" on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'project-thumbnails'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "project-thumbnails update own folder" on storage.objects;
create policy "project-thumbnails update own folder" on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'project-thumbnails'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'project-thumbnails'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "project-thumbnails delete own folder" on storage.objects;
create policy "project-thumbnails delete own folder" on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'project-thumbnails'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

commit;
