// The project's own asset library — the Assets panel's "Project" side (the
// "Server" side is state/user-assets.ts + state/node-presets.ts). Empty in a
// new project; items arrive from Upload / an OS drop while Project is
// selected, a node's Add to Assets ▸ Project, or Copy to Project on a Server
// card. Saved with the project as SavedProject.assetLibrary
// (lib/project-library-format.ts owns the shape).
//
// A module store read through useSyncExternalStore, like user-assets: the
// panel, the node context menu and EffectsApp all touch it. One project is
// open at a time, so one store; EffectsApp replaces it on every load
// (applySavedProjectLibrary), clears it on File → New, and attaches it on
// every save (attachProjectLibrary). Because it is module state it also
// survives the editor's same-tab unmount/remount (docs round-trip) for free.
//
// Image/SVG bytes load lazily: a loaded item keeps its envelope's URL (a
// `data:` URL from a .toolbox / inline save, or an https Storage URL from a
// v9 cloud save) and fetches it the first time an insert or a save needs
// the bytes. Saves always write `data:` envelopes so both containers can
// extract them.

import { useSyncExternalStore } from "react";
import { sha256Hex, isAssetRef } from "@/lib/asset-envelope";
import { encodeThumbDataUrlWithinCap, isThumbDataUrl } from "@/lib/asset-thumbnails";
import { isCloudMediaRef, type CloudMediaRef } from "@/lib/cloud-media";
import { blobToDataUrl, primeBlobDataUrl } from "@/lib/data-url";
import type { SavedProject } from "@/lib/project";
import {
  savedLibraryItems,
  type ProjectAssetKind,
  type SavedProjectAsset,
} from "@/lib/project-library-format";

export type { ProjectAssetKind } from "@/lib/project-library-format";

export const MAX_PROJECT_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_PROJECT_SVG_BYTES = 5 * 1024 * 1024;
const MAX_NAME = 80;

export interface ProjectAsset {
  id: string;
  kind: ProjectAssetKind;
  name: string;
  thumb: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  /** Image / SVG bytes: a fresh Blob, or the URL a load left behind. */
  media?: {
    filename: string;
    mime: string;
    url: string | null;
    /** The envelope as loaded — re-emitted if the bytes can't be fetched. */
    saved?: Record<string, unknown>;
  };
  video?: CloudMediaRef & { filename: string; size: number };
  fragment?: SavedProject;
}

/** What every add (and every import pipeline) reports back. */
export type LibraryAddResult =
  | { ok: true; name: string; duplicate: boolean }
  | { ok: false; error: string };

// --- store ------------------------------------------------------------------------

const EMPTY: ProjectAsset[] = [];
let items: ProjectAsset[] = EMPTY; // newest first
const listeners = new Set<() => void>();
// Bytes by item id — kept off the item so a lazy fetch never republishes.
const blobs = new Map<string, Blob>();
const hashes = new Map<string, string>();
let onEdit: (() => void) | null = null;

function publish(next: ProjectAsset[]) {
  items = next;
  for (const l of [...listeners]) l();
}

