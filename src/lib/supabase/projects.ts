import { createClient } from "@/lib/supabase/client";
import type { SavedProject } from "@/lib/project";
import {
  deleteProjectAssets,
  pruneProjectAssets,
  resolveAssetRefs,
  uploadGraphAssets,
} from "@/lib/supabase/project-assets";

// Practical ceiling for the jsonb `graph` column. After Tier 2, media lives
// in Storage and the row is tiny, so this only bites the inline FALLBACK
// path (Storage unavailable — e.g. the bucket's SQL migration hasn't been
// run) on a very large project. Thrown from the row writers with an
// actionable hint; the editor surfaces the message.
const MAX_ROW_MB = 45;

function guardRowSize(graph: SavedProject): void {
  const mb = JSON.stringify(graph).length / (1024 * 1024);
  if (mb > MAX_ROW_MB) {
    throw new Error(
      `Project is ~${Math.round(mb)}MB — too large for cloud save. Use File → Save to File (.toolbox).`
    );
  }
}

export interface ProjectAuthor {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface ProjectRow {
  id: string;
  name: string;
  thumbnail: string | null;
  is_public: boolean;
  user_id: string;
  updated_at: string;
  created_at: string;
  // Aggregate ratings, denormalized onto the row by a trigger on
  // project_ratings — see specdocs/ratings-migration.sql. `null` avg
  // means the project has no ratings yet.
  ratings_avg: number | null;
  ratings_count: number;
  // Stable random slug minted when a project goes public; cleared when
  // it goes private (by a DB trigger as a safety net + the client). The
  // /live/<slug> route resolves rows by this column.
  public_slug: string | null;
  // Populated for rows returned by listPublicProjects; null elsewhere.
  author: ProjectAuthor | null;
  // Which project_folders row this project lives in (null/undefined =
  // root). Only fetched by listPrivateProjects — folders are a
  // private-tab concept — and undefined until the folders migration
  // (specdocs/project-folders-migration.sql) has been run. Read it as
  // `row.folder_id ?? null`.
  folder_id?: string | null;
}

const BASE_COLS =
  "id, name, thumbnail, is_public, user_id, updated_at, created_at, ratings_avg, ratings_count, public_slug";

// Random URL-safe slug. 12 chars × base36 ≈ 62 bits of entropy — well
// under astronomical collision risk at any realistic project count, and
// short enough to fit comfortably in a URL pill.
function mintPublicSlug(): string {
  const out: string[] = [];
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  for (const b of bytes) {
    out.push((b % 36).toString(36));
  }
  return out.join("");
}

const THUMB_BUCKET = "project-thumbnails";

// ========================================================================
// Thumbnails
//
// Historical rows store a `data:image/jpeg;base64,…` URL in the
// `thumbnail` column. New rows upload the JPEG to Supabase Storage
// under `<user_id>/<project_id>.jpg` and store the bucket's public URL
// instead. That cuts listing-query bandwidth by ~1000× and lets the
// CDN + browser cache handle repeat thumbnail views.
//
// Both shapes coexist: use `thumbnailSrc(row)` on the read side so
// legacy data URLs still render. Saves naturally migrate a row the
// next time it's written.
// ========================================================================

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  // Easiest cross-browser way to turn a data URL into a Blob — no
  // manual base64 decode, and the browser validates the MIME for us.
  const resp = await fetch(dataUrl);
  return resp.blob();
}

