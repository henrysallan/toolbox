# Save optimization — Tier 2: content-addressed cloud assets

Status: implemented (code + migration SQL). Awaiting the manual Supabase
migration run + in-browser verification (milestone 3).
Prior tier: 071426_save-optimization.md (identity-keyed encode caches). This
builds on it — the cloud save path post-processes Tier 1's inline-data-URL
graph.

## Problem

Cloud save uploads the *entire* graph jsonb — media inlined as base64 — on
every save, even when only a slider moved. A 20MB project pushes ~20MB up
the wire (browsers don't gzip request bodies) each save, Postgres rewrites
the whole TOASTed `graph` column, and past ~30s of body it trips the
statement timeout (57014) — the origin of the 50MB hard cap and 16MB
warning in `saveToRow`. Loads pull the same giant row through PostgREST in
one shot.

## Solution

Mirror the `.toolbox` container in the cloud. Media assets become
**content-addressed objects in Supabase Storage**; the `graph` row keeps
only `{ kind, asset: <sha256>, ext, mime, …envelope }` references. On save
the client uploads **only assets not already present**, then writes a
now-tiny row. On load, refs resolve to public Storage URLs that the
existing deserializer fetches lazily.

Result: save cost ≈ new-media bytes + tiny row (unchanged media = zero
upload); the 50MB cap and the timeout failure class are gone; loads fetch
assets in parallel from the CDN instead of one monster row.

## Decisions (owner, 2026-07-14)

1. **One public bucket, unguessable paths.** Bucket `project-assets`,
   `public: true`, exactly like `project-thumbnails`. Path
   `<user_id>/<project_id>/<sha256>.<ext>`. Reads are unrestricted (CDN-
   cached, work for signed-out `/live` visitors with no signed-URL expiry
   or minting). **Trade-off, on the record:** a *private* project's media
   is then security-by-obscurity — the path needs a 256-bit content hash
   AND a UUID to guess, but a leaked URL (logs, referrer) is world-
   readable forever. This matches the existing trust level of thumbnails.
   If real per-project privacy is ever needed, revisit with a private
   bucket + signed URLs (rejected here for the live-viewer expiry wart and
   extra infra).

2. **Per-project namespacing.** Assets live under `<user>/<project>/`. GC
   is trivial — deleting a project deletes its prefix; re-save prunes its
   own prefix. No cross-project dedup (the same image in two projects is
   stored twice), accepted to avoid refcounted GC.

3. **Post-process the cloud save path.** `serializeGraph` is unchanged and
   still emits inline data-URLs (Tier 1 makes that cheap for unchanged
   media). The cloud writer extracts → uploads → rewrites to refs, reusing
   the exact primitives `writeProjectFile` already uses. `.toolbox` stays
   inline-then-extract as today. (A future unification could give
   `serializeGraph` a binary-collector mode so both paths and `.toolbox`
   drop base64 — explicitly out of scope here.)

## Schema v9

`CURRENT_SCHEMA = 9`. The only wire change: a media envelope MAY carry
`asset: <hash>` + `ext` instead of `dataUrl`. Everything else is
identical. Back-compat:

- **Old rows load unchanged.** ≤v8 rows have inline `dataUrl` envelopes;
  `resolveAssetRefs` is a no-op on them (no `asset` field), and
  deserialize inlines them exactly as before. No migration pass needed.
- **A v9 row opened by an old build** can't resolve refs — same forward-
  only contract every schema bump has (invariant #2). Desktop mitigated by
  auto-update. Exported apps embed an inline graph at export time and are
  unaffected.
- First save of any project (old or new) rewrites it to v9 refs.

## Data flow

### Save (`saveProject` / `updateProject` in supabase/projects.ts)

Both already resolve `userId` (getUser) and a `projectId` (generated /
arg). New step between serialize and the DB write:

```
graph(inline) ──uploadGraphAssets({supabase,userId,projectId})──▶ graph(refs)
```

`uploadGraphAssets`:
1. Walk nodes; for each inline asset (`isInlineAsset`) decode bytes
   (native `fetch(dataUrl)`), `sha256Hex` → path
   `<user>/<project>/<hash>.<ext>`. Build the ref `{…envelope − dataUrl,
   asset: hash, ext, mime}`. Dedup within the graph by hash.
2. `list(<user>/<project>/)` once → set of existing object names. Upload
   only assets whose file isn't present (`upsert: true` anyway, so a race
   double-write is harmless — content-addressed, same bytes same path).
3. Return the ref-graph. Callers write it to the row.

Ordering: **assets first, row last.** A failed/rolled-back save leaves
cheap orphan objects, never a row pointing at missing assets (same
rationale as the existing thumbnail-before-row upload).

Re-save of an unchanged project: identical bytes → identical hashes →
all present in `list` → zero uploads; only the tiny row is written.

**Prune (best-effort, `updateProject` only, AFTER a successful CAS
write):** delete objects under the prefix whose hash isn't in the written
ref set. Safe because per-project scoping means nothing else references
them, and it runs only when our compare-and-swap won (so we are the
authoritative latest — a window that lost the CAS errors out before
pruning). Non-fatal: a failed prune just leaves orphans.

The `saveToRow` 50MB cap / 16MB warning move to measuring the **ref-graph**
(post-upload), which is tiny — so the cap effectively lifts. Keep a much
higher guard (e.g. warn if a *single asset* > 100MB) as a sanity rail.

### Load (`loadProject`, `loadPublicProjectBySlug`)

After fetching the row, before returning the graph:

```
graph(refs) ──resolveAssetRefs({supabase,userId,projectId})──▶ graph(url-envelopes)
```

`resolveAssetRefs` replaces each `{asset,ext}` ref with `{…envelope,
dataUrl: <public Storage URL>}` (via `storage.getPublicUrl` — synchronous,
no fetch). `deserializeParams` already does `fetch(envelope.dataUrl)`,
which works on an `https:` URL exactly as on a `data:` URL, so **deserialize
is unchanged** and fetches lazily/in parallel per node. No ref → no-op
(old inline rows pass straight through).

Both load functions have `user_id` + project id in hand, so this needs **no
threading of ids to the `/p` and `/live` client components** — the graph
they receive already carries URLs.

**Tier 1 cache interaction:** the prime calls in deserialize
(`primeBlobDataUrl` / `primeBitmapDataUrl`) are guarded to only cache
`data:` URLs. On the v9 path the primed value would be an `https:` URL —
priming it would make the next save's cached "data-URL" a non-`data:`
string that `isInlineAsset` rejects, silently dropping the asset from the
row. The guard skips priming for storage URLs; the first re-save then
re-encodes via Tier 1's cache-miss path (one honest encode) and produces a
real `data:` URL → extract → same content hash → already present → no
re-upload. Correct and no base64 at load time.

### Delete (`deleteProject`)

After the row delete, remove the `<user>/<project>/` Storage prefix
(list + bulk `remove`), best-effort, mirroring the thumbnail cleanup
already there.

## Access-control & the `is_public` toggle

Because the bucket is fully public, going public/private needs **no asset
movement** — the URLs already resolve for anyone. `setProjectVisibility`
is unchanged. (This is the upside of decision #1 vs copy-on-publish.)

## Shared primitives

`isInlineAsset`, `isAssetRef`, `dataUrlToBytes`, `sha256Hex`, `mimeToExt`,
`PRECOMPRESSED_MIMES` currently live module-private in project-file.ts.
Extract to `src/lib/asset-envelope.ts` and import from both project-file.ts
and the new cloud path — one definition of "what an asset envelope is."

## Files

- `specdocs/project-assets-migration.sql` — new bucket + RLS (copy of the
  thumbnails migration, retargeted). **The owner runs this in the Supabase
  SQL editor before v9 saves work.**
- `src/lib/asset-envelope.ts` — extracted shared primitives.
- `src/lib/supabase/project-assets.ts` — `uploadGraphAssets`,
  `resolveAssetRefs`, `deleteProjectAssets`, `PROJECT_ASSETS_BUCKET`.
- `src/lib/project.ts` — `CURRENT_SCHEMA = 9`; prime-call `data:` guards;
  v9 doc note.
- `src/lib/project-file.ts` — import primitives from asset-envelope.ts.
- `src/lib/supabase/projects.ts` — wire upload into save, resolve into
  load, prune into delete; retarget the size cap at the ref-graph.

## Milestones

1. Bucket SQL + `asset-envelope.ts` extraction (no behavior change;
   typecheck + `.toolbox` round-trip still green).
2. `project-assets.ts` + schema v9 + save/load/delete wiring + prime
   guards.
3. Manual: run the migration; browser round-trip (cloud save→reload,
   `/p` + `/live` view, delete) with images/paint/EXR/fonts; verify a
   second save uploads nothing (network panel) and the row is tiny.

## Verification

- `npm run typecheck`, `npm run check`, `npm run lint:ratchet`.
- Node test of `uploadGraphAssets`/`resolveAssetRefs` pure logic against a
  faked storage client: dedup, only-new upload, ref round-trips to the same
  URL, caller graph not mutated, ≤v8 inline graphs pass through untouched.
- Manual (milestone 3 above) — the parts needing real Supabase + a browser.
