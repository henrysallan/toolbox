-- Toolbox: R2 cloud media — M0 (entitlements + asset ledger)
-- Spec: specdocs/081626_r2-media-storage.md
--
-- Adds:
--   * public.user_entitlements — per-user feature gate + quota, with
--     Stripe-ready columns (all null until M4). SELECT-own only; NO
--     client write policies — writes happen exclusively via the service
--     role (API routes, later the Stripe webhook) or this SQL editor.
--     Deliberately NOT user_preferences.meta: that table's RLS grants
--     the user UPDATE on their own row, which would be self-serve
--     entitlement.
--   * public.media_assets — the upload ledger (quota accounting, future
--     GC). Same rule: SELECT-own, service-role writes only — a
--     client-writable ledger would let a user reset their own quota
--     while keeping the objects.
--   * seed row enabling cloud media for the owner's personal account.
--
-- Run in the Supabase SQL editor. Wrapped in a transaction and every
-- statement is idempotent — safe to re-run.

begin;

-- ============================================================
-- user_entitlements
-- ============================================================

create table if not exists public.user_entitlements (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  cloud_media         boolean not null default false,
  storage_quota_bytes bigint,            -- null = unlimited
  plan                text not null default 'free',
  -- Stripe-ready columns, all null until the payments milestone (M4):
  stripe_customer_id     text,
  stripe_subscription_id text,
  subscription_status    text,
  current_period_end     timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_entitlements enable row level security;
grant select on public.user_entitlements to authenticated;

drop policy if exists "entitlements select own" on public.user_entitlements;
create policy "entitlements select own" on public.user_entitlements
  for select using (auth.uid() = user_id);

-- No insert/update/delete policies on purpose (see header).

-- ============================================================
-- media_assets (the ledger)
-- ============================================================

create table if not exists public.media_assets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  hash       text not null,              -- sha256 hex of the file bytes
  ext        text not null,
  mime       text not null,
  size       bigint not null,
  filename   text not null,              -- display name for the storage panel
  kind       text not null,              -- 'video' | 'audio' | 'model'
  status     text not null default 'pending',  -- 'pending' | 'ready'
  created_at timestamptz not null default now(),
  unique (user_id, hash)
);

create index if not exists media_assets_user_idx
  on public.media_assets (user_id);

alter table public.media_assets enable row level security;
grant select on public.media_assets to authenticated;

drop policy if exists "media_assets select own" on public.media_assets;
create policy "media_assets select own" on public.media_assets
  for select using (auth.uid() = user_id);

-- No insert/update/delete policies on purpose (see header).

-- ============================================================
-- seed: enable cloud media for the owner's personal account
-- ============================================================

insert into public.user_entitlements (user_id, cloud_media, plan)
select id, true, 'owner'
from auth.users
where email = 'isthishenry@gmail.com'
on conflict (user_id) do update
  set cloud_media = true, plan = 'owner', updated_at = now();

commit;
