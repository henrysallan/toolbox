# R2 media storage + entitlements (and the road to paid storage)

Status: **M0 complete and verified** (2026-08-17): infra live (bucket,
`media.isthishenry.com`, CORS, migration + owner seed) and the full route
flow tested end-to-end — presign → presigned PUT → commit → public URL
byte-match, content-addressed dedup on re-presign, un-entitled account
403, quota row cleanup. Production routes need one redeploy to receive
the (Sensitive) env vars before they work on the hosted app. Next: M1.
Decisions in §3 resolved by owner 2026-08-16. Companion reading: [archive/071426_cloud-asset-storage.md](archive/071426_cloud-asset-storage.md)
(the images tier this extends), [081426_shared-projects.md](081426_shared-projects.md)
(collaborator asset-write conventions), and the header comment of
[lib/media-relink.ts](../src/lib/media-relink.ts) (the relink strategies this
supersedes for entitled users).

## 1. Problem

Toolbox has **two media pipelines** today:

| Class | Types | Persisted? |
|---|---|---|
| Embedded | `file` (image/EXR), `paint`, `font` | Yes — content-addressed objects in the public Supabase Storage bucket `project-assets` (`<user>/<project>/<sha256>.<ext>`), refs in the row |
| Referenced | `video_file`, `audio_file`, `model_file`, `image_sequence` | **No** — only an identity envelope (filename/size/duration/dims); bytes must be re-picked from local disk (relink) |

Consequences of the second row:

- Every project load on another machine (or after handle loss) hits the
  relink modal; Electron and Firefox/Safari can't silently relink at all.
- `model_file` (GLB/OBJ/STL) has **no relink** — a 3D import is simply lost
  on reload (`project.ts:473` "No relink yet"; the pill renders "re-pick").
- Live links and exported apps can't ship with their video/audio — the
  control panel makes the *visitor* supply files. `model_file` isn't even in
  `FILE_PARAM_TYPES`, so a 3D project can't meaningfully go live at all.

Why heavy media can't just join the existing Supabase pipeline:

- The images tier round-trips bytes through base64 data-URLs inside
  `serializeGraph` — non-viable for a 500 MB clip (memory + CPU).
- Supabase Storage bills **egress** (~$0.09/GB past the bundled quota).
  Video playback is egress-heavy, and public live links multiply it by
  audience size — the cost scales with *success*.

**Cloudflare R2** is the fit: S3-compatible, $0.015/GB-mo storage, **zero
egress fees**, presigned uploads, range requests (video seeking) natively,
custom-domain public buckets riding the Cloudflare CDN.

## 2. Product shape (what the owner asked for)

- Cloud object storage for video / audio / 3D files (more kinds later).
- **Gated per user.** Enabled initially for exactly one account
  (`isthishenry@gmail.com`). Everyone else keeps today's behavior
  (relink) untouched.
- The gate is an **entitlement** designed so that a future Stripe
  subscription webhook can flip it — payments UI comes later (§9), but the
  schema and the gate must not need rework when it does.
- **Reading is never gated.** A viewer/collaborator without the entitlement
  still plays R2-hosted media (public unguessable URLs, same trust model as
  the images bucket). Only *upload* (and quota) is entitled. This is what
  makes live links work for anonymous visitors and shared projects work for
  un-entitled collaborators.

## 3. Decisions (owner, 2026-08-16)

1. **Media domain: `media.isthishenry.com`** (app domain is
   `https://toolbox.isthishenry.com`). One level deep on purpose:
   Cloudflare Universal SSL covers only `*.isthishenry.com`, so
   `media.toolbox.isthishenry.com` would need the paid Advanced
   Certificate Manager. Constraint to verify at setup time: R2 custom
   domains require the `isthishenry.com` **zone to be on Cloudflare** in
   the same account as the bucket (§8.1). `*.r2.dev` is rate-limited and
   not production-suitable.
