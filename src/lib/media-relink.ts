// Media relink — videos/audio aren't stored in the cloud, so loaded
// projects need their local files back. Two cooperating strategies:
//
//   A. Persisted FileSystemFileHandles (Chromium). When the user picks a
//      file via showOpenFilePicker we stash the handle in IndexedDB keyed
//      by filename+size. On project load we look the handle up and read
//      the file straight off disk — silently when the browser has
//      persisted the permission grant, otherwise behind one "Relink"
//      click (requestPermission needs a user gesture).
//
//   B. Manual relink with matching. Whatever can't be resolved by a
//      handle is listed in a relink prompt; the user multi-picks files
//      once and we match them to nodes by filename (+size when known),
//      so one gesture relinks the whole project.
//
// Projects serialize a lightweight envelope per media param (filename /
// size / duration / dims) instead of null — see lib/project.ts. While a
// param is unlinked at runtime, the envelope is parked in the params dict
// under `<param>${MISSING_MEDIA_SUFFIX}` so an immediate re-save doesn't
// forget the file.

import { platform } from "./platform";
import type { CloudMediaRef } from "./cloud-media";

export interface MediaEnvelope {
  kind: "video_file" | "audio_file";
  filename: string;
  size?: number;
  duration?: number;
  width?: number;
  height?: number;
  // v11+: content-addressed object in the R2 media bucket (spec
  // 081626_r2-media-storage.md §7.1). Present ⇒ load streams from the
  // cloud URL and relink is never needed; absent/unreachable ⇒ the relink
  // strategies below, unchanged. NESTED on purpose — a top-level `asset`
  // field would trip the Supabase images tier's isAssetRef() walk.
  cloud?: CloudMediaRef;
}

export interface MissingMedia {
  nodeId: string;
  paramName: string;
  envelope: MediaEnvelope;
}

export const MISSING_MEDIA_SUFFIX = "__missingMedia";

// --- File System Access typings -------------------------------------------
// Not in lib.dom (Chromium-only API); minimal structural shapes.

interface FsaFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  queryPermission?(o: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(o: { mode: "read" }): Promise<PermissionState>;
}

type ShowOpenFilePicker = (opts: {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<FsaFileHandle[]>;

export function supportsFileHandles(): boolean {
  return typeof window !== "undefined" && "showOpenFilePicker" in window;
}

// --- IndexedDB handle store -------------------------------------------------

const DB_NAME = "toolbox-media-relink";
const STORE = "handles";

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    // Another tab holding an old connection during an upgrade would
    // otherwise leave this promise pending forever — and a hung lookup
    // reads as "the Relink button does nothing".
    req.onblocked = () => resolve(null);
  });
}

// Keyed by name+size: stable across projects (the same clip wired into
// three projects resolves through one entry) and collision-safe enough —
// two different files sharing both name and byte count is vanishingly rare.
function handleKey(filename: string, size?: number): string {
  return `${filename}|${size ?? "?"}`;
}