async function uploadThumbnail(
  userId: string,
  projectId: string,
  dataUrl: string
): Promise<string | null> {
  try {
    const blob = await dataUrlToBlob(dataUrl);
    const path = `${userId}/${projectId}.jpg`;
    const supabase = createClient();
    const { error } = await supabase.storage
      .from(THUMB_BUCKET)
      .upload(path, blob, {
        contentType: "image/jpeg",
        upsert: true,
        // Public bucket + CDN, but the object URL doesn't change
        // between updates (same path). We cache-bust at render time
        // via ?v=<updated_at>, so a long max-age here is safe.
        cacheControl: "3600",
      });
    if (error) {
      console.error("uploadThumbnail failed:", error);
      return null;
    }
    const { data } = supabase.storage.from(THUMB_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  } catch (err) {
    console.error("uploadThumbnail threw:", err);
    return null;
  }
}

async function deleteThumbnail(
  userId: string,
  projectId: string
): Promise<void> {
  try {
    const supabase = createClient();
    await supabase.storage
      .from(THUMB_BUCKET)
      .remove([`${userId}/${projectId}.jpg`]);
  } catch {
    // Best-effort. Orphaned blobs are cheap; worth nothing to block
    // the delete path on storage errors.
  }
}

// Given a project row, return the right `<img src>`. Handles both
// legacy inline data URLs and new Storage URLs, and appends a
// cache-buster so a re-save is picked up without cache lag.
export function thumbnailSrc(row: {
  thumbnail: string | null;
  updated_at: string;
}): string | null {
  if (!row.thumbnail) return null;
  if (row.thumbnail.startsWith("data:")) return row.thumbnail;
  const sep = row.thumbnail.includes("?") ? "&" : "?";
  const v = Date.parse(row.updated_at) || 0;
  return `${row.thumbnail}${sep}v=${v}`;
}

// ========================================================================
// Egress-aware session cache
//
// Listings and loaded projects are cached in-memory for the lifetime of
// the page (module-level, survives component unmount/remount). The TTL
// is deliberately long — collaboration staleness is explicitly opted
// into via the refresh button rather than fought with aggressive
// revalidation. Every mutation (save / rename / visibility / delete)
// invalidates the whole cache so the user's own actions are reflected
// immediately.
// ========================================================================

const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes

interface ListCacheEntry {
  rows: ProjectRow[];
  fetchedAt: number;
  // Private cache only: which user it was fetched for. Wipe on sign
  // switch so you don't see the prior account's projects.
  ownerId?: string;
}

let privateListCache: ListCacheEntry | null = null;
let publicListCache: ListCacheEntry | null = null;
const loadedCache = new Map<
  string,
  { project: LoadedProject; fetchedAt: number }
>();

function fresh(entry: { fetchedAt: number } | null | undefined): boolean {
  if (!entry) return false;
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

// Dropped by the refresh button and by every mutation in this file.
// Exported so the UI can force a refetch on demand.
export function invalidateProjectCaches() {
  privateListCache = null;
  publicListCache = null;
  loadedCache.clear();
}

// ========================================================================
// mutations (auto-invalidate)
// ========================================================================

// A Supabase PostgrestError collapses to "Object" / "[object Object]" in the
// browser console, hiding the actual reason a write failed (statement timeout
// on a huge jsonb body → code 57014, an unsupported NUL char in the JSON → 22P05,
// RLS denial, etc.). Expand the useful fields plus the serialized payload size
// so a failed save is diagnosable instead of opaque. The graph object is only
// measured here, never mutated.
function logProjectWriteError(
  where: string,
  error: unknown,
  graph: SavedProject
): void {
  const e = (error ?? {}) as {
    message?: string;
    code?: string;
    details?: string;
    hint?: string;
  };
  let bytes = -1;
  try {
    bytes = JSON.stringify(graph).length;
  } catch {
    // Circular / non-serializable — JSON.stringify would also have failed
    // before the request, but be defensive so logging never throws.
  }
  // eslint-disable-next-line no-console
  console.error(`${where} failed:`, {
    message: e.message,
    code: e.code,
    details: e.details,
    hint: e.hint,
    graphMB: bytes >= 0 ? +(bytes / 1_048_576).toFixed(2) : null,
    nodes: graph?.nodes?.length,
    raw: error,
  });
}

export async function saveProject(
  name: string,
  graph: SavedProject,
  thumbnail: string | null,
  isPublic = false
): Promise<{ id: string } | null> {
  const supabase = createClient();
  const { data: userResp } = await supabase.auth.getUser();
  if (!userResp.user) return null;
  const userId = userResp.user.id;
  // Pre-generate the id so we can upload the thumbnail to its final
  // path before the row exists — one fewer DB round-trip than the
  // insert-then-upload-then-update alternative. Worst case on a hard
  // failure is an orphan blob, which is cheap.
  const projectId = crypto.randomUUID();
  // Assets first, row last: upload media to Storage and reduce the graph to
  // content-addressed refs (falls back to the inline graph if Storage is
  // unavailable). A failed insert below then leaves only cheap orphan
  // objects, never a row pointing at missing assets.
  const { graph: rowGraph } = await uploadGraphAssets(supabase, graph, {
    userId,
    projectId,
  });
  guardRowSize(rowGraph);
  let thumbnailUrl: string | null = null;
  if (thumbnail) {
    thumbnailUrl = await uploadThumbnail(userId, projectId, thumbnail);
  }
  const { error } = await supabase
    .from("projects")
    .insert({
      id: projectId,
      user_id: userId,
      name,
      graph: rowGraph,
      thumbnail: thumbnailUrl,
      is_public: isPublic,
    });
  if (error) {
    logProjectWriteError("saveProject", error, rowGraph);
    // Row insert failed — drop the orphan blob we just uploaded.
    if (thumbnailUrl) await deleteThumbnail(userId, projectId);
    return null;
  }
  invalidateProjectCaches();
  return { id: projectId };
}

// Overwrites graph + thumbnail on an existing project row. Name and
// visibility are preserved — use renameProject or setProjectVisibility
// for those. `updated_at` is bumped explicitly so the load grid reorders.
export interface UpdateProjectResult {
  ok: boolean;
  // The compare-and-swap matched zero rows: another window/machine saved
  // this project since `expectedUpdatedAt` was read. Nothing was written.
  conflict?: boolean;
  // The row's updated_at after a successful write — carry it forward as
  // the next save's expectedUpdatedAt.
  updatedAt?: string;
}

export async function updateProject(
  id: string,
  graph: SavedProject,
  thumbnail: string | null,
  // Optimistic concurrency: the row's updated_at as of when this editor
  // loaded (or last saved) it. When provided, the UPDATE also matches on
  // it — zero rows updated ⇒ conflict, and the newer row is left intact.
  // Omit to keep the old last-writer-wins behavior (e.g. the overwrite-
  // by-name path, which targets a row this editor never loaded).
  expectedUpdatedAt?: string
): Promise<UpdateProjectResult> {
  const supabase = createClient();
  const { data: userResp } = await supabase.auth.getUser();
  if (!userResp.user) return { ok: false };
  const userId = userResp.user.id;
  // Assets first, row last: upload media to Storage and reduce the graph to
  // content-addressed refs (unchanged media re-hashes to existing objects =
  // zero upload; falls back to the inline graph if Storage is unavailable).
  const {
    graph: rowGraph,
    usedStorage,
    keepFilenames,
    existingBefore,
  } = await uploadGraphAssets(supabase, graph, { userId, projectId: id });
  guardRowSize(rowGraph);
  // Upload the thumbnail so the thumbnail column is only touched when we've
  // actually got a fresh URL to point at. If the upload fails we still push
  // the graph through — users don't want a save blocked by transient storage
  // errors — and leave the old thumbnail in place by omitting it.
  const updatedAt = new Date().toISOString();
  let payload: Record<string, unknown> = {
    graph: rowGraph,
    updated_at: updatedAt,
  };
  if (thumbnail) {
    const url = await uploadThumbnail(userId, id, thumbnail);
    if (url) payload = { ...payload, thumbnail: url };
  } else if (thumbnail === null) {
    // Explicit null means "clear the thumbnail." Rare in practice
    // (we generally pass a data URL), but respect the contract.
    payload = { ...payload, thumbnail: null };
  }
  let query = supabase.from("projects").update(payload).eq("id", id);
  if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error } = await query.select("id");
  if (error) {
    logProjectWriteError("updateProject", error, rowGraph);
    return { ok: false };
  }
  if (expectedUpdatedAt && (!data || data.length === 0)) {
    // Row exists (this editor loaded it) but its updated_at moved on.
    return { ok: false, conflict: true };
  }
  // Prune orphaned assets (media dropped/replaced by this save). Gated on a
  // won compare-and-swap (expectedUpdatedAt present + matched): we're then
  // the authoritative latest, so nothing else references what we prune. The
  // last-writer-wins overwrite-by-name path has no CAS, so it skips prune
  // (its orphans are cheap). Best-effort, and not awaited — never block the
  // save on cleanup.
  if (usedStorage && expectedUpdatedAt) {
    void pruneProjectAssets(
      supabase,
      { userId, projectId: id },
      keepFilenames,
      existingBefore
    );
  }
  invalidateProjectCaches();
  return { ok: true, updatedAt };
}

// Rename without touching graph/thumbnail so typing in the menu-bar
// name pill doesn't cost a full serialize. Returns the row's new
// updated_at (it bumps here!) so the editor can keep its save guard in
// sync.
export interface RenameProjectResult {
  ok: boolean;
  // CAS matched zero rows — another window/machine moved the row since
  // `expectedUpdatedAt` was read. Nothing was written; the editor is stale.
  conflict?: boolean;
  updatedAt?: string;
}

export async function renameProject(
  id: string,
  name: string,
  // Same optimistic-concurrency contract as updateProject: when provided,
  // the UPDATE also matches on updated_at so a stale window's rename
  // CONFLICTS instead of laundering a fresh stamp past the next save's CAS.
  // Omit for rows this editor never loaded (last-writer-wins).
  expectedUpdatedAt?: string
): Promise<RenameProjectResult> {
  const supabase = createClient();
  const updatedAt = new Date().toISOString();
  let query = supabase
    .from("projects")
    .update({ name, updated_at: updatedAt })
    .eq("id", id);
  if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error } = await query.select("id");
  if (error) {
    console.error("renameProject failed:", error);
    return { ok: false };
  }
  if (expectedUpdatedAt && (!data || data.length === 0)) {
    return { ok: false, conflict: true };
  }
  invalidateProjectCaches();
  return { ok: true, updatedAt };
}

