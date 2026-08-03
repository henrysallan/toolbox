// File → Open Recent: the local cache of recently-opened projects
// (spec 073026_open-recent.md). Per-machine, never synced to the cloud.
//
// Three entry kinds share one recency-sorted menu:
// - "cloud"        — a Supabase project row; {id, name} in localStorage.
// - "local"        — a web-opened .toolbox; its FileSystemFileHandle lives in
//                    IndexedDB (handles don't serialize to localStorage),
//                    metadata in the same localStorage list. Chromium only —
//                    the <input type=file> fallback yields no handle, so those
//                    opens are not recorded (a row that can't reopen is worse
//                    than no row).
// - "local-native" — desktop .toolbox recents. NOT stored here: merged at
//                    list time from platform.recents (Electron main owns that
//                    list and prunes dead paths), so this menu and the
//                    LoadGrid "Local" tab always agree.
//
// SSR-safe: window/localStorage/indexedDB are only touched inside functions.

import { platform } from "@/lib/platform";

export type RecentProjectEntry =
  | { kind: "cloud"; id: string; name: string; lastOpened: number }
  | { kind: "local"; refId: string; name: string; lastOpened: number }
  | { kind: "local-native"; path: string; name: string; lastOpened: number };

const LS_KEY = "toolbox.openRecent";
const MAX_STORED = 20;

// --- localStorage list (cloud + web-local metadata) -------------------------

type StoredEntry = Extract<RecentProjectEntry, { kind: "cloud" | "local" }>;

function readStored(): StoredEntry[] {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    const v = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is StoredEntry =>
        !!e &&
        typeof e.name === "string" &&
        typeof e.lastOpened === "number" &&
        ((e.kind === "cloud" && typeof e.id === "string") ||
          (e.kind === "local" && typeof e.refId === "string"))
    );
  } catch {
    // Private mode / disabled storage / corrupt JSON — behave as empty.
    return [];
  }
}

function writeStored(list: StoredEntry[]) {
  try {
    window.localStorage.setItem(
      LS_KEY,
      JSON.stringify(list.slice(0, MAX_STORED))
    );
  } catch {
    /* best-effort */
  }
  notify();
}

// --- change notification (EffectsApp keeps React state in sync) ------------

const listeners = new Set<() => void>();

export function subscribeRecentProjects(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Also exported so EffectsApp can poke listeners after operations that mutate
// the NATIVE list out-of-band (desktop open/save dialogs record in main).
export function notifyRecentProjectsChanged() {
  notify();
}

function notify() {
  for (const cb of listeners) cb();
}

// --- IndexedDB handle store (web-local entries) -----------------------------

const DB_NAME = "toolbox-recent-files";
const DB_STORE = "handles";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE))
        req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbOp<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

const idbGet = (key: string) =>
  idbOp<unknown>("readonly", (s) => s.get(key));
const idbPut = (key: string, value: unknown) =>
  idbOp("readwrite", (s) => s.put(value, key));
const idbDelete = (key: string) =>
  idbOp("readwrite", (s) => s.delete(key));
const idbClear = () => idbOp("readwrite", (s) => s.clear());

// --- File System Access plumbing (Chromium) ---------------------------------

// The FSA picker + per-handle permission methods aren't in the project's DOM
// lib yet — cast, same pattern as web.ts's showDirectoryPicker.
type FsaWindow = Window & {
  showOpenFilePicker?: (opts?: {
    types?: { description?: string; accept: Record<string, string[]> }[];
    multiple?: boolean;
  }) => Promise<FileSystemFileHandle[]>;
};
type FsaHandle = FileSystemFileHandle & {
  queryPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
  isSameEntry?: (other: FileSystemFileHandle) => Promise<boolean>;
};

export function supportsLocalFileRecents(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as FsaWindow).showOpenFilePicker === "function"
  );
}

/** Web File → Load… on Chromium: pick a .toolbox via the FSA picker and record
 *  its handle as a recent. Returns the picked File, or null on cancel (callers
 *  must NOT fall back to another dialog on null — check
 *  supportsLocalFileRecents() first to choose the legacy input path). */
export async function pickAndRecordLocalToolbox(): Promise<File | null> {
  const picker = (window as FsaWindow).showOpenFilePicker;
  if (!picker) return null;
  let handles: FileSystemFileHandle[];
  try {
    handles = await picker({
      types: [
        {
          description: "Toolbox project",
          accept: { "application/zip": [".toolbox"] },
        },
      ],
      multiple: false,
    });
  } catch {
    return null; // cancelled
  }
  const handle = handles?.[0];
  if (!handle) return null;
  try {
    const file = await handle.getFile();
    // Record at pick time (desktop main records at dialog time too) so a file
    // that later fails to parse still shows up — consistent across platforms.
    await recordLocalHandle(handle, file.name);
    return file;
  } catch {
    return null; // file vanished between pick and read — treat as cancel
  }
}

