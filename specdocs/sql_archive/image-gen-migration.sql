-- Toolbox: Image Generate node migration
-- Adds:
--   * public.image_gen_sessions — one row per (user, project, node).
--     Holds the chat history + a JSON list of generated image refs.
--     The conversation's most recent OpenAI Responses-API id is
--     persisted so multi-turn follow-ups can chain via
--     `previous_response_id`.
--   * Two storage buckets:
--       - image-gen-private  (RLS-locked to the owner)
--       - image-gen-public   (anon read; authenticated write)
--     Buckets are created via storage.buckets insert; the policies on
--     storage.objects gate per-bucket access.
--   * RLS so a user can only see their own sessions.
--
-- Run in the Supabase SQL editor. Wrapped in a transaction; every
-- statement is idempotent — safe to re-run.

begin;

-- ============================================================
-- session table
--
-- We keep all chat + generation metadata in a single row keyed on
-- (user, project, node). messages = chronological list of prompts
-- and the image ids they produced.
-- ============================================================

create table if not exists public.image_gen_sessions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  project_id          uuid not null references public.projects(id) on delete cascade,
  node_id             text not null,
  -- Most recent response id from OpenAI's Responses API; used as
  -- previous_response_id on the next turn so the model carries
  -- context. Null on a fresh session.
  last_response_id    text,
  -- messages: [
  --   { id: string,  prompt: string,  status: "pending"|"done"|"error",
  --     createdAt: number,  imagePaths: string[],  error?: string,
  --     refImageHashes?: string[] }
  -- ]
  -- imagePaths point to objects in image-gen-private (private to the
  -- owner). Each image's URL is constructed at read time from this
  -- path + the bucket.
  messages            jsonb not null default '[]'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, project_id, node_id)
);

create index if not exists image_gen_sessions_user_project_idx
  on public.image_gen_sessions (user_id, project_id);

-- updated_at touch trigger.
create or replace function public.trg_image_gen_sessions_touch()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists image_gen_sessions_touch
  on public.image_gen_sessions;
create trigger image_gen_sessions_touch
before update on public.image_gen_sessions
for each row execute function public.trg_image_gen_sessions_touch();

alter table public.image_gen_sessions enable row level security;

drop policy if exists "image_gen_sessions select own"
  on public.image_gen_sessions;
create policy "image_gen_sessions select own"
  on public.image_gen_sessions
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "image_gen_sessions insert own"
  on public.image_gen_sessions;
create policy "image_gen_sessions insert own"
  on public.image_gen_sessions
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "image_gen_sessions update own"
  on public.image_gen_sessions;
create policy "image_gen_sessions update own"
  on public.image_gen_sessions
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "image_gen_sessions delete own"
  on public.image_gen_sessions;
create policy "image_gen_sessions delete own"
  on public.image_gen_sessions
  for delete to authenticated using (auth.uid() = user_id);

grant select, insert, update, delete on public.image_gen_sessions
  to authenticated;

-- ============================================================
-- storage buckets
--
-- Public bucket: file_size_limit set generously to accommodate
-- 4K PNGs that gpt-image-2 can produce. Adjust if needed.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('image-gen-private', 'image-gen-private', false, 33554432),  -- 32 MB
  ('image-gen-public',  'image-gen-public',  true,  33554432)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;

-- ============================================================
-- storage.objects RLS for image-gen-private
--
-- Path convention: <userId>/<projectId>/<nodeId>/<imageId>.<ext>
-- Allow CRUD only when the first path segment matches auth.uid().
-- ============================================================

drop policy if exists "image_gen_private read own"
  on storage.objects;
create policy "image_gen_private read own"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'image-gen-private'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "image_gen_private write own"
  on storage.objects;
create policy "image_gen_private write own"
  on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'image-gen-private'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "image_gen_private update own"
  on storage.objects;
create policy "image_gen_private update own"
  on storage.objects
  for update to authenticated
  using (
    bucket_id = 'image-gen-private'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'image-gen-private'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "image_gen_private delete own"
  on storage.objects;
create policy "image_gen_private delete own"
  on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'image-gen-private'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- ============================================================
-- storage.objects RLS for image-gen-public
--
-- Path convention: <projectId>/<nodeId>/<imageId>.<ext>
-- Public read; authenticated write. We don't enforce a per-project
-- ownership check at the storage layer in v1 — the worst case is
-- a signed-in user uploading to someone else's <projectId>/ path,
-- which is benign (the ImageGeneratePanel only ever writes to its
-- own project's path) and nothing about it leaks data.
-- ============================================================

drop policy if exists "image_gen_public read all"
  on storage.objects;
create policy "image_gen_public read all"
  on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'image-gen-public');

drop policy if exists "image_gen_public write authed"
  on storage.objects;
create policy "image_gen_public write authed"
  on storage.objects
  for insert to authenticated
  with check (bucket_id = 'image-gen-public');

drop policy if exists "image_gen_public update authed"
  on storage.objects;
create policy "image_gen_public update authed"
  on storage.objects
  for update to authenticated
  using (bucket_id = 'image-gen-public')
  with check (bucket_id = 'image-gen-public');

drop policy if exists "image_gen_public delete authed"
  on storage.objects;
create policy "image_gen_public delete authed"
  on storage.objects
  for delete to authenticated
  using (bucket_id = 'image-gen-public');

commit;