export async function setProjectVisibility(
  id: string,
  isPublic: boolean,
  // Optimistic concurrency, same contract as updateProject/renameProject:
  // a stale window's visibility flip conflicts rather than laundering a
  // fresh updated_at past the next save's CAS.
  expectedUpdatedAt?: string
): Promise<
  // updatedAt: the row bumps its version here — the editor feeds it back
  // into its save guard (see updateProject's expectedUpdatedAt).
  | { ok: true; slug: string | null; updatedAt: string }
  | { ok: false; conflict?: boolean }
> {
  const supabase = createClient();
  // Going public mints a slug if one doesn't already exist; going private
  // explicitly clears it (the DB trigger does the same as a safety net).
  // We pass the slug through the same UPDATE so visibility + slug stay
  // atomically consistent — no half-published rows.
  const updatedAt = new Date().toISOString();
  const payload: Record<string, unknown> = {
    is_public: isPublic,
    updated_at: updatedAt,
  };
  let resolvedSlug: string | null = null;
  if (isPublic) {
    const { data: existing } = await supabase
      .from("projects")
      .select("public_slug")
      .eq("id", id)
      .maybeSingle();
    if (existing?.public_slug) {
      resolvedSlug = existing.public_slug as string;
    } else {
      resolvedSlug = mintPublicSlug();
      payload.public_slug = resolvedSlug;
    }
  } else {
    payload.public_slug = null;
  }
  let query = supabase.from("projects").update(payload).eq("id", id);
  if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error } = await query.select("id");
  if (error) {
    console.error("setProjectVisibility failed:", error);
    return { ok: false };
  }
  if (expectedUpdatedAt && (!data || data.length === 0)) {
    return { ok: false, conflict: true };
  }
  invalidateProjectCaches();
  return { ok: true, slug: isPublic ? resolvedSlug : null, updatedAt };
}

