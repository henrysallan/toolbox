// Asset Library store + ops (specdocs/090326_asset-library.md §2).
//
// A module store read through useSyncExternalStore — the node-presets
// pattern: the panel, the node context menu and EffectsApp all touch the
// library from far-apart places, and a store lets each subscribe with
// zero prop plumbing. Cloud-only (no localStorage): the library IS the
// cloud copy; signed-out users see the presets (which have their own
// offline store) and a sign-in hint.
//
// Ops do the whole add pipeline — bytes → hash → dedup probe → object
// upload → thumbnail upload → row insert → publish — in the "assets
// first, row last" order the images tier established: a crash mid-way
// leaves an orphan object (cheap), never a row pointing at nothing.
// Ids are minted client-side so the thumbnail can land before the row.

import { useSyncExternalStore } from "react";
import { sha256Hex } from "@/lib/asset-envelope";
import type { CloudMediaRef } from "@/lib/cloud-media";
import {
  currentUserId,
  deleteUserAssetRow,
  findUserAssetByHash,
  insertUserAsset,
  listUserAssets,
  removeUserAssetObjects,
  updateUserAsset,
  uploadUserAssetObject,
  uploadUserAssetThumb,
  userAssetObjectPath,
  userAssetThumbPath,
  type UserAssetKind,
  type UserAssetRow,
} from "@/lib/supabase/user-assets";

export type { UserAssetKind, UserAssetRow } from "@/lib/supabase/user-assets";

// Supabase Storage's per-object ceiling on the current plan; the images
// tier lives with the same one.
export const MAX_IMAGE_ASSET_BYTES = 50 * 1024 * 1024;
export const MAX_SVG_ASSET_BYTES = 5 * 1024 * 1024;
export const MAX_ASSET_NAME = 80;

export type LibraryStatus = "idle" | "loading" | "ready" | "signed-out" | "error";

export interface LibraryState {
  status: LibraryStatus;
  rows: UserAssetRow[];
  error: string | null;
  /** In-flight add/replace/delete ops — drives the panel's busy indicator. */
  busy: number;
}

const INITIAL: LibraryState = { status: "idle", rows: [], error: null, busy: 0 };
let state: LibraryState = INITIAL;
const listeners = new Set<() => void>();

function publish(next: Partial<LibraryState>) {
  state = { ...state, ...next };
  for (const l of [...listeners]) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getUserAssetsState(): LibraryState {
  return state;
}

export function getUserAsset(id: string): UserAssetRow | undefined {
  return state.rows.find((r) => r.id === id);
}

export function useUserAssets(): LibraryState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => INITIAL
  );
}

function withBusy<T>(p: Promise<T>): Promise<T> {
  publish({ busy: state.busy + 1 });
  return p.finally(() => publish({ busy: Math.max(0, state.busy - 1) }));
}

// --- load -----------------------------------------------------------------------

let loadSeq = 0;

/** Fetch the library. Call on mount and whenever the identity changes. */
export async function loadUserAssets(): Promise<void> {
  const seq = ++loadSeq;
  // Keep stale rows visible during a refresh; only a cold load spins.
  publish({ status: state.status === "ready" ? "ready" : "loading", error: null });
  const res = await listUserAssets();
  if (seq !== loadSeq) return; // a newer load superseded this one
  if (res.kind === "signed-out") publish({ status: "signed-out", rows: [], error: null });
  else if (res.kind === "error") publish({ status: "error", error: res.error });
  else publish({ status: "ready", rows: res.rows, error: null });
}

// --- add --------------------------------------------------------------------------

export type AddAssetResult =
  | { ok: true; row: UserAssetRow; duplicate: boolean }
  | { ok: false; error: string };

function cleanName(name: string, fallback: string): string {
  const t = name.trim().slice(0, MAX_ASSET_NAME);
  return t || fallback;
}

function mintId(): string {
  return crypto.randomUUID();
}