async function recordLocalHandle(handle: FileSystemFileHandle, fileName: string) {
  const name = fileName.replace(/\.toolbox$/i, "") || fileName;
  const stored = readStored();
  // Dedupe against the same underlying file — reuse its refId so re-opening
  // a file moves its one entry to the front instead of accumulating rows.
  let refId: string | null = null;
  for (const e of stored) {
    if (e.kind !== "local") continue;
    try {
      const existing = (await idbGet(e.refId)) as FsaHandle | undefined;
      if (existing && (await existing.isSameEntry?.(handle))) {
        refId = e.refId;
        break;
      }
    } catch {
      /* unreadable handle — leave it; open will prune it */
    }
  }
  if (!refId)
    refId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  try {
    await idbPut(refId, handle);
  } catch {
    return; // no IDB (private mode) — can't reopen later, so don't list it
  }
  writeStored([
    { kind: "local", refId, name, lastOpened: Date.now() },
    ...stored.filter((e) => e.kind !== "local" || e.refId !== refId),
  ]);
}

/** Reopen a web-local recent: permission dance + getFile. Returns null when
 *  the file can't be produced — the entry self-prunes if the file is GONE
 *  (handle lost or NotFoundError), but survives a permission denial. */
export async function openLocalRecentFile(refId: string): Promise<File | null> {
  let handle: FsaHandle | undefined;
  try {
    handle = (await idbGet(refId)) as FsaHandle | undefined;
  } catch {
    handle = undefined;
  }
  if (!handle) {
    removeLocalEntry(refId);
    return null;
  }
  try {
    // A menu click carries user activation, so requestPermission may prompt.
    let perm = (await handle.queryPermission?.({ mode: "read" })) ?? "granted";
    if (perm !== "granted")
      perm = (await handle.requestPermission?.({ mode: "read" })) ?? "denied";
    if (perm !== "granted") return null; // denied — keep the entry
    const file = await handle.getFile();
    // Bump recency in place.
    const stored = readStored();
    const hit = stored.find((e) => e.kind === "local" && e.refId === refId);
    if (hit) {
      hit.lastOpened = Date.now();
      writeStored(
        [...stored].sort((a, b) => b.lastOpened - a.lastOpened)
      );
    }
    return file;
  } catch {
    // File moved/deleted (NotFoundError) — mirror main's dead-path pruning.
    removeLocalEntry(refId);
    void idbDelete(refId).catch(() => {});
    return null;
  }
}

function removeLocalEntry(refId: string) {
  writeStored(
    readStored().filter((e) => e.kind !== "local" || e.refId !== refId)
  );
}

// --- cloud entries ----------------------------------------------------------

/** Move/insert the cloud project to the front with a fresh timestamp. Called
 *  on cloud load AND on every successful cloud save — a saved row is an
 *  openable recent. */
export function recordCloudRecent(id: string, name: string) {
  const stored = readStored();
  writeStored([
    { kind: "cloud", id, name, lastOpened: Date.now() },
    ...stored.filter((e) => e.kind !== "cloud" || e.id !== id),
  ]);
}

/** Drop a cloud entry — for flows that delete the underlying row (e.g. the
 *  rename-overwrite path abandons its source row). */
export function removeCloudRecent(id: string) {
  writeStored(readStored().filter((e) => e.kind !== "cloud" || e.id !== id));
}

/** Rename patches the stored label WITHOUT bumping recency — renaming a
 *  project you haven't opened in a while must not reorder the menu. */
export function renameCloudRecent(id: string, name: string) {
  const stored = readStored();
  const hit = stored.find((e) => e.kind === "cloud" && e.id === id);
  if (!hit) return;
  hit.name = name;
  writeStored(stored);
}

// --- the merged list + clear ------------------------------------------------

/** The full recency-sorted list: localStorage entries merged with the desktop
 *  native recents (which Electron main records/prunes on its own). */
export async function listRecentProjects(): Promise<RecentProjectEntry[]> {
  if (typeof window === "undefined") return [];
  const stored: RecentProjectEntry[] = readStored();
  let native: RecentProjectEntry[] = [];
  if (platform.recents) {
    try {
      native = (await platform.recents.list()).map((r) => ({
        kind: "local-native" as const,
        path: r.path,
        name: r.name.replace(/\.toolbox$/i, "") || r.name,
        lastOpened: r.lastOpened,
      }));
    } catch {
      /* bridge hiccup — show what we have */
    }
  }
  return [...stored, ...native].sort((a, b) => b.lastOpened - a.lastOpened);
}

/** Clear Menu: localStorage list, IDB handles, AND the native list (which
 *  also empties the desktop LoadGrid "Local" tab — same recents concept). */
export async function clearRecentProjects(): Promise<void> {
  try {
    window.localStorage.removeItem(LS_KEY);
  } catch {
    /* best-effort */
  }
  await idbClear().catch(() => {});
  if (platform.recents) {
    try {
      const native = await platform.recents.list();
      await Promise.all(native.map((r) => platform.recents!.remove(r.path)));
    } catch {
      /* best-effort */
    }
  }
  notify();
}