2. **Public-read** with unguessable `<uid>/<sha256>` paths — the
   trade-off already accepted on the record for `project-assets` (071426
   decision #1); the only shape that keeps live-link URLs stable,
   CDN-cacheable, and expiry-free.
3. **Audio in v1: yes** — shares the video code path almost entirely.
4. **Dedup scope: per-USER** (`<user_id>/<sha256>.<ext>`), unlike the
   per-project images bucket. Videos are big and reused across projects.
   Cost: GC needs the ledger (§5.2) instead of prefix-delete — v1 defers
   GC entirely (§8 M3).
5. **Schema bump: yes**, `CURRENT_SCHEMA` 10 → 11 at M1. The envelope
   fields are additive, but an older build re-saving a v11 project would
   silently drop the cloud refs (recoverable — object and ledger survive
   — but the v9 precedent bumped for less).
6. **Owner quota: unlimited** (`storage_quota_bytes = null`) for the
   seeded account; tiers come with Stripe.
7. **Lapse policy: read-forever.** When a subscription ends, uploads stop
   but stored assets and published live links keep working. Revisit only
   if abuse appears.

## 4. Architecture overview

```
pick file ──▶ register locally (unchanged — instant playback)
   │
   └─(entitled?)──▶ sha256 (streaming) ──▶ POST /api/media/presign
                                             │  auth + entitlement + quota
                                             │  ledger row (status=pending)
                                             ▼
                    PUT bytes ──────────▶ R2  (presigned URL, XHR progress)
                                             │
                    POST /api/media/commit ──┤  HEAD verifies size
                                             ▼  ledger row → ready
                    param value gains { cloud: { hash, ext, owner } }

save: envelope serializes WITH the cloud ref (no bytes through serialize —
      upload happened at pick time; this sidesteps the base64 problem that
      kept video out of the images tier)

load: envelope has cloud ref ──▶ <video src="https://media…/owner/hash.ext">
      (streams, range requests, no download-then-play)
      ref missing / fetch fails ──▶ today's relink flow, unchanged
```

Two new tables, two (later three) API routes, one new client subsystem
(upload manager + entitlements context), additive envelope fields. The
images tier is **untouched** — images stay in Supabase Storage for now
(possible R2 migration is explicitly out of scope, §10).

## 5. Data model

Migration: **[r2-media-migration.sql](r2-media-migration.sql)** (hand-run
in the Supabase SQL editor, idempotent, includes the owner seed).

### 5.1 `user_entitlements` — the gate

`user_id (pk → auth.users) · cloud_media bool · storage_quota_bytes
bigint null=unlimited · plan · stripe_customer_id / stripe_subscription_id
/ subscription_status / current_period_end (all null until M4) ·
timestamps`. RLS: **select-own only — no client write policies**; writes
happen exclusively via service role (API routes, later the Stripe
webhook) or the SQL editor.

**Deliberately NOT `user_preferences.meta`** — that table's RLS grants the
user full UPDATE on their own row, so a flag there is self-serve
entitlement. The migration seeds `cloud_media = true, plan = 'owner'` for
`isthishenry@gmail.com`.

### 5.2 `media_assets` — the ledger (quota + future GC)

`id · user_id · hash (sha256) · ext · mime · size · filename · kind
('video'|'audio'|'model') · status ('pending'|'ready') · created_at ·
unique (user_id, hash)`. RLS: select-own only; **writes service-role
only** — client-writable rows would let a user reset their own quota
ledger while keeping the objects.

Quota used = `sum(size)` over rows that are `ready` OR (`pending` AND
younger than 24 h) — counting fresh pendings prevents overshoot by parallel
presigns; stale pendings (abandoned uploads) age out of the sum and get
swept later (M3).

Both tables follow the house 42703 convention consumers-side: code ships
tolerant of the tables not existing yet (entitlement read failure ⇒ not
entitled ⇒ default behavior), since migrations are hand-run.

### 5.3 Bucket

- Name: `toolbox-media`. Key: `<user_id>/<sha256>.<ext>` — flat per-user,
  content-addressed. Same file in three projects = one object.
- Public read via the custom domain (§3.1); unguessable-path privacy, same
  recorded trade-off as `project-assets`.
- Shared projects: an upload always lands under the **uploader's** prefix
  and counts against the **uploader's** quota. This differs from the
  Supabase convention (collaborator writes land in the owner's prefix)
  because the envelope carries its `owner` explicitly (§7.1), so resolution
  never assumes the project owner's folder — and quota responsibility
  follows the person who has the entitlement.

## 6. Server surface

First real server-side product code beyond the AI proxies. Modeled on
[lib/ai/anthropic-key.ts](../src/lib/ai/anthropic-key.ts): server Supabase
client → `auth.getUser()` → per-user lookup → typed
`{ ok } | { ok:false, status, error }`.

Implemented in: [cloud-media.ts](../src/lib/cloud-media.ts) (shared
vocabulary: constants, ref shape, URL building, ext/mime tables),
[cloud-media-server.ts](../src/lib/cloud-media-server.ts) (auth +
entitlement resolution, service-role client, aws4fetch signing),
[api/media/presign/route.ts](../src/app/api/media/presign/route.ts),
[api/media/commit/route.ts](../src/app/api/media/commit/route.ts).

### 6.1 `POST /api/media/presign`

Body `{ hash, size, filename, kind }` — **no client-chosen mime**: the
server derives ext AND mime from the filename against the kind's
allowlist and signs the Content-Type into the presigned URL. On a
public-read bucket an uploader-chosen mime would let an entitled account
store `text/html` served from `media.isthishenry.com` — a hosted phishing
page. Flow →

1. Auth (cookie session; later also `Authorization: Bearer` for desktop, §6.5).
2. Entitlement: `user_entitlements.cloud_media` for `user.id` (the route can
   read it with the user's own cookie-scoped client — select-own RLS covers
   it; the service-role client is only needed for ledger writes).
3. Dedup: `(user_id, hash)` already `ready` → return `{ already: true, url }`
   (zero upload — the idempotent re-save property of the images tier).
4. Quota: ledger sum (ready + fresh pendings) + incoming `size` ≤ quota
   (null = skip).
5. Upsert ledger row (`pending`), presign `PUT` for `<uid>/<hash>.<ext>`
   with the Content-Type signed, 1 h expiry. Size is NOT bound in the
   signature — it's verified at commit instead (§6.2), which deletes a
   mismatched object.
6. Return `{ uploadUrl, key, headers, expiresSeconds }` — the uploader
   must send exactly the returned Content-Type header.

Caps: v1 rejects `size > 2 GB` (single presigned PUT; multipart is M3).

### 6.2 `POST /api/media/commit`

Body `{ hash }` → signed `HEAD` against R2 verifies the object exists and
its size matches the ledger row → flip `pending → ready` → return the
public URL. Commit-after-upload means a crashed upload leaves only an
aged-out pending row, never a `ready` row pointing at nothing (the images
tier's "assets first, row last" ordering, translated).

### 6.3 SDK + env

- **aws4fetch** (few-KB, edge-safe) for presigning/HEAD — not the
  full `@aws-sdk/client-s3`.
- New env (Vercel only, never `NEXT_PUBLIC_`, never the Electron allowlist):
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
  and `SUPABASE_SERVICE_ROLE_KEY` (**new class of secret for this repo** —
  first service-role use anywhere; it exists only inside these routes).
- The public media base URL is a source constant
  (`MEDIA_PUBLIC_BASE = "https://media.isthishenry.com"` in
  [cloud-media.ts](../src/lib/cloud-media.ts) — house style, bucket names
  are constants too), used by both client URL-building and the routes.

### 6.4 Bucket CORS

- `GET`: `AllowedOrigins: *` — exported apps run on arbitrary origins, and
  WebGL upload of video frames requires `crossOrigin="anonymous"` +
  `Access-Control-Allow-Origin`. Same reasoning applies to Web Audio:
  `MediaElementSource` on a non-CORS cross-origin element outputs silence,
  which would kill the audio-analysis coercions.
- `PUT`: app production origin, `http://localhost:3000`, and
  `http://127.0.0.1:38274` (the pinned Electron origin).

### 6.5 Electron

The embedded standalone server deliberately strips secrets from its env
(`electron/server.js` allowlist — loopback servers are reachable by any
local process), so **the R2 routes are dead in the desktop's own server by
design**. Desktop uploads call the **hosted** deployment instead, passing
`session.access_token` as a Bearer header; the routes accept bearer-or-
cookie (`auth.getUser(jwt)`). Deferred to M3 — v1 is web-only for upload;
desktop *playback* of cloud refs works from day one (it's just an https
URL).

## 7. Client changes

### 7.1 Envelope extension (additive, schema 11)

```ts
interface MediaEnvelope {
  kind: "video_file" | "audio_file";        // model_file has its own shape
  filename: string; size?: number; duration?: number;
  width?: number; height?: number;
  cloud?: { hash: string; ext: string; owner: string };   // NEW
}
```

URL = `<media-base>/<owner>/<hash>.<ext>`.

A **nested `cloud` object, not top-level `asset`/`ext`** — deliberately.
`isAssetRef()` matches any object with a string `asset`, and both
`rewriteNodeToRefs` and `resolveAssetRefs` walk **every** param: top-level
`asset` on a video envelope would get keep-set-polluted and have a bogus
Supabase `dataUrl` grafted on. The nested key keeps the two systems
orthogonal with zero changes to the images tier. (Related landmine, on the
record: `project.ts` `isDataUrl` deliberately refuses `https:` — cloud URLs
must never masquerade as inline assets.)

`model_file` params (`{ kind, filename, size, format }`) gain the same
`cloud` field. `image_sequence` is out of scope (§10).

The `__missingMedia` parking mechanism is untouched — an envelope with a
`cloud` ref parks and revives exactly like today, so the hybrid
"ref present → fetch; absent → relink" is purely additive.

### 7.2 Entitlements context

`useEntitlements()` alongside `useUser()`: fetches the user's
`user_entitlements` row once per session (RLS select-own). Row absent /
table missing / error ⇒ `{ cloudMedia: false }` ⇒ today's behavior. This
read is advisory UI state only — the server re-checks on every presign.

### 7.3 Upload manager

New `lib/media-upload.ts`:

- **Hashing**: streaming sha256 via `hash-wasm` (new tiny dep) —
  `crypto.subtle.digest` needs the whole buffer in memory, a non-starter at
  2 GB. Chunked file reads keep memory flat.
- **Upload**: `XMLHttpRequest` PUT (fetch has no upload-progress events),
  progress surfaced per-node (the `node-media-loading` event pattern the
  image streamer already broadcasts).
- **Lifecycle**: pick → register locally (instant playback, unchanged) →
  hash/presign/PUT/commit in the background → on success, attach
  `cloud` to the param value in memory. Failure at any step = toast + the
  file stays local-only (relinkable) — mirror of the images tier's
  "Storage errors ⇒ fall back inline, saves keep working" rollout rule.
- **Save ordering**: a save while an upload is in flight serializes the
  envelope *without* the ref (still relinkable); the next save after commit
  includes it. No new save/stream race machinery — unlike images, the graph
  row never depends on the upload having happened.

Wire into `VideoFileControl` / `AudioFileControl` / `ModelFileControl` and
the drag-drop path (`onAddFileNode`), gated on `cloudMedia`.

### 7.4 Load path

- `registerVideoFile` / `registerAudioFile` gain URL variants (today they
  build ObjectURLs from Files; a `<video src=https crossOrigin=anonymous>`
  streams with range requests instead of downloading first). Electron's
  native-ffmpeg transcode fallback only applies to local Files; a cloud URL
  that Chromium can't decode is a known limitation (§10 transcoding).
- `import-3d.ts`'s `loadGeometry(url)` already accepts any URL — the GLB
  path is nearly free, and it **rescues the currently-lossy `model_file`**.
- Fetch failure (deleted object, offline) degrades to the missing-media
  marker → relink modal, which gains a "cloud fetch failed" status line.
- **Live viewer + `/p/` + exported apps**: envelopes resolve the same way —
  live links finally carry their own video/audio/3D. The control panel's
  file inputs remain as overrides. (`model_file` should join
  `FILE_PARAM_TYPES` as part of this.)
- Works for everyone — playback needs no entitlement (§2).

## 8. Milestones

- **M0 — infra + gate, no product change.** Code: DONE —
  [r2-media-migration.sql](r2-media-migration.sql),
  [cloud-media.ts](../src/lib/cloud-media.ts),
  [cloud-media-server.ts](../src/lib/cloud-media-server.ts), the two
  routes, [entitlements.ts](../src/lib/entitlements.ts)
  (`useEntitlements()`), `aws4fetch` dep. Blocked on §8.1. Verify once
  unblocked: presign from a signed-in session → PUT a file → commit →
  public URL streams in a bare `<video>` tag; a second (un-entitled)
  account gets 403 from presign.

### 8.1 Manual setup checklist (owner — dashboards, ~15 min)

Cloudflare:

1. **Confirm the `isthishenry.com` zone is on Cloudflare** (Cloudflare
   nameservers). R2 custom domains only attach to zones in the same
   account — if DNS lives elsewhere (e.g. Vercel), the zone has to move
   first; everything else below waits on this.
2. R2 → create bucket **`toolbox-media`**.
3. Bucket → Settings → Custom Domains → connect
   **`media.isthishenry.com`** (this is what makes it public-read; leave
   `r2.dev` access disabled).
4. Bucket → Settings → CORS policy:

   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["Range"],
       "ExposeHeaders": ["Content-Length", "Content-Range"],
       "MaxAgeSeconds": 86400
     },
     {
       "AllowedOrigins": [
         "https://toolbox.isthishenry.com",
         "http://localhost:3000",
         "http://127.0.0.1:38274"
       ],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["Content-Type"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

5. R2 → Manage API Tokens → create an **Object Read & Write** token
   scoped to the `toolbox-media` bucket → note the Access Key ID +
   Secret Access Key (S3 credentials) and the Account ID.

Supabase:

6. SQL editor → run
   [specdocs/r2-media-migration.sql](r2-media-migration.sql) (idempotent;
   includes the seed for `isthishenry@gmail.com`).
7. Project Settings → API → copy the **service_role** key (for the env
   below). First service-role use in this project — it must never leave
   Vercel/`.env.local`.

Env (Vercel project settings AND local `.env.local`; never
`NEXT_PUBLIC_`, never the Electron allowlist):

```
R2_ACCOUNT_ID=…
R2_ACCESS_KEY_ID=…
R2_SECRET_ACCESS_KEY=…
R2_BUCKET=toolbox-media
SUPABASE_SERVICE_ROLE_KEY=…
```
- **M1 — upload path (web, entitled). Code DONE (2026-08-17)**, including
  the editor-side load path (video/audio stream from the URL; model
  values rebuild — the `model_file` rescue landed early). Files:
  [cloud-media-upload.ts](../src/lib/cloud-media-upload.ts) (registry +
  upload manager + `setCloudMediaEnabled` gate + pill-state store),
  URL variants in [video.ts](../src/lib/video.ts) /
  [audio.ts](../src/lib/audio.ts), envelope + schema 11 in
  [project.ts](../src/lib/project.ts), pick/drag-drop/relink triggers in
  param-controls + EffectsApp, cloud round-trip guards in
  check-persistence §6. Notable constraint honored: param-controls is
  export-bundle-shared, so it can't read entitlements — EffectsApp sets a
  module flag instead, and the uploader derives `owner` from the presign
  key rather than importing Supabase. Manual verify (owner): pick video →
  ☁ appears on the pill → save → open in another browser profile → plays
  with no relink modal; un-entitled account picks stay local-only.
- **M2 — load everywhere. Code DONE (2026-08-17).** Most of it came free:
  the live viewer, `/p/`, and exported apps all deserialize through the
  same project.ts path M1 wired, and export verified byte-independent
  (video export samples rendered frames; audio export `fetch(spec.url)`
  works on https). Delta shipped here: `model_file` joined
  `FileParamType`/`FILE_PARAM_TYPES` with a `ModelFileRow` in the live
  ControlPanel (cloud-prefilled, picker as override — 3D projects can go
  live for the first time); the relink modal marks cloud-backed parked
  clips "☁ unreachable"; export-template bundle verified building with
  the new imports. Manual verify: publish a live link with cloud video +
  GLB → plays signed-out in a fresh browser; exported app does the same.
- **M3 — management + hardening.** Storage panel (usage, per-asset list,
  delete with reference scan), stale-pending sweep, multipart >2 GB,
  desktop bearer-auth uploads, quota UX (clear error at cap).
- **M4 — Stripe (own spec when we get there).** §9 is the forward design.

## 9. Payments (thinking ahead — NOT being built now)

The entitlement layer is the contract; Stripe is just a writer to it.

- **Model**: subscription (Stripe Checkout + Billing Portal, no custom card
  UI). Tiers TBD — e.g. free = no cloud media; Pro = cloud media +
  100 GB. Metered overage is a later option (Stripe usage records fed from
  the ledger — another reason `media_assets` exists).
- **Routes** (M4): `/api/billing/checkout` (Checkout Session; `user.id` in
  metadata, reuse `stripe_customer_id` when present), `/api/billing/portal`,
  `/api/billing/webhook` (raw-body signature verification;
  `checkout.session.completed`, `customer.subscription.updated|deleted` →
  service-role upsert of the entitlement row: `cloud_media`, quota, `plan`,
  status, period end). Webhooks are the **only** writer besides the SQL
  editor — the same no-client-writes rule that makes the table trustworthy.
- **Ungating = the webhook writing rows.** No schema change, no gate-logic
  change; the seeded owner row is just a hand-written subscription.
- **Lapse**: uploads stop immediately (`cloud_media = false` fails presign).
  Stored assets / live links: §3.7 (recommend read-forever for now).
- **Client**: `useEntitlements()` already carries `plan` — pricing UI can
  render from it whenever we build it.

## 10. Out of scope / later

- **Image migration to R2** — the Supabase images tier keeps working
  unchanged; consolidation is a separate decision (egress pressure will
  tell us).
- **`image_sequence`** — hundreds of per-frame files; wants an archive
  format or per-frame ledger design of its own. Still session-lost for now.
- **Transcoding** — uploads are stored as-picked; a ProRes `.mov` that only
  played via Electron's native-ffmpeg fallback won't play for web viewers
  of the same project. A transcode pipeline (upload-time or on-demand) is a
  real future project; do not bolt it onto M1.
- **True private media** (signed GETs) — revisit only if the recorded
  unguessable-path trade-off stops being acceptable.
- **GC beyond manual delete** — refcounting across projects (a
  `project_media_refs` join table maintained at save time) only becomes
  worth it with real user volume; the M3 reference *scan* (jsonb search
  across the user's rows) is enough at current scale.
