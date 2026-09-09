import { createClient } from "@/lib/supabase/client";
import { cloudMediaUrl } from "@/lib/cloud-media";

// Asset Library data layer (specdocs/090326_asset-library.md §1–2): row
// CRUD on `user_assets` plus the `user-assets` Storage bucket. Schema +
// bucket layout match specdocs/user-assets-migration.sql.
//
// Images / SVGs are content-addressed objects at <uid>/<hash>.<ext>;
// thumbnails at <uid>/thumbs/<id>.jpg (upserted in place — `thumb_rev`
// is the cache-buster). Video rows carry no object here: they point at
// the R2 object the cloud-media tier already holds (storage = 'r2').
//
// Conventions follow project-assets.ts / image-gen.ts: warn-and-degrade,
// typed {ok}|{ok:false,error} results, no thrown errors across the seam.

export const USER_ASSETS_BUCKET = "user-assets";

export type UserAssetKind = "image" | "svg" | "video";
export type UserAssetStorage = "supabase" | "r2";

export const USER_ASSET_KINDS: readonly UserAssetKind[] = [
  "image",
  "svg",
  "video",
];

export interface UserAssetRow {
  id: string;
  userId: string;
  kind: UserAssetKind;
  name: string;
  hash: string;
  ext: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  storage: UserAssetStorage;
  /** R2 uploader id (video rows) — the CloudMediaRef.owner. */
  owner: string | null;
  /** 0 = no thumbnail; bumped on every (re)upload. */
  thumbRev: number;
  createdAt: string;
  updatedAt: string;
}

const COLS =
  "id, user_id, kind, name, hash, ext, mime, size, width, height, duration, storage, owner, thumb_rev, created_at, updated_at";

// Newest-first page size. One query; paging is a follow-up if libraries
// ever outgrow it.
const LIST_LIMIT = 500;

function isKind(v: unknown): v is UserAssetKind {
  return v === "image" || v === "svg" || v === "video";
}

function rowFrom(r: Record<string, unknown>): UserAssetRow | null {
  if (typeof r.id !== "string" || typeof r.user_id !== "string") return null;
  if (!isKind(r.kind)) return null;
  const storage: UserAssetStorage = r.storage === "r2" ? "r2" : "supabase";
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    name: typeof r.name === "string" ? r.name : "",
    hash: typeof r.hash === "string" ? r.hash : "",
    ext: typeof r.ext === "string" ? r.ext : "",
    mime: typeof r.mime === "string" ? r.mime : "",
    size: num(r.size) ?? 0,
    width: num(r.width),
    height: num(r.height),
    duration: num(r.duration),
    storage,
    owner: typeof r.owner === "string" ? r.owner : null,
    thumbRev: num(r.thumb_rev) ?? 0,
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : "",
  };
}

// --- auth -------------------------------------------------------------------

export async function currentUserId(): Promise<string | null> {
  try {
    const supa = createClient();
    const { data } = await supa.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

// --- rows ---------------------------------------------------------------------

export type ListUserAssetsResult =
  | { kind: "ok"; rows: UserAssetRow[] }
  | { kind: "signed-out" }
  | { kind: "error"; error: string };

export async function listUserAssets(): Promise<ListUserAssetsResult> {
  const supa = createClient();
  const { data: u, error: authError } = await supa.auth.getUser();
  if (authError) return { kind: "error", error: authError.message };
  const uid = u.user?.id;
  if (!uid) return { kind: "signed-out" };
  const { data, error } = await supa
    .from("user_assets")
    .select(COLS)
    .eq("user_id", uid)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) {
    // Pre-migration DB: the table doesn't exist yet. An empty library is
    // the right answer (the add paths surface their own errors).
    if (error.code === "42P01") return { kind: "ok", rows: [] };
    console.warn("listUserAssets:", error.message);
    return { kind: "error", error: error.message };
  }
  const rows: UserAssetRow[] = [];
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const row = rowFrom(r);
    if (row) rows.push(row);
  }
  return { kind: "ok", rows };
}

export async function findUserAssetByHash(
  kind: UserAssetKind,
  hash: string
): Promise<UserAssetRow | null> {
  const supa = createClient();
  const { data: u } = await supa.auth.getUser();
  const uid = u.user?.id;
  if (!uid) return null;
  const { data, error } = await supa
    .from("user_assets")
    .select(COLS)
    .eq("user_id", uid)
    .eq("kind", kind)
    .eq("hash", hash)
    .maybeSingle();
  if (error || !data) return null;
  return rowFrom(data as Record<string, unknown>);
}

export interface NewUserAsset {
  /** Pre-generated so the thumbnail can upload before the row exists. */
  id: string;
  kind: UserAssetKind;
  name: string;
  hash: string;
  ext: string;
  mime: string;
  size: number;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  storage: UserAssetStorage;
  owner?: string | null;
  thumbRev: number;
}

