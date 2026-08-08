# Save optimization — Tier 1: identity-keyed encode caches (no format change)

Status: implemented (this doc describes what shipped).
Follow-up (Tier 2, separate spec when designed): content-addressed assets in
Supabase Storage so cloud saves upload only *new* media — see "Out of scope".

## Problem

Save cost is dominated by media assets, and every save re-encoded all of
them from scratch even when nothing changed:

- Every image `file` param re-ran Blob → arrayBuffer → a manual chunked
  `String.fromCharCode` + `btoa` loop (~1.33× inflation, heavy GC).
- Every paint layer re-ran a full `canvas.toDataURL("image/png")` encode.
- EXR stills re-encoded their entire original bytes the same way.
- The `.toolbox` writer then `structuredClone`d the whole graph, decoded
  every asset *back* to bytes with a per-char `atob` loop, hashed it, and
  DEFLATE-level-6-compressed every asset — including PNG/JPEG/WebP bytes
  that are already compressed and gain ~nothing from deflate.

Net: ~6–7 full passes over every media byte per file save, all on the main
thread, regardless of what changed. The graph JSON itself (nodes, edges,
keyframes) is almost always tiny.

## Design

One new module, [src/lib/data-url.ts](../../src/lib/data-url.ts): cached
native encoders, keyed on **object identity** in WeakMaps.

- `blobToDataUrl(blob, fallbackMime?)` — FileReader native encode, cached
  per Blob. Blobs are immutable, so identity is a sound key; entries die
  with the Blob.
- `bufferToDataUrl(buffer, mime)` — same, keyed per ArrayBuffer (font
  bytes).
- `bitmapToPngDataUrl(bmp)` — canvas draw + PNG encode, cached per
  ImageBitmap (also immutable). Used for unregistered-original image
  fallbacks AND paint snapshots.
- `primeBlobDataUrl` / `primeBitmapDataUrl` — deserialize seeds the caches
  with the data-URLs it just loaded, so the *first* save after a load is
  cached too, and the re-encoded bytes are byte-identical to the loaded
  ones (stable `.toolbox` asset hashes across load/save cycles).

### Why paint encodes from the snapshot, not the live canvas

The paint canvas is mutated in place, so it can't key a cache. But every
mutation path — stroke rAF ticks, stroke end, fill end, resolution resize
(PaintOverlay), and undo/redo (`onPaintRestore` in EffectsApp) — mints a
**fresh snapshot ImageBitmap** via `createImageBitmap(canvas)`. Serialize
now encodes the snapshot bitmap instead of the canvas: the cache key and
the encoded pixels are the same object, so they can never disagree. A save
fired in the few-ms window between an undo's `putImageData` and its async
snapshot replacement serializes the last *committed* snapshot — acceptable
last-committed-state semantics (previously it read the live canvas). The
`snapshot: null` bootstrap case (empty canvas, no strokes yet) falls back
to a direct uncached canvas encode.

### `.toolbox` writer ([src/lib/project-file.ts](../../src/lib/project-file.ts))

- Shallow clone (spread nodes + params) instead of `structuredClone` of a
  tree holding multi-MB strings. Envelope objects are already copied via
  `{...val}` before mutation, so the caller's graph stays untouched.
- Asset decode via native `fetch(dataUrl)` instead of the per-char `atob`
  loop.
- Already-compressed asset mimes (png/jpeg/webp/gif/exr, and the jpeg
  thumbnail) are written with `compression: "STORE"`; DEFLATE stays for
  `project.json` / `manifest.json` / everything else (e.g. fonts, which do
  deflate well). STORE entries are standard zip — old app versions read
  new files fine, no format bump.

### What was deliberately skipped

- Cross-save SHA-256 caching: hashes are computed on fresh byte arrays, and
  `crypto.subtle` is native and fast — after STORE-mode it's nowhere near
  the bottleneck. Not worth retaining giant strings as Map keys.
- The cloud preflight `JSON.stringify` (size check) and supabase-js's
  second stringify: unavoidable without bypassing supabase-js; the payload
  upload dominates that path anyway (Tier 2's target).
- Incremental zip rewriting: after STORE-mode, regeneration is ~a copy
  pass.

## Invariant (add to reviews of media-param code)

**Media param values are replace-only.** The save caches key on object
identity (Blob / ArrayBuffer / ImageBitmap). Any code that produces new
media *content* must produce a new object — never mutate bytes or pixels
behind an existing Blob/bitmap reference. Every existing path already
behaves this way (Blobs/bitmaps are immutable by API; paint mints new
snapshots); keep it that way.

## Memory trade-off

The caches retain each asset's base64 string (~1.33× its encoded file
size) for as long as the media object lives. This is small next to what
the app already holds per image (the decoded RGBA bitmap is typically an
order of magnitude larger than the source file). Seeding at load makes the
cost unconditional rather than starting at first save — accepted.

## Expected effect

A save where no media changed costs: small JSON stringify + (cloud) the
network upload of the full row, or (file) hashing + one copy pass into a
mostly-STORE zip. Serialize itself drops from O(total media bytes, several
passes) to ~O(graph JSON). The cloud upload becomes the remaining
bottleneck — that's Tier 2.

## Out of scope — Tier 2 pointer

Move cloud media out of the jsonb row into content-addressed Supabase
Storage objects (`{kind, asset: <hash>}` refs, schema v9), mirroring the
`.toolbox` container. Open design questions for that spec: public-project
asset access (signed URLs vs copy-on-publish), per-project vs per-user
namespacing (GC simplicity vs dedup), and whether `serializeGraph` grows a
binary-envelope mode so `.toolbox` drops base64 entirely.

## Verification

- `npm run typecheck`, `npm run check`, `npm run lint:ratchet`.
- Node round-trip sanity of `writeProjectFile`/`readProjectFile` (assets
  dedup, STORE entries readable, caller's graph not mutated).
- Manual in-browser: save→load round-trip (cloud + `.toolbox`) of a
  project with images, paint, EXR, custom + local fonts; paint→undo→save
  serializes the undone state; repeated Cmd+S on a media-heavy project is
  visibly faster after the first save.
