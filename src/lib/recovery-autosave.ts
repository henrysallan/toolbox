// Local recovery autosave (shared projects M4, first slice —
// specdocs/081426_shared-projects.md). Crash-recovery snapshots of the
// working graph, kept STRICTLY local in IndexedDB: zero cloud cost, no
// retention policy to run server-side, private by construction. Works
// identically on web and desktop (the Electron renderer's IndexedDB
// persists under the app's userData profile) — no IPC, no main-process
// involvement.
//
// Model: snapshots live in per-project "buckets" (the cloud project id,
// or "untitled" for unsaved work). Each bucket keeps the newest
// KEEP_PER_BUCKET snapshots; an explicit save clears the working bucket
// — recovery's job is crash safety, not history (that's the
// project_versions slice, deliberately not built yet).
//
// Two object stores share one auto-incremented id: `meta` (small: name,
// bucket, stamp) and `graphs` (the SavedProject payload, potentially
// tens of MB). Listing reads ONLY meta so opening the recovery modal
// never hauls megabytes; the graph is fetched on restore.
//
// Every call fails soft (resolves empty/void) when IndexedDB is
// unavailable — recovery is a safety net, never a blocker.

export const KEEP_PER_BUCKET = 5;
export const UNTITLED_BUCKET = "untitled";

const DB_NAME = "toolbox-recovery";
const DB_VERSION = 1;
const META = "meta";
const GRAPHS = "graphs";

export interface RecoverySnapshotMeta {
  id: number;
  // Cloud project id, or UNTITLED_BUCKET for unsaved work.
  bucket: string;
  // Display name at snapshot time (project name / file base name).
  name: string;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) {
        const meta = db.createObjectStore(META, {
          keyPath: "id",
          autoIncrement: true,
        });
        meta.createIndex("bucket", "bucket");
        meta.createIndex("savedAt", "savedAt");
      }
      if (!db.objectStoreNames.contains(GRAPHS)) {
        db.createObjectStore(GRAPHS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function requestAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Write a snapshot, then prune the bucket back to KEEP_PER_BUCKET
// (oldest out). The graph is stored via structured clone — no
// JSON.stringify pass, so a large project costs one clone, not a
// serialize-to-string.
export async function saveRecoverySnapshot(
  bucket: string,
  name: string,
  graph: unknown
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction([META, GRAPHS], "readwrite");
    const meta = tx.objectStore(META);
    const graphs = tx.objectStore(GRAPHS);
    const id = (await requestAsPromise(
      meta.add({ bucket, name, savedAt: Date.now() })
    )) as number;
    graphs.put(graph, id);
    // Prune: everything in this bucket beyond the newest KEEP_PER_BUCKET.
    const inBucket = (await requestAsPromise(
      meta.index("bucket").getAll(bucket)
    )) as RecoverySnapshotMeta[];
    const excess = inBucket
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(KEEP_PER_BUCKET);
    for (const m of excess) {
      meta.delete(m.id);
      graphs.delete(m.id);
    }
    await txDone(tx);
  } catch (e) {
    console.warn("saveRecoverySnapshot failed:", e);
  } finally {
    db.close();
  }
}

// All snapshots across buckets, newest first — meta only.
export async function listRecoverySnapshots(): Promise<
  RecoverySnapshotMeta[]
> {
  const db = await openDb();
  if (!db) return [];
  try {
    const tx = db.transaction(META, "readonly");
    const all = (await requestAsPromise(
      tx.objectStore(META).getAll()
    )) as RecoverySnapshotMeta[];
    return all.sort((a, b) => b.savedAt - a.savedAt);
  } catch (e) {
    console.warn("listRecoverySnapshots failed:", e);
    return [];
  } finally {
    db.close();
  }
}

export async function getRecoverySnapshotGraph(
  id: number
): Promise<unknown | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(GRAPHS, "readonly");
    const graph = await requestAsPromise(tx.objectStore(GRAPHS).get(id));
    return graph ?? null;
  } catch (e) {
    console.warn("getRecoverySnapshotGraph failed:", e);
    return null;
  } finally {
    db.close();
  }
}

export async function deleteRecoverySnapshot(id: number): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction([META, GRAPHS], "readwrite");
    tx.objectStore(META).delete(id);
    tx.objectStore(GRAPHS).delete(id);
    await txDone(tx);
  } catch (e) {
    console.warn("deleteRecoverySnapshot failed:", e);
  } finally {
    db.close();
  }
}

// Explicit save → the working bucket's snapshots have done their job.
export async function clearRecoveryBucket(bucket: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction([META, GRAPHS], "readwrite");
    const meta = tx.objectStore(META);
    const inBucket = (await requestAsPromise(
      meta.index("bucket").getAll(bucket)
    )) as RecoverySnapshotMeta[];
    for (const m of inBucket) {
      meta.delete(m.id);
      tx.objectStore(GRAPHS).delete(m.id);
    }
    await txDone(tx);
  } catch (e) {
    console.warn("clearRecoveryBucket failed:", e);
  } finally {
    db.close();
  }
}
