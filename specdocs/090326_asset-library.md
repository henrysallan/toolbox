# Asset Library — project-agnostic Assets panel (2026-09-03)

Status: **M1–M4 code complete (2026-09-03)** — gates green (typecheck,
`npm run check` incl. the new `check-svg-write`, lint on touched files).
First browser pass (owner, same day) found two bugs, both fixed: the node
editor's `onDragOver` never opted in to `application/x-toolbox-asset`
(no `drop` for ANY Assets-panel card — the June folder/font drags had
the same latent bug), and preset thumbnails could come back empty (node
not in the eval cache / JPEG over the inline cap — see §3.3).
Pending: owner runs [user-assets-migration.sql](user-assets-migration.sql)
in the Supabase SQL editor, then the §7 manual pass in the browser.

A per-user library of images, SVGs, videos and node presets that follows
the user across projects and devices, surfaced in a new **Assets** panel
kind. Cards drag (or double-click) into the node editor. Media enters the
library from a node's context menu (**Add to Assets**) or from the panel's
own **Assets ▸ Upload Asset…** menu; node presets enter through the
existing **Save as Preset…**. Every entry gets an auto-generated
thumbnail, replaceable from the card's context menu.

Extends, and folds in, the June assets work
([archive/062926_assets.md](archive/062926_assets.md) — project fonts +
external folder, the `AssetsView` component and the
`application/x-toolbox-asset` drag/drop path). Storage precedents:
[archive/071426_cloud-asset-storage.md](archive/071426_cloud-asset-storage.md)
(Supabase images tier) and
[081626_r2-media-storage.md](081626_r2-media-storage.md) (R2 video tier).
Preset precedent: [081226_user-node-presets.md](081226_user-node-presets.md).

## Decisions (owner Q&A, 2026-09-03)

1. **One component, three mounts.** "Assets" becomes a real `PanelKind`;
   the upgraded `AssetsView` IS the panel, with the library as its
   primary section and the existing *In project* / *Folder* sections
   folded in below. File → Assets (param-panel mount) and the Project
   view's Comps/Assets pill keep working because they render the same
   component.
2. **Images and SVGs live in a new public Supabase bucket `user-assets`**,
   content-addressed `<uid>/<hash>.<ext>`, own-folder RLS — the
   `project-assets` shape verbatim. Thumbnails sit in the same bucket at
   `<uid>/thumbs/<assetId>.jpg`. (Rejected: a `library` pseudo-project
   inside `project-assets` — its prune/delete code lists by prefix.)
3. **Index = a `user_assets` table**, client-writable under own-row RLS.
   Unlike the R2 ledger there is no quota to protect, so no service role.
4. **Presets stay in their store** (`user_preferences.node_presets`
   jsonb + localStorage) and gain an optional small `thumbnail` field.
   The add menus and the signed-out path are untouched; the panel merges
   two stores. ~1 MB of jsonb at the 60-preset cap is the accepted cost.