export async function deleteProject(id: string): Promise<boolean> {
  const supabase = createClient();
  const { data: userResp } = await supabase.auth.getUser();
  const userId = userResp.user?.id ?? null;
  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) {
    console.error("deleteProject failed:", error);
    return false;
  }
  // Best-effort — orphans are cheap, but clean up when we can.
  if (userId) {
    await deleteThumbnail(userId, id);
    // Per-project asset prefix — one bulk removal, no refcounting needed.
    await deleteProjectAssets(supabase, { userId, projectId: id });
  }
  invalidateProjectCaches();
  return true;
}

// ========================================================================
// ratings
// ========================================================================

// Fetch the signed-in user's existing rating for a project. Returns null
// when the user is signed out or hasn't rated. Used to seed the rating
// popover so users see their own previous score.
export async function getOwnRating(
  projectId: string
): Promise<number | null> {
  const supabase = createClient();
  const { data: userResp } = await supabase.auth.getUser();
  if (!userResp.user) return null;
  const { data, error } = await supabase
    .from("project_ratings")
    .select("rating")
    .eq("project_id", projectId)
    .eq("user_id", userResp.user.id)
    .maybeSingle();
  if (error) {
    console.error("getOwnRating failed:", error);
    return null;
  }
  return data?.rating ?? null;
}