// Shared tail: thumbnail (best-effort) → row → publish. `bytes` is null
// for R2-backed rows (video), whose object already exists.
async function finishAdd(args: {
  userId: string;
  kind: UserAssetKind;
  name: string;
  hash: string;
  ext: string;
  mime: string;
  size: number;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  storage: "supabase" | "r2";
  owner?: string | null;
  bytes: Blob | Uint8Array | null;
  thumb: Blob | null;
}): Promise<AddAssetResult> {
  const dup = await findUserAssetByHash(args.kind, args.hash);
  if (dup) {
    // Make sure it's in the local list (a stale list is possible after a
    // refresh race), then report the duplicate.
    if (!state.rows.some((r) => r.id === dup.id))
      publish({ rows: [dup, ...state.rows] });
    return { ok: true, row: dup, duplicate: true };
  }
  if (args.bytes) {
    const up = await uploadUserAssetObject({
      userId: args.userId,
      hash: args.hash,
      ext: args.ext,
      kind: args.kind,
      mime: args.mime,
      bytes: args.bytes,
    });
    if (!up.ok) return { ok: false, error: up.error ?? "Upload failed." };
  }
  const id = mintId();
  let thumbRev = 0;
  if (args.thumb) {
    const t = await uploadUserAssetThumb(args.userId, id, args.thumb);
    if (t.ok) thumbRev = 1;
    else console.warn("[user-assets] thumbnail upload failed:", t.error);
  }
  const ins = await insertUserAsset({
    id,
    kind: args.kind,
    name: args.name,
    hash: args.hash,
    ext: args.ext,
    mime: args.mime,
    size: args.size,
    width: args.width ?? null,
    height: args.height ?? null,
    duration: args.duration ?? null,
    storage: args.storage,
    owner: args.owner ?? null,
    thumbRev,
  });
  if (!ins.ok) {
    // Row failed after the objects landed — tidy the thumb (the content
    // object may be shared with a concurrent add of the same bytes; leave it).
    if (thumbRev) void removeUserAssetObjects([userAssetThumbPath(args.userId, id)]);
    return { ok: false, error: ins.error };
  }
  publish({ rows: [ins.row, ...state.rows], status: "ready" });
  return { ok: true, row: ins.row, duplicate: false };
}

async function requireUser(): Promise<
  { ok: true; userId: string } | { ok: false; error: string }
> {
  const uid = await currentUserId();
  if (!uid) return { ok: false, error: "Sign in to use your asset library." };
  return { ok: true, userId: uid };
}

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-exr": "exr",
};

export function imageExtForMime(mime: string): string | null {
  return IMAGE_EXT[mime] ?? null;
}

/**
 * Add an encoded image. `mime` must be one of imageExtForMime's keys —
 * callers re-encode anything else to PNG first.
 */
export function addImageAsset(input: {
  bytes: Blob;
  mime: string;
  name: string;
  width?: number | null;
  height?: number | null;
  thumb: Blob | null;
}): Promise<AddAssetResult> {
  return withBusy(
    (async (): Promise<AddAssetResult> => {
      const ext = imageExtForMime(input.mime);
      if (!ext) return { ok: false, error: `Unsupported image type (${input.mime}).` };
      if (input.bytes.size > MAX_IMAGE_ASSET_BYTES)
        return { ok: false, error: "Image is over the 50 MB asset limit." };
      const u = await requireUser();
      if (!u.ok) return u;
      const bytes = new Uint8Array(await input.bytes.arrayBuffer());
      const hash = await sha256Hex(bytes);
      return finishAdd({
        userId: u.userId,
        kind: "image",
        name: cleanName(input.name, "Image"),
        hash,
        ext,
        mime: input.mime,
        size: bytes.byteLength,
        width: input.width,
        height: input.height,
        storage: "supabase",
        bytes,
        thumb: input.thumb,
      });
    })()
  );
}