5. **Preset thumbnail = the node's primary output.** Texture-backed
   (image / mask / uv, or an image_group's first item) → GPU readback;
   **spline → the same stroke the viewport's default spline preview
   draws; 2D points → dots.** Anything else (3D, values, unevaluated)
   falls back to a type glyph; the custom-thumbnail upload covers it.
6. **Video thumbnail = a fixed point**: 10 % into the clip.
7. **Video needs the cloud-media entitlement.** Un-entitled accounts see
   *Add to Assets* disabled with a hint on video nodes, and Upload
   accepts images/SVG only. Stripe flips this later (R2 spec §9).
8. **v1 media scope: Image Source, SVG Source, Video Source.** Audio, 3D,
   fonts, paint, image sequences later.
9. **Panel chrome:** header row with the kind chip, an **Assets ▾** menu
   (Upload Asset…, Refresh), filter chips (All · Images · SVG · Video ·
   Presets), a search box, count. Grid of cards, newest first. Card
   context menu: Rename…, Replace Thumbnail…, Delete. OS files dropped on
   the panel upload. Double-click inserts at the last pointer position.
10. **Menu label: "Add to Assets"** (it copies bytes into a library; "Mark
    as asset" reads like a toggle).
11. **Delete semantics.** Image/SVG: object + thumbnail + row go; projects
    are unaffected (they copied the bytes into their own prefix on save).
    Video: row only — the R2 object is referenced directly by projects and
    is never touched. Preset: the existing removal.
12. **Insert paths.** Image/SVG drops fetch the object and ride the
    existing file-drop path (the project re-uploads into its own prefix on
    save — the recorded per-project model). Video drops build the value
    from the R2 URL and seed the cloud-ref registry, so the save carries
    the ref with no re-upload. Presets ride the existing `user-preset:`
    insert, refactored to take a drop position.

## 1. Data model

Migration: **[user-assets-migration.sql](user-assets-migration.sql)**
(hand-run in the Supabase SQL editor, idempotent).

### 1.1 `user_assets`

```
id          uuid pk default gen_random_uuid()
user_id     uuid not null → auth.users on delete cascade
kind        text not null            -- 'image' | 'svg' | 'video'
name        text not null            -- display name (rename in place)
hash        text not null            -- sha256 hex of the bytes
ext         text not null
mime        text not null
size        bigint not null
width/height int null, duration double precision null
storage     text not null            -- 'supabase' | 'r2'
owner       uuid null                -- R2 uploader id (video); the CloudMediaRef.owner
thumb_rev   int not null default 0   -- 0 = no thumbnail; bumped on every (re)upload
created_at / updated_at timestamptz
unique (user_id, kind, hash)
```

RLS: select / insert / update / delete **own rows**. Rollout-safe
consumer-side: `42P01` (table missing) ⇒ empty list; an insert failure
toasts and nothing else changes.

`thumb_rev` instead of a URL column: the thumbnail path is derived
(`<uid>/thumbs/<id>.jpg`), and the rev is the cache-buster (`?v=<rev>`),
so replacing a thumbnail never changes the row's shape.

### 1.2 Bucket `user-assets`

Public; policies copied from `project-assets` (read: all; write/update/
delete: `auth.uid() = foldername[1]`). Objects:

- `<uid>/<hash>.<ext>` — image / SVG bytes. **SVGs upload with
  `contentType: application/octet-stream`**, never `image/svg+xml`: on a
  public bucket a script-bearing SVG served inline is a hosted XSS page.
  The client only ever `fetch()`es the text and parses it itself; the
  thumbnail is a raster we render.
- `<uid>/thumbs/<assetId>.jpg` — 256 px JPEG, `upsert: true`. Custom
  thumbnails are **re-encoded client-side** into the same shape (bounded
  size, known mime) — user-supplied bytes are never stored as-is.

Videos have **no object here** — `storage = 'r2'` rows point at the
existing `<owner>/<hash>.<ext>` on `media.isthishenry.com`.

### 1.3 Preset thumbnail (additive, no migration)

`UserNodePreset.thumbnail?: string` — a `data:image/…` URL, ≤ 96 K chars.
`sanitize` keeps the field only when it's a string with that prefix
under the cap; anything else is dropped (the preset itself survives).
New store ops: `setUserNodePresetThumbnail(id, dataUrl | null)` and
`renameUserNodePreset(id, name)` (the 081226 "rename in place"
follow-up — the card menu wants it).

## 2. Modules

- **[lib/supabase/user-assets.ts](../src/lib/supabase/user-assets.ts)** —
  row CRUD + object upload/remove + URL builders (`userAssetUrl`,
  `userAssetThumbUrl(row)` with the `?v=` bust). Mirrors
  `project-assets.ts` conventions (`createClient`, warn-and-degrade).
- **[state/user-assets.ts](../src/state/user-assets.ts)** — module store
  with `useSyncExternalStore` (the node-presets pattern): `loadUserAssets`
  (on mount / identity change), `useUserAssets()`, and the ops the panel
  and EffectsApp call: `addImageAsset`, `addSvgAsset`, `addVideoAsset`,
  `renameAsset`, `replaceAssetThumbnail`, `deleteAsset`. Each op does
  bytes → hash → dedup probe → object upload → thumbnail → row insert →
  publish; the store owns the "already in your assets" short-circuit
  (`unique (user_id, kind, hash)`).
- **[lib/asset-thumbnails.ts](../src/lib/asset-thumbnails.ts)** — pure
  thumbnail makers, all landing on a 256 px canvas:
  `thumbFromBitmap`, `thumbFromVideoUrl(url, duration)` (own `<video>`,
  seek to 10 %, draw, dispose — never touches the node's live element),
  `thumbFromSpline(subpaths, aspect)` / `thumbFromPoints(value, aspect)`
  (the peek popover's Path2D / dot drawing, on a fixed dark plate),
  `thumbFromPixels(rgba, w, h, kind)` (readback → canvas; masks expand
  R → gray), `normalizeThumbnailFile(file)` for custom uploads. Raster
  → JPEG 0.8; vector → PNG (transparent, crisp lines). Outputs a data
  URL (presets) or Blob (Storage) via one encoder.
- **[lib/svg-write.ts](../src/lib/svg-write.ts)** — `svgFromSubpaths
  (subpaths, aspect, name?)`: SVG Source keeps only the PARSED subpaths
  (`SvgFileParamValue`), not the file text, so an SVG asset is
  synthesized: viewBox `0 0 <1000·aspect> 1000`, one `<path>` per
  subpath with cubic segments from the anchor handles, `Z` on closed.
  Round-trips through `parseSvg` (guarded by `check-svg-write.mts`).
  One format for every SVG asset regardless of provenance.

## 3. Capture paths

### 3.1 Add to Assets (node context menu)

NodeEditor gains `onAddNodeToAssets?(nodeId)` and
`addToAssetsDisabledReason?(nodeId) → string | undefined`. The menu row
renders only for `image-source` / `svg-source` / `video-source`; the
`NodeContextMenu` item type grows `disabled` + `title` so the un-entitled
video case shows greyed with its hint. EffectsApp's handler:

- **image-source**: `file` param is an `ImageBitmap` → bytes from
  `getImageOriginal(bmp)` (the registered source Blob) else a PNG
  re-encode; EXR (`ExrImageParamValue`) → its `blob` as `image/x-exr`.
  Thumbnail: from the bitmap; EXR from the node's evaluated output
  readback (falls back to the glyph). Name = node display name.
- **svg-source**: `svgFromSubpaths(value)` → `.svg` bytes; thumbnail =
  `thumbFromSpline`.
- **video-source**: needs a `CloudMediaRef` for `(filename, size)` in
  the registry. Missing ref + upload in flight ⇒ toast "still uploading —
  try again in a moment"; missing + error ⇒ toast the failure; not
  entitled ⇒ the row is disabled (hint: "Video assets need cloud media,
  which isn't enabled for this account"). Row: `storage='r2'`,
  hash/ext/owner from the ref, no bytes moved. Thumbnail from the value's
  own `url` (ObjectURL or cloud URL) at 10 %.
- Empty param ⇒ disabled, "Load a file first". Signed out ⇒ toast
  "Sign in to use your asset library".

### 3.2 Upload Asset… / OS drop on the panel

`<input type=file multiple accept="image/*,.svg,video/*">` (and the
panel body's `onDrop` for `Files`). Per file, `detectFileKind`-style
classification: image → decode (`createImageBitmap`) for dimensions +
thumbnail, upload original bytes (mime from the `MIME_TO_EXT` table;
bmp/avif/unknown re-encode to PNG); svg → text → `parseSvg` (validates)
→ upload the ORIGINAL text as octet-stream, thumbnail from the parsed
subpaths; video → `maybeUploadCloudMedia(file, "video")` then read the
ref from the registry (un-entitled ⇒ toast and skip). Caps: image
≤ 50 MB, SVG ≤ 5 MB (Storage object limit), video per the R2 caps.

### 3.3 Save as Preset… thumbnail

In the modal's `onSave`, after `serializeGraph`: `captureNodeThumbnail
(nodeId)` reads `readNodeOutput(nodeId)?.primary` — texture-backed →
`readPeekPixels` at a ≤256 px fit → `thumbFromPixels`; `image_group` →
first item; `spline` → `thumbFromSpline(subpaths, canvasAspect)`; 2D
`points` (no `z`) → `thumbFromPoints`; else `null`. Best-effort: a
`null` thumbnail saves the preset without one, and the toast says so.
While the modal is open its node is **forced into the eval pass** (the
peek/spreadsheet `extraTargets` treatment, `saveNodePresetTargetRef`),
so a disconnected or consumption-gated node still has a fresh primary
output at save time. **Group shells and reroutes resolve to their
interior producer first** (`resolvePreviewProducer`, the viewport's own
remap): flatten dissolves the shell, so neither the eval cache nor
`extraTargets` knows the shell's id — the capture reads the exact
(node, handle) the shell's image socket is fed from. The inline encoder (`encodeThumbDataUrlWithinCap`)
steps down — asked format → JPEG 0.65 → 160px JPEG — to stay under the
96 K-char cap; capture failures log a `[asset-thumb]` console line with
the reason.

### 3.4 Replace Thumbnail…

Card menu → file input (`image/*`) → `normalizeThumbnailFile` → media:
upload to `<uid>/thumbs/<id>.jpg` + `thumb_rev + 1`; preset:
`setUserNodePresetThumbnail(id, dataUrl)`.

## 4. The panel

`AssetsView` (kept — the shared component) gains a `kindMenu?` slot and
an `onInsert(payload)` callback; everything else it reads from the
stores (`useUserAssets`, `useUserNodePresets`, `useUser`,
`useEntitlements`) so the three mounts need no new plumbing.

- **Header**: `{kindMenu}` · **Assets ▾** (`MenuDropdown` + `MenuItem`
  exported from MenuBar.tsx: Upload Asset…, Refresh) · filter chips ·
  search (fuzzy on name, `lib/fuzzy-search.ts`) · "N items".
- **Library grid**: `repeat(auto-fill, minmax(96px,1fr))` cards — the
  existing `AssetCard` generalized: thumbnail (or kind glyph), name,
  small kind badge. `draggable` with payload
  `{ source: "library" | "preset", kind, ref: <id>, name }`.
  Double-click → `onInsert`. Right-click → `AssetCardMenu` (the
  NodeContextMenu shape, local): Rename… (`PresetNameModal` reused with
  rename copy), Replace Thumbnail…, Delete (no confirm — same as preset
  ×). Presets: Rename/Replace/Delete route to the preset store.
- **States**: loading spinner; signed-out hint ("Sign in to use your
  asset library" — presets still list); empty hint ("Assets ▸ Upload
  Asset…, or right-click a node → Add to Assets").
- **Drop target**: `onDragOver` opts in for `Files` only (our own card
  drags are ignored), tinted border while hovering.
- **Legacy sections** (*In project*, *Folder*) render below the library
  unchanged.

### 4.1 Panel-kind plumbing (the 081326 checklist)

1. `layout/model.ts`: `"assets"` in `PanelKind`, `PANEL_KINDS` (after
   `spreadsheet`), `PANEL_LABELS` "Assets".
2. `PanelKindMenu.tsx` `KindIcon`: a picture-frame glyph.
3. `EffectsApp` `panelKindMenuFor`: `assets: reason` in the last-viewport
   map.
4. `renderLayoutPanel`: `if (panel === "assets")` → `<AssetsView
   kindMenu=… onInsert=… />` (before the params fallthrough).
5. Pop-out is free. Cross-window HTML5 drag works within the origin, so a
   popped-out Assets window still drags into the main editor.

## 5. Insert paths

`onAddAssetNode(payload, flowPos)` (existing) grows two branches:

- `source: "library"` → row from the store. `image`/`svg`: `fetch(url)`
  → `File(name, mime)` → `onAddFileNode(file, flowPos)` (Source node,
  root auto-wraps). `video`: `seedCloudMediaRef(name, size, ref)` →
  `registerVideoUrl(cloudMediaUrl(ref), { filename: name, size })` →
  `spawnNode("video-source")` + `placeSourceNode`. The seeded ref is what
  makes the next save carry `cloud:{…}` with no upload.
- `source: "preset"` → `insertUserPresetAt(id, flowPos)` — the body of
  today's `user-preset:` branch in `onAddNode` extracted into a callback
  that takes the position; `onAddNode` passes the pointer+jitter position
  it computes today. The drop point anchors the fragment's **top-level
  nodes** (`fragmentTopLeft`): a group preset's interior positions live in
  the shell's own scope space, and the old min-over-everything offset
  landed the shell off-cursor by (shell − interior). `insertClonedFragment`
  (paste/duplicate) had the same latent bug and shares the helper.

Double-click: `onInsert(payload)` → the same function at
`lastPanePointerRef.current ?? {200,200}` + jitter.

The drop handler in NodeEditor is unchanged — it already forwards any
`application/x-toolbox-asset` payload with a `ref`.

## 6. Milestones

- **M1 — storage + store + thumbnails.** Migration SQL;
  `lib/supabase/user-assets.ts`; `state/user-assets.ts`;
  `lib/asset-thumbnails.ts`; `lib/svg-write.ts`; preset `thumbnail`
  field + `rename`/`setThumbnail` ops. Checks: `check-node-presets.mts`
  gains thumbnail-sanitize cases; new `check-svg-write.mts`
  (subpaths → SVG → `parseSvg` → anchors within ε, closed flags kept,
  aspect preserved), wired into `npm run check`.
- **M2 — the panel.** Kind plumbing; `AssetsView` upgrade (header menu,
  chips, search, cards, card menu, rename modal, OS-file drop, states);
  `MenuDropdown`/`MenuItem` export; the three mounts.
- **M3 — capture.** Add to Assets (context menu + gating + EffectsApp
  handler for the three node kinds); Upload Asset… + panel drop; preset
  thumbnail capture in Save as Preset…; Replace Thumbnail….
- **M4 — insert.** `insertUserPresetAt` refactor; library/preset
  branches in `onAddAssetNode`; double-click insert.
- **Ship:** devguide ("Persistence & sharing" — the library tier, the
  Assets panel kind, the SVG octet-stream rule; "Repo map" entries),
  devlist entry, 081226 follow-ups struck.

## 7. Gates

`npm run typecheck`, `npm run check`, `npm run lint:ratchet`. Manual
(browser, signed in, migration applied): Add to Assets on an image / SVG
/ cloud video → cards with thumbnails; Upload Asset… + OS drop; drag each
kind into the editor → correct Source node, save, reload → video plays
without relink (ref carried), image re-uploads under the project;
Save as Preset on a Rasterize / Circle / Scatter Points node → image /
spline / points thumbnails; Replace Thumbnail on each kind; Rename;
Delete; signed-out panel shows presets + hint; pop-out panel drags into
the main window; the kind chip can't retire the last viewport.

## 8. Out of scope / follow-ups

- Thumbnails in the add menus (Shift+A / Add dropdown) — the field
  exists; the menus just don't render it yet.
- Audio / 3D / font / paint / image-sequence assets; folders or tags in
  the library; multi-select.
- Moving presets into `user_assets` (lifts the 60-preset cap; needs the
  add menus + offline path to read the new store).
- The R2 spec's M3 storage panel (usage, per-asset delete with reference
  scan) — natural to host in this panel later.
- MCP / AI Recipe exposure of library assets.