// Upsert the user's rating for a project. The DB trigger refreshes the
// project's `ratings_avg` + `ratings_count` automatically. Returns true
// on success. We invalidate the listing caches so the next load grid
// fetch reflects the updated aggregate.
export async function setRating(
  projectId: string,
  rating: number
): Promise<boolean> {
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) return false;
  const value = Math.round(rating);
  const supabase = createClient();
  const { data: userResp } = await supabase.auth.getUser();
  if (!userResp.user) return false;
  const { error } = await supabase
    .from("project_ratings")
    .upsert(
      {
        project_id: projectId,
        user_id: userResp.user.id,
        rating: value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id,user_id" }
    );
  if (error) {
    console.error("setRating failed:", error);
    return false;
  }
  invalidateProjectCaches();
  return true;
}

// Drops the user's rating row entirely. The trigger recomputes the
// aggregate (potentially back to "no ratings yet" → null avg).
export async function clearRating(projectId: string): Promise<boolean> {
  const supabase = createClient();
  const { data: userResp } = await supabase.auth.getUser();
  if (!userResp.user) return false;
  const { error } = await supabase
    .from("project_ratings")
    .delete()
    .eq("project_id", projectId)
    .eq("user_id", userResp.user.id);
  if (error) {
    console.error("clearRating failed:", error);
    return false;
  }
  invalidateProjectCaches();
  return true;
}

// ========================================================================
// listings (cached)
// ========================================================================

// Mine only. Relies on RLS to deny cross-user reads; no explicit
// user_id filter needed on the wire, but we do pass one so the query
// planner picks up the (user_id) index.
// Resolve fast on a stalled network instead of hanging the projects UI.
const LIST_TIMEOUT_MS = 6000;
function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("network timeout")), ms)
    ),
  ]);
}

// True only when the browser is certain there's no network — lets us skip
// doomed cloud requests for an instant offline UX. `onLine: true` is not a
// guarantee of real connectivity, so the timeout above is the backstop.
function definitelyOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export async function listPrivateProjects(): Promise<ProjectRow[]> {
  const supabase = createClient();
  try {
    // getSession is local (no network); offline it returns the cached session.
    const { data: sess } = await supabase.auth.getSession();
    const uid = sess.session?.user?.id;
    if (!uid) return [];
    if (
      privateListCache &&
      privateListCache.ownerId === uid &&
      fresh(privateListCache)
    ) {
      return privateListCache.rows;
    }
    if (definitelyOffline()) {
      return privateListCache?.ownerId === uid ? privateListCache.rows : [];
    }
    // folder_id is private-tab-only, so it rides this query rather than
    // BASE_COLS. Pre-migration DBs don't have the column — PostgREST
    // answers 42703 — so retry once without it and the grid lists flat.
    const fetchList = (cols: string) =>
      withTimeout(
        supabase
          .from("projects")
          .select(cols)
          .eq("user_id", uid)
          .order("updated_at", { ascending: false }),
        LIST_TIMEOUT_MS
      ) as Promise<{
        data: Record<string, unknown>[] | null;
        error: { code?: string } | null;
      }>;
    let { data, error } = await fetchList(`${BASE_COLS}, folder_id`);
    if (error?.code === "42703") {
      ({ data, error } = await fetchList(BASE_COLS));
    }
    if (error) {
      console.error("listPrivateProjects failed:", error);
      return privateListCache?.ownerId === uid ? privateListCache.rows : [];
    }
    const rows = (data ?? []).map((r) => ({ ...r, author: null }) as ProjectRow);
    privateListCache = { rows, fetchedAt: Date.now(), ownerId: uid };
    return rows;
  } catch (e) {
    // Offline / timeout — degrade to empty instead of throwing (which would
    // leave the grid spinning forever).
    console.warn("listPrivateProjects unavailable (offline?):", e);
    return [];
  }
}

