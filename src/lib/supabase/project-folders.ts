import { createClient } from "@/lib/supabase/client";
import { invalidateProjectCaches } from "@/lib/supabase/projects";

// ========================================================================
// Project folders — per-user, arbitrarily nestable organization for the
// Private tab of the load grid. Sibling module to projects.ts with the
// same egress-aware conventions: a long-TTL session cache keyed to the
// signed-in user, a fetch timeout, offline degradation, and cache
// invalidation on every mutation.
//
// Rollout safety: if specdocs/sql_archive/project-folders-migration.sql hasn't been
// run, listFolders() errors → returns [] → the grid renders flat exactly
// as before the feature; mutations no-op with a console error.
//
// Spec: specdocs/archive/072726_project-folders.md
// ========================================================================

export interface FolderRow {
  id: string;
  user_id: string;
  name: string;
  // null = the folder lives at the root of the Private tab.
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

const FOLDER_COLS = "id, user_id, name, parent_id, created_at, updated_at";

// Same numbers as projects.ts — kept local (they're internal there) so
// this module doesn't widen that file's surface.
const CACHE_TTL_MS = 60 * 60 * 1000;
const LIST_TIMEOUT_MS = 6000;

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("network timeout")), ms)
    ),
  ]);
}

function definitelyOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

let folderCache: {
  rows: FolderRow[];
  fetchedAt: number;
  ownerId: string;
} | null = null;

export function invalidateFolderCache() {
  folderCache = null;
}

// ALL of the user's folders, flat — callers build the tree from
// parent_id. The whole list is one small fetch; drill-in navigation is
// then pure client-side filtering with zero extra egress.
export async function listFolders(): Promise<FolderRow[]> {
  const supabase = createClient();
  try {
    const { data: sess } = await supabase.auth.getSession();
    const uid = sess.session?.user?.id;
    if (!uid) return [];
    if (
      folderCache &&
      folderCache.ownerId === uid &&
      Date.now() - folderCache.fetchedAt < CACHE_TTL_MS
    ) {
      return folderCache.rows;
    }
    if (definitelyOffline()) {
      return folderCache?.ownerId === uid ? folderCache.rows : [];
    }
    const { data, error } = await withTimeout(
      supabase
        .from("project_folders")
        .select(FOLDER_COLS)
        .eq("user_id", uid)
        .order("name", { ascending: true }),
      LIST_TIMEOUT_MS
    );
    if (error) {
      // Includes the pre-migration case (relation doesn't exist) — the
      // grid degrades to the flat view.
      console.error("listFolders failed:", error);
      return folderCache?.ownerId === uid ? folderCache.rows : [];
    }
    const rows = (data ?? []) as FolderRow[];
    folderCache = { rows, fetchedAt: Date.now(), ownerId: uid };
    return rows;
  } catch (e) {
    console.warn("listFolders unavailable (offline?):", e);
    return [];
  }
}

export async function createFolder(
  name: string,
  parentId: string | null
): Promise<FolderRow | null> {
  const supabase = createClient();
  const { data: userResp } = await supabase.auth.getUser();
  if (!userResp.user) return null;
  const { data, error } = await supabase
    .from("project_folders")
    .insert({
      user_id: userResp.user.id,
      name,
      parent_id: parentId,
    })
    .select(FOLDER_COLS)
    .single();
  if (error) {
    console.error("createFolder failed:", error);
    return null;
  }
  invalidateFolderCache();
  return data as FolderRow;
}

export async function renameFolder(
  id: string,
  name: string
): Promise<boolean> {
  const supabase = createClient();
  const { error } = await supabase
    .from("project_folders")
    .update({ name, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    console.error("renameFolder failed:", error);
    return false;
  }
  invalidateFolderCache();
  return true;
}

// Re-parent a folder. The caller guards against dropping a folder into
// itself/its own subtree for UX; the DB trigger is the enforcement
// backstop, so a raced/buggy move errors rather than corrupting.
export async function moveFolder(
  id: string,
  parentId: string | null
): Promise<boolean> {
  const supabase = createClient();
  const { error } = await supabase
    .from("project_folders")
    .update({ parent_id: parentId, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    console.error("moveFolder failed:", error);
    return false;
  }
  invalidateFolderCache();
  return true;
}

// Delete never deletes projects: contents (subfolders + projects) are
// re-homed to the deleted folder's parent first, then the row goes.
// Partial failure is benign — children already moved, folder remains.
// The FKs' `on delete set null` backstop catches anything orphaned
// outside this path (they fall to root).
export async function deleteFolder(
  id: string,
  parentId: string | null
): Promise<boolean> {
  const supabase = createClient();
  const { error: subErr } = await supabase
    .from("project_folders")
    .update({ parent_id: parentId })
    .eq("parent_id", id);
  if (subErr) {
    console.error("deleteFolder (re-parent subfolders) failed:", subErr);
    return false;
  }
  // No updated_at bump — see moveProjectToFolder.
  const { error: projErr } = await supabase
    .from("projects")
    .update({ folder_id: parentId })
    .eq("folder_id", id);
  if (projErr) {
    console.error("deleteFolder (re-home projects) failed:", projErr);
    return false;
  }
  const { error } = await supabase
    .from("project_folders")
    .delete()
    .eq("id", id);
  if (error) {
    console.error("deleteFolder failed:", error);
    return false;
  }
  invalidateFolderCache();
  invalidateProjectCaches();
  return true;
}

// Files a project into a folder (null = root). Deliberately does NOT
// bump updated_at: a drag in the load grid must not conflict an open
// editor's optimistic-concurrency save (the CAS matches on updated_at)
// and must not reorder the date sort.
export async function moveProjectToFolder(
  projectId: string,
  folderId: string | null
): Promise<boolean> {
  const supabase = createClient();
  const { error } = await supabase
    .from("projects")
    .update({ folder_id: folderId })
    .eq("id", projectId);
  if (error) {
    console.error("moveProjectToFolder failed:", error);
    return false;
  }
  invalidateProjectCaches();
  return true;
}