export async function insertUserAsset(
  a: NewUserAsset
): Promise<{ ok: true; row: UserAssetRow } | { ok: false; error: string }> {
  const supa = createClient();
  const { data: u } = await supa.auth.getUser();
  const uid = u.user?.id;
  if (!uid) return { ok: false, error: "Not signed in." };
  const { data, error } = await supa
    .from("user_assets")
    .insert({
      id: a.id,
      user_id: uid,
      kind: a.kind,
      name: a.name,
      hash: a.hash,
      ext: a.ext,
      mime: a.mime,
      size: a.size,
      width: a.width ?? null,
      height: a.height ?? null,
      duration: a.duration ?? null,
      storage: a.storage,
      owner: a.owner ?? null,
      thumb_rev: a.thumbRev,
    })
    .select(COLS)
    .single();
  if (error) {
    if (error.code === "42P01")
      return {
        ok: false,
        error:
          "Asset library isn't set up on this database yet (user_assets table missing).",
      };
    return { ok: false, error: error.message };
  }
  const row = rowFrom(data as Record<string, unknown>);
  if (!row) return { ok: false, error: "Malformed row returned." };
  return { ok: true, row };
}

export async function updateUserAsset(
  id: string,
  patch: { name?: string; thumbRev?: number }
): Promise<{ ok: true; row: UserAssetRow } | { ok: false; error: string }> {
  const supa = createClient();
  const payload: Record<string, unknown> = {};
  if (patch.name !== undefined) payload.name = patch.name;
  if (patch.thumbRev !== undefined) payload.thumb_rev = patch.thumbRev;
  const { data, error } = await supa
    .from("user_assets")
    .update(payload)
    .eq("id", id)
    .select(COLS)
    .single();
  if (error) return { ok: false, error: error.message };
  const row = rowFrom(data as Record<string, unknown>);
  if (!row) return { ok: false, error: "Malformed row returned." };
  return { ok: true, row };
}

export async function deleteUserAssetRow(
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const supa = createClient();
  const { error } = await supa.from("user_assets").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// --- objects --------------------------------------------------------------------

export function userAssetObjectPath(
  userId: string,
  hash: string,
  ext: string
): string {
  return `${userId}/${hash}.${ext}`;
}

export function userAssetThumbPath(userId: string, id: string): string {
  return `${userId}/thumbs/${id}.jpg`;
}

// SVG bytes are stored as octet-stream ON PURPOSE (spec §1.2): on a public
// bucket, a script-bearing SVG served as image/svg+xml is a hosted XSS
// page. The client only ever fetch()es the text and parses it itself.
export function storedContentType(kind: UserAssetKind, mime: string): string {
  return kind === "svg" ? "application/octet-stream" : mime;
}

export async function uploadUserAssetObject(args: {
  userId: string;
  hash: string;
  ext: string;
  kind: UserAssetKind;
  mime: string;
  bytes: Blob | Uint8Array;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const supa = createClient();
    const body =
      args.bytes instanceof Blob
        ? args.bytes
        : new Blob([args.bytes as BlobPart]);
    const { error } = await supa.storage
      .from(USER_ASSETS_BUCKET)
      .upload(userAssetObjectPath(args.userId, args.hash, args.ext), body, {
        contentType: storedContentType(args.kind, args.mime),
        // Content-addressed: identical bytes at the same path are
        // idempotent, so upsert is safe under concurrent adds.
        upsert: true,
        cacheControl: "31536000",
      });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function uploadUserAssetThumb(
  userId: string,
  id: string,
  blob: Blob
): Promise<{ ok: boolean; error?: string }> {
  try {
    const supa = createClient();
    const { error } = await supa.storage
      .from(USER_ASSETS_BUCKET)
      .upload(userAssetThumbPath(userId, id), blob, {
        contentType: "image/jpeg",
        upsert: true,
        // Same path across replacements; the row's thumb_rev busts caches.
        cacheControl: "3600",
      });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Best-effort: an orphaned object is cheap, a blocked delete is not.
export async function removeUserAssetObjects(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    const supa = createClient();
    await supa.storage.from(USER_ASSETS_BUCKET).remove(paths);
  } catch (err) {
    console.warn("removeUserAssetObjects:", err);
  }
}

// --- URLs ----------------------------------------------------------------------

function publicUrl(path: string): string {
  const supa = createClient();
  return supa.storage.from(USER_ASSETS_BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Where the asset's bytes live: the bucket object, or the R2 media URL. */
export function userAssetUrl(row: UserAssetRow): string | null {
  if (row.storage === "r2") {
    if (!row.owner || !row.hash || !row.ext) return null;
    return cloudMediaUrl({ hash: row.hash, ext: row.ext, owner: row.owner });
  }
  if (!row.hash || !row.ext) return null;
  return publicUrl(userAssetObjectPath(row.userId, row.hash, row.ext));
}

/** Thumbnail URL with the rev as a cache-buster, or null when none. */
export function userAssetThumbUrl(row: UserAssetRow): string | null {
  if (row.thumbRev <= 0) return null;
  return `${publicUrl(userAssetThumbPath(row.userId, row.id))}?v=${row.thumbRev}`;
}

/**
 * A filename for the asset's bytes — the display name plus the stored
 * extension (unless the name already carries it). Used when a library
 * item re-enters a project as a File / video envelope, where the
 * (filename, size) pair keys the cloud-media registry.
 */
export function userAssetFilename(row: UserAssetRow): string {
  const suffix = `.${row.ext}`;
  return row.ext && !row.name.toLowerCase().endsWith(suffix)
    ? `${row.name}${suffix}`
    : row.name;
}