// Every is_public=true row, regardless of owner. Works for signed-out
// visitors too (RLS + grants allow anon SELECT). Authors are merged in
// via a separate profiles query so we don't rely on a PostgREST
// foreign-key relationship between projects and profiles.
export async function listPublicProjects(): Promise<ProjectRow[]> {
  if (fresh(publicListCache)) return publicListCache!.rows;
  if (definitelyOffline()) return publicListCache?.rows ?? [];
  const supabase = createClient();
  try {
  const { data, error } = await withTimeout(
    supabase
      .from("projects")
      .select(BASE_COLS)
      .eq("is_public", true)
      .order("updated_at", { ascending: false }),
    LIST_TIMEOUT_MS
  );
  if (error) {
    console.error("listPublicProjects failed:", error);
    return publicListCache?.rows ?? [];
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    publicListCache = { rows: [], fetchedAt: Date.now() };
    return [];
  }
  const uids = Array.from(new Set(rows.map((r) => r.user_id)));
  const { data: profs } = await withTimeout(
    supabase
      .from("profiles")
      .select("id, display_name, avatar_url")
      .in("id", uids),
    LIST_TIMEOUT_MS
  );
  const byId = new Map<string, ProjectAuthor>();
  for (const p of profs ?? [])
    byId.set(p.id as string, p as ProjectAuthor);
  const enriched = rows.map(
    (r) =>
      ({
        ...r,
        author: byId.get(r.user_id) ?? null,
      }) as ProjectRow
  );
  publicListCache = { rows: enriched, fetchedAt: Date.now() };
  return enriched;
  } catch (e) {
    console.warn("listPublicProjects unavailable (offline?):", e);
    return publicListCache?.rows ?? [];
  }
}

// ========================================================================
// per-project load (cached)
// ========================================================================

export interface LoadedProject {
  name: string;
  graph: SavedProject;
  is_public: boolean;
  user_id: string;
  author: ProjectAuthor | null;
  // The /p/<slug> editor link and /live/<slug> client view both
  // need this. Null when the project isn't currently public.
  public_slug: string | null;
  // Row version as of this load — feed to updateProject's
  // expectedUpdatedAt so a save from a stale window is detected
  // instead of silently clobbering the newer row.
  updated_at: string | null;
}

// Server-side variant: resolves a public project by its URL slug. Takes
// the supabase client as an argument so callers can pass either the
// browser or server SSR client. Cache-bypass — every /live request hits
// the DB so private flips and renames propagate immediately.
export async function loadPublicProjectBySlug(
  client: ReturnType<typeof createClient>,
  slug: string
): Promise<{
  id: string;
  name: string;
  graph: SavedProject;
  user_id: string;
  author: ProjectAuthor | null;
  public_slug: string;
} | null> {
  const { data, error } = await client
    .from("projects")
    .select("id, name, graph, user_id")
    .eq("public_slug", slug)
    .eq("is_public", true)
    .maybeSingle();
  if (error) {
    console.error("loadPublicProjectBySlug failed:", error);
    return null;
  }
  if (!data) return null;
  let author: ProjectAuthor | null = null;
  const { data: prof } = await client
    .from("profiles")
    .select("id, display_name, avatar_url")
    .eq("id", data.user_id)
    .maybeSingle();
  if (prof) author = prof as ProjectAuthor;
  return {
    id: data.id as string,
    name: data.name as string,
    // Resolve v9 asset refs against the OWNER's folder (data.user_id), not
    // the viewer's — public assets live under the author's prefix. No-op on
    // ≤v8 inline graphs.
    graph: resolveAssetRefs(client, data.graph as SavedProject, {
      userId: data.user_id as string,
      projectId: data.id as string,
    }),
    user_id: data.user_id as string,
    author,
    public_slug: slug,
  };
}

export async function loadProject(id: string): Promise<LoadedProject | null> {
  const cached = loadedCache.get(id);
  if (cached && fresh(cached)) return cached.project;
  const supabase = createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("name, graph, is_public, user_id, public_slug, updated_at")
    .eq("id", id)
    .single();
  if (error) {
    console.error("loadProject failed:", error);
    return null;
  }
  let author: ProjectAuthor | null = null;
  // Only bother looking up the author for public projects — private
  // projects are always authored by the current user, and we already
  // know who that is.
  if (data.is_public) {
    const { data: prof } = await supabase
      .from("profiles")
      .select("id, display_name, avatar_url")
      .eq("id", data.user_id)
      .maybeSingle();
    if (prof) author = prof as ProjectAuthor;
  }
  const project: LoadedProject = {
    name: data.name as string,
    // Rewrite v9 asset refs → public Storage URLs so the deserializer
    // fetches media lazily. No-op on ≤v8 inline graphs.
    graph: resolveAssetRefs(supabase, data.graph as SavedProject, {
      userId: data.user_id as string,
      projectId: id,
    }),
    is_public: !!data.is_public,
    user_id: data.user_id as string,
    author,
    public_slug: (data.public_slug as string | null) ?? null,
    updated_at: (data.updated_at as string | null) ?? null,
  };
  loadedCache.set(id, { project, fetchedAt: Date.now() });
  return project;
}