export async function storeMediaHandle(
  file: File,
  handle: unknown
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(handle, handleKey(file.name, file.size));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

async function lookupHandle(
  filename: string,
  size?: number
): Promise<FsaFileHandle | null> {
  const db = await openDb();
  if (!db) return null;
  const result = await new Promise<unknown>((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(handleKey(filename, size));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  db.close();
  const h = result as FsaFileHandle | undefined;
  return h && typeof h.getFile === "function" ? h : null;
}

// Resolve an envelope back to a File via its stored handle.
// `allowPrompt: false` is the silent path (project load — no gesture
// available); it succeeds only when the permission grant persisted.
// `allowPrompt: true` may pop the browser's re-grant prompt and must be
// called from a user gesture.
export async function readStoredMediaFile(
  env: { filename: string; size?: number },
  opts: { allowPrompt: boolean }
): Promise<File | null> {
  try {
    const h = await lookupHandle(env.filename, env.size);
    if (!h) return null;
    let perm: PermissionState =
      (await h.queryPermission?.({ mode: "read" })) ?? "granted";
    if (perm !== "granted" && opts.allowPrompt && h.requestPermission) {
      perm = await h.requestPermission({ mode: "read" });
    }
    if (perm !== "granted") return null;
    return await h.getFile();
  } catch {
    // Handle is stale (file moved/deleted), permission API threw, or the
    // prompt lacked user activation — all mean "couldn't resolve".
    return null;
  }
}

// --- picking ----------------------------------------------------------------

const PICKER_TYPES: Record<
  "video" | "audio",
  { description: string; accept: Record<string, string[]> }
> = {
  video: {
    description: "Video",
    accept: {
      "video/*": [".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi"],
    },
  },
  audio: {
    description: "Audio",
    accept: {
      "audio/*": [".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"],
    },
  },
};

// Open the File System Access picker and persist a handle for every pick.
// Returns "unsupported" (caller falls back to <input type="file">), null
// (user cancelled / no activation), or the picked files.
export async function pickMediaFiles(opts: {
  kind: "video" | "audio" | "media";
  multiple?: boolean;
}): Promise<File[] | "unsupported" | null> {
  // Electron: use a native Open dialog. (No FSA handle to persist, so silent
  // re-link on next load isn't available natively yet — a future enhancement
  // would persist the absolute path instead.)
  if (platform.isNative) return platform.pickOpenFiles(opts);
  if (!supportsFileHandles()) return "unsupported";
  const picker = (
    window as unknown as { showOpenFilePicker: ShowOpenFilePicker }
  ).showOpenFilePicker;
  try {
    const handles = await picker({
      multiple: !!opts.multiple,
      excludeAcceptAllOption: false,
      types:
        opts.kind === "media"
          ? [PICKER_TYPES.video, PICKER_TYPES.audio]
          : [PICKER_TYPES[opts.kind]],
    });
    const files: File[] = [];
    for (const h of handles) {
      const file = await h.getFile();
      await storeMediaHandle(file, h);
      files.push(file);
    }
    return files;
  } catch (err) {
    // AbortError = user cancelled (expected, stay quiet). Anything else
    // (SecurityError from consumed activation, TypeError…) is a real
    // failure the caller can't distinguish — log it.
    if ((err as DOMException)?.name !== "AbortError") {
      console.warn("showOpenFilePicker failed:", err);
    }
    return null;
  }
}

// <input type="file"> fallback for browsers without showOpenFilePicker.
// No handle to persist — these picks relink the session but can't
// auto-relink next time.
export function pickMediaFilesViaInput(opts: {
  kind: "video" | "audio" | "media";
  multiple?: boolean;
}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = !!opts.multiple;
    input.accept =
      opts.kind === "media"
        ? "video/*,audio/*"
        : opts.kind === "video"
          ? "video/*"
          : "audio/*";
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      resolve(files);
    };
    input.onchange = () => finish(Array.from(input.files ?? []));
    // Cancelling fires no event reliably across browsers; oncancel is
    // recent but not universal. The file dialog blurs the window, so a
    // refocus with no change event (after a grace period for the change
    // to land) means the user cancelled — without this, the promise can
    // hang forever and wedge the caller's busy-flag.
    input.oncancel = () => finish([]);
    const onFocus = () => {
      window.setTimeout(() => finish(Array.from(input.files ?? [])), 400);
    };
    window.addEventListener("focus", onFocus);
    input.click();
  });
}

// --- matching (Option C) -----------------------------------------------------

// Match picked files to missing entries: exact filename+size first, then
// filename only. One file may satisfy several entries (the same clip wired
// into multiple nodes).
export function matchFilesToMissing(
  files: File[],
  missing: MissingMedia[]
): Map<MissingMedia, File> {
  const result = new Map<MissingMedia, File>();
  for (const pass of ["exact", "name"] as const) {
    for (const m of missing) {
      if (result.has(m)) continue;
      const f = files.find(
        (f) =>
          f.name === m.envelope.filename &&
          (pass === "name" ||
            (m.envelope.size != null && f.size === m.envelope.size))
      );
      if (f) result.set(m, f);
    }
  }
  return result;
}