/** Add SVG markup (the original file text, or a synthesized document). */
export function addSvgAsset(input: {
  text: string;
  name: string;
  /** Source aspect (viewBox w/h) — stored as width/height ×1000 for display. */
  aspect?: number | null;
  thumb: Blob | null;
}): Promise<AddAssetResult> {
  return withBusy(
    (async (): Promise<AddAssetResult> => {
      const bytes = new TextEncoder().encode(input.text);
      if (bytes.byteLength > MAX_SVG_ASSET_BYTES)
        return { ok: false, error: "SVG is over the 5 MB asset limit." };
      const u = await requireUser();
      if (!u.ok) return u;
      const hash = await sha256Hex(bytes);
      const aspect =
        input.aspect && Number.isFinite(input.aspect) && input.aspect > 0
          ? input.aspect
          : null;
      return finishAdd({
        userId: u.userId,
        kind: "svg",
        name: cleanName(input.name, "SVG"),
        hash,
        ext: "svg",
        mime: "image/svg+xml",
        size: bytes.byteLength,
        width: aspect ? Math.round(1000 * aspect) : null,
        height: aspect ? 1000 : null,
        storage: "supabase",
        bytes,
        thumb: input.thumb,
      });
    })()
  );
}

/**
 * Add a video that ALREADY lives in R2 (the cloud-media tier uploaded it
 * at pick time). No bytes move — the row points at the existing object.
 */
export function addVideoAsset(input: {
  ref: CloudMediaRef;
  name: string;
  size: number;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  thumb: Blob | null;
}): Promise<AddAssetResult> {
  return withBusy(
    (async (): Promise<AddAssetResult> => {
      const u = await requireUser();
      if (!u.ok) return u;
      return finishAdd({
        userId: u.userId,
        kind: "video",
        name: cleanName(input.name, "Video"),
        hash: input.ref.hash,
        ext: input.ref.ext,
        mime: `video/${input.ref.ext === "mov" ? "quicktime" : input.ref.ext}`,
        size: input.size,
        width: input.width,
        height: input.height,
        duration: input.duration,
        storage: "r2",
        owner: input.ref.owner,
        bytes: null,
        thumb: input.thumb,
      });
    })()
  );
}

// --- edit / delete ----------------------------------------------------------------

export function renameAsset(
  id: string,
  name: string
): Promise<{ ok: boolean; error?: string }> {
  return withBusy(
    (async () => {
      const row = getUserAsset(id);
      if (!row) return { ok: false, error: "Asset not found." };
      const next = cleanName(name, row.name);
      if (next === row.name) return { ok: true };
      const res = await updateUserAsset(id, { name: next });
      if (!res.ok) return { ok: false, error: res.error };
      publish({ rows: state.rows.map((r) => (r.id === id ? res.row : r)) });
      return { ok: true };
    })()
  );
}

/** Upload a (already normalized, JPEG) thumbnail and bump the rev. */
export function replaceAssetThumbnail(
  id: string,
  thumb: Blob
): Promise<{ ok: boolean; error?: string }> {
  return withBusy(
    (async () => {
      const row = getUserAsset(id);
      if (!row) return { ok: false, error: "Asset not found." };
      const up = await uploadUserAssetThumb(row.userId, id, thumb);
      if (!up.ok) return { ok: false, error: up.error };
      const res = await updateUserAsset(id, { thumbRev: row.thumbRev + 1 });
      if (!res.ok) return { ok: false, error: res.error };
      publish({ rows: state.rows.map((r) => (r.id === id ? res.row : r)) });
      return { ok: true };
    })()
  );
}

/**
 * Delete a row, then its objects. Supabase-stored bytes go too (the
 * (user, kind, hash) uniqueness means exactly one row references them;
 * projects copied what they use into their own prefix). R2 objects are
 * never touched — projects reference them directly (decision 11).
 */
export function deleteAsset(
  id: string
): Promise<{ ok: boolean; error?: string }> {
  return withBusy(
    (async () => {
      const row = getUserAsset(id);
      if (!row) return { ok: false, error: "Asset not found." };
      const res = await deleteUserAssetRow(id);
      if (!res.ok) return { ok: false, error: res.error };
      publish({ rows: state.rows.filter((r) => r.id !== id) });
      const paths: string[] = [];
      if (row.thumbRev > 0) paths.push(userAssetThumbPath(row.userId, id));
      if (row.storage === "supabase" && row.hash && row.ext)
        paths.push(userAssetObjectPath(row.userId, row.hash, row.ext));
      void removeUserAssetObjects(paths);
      return { ok: true };
    })()
  );
}