/** A user edit (not a load): EffectsApp marks the project dirty. */
function edited(next: ProjectAsset[]) {
  publish(next);
  onEdit?.();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useProjectLibrary(): ProjectAsset[] {
  return useSyncExternalStore(
    subscribe,
    () => items,
    () => EMPTY
  );
}

export function getProjectAsset(id: string): ProjectAsset | undefined {
  return items.find((i) => i.id === id);
}

/** EffectsApp registers its "project went dirty" callback here. */
export function setProjectLibraryEditListener(fn: (() => void) | null) {
  onEdit = fn;
}

function cleanName(name: string, fallback: string): string {
  return name.trim().slice(0, MAX_NAME) || fallback;
}

function inlineThumb(
  canvas: HTMLCanvasElement | null | undefined,
  format: "jpeg" | "png"
): string | null {
  if (!canvas) return null;
  try {
    return encodeThumbDataUrlWithinCap(canvas, format);
  } catch {
    return null;
  }
}

// --- bytes ------------------------------------------------------------------------

/** An image/SVG item's encoded bytes (fetched once from a loaded URL). */
export async function projectAssetBlob(item: ProjectAsset): Promise<Blob> {
  const hit = blobs.get(item.id);
  if (hit) return hit;
  const url = item.media?.url;
  if (!url) throw new Error(`"${item.name}" has no stored bytes.`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Couldn't fetch "${item.name}" (${resp.status}).`);
  const raw = await resp.blob();
  const blob =
    raw.type || !item.media?.mime ? raw : new Blob([raw], { type: item.media.mime });
  if (url.startsWith("data:")) primeBlobDataUrl(blob, url);
  blobs.set(item.id, blob);
  return blob;
}

async function itemHash(item: ProjectAsset): Promise<string | null> {
  const hit = hashes.get(item.id);
  if (hit) return hit;
  try {
    const blob = await projectAssetBlob(item);
    const h = await sha256Hex(new Uint8Array(await blob.arrayBuffer()));
    hashes.set(item.id, h);
    return h;
  } catch {
    return null;
  }
}

async function findByHash(hash: string): Promise<ProjectAsset | undefined> {
  for (const it of items) {
    if (!it.media) continue;
    if ((await itemHash(it)) === hash) return it;
  }
  return undefined;
}

// --- add --------------------------------------------------------------------------

async function addMedia(input: {
  kind: "image" | "svg";
  bytes: Blob;
  mime: string;
  filename: string;
  name: string;
  width: number | null;
  height: number | null;
  thumb: string | null;
}): Promise<LibraryAddResult> {
  const hash = await sha256Hex(new Uint8Array(await input.bytes.arrayBuffer()));
  const dup = await findByHash(hash);
  if (dup) return { ok: true, name: dup.name, duplicate: true };
  const id = crypto.randomUUID();
  blobs.set(id, input.bytes);
  hashes.set(id, hash);
  const item: ProjectAsset = {
    id,
    kind: input.kind,
    name: input.name,
    thumb: input.thumb,
    width: input.width,
    height: input.height,
    duration: null,
    media: { filename: input.filename, mime: input.mime, url: null },
  };
  edited([item, ...items]);
  return { ok: true, name: item.name, duplicate: false };
}

export function addProjectImage(input: {
  bytes: Blob;
  mime: string;
  ext: string;
  name: string;
  width?: number | null;
  height?: number | null;
  thumbCanvas?: HTMLCanvasElement | null;
}): Promise<LibraryAddResult> {
  if (input.bytes.size > MAX_PROJECT_IMAGE_BYTES)
    return Promise.resolve({ ok: false, error: "Image is over the 50 MB asset limit." });
  const name = cleanName(input.name, "Image");
  return addMedia({
    kind: "image",
    bytes: input.bytes,
    mime: input.mime,
    filename: name.toLowerCase().endsWith(`.${input.ext}`) ? name : `${name}.${input.ext}`,
    name,
    width: input.width ?? null,
    height: input.height ?? null,
    thumb: inlineThumb(input.thumbCanvas, "jpeg"),
  });
}

export function addProjectSvg(input: {
  text: string;
  name: string;
  aspect?: number | null;
  thumbCanvas?: HTMLCanvasElement | null;
}): Promise<LibraryAddResult> {
  const bytes = new Blob([input.text], { type: "image/svg+xml" });
  if (bytes.size > MAX_PROJECT_SVG_BYTES)
    return Promise.resolve({ ok: false, error: "SVG is over the 5 MB asset limit." });
  const aspect =
    input.aspect && Number.isFinite(input.aspect) && input.aspect > 0
      ? input.aspect
      : null;
  const name = cleanName(input.name, "SVG");
  return addMedia({
    kind: "svg",
    bytes,
    mime: "image/svg+xml",
    filename: name.toLowerCase().endsWith(".svg") ? name : `${name}.svg`,
    name,
    width: aspect ? Math.round(1000 * aspect) : null,
    height: aspect ? 1000 : null,
    thumb: inlineThumb(input.thumbCanvas, "png"),
  });
}

/** A clip that already lives in cloud media — no bytes move. */
export function addProjectVideo(input: {
  ref: CloudMediaRef;
  filename: string;
  name: string;
  size: number;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  thumbCanvas?: HTMLCanvasElement | null;
  thumb?: string | null;
}): LibraryAddResult {
  const dup = items.find(
    (i) => i.video?.hash === input.ref.hash && i.video.owner === input.ref.owner
  );
  if (dup) return { ok: true, name: dup.name, duplicate: true };
  const item: ProjectAsset = {
    id: crypto.randomUUID(),
    kind: "video",
    name: cleanName(input.name, "Video"),
    thumb: input.thumb ?? inlineThumb(input.thumbCanvas, "jpeg"),
    width: input.width ?? null,
    height: input.height ?? null,
    duration: input.duration ?? null,
    video: { ...input.ref, filename: input.filename, size: input.size },
  };
  edited([item, ...items]);
  return { ok: true, name: item.name, duplicate: false };
}

/** A node preset's fragment, copied in (name-unique, case-insensitive). */
export function addProjectPreset(input: {
  name: string;
  fragment: SavedProject;
  thumb?: string | null;
}): LibraryAddResult {
  const name = cleanName(input.name, "Preset");
  const dup = items.find(
    (i) => i.kind === "preset" && i.name.toLowerCase() === name.toLowerCase()
  );
  if (dup) return { ok: true, name: dup.name, duplicate: true };
  const item: ProjectAsset = {
    id: crypto.randomUUID(),
    kind: "preset",
    name,
    thumb: isThumbDataUrl(input.thumb) ? input.thumb : null,
    width: null,
    height: null,
    duration: null,
    fragment: input.fragment,
  };
  edited([item, ...items]);
  return { ok: true, name: item.name, duplicate: false };
}

// --- edit / delete ------------------------------------------------------------------

export function renameProjectAsset(id: string, name: string): boolean {
  const trimmed = name.trim().slice(0, MAX_NAME);
  if (!trimmed) return false;
  const target = items.find((i) => i.id === id);
  if (!target) return false;
  if (
    target.kind === "preset" &&
    items.some(
      (i) =>
        i.id !== id &&
        i.kind === "preset" &&
        i.name.toLowerCase() === trimmed.toLowerCase()
    )
  )
    return false;
  edited(items.map((i) => (i.id === id ? { ...i, name: trimmed } : i)));
  return true;
}

export function setProjectAssetThumb(id: string, thumb: string) {
  if (!isThumbDataUrl(thumb)) return;
  edited(items.map((i) => (i.id === id ? { ...i, thumb } : i)));
}

export function removeProjectAsset(id: string) {
  blobs.delete(id);
  hashes.delete(id);
  edited(items.filter((i) => i.id !== id));
}

// --- load / save ----------------------------------------------------------------------

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fromSaved(s: SavedProjectAsset): ProjectAsset | null {
  const base = {
    id: s.id,
    kind: s.kind,
    name: cleanName(s.name, "Asset"),
    thumb: isThumbDataUrl(s.thumb) ? s.thumb : null,
    width: num(s.width),
    height: num(s.height),
    duration: num(s.duration),
  };
  if (s.kind === "image" || s.kind === "svg") {
    const env = s.params?.media as Record<string, unknown> | null | undefined;
    // A .toolbox whose asset went missing re-inlines it as null — drop the
    // item rather than show a card that can't insert.
    if (!env || typeof env !== "object" || typeof env.dataUrl !== "string")
      return null;
    return {
      ...base,
      media: {
        filename:
          typeof env.filename === "string" ? env.filename : base.name,
        mime:
          typeof env.mime === "string"
            ? env.mime
            : s.kind === "svg"
              ? "image/svg+xml"
              : "",
        url: env.dataUrl,
        saved: env,
      },
    };
  }
  if (s.kind === "video") {
    const v = s.video as Record<string, unknown> | undefined;
    if (!isCloudMediaRef(v) || typeof v.filename !== "string") return null;
    return {
      ...base,
      video: {
        hash: v.hash,
        ext: v.ext,
        owner: v.owner,
        filename: v.filename,
        size: num(v.size) ?? 0,
      },
    };
  }
  if (!s.fragment) return null;
  return { ...base, fragment: s.fragment };
}

/** Replace the library with a loaded project's (absent → empty). */
export function applySavedProjectLibrary(graph: SavedProject | null | undefined) {
  blobs.clear();
  hashes.clear();
  const next = graph
    ? savedLibraryItems(graph)
        .map(fromSaved)
        .filter((i): i is ProjectAsset => i !== null)
    : [];
  publish(next.length ? next : EMPTY);
}

/** File → New. */
export function clearProjectLibrary() {
  applySavedProjectLibrary(null);
}

// Remote (https) envelope URL → data: URL, memoized: preset fragments loaded
// from a cloud save hold Storage URLs, and a .toolbox needs the bytes.
const remoteInline = new Map<string, string>();
async function inlineRemote(url: string): Promise<string | null> {
  const hit = remoteInline.get(url);
  if (hit) return hit;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await blobToDataUrl(await resp.blob());
    remoteInline.set(url, data);
    return data;
  } catch {
    return null;
  }
}

/**
 * A fragment with every remote (https) media envelope re-inlined as a
 * `data:` URL — saves need the bytes, and so does a copy to the Server
 * library (a Storage URL there would outlive the project's prune).
 */
export async function inlineFragmentMedia(
  fragment: SavedProject
): Promise<SavedProject> {
  let changed = false;
  const nodes = await Promise.all(
    fragment.nodes.map(async (n) => {
      let params: Record<string, unknown> | null = null;
      for (const [key, val] of Object.entries(n.params ?? {})) {
        if (!isAssetRef(val)) continue;
        const url = (val as { dataUrl?: unknown }).dataUrl;
        if (typeof url !== "string" || url.startsWith("data:")) continue;
        const data = await inlineRemote(url);
        if (!data) continue;
        const env: Record<string, unknown> = { ...val, dataUrl: data };
        delete env.asset;
        delete env.ext;
        params ??= { ...n.params };
        params[key] = env;
      }
      if (!params) return n;
      changed = true;
      return { ...n, params };
    })
  );
  return changed ? { ...fragment, nodes } : fragment;
}

async function toSaved(item: ProjectAsset): Promise<SavedProjectAsset | null> {
  const base: SavedProjectAsset = {
    id: item.id,
    kind: item.kind,
    name: item.name,
    ...(item.thumb ? { thumb: item.thumb } : {}),
    ...(item.width != null ? { width: item.width } : {}),
    ...(item.height != null ? { height: item.height } : {}),
    ...(item.duration != null ? { duration: item.duration } : {}),
  };
  if (item.media) {
    let media: Record<string, unknown> | null = null;
    try {
      const blob = await projectAssetBlob(item);
      media = {
        kind: "file",
        dataUrl: await blobToDataUrl(blob, item.media.mime || undefined),
        filename: item.media.filename,
        mime: item.media.mime,
      };
    } catch (err) {
      // Bytes unreachable (offline, object gone): keep the loaded envelope
      // so a cloud save still holds the ref and the next save can retry.
      console.warn(`[project-library] "${item.name}": bytes unavailable`, err);
      media = item.media.saved ?? null;
    }
    return media ? { ...base, params: { media } } : null;
  }
  if (item.video) return { ...base, video: item.video };
  if (item.fragment)
    return { ...base, fragment: await inlineFragmentMedia(item.fragment) };
  return null;
}

/** Attach the library to a serialized graph (omitted when empty). */
export async function attachProjectLibrary(graph: SavedProject): Promise<void> {
  if (items.length === 0) return;
  const saved = (await Promise.all(items.map(toSaved))).filter(
    (s): s is SavedProjectAsset => s !== null
  );
  if (saved.length) graph.assetLibrary = saved;
}
