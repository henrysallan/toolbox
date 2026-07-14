// Content-addressed project media in Supabase Storage (save optimization
// Tier 2). Media assets that used to inline as base64 in the `graph` jsonb
// row now live as objects in the public `project-assets` bucket, named
// <user_id>/<project_id>/<sha256>.<ext>. The row keeps only { kind, asset,
// ext, …envelope } references.
//
// Save uploads only assets not already present (content hash = idempotent),
// then writes a tiny row. Load rewrites refs to public Storage URLs the
// deserializer fetches lazily. Delete removes the project's prefix.
//
// Rollout-safe: uploadGraphAssets FALLS BACK to the inline graph if Storage
// errors (e.g. the bucket doesn't exist because the SQL migration hasn't
// been run yet — specdocs/project-assets-migration.sql), so cloud saves
// keep working the old way until the bucket is live, then switch over
// automatically. See specdocs/071426_cloud-asset-storage.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SavedNode, SavedProject } from "@/lib/project";
import {
  dataUrlToBytes,
  isAssetRef,
  isInlineAsset,
  mimeToExt,
  PRECOMPRESSED_MIMES,
  sha256Hex,
} from "@/lib/asset-envelope";

export const PROJECT_ASSETS_BUCKET = "project-assets";

// Storage.list() returns at most this many per call; loop for big projects.
const LIST_PAGE = 1000;

interface AssetLocator {
  userId: string;
  projectId: string;
}

function assetFilename(hash: string, ext: string): string {
  return `${hash}.${ext}`;
}

function assetPath(loc: AssetLocator, hash: string, ext: string): string {
  return `${loc.userId}/${loc.projectId}/${assetFilename(hash, ext)}`;
}

// Shallow-clone the graph down to the param records we rewrite, leaving the
// caller's in-memory graph untouched (same discipline as writeProjectFile).
function cloneForRewrite(graph: SavedProject): SavedProject {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => ({ ...n, params: { ...n.params } })),
  };
}

// List every object filename under a project's prefix (paginated).
async function listProjectAssetFilenames(
  supabase: SupabaseClient,
  loc: AssetLocator
): Promise<Set<string>> {
  const prefix = `${loc.userId}/${loc.projectId}`;
  const names = new Set<string>();
  for (let offset = 0; ; offset += LIST_PAGE) {
    const { data, error } = await supabase.storage
      .from(PROJECT_ASSETS_BUCKET)
      .list(prefix, { limit: LIST_PAGE, offset });
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const f of data) names.add(f.name);
    if (data.length < LIST_PAGE) break;
  }
  return names;
}

export interface UploadResult {
  // Graph with inline data-URLs replaced by { asset, ext } refs — write
  // THIS to the row. On a Storage failure this is the ORIGINAL inline graph
  // (fallback) so the save still succeeds the old way.
  graph: SavedProject;
  // Whether refs were produced (true) or we fell back to inline (false).
  usedStorage: boolean;
  // Filenames (<hash>.<ext>) referenced by this graph — for prune. Empty on
  // fallback.
  keepFilenames: Set<string>;
}

// Extract inline assets → upload the ones not already present → return the
// ref-graph. Content-addressed, so unchanged media re-hashes to an existing
// object and is skipped (zero upload). Assets first, row last: the caller
// writes the returned graph AFTER this resolves, so a failed save leaves
// cheap orphan objects, never a row pointing at missing assets.
export async function uploadGraphAssets(
  supabase: SupabaseClient,
  graph: SavedProject,
  loc: AssetLocator
): Promise<UploadResult> {
  try {
    // 1. Extract: collect unique assets and rewrite params to refs.
    const out = cloneForRewrite(graph);
    const keepFilenames = new Set<string>();
    // hash -> { bytes, ext, mime } for assets we may need to upload.
    const pending = new Map<
      string,
      { bytes: Uint8Array; ext: string; mime: string }
    >();

    for (const node of out.nodes) {
      await rewriteNodeToRefs(node, pending, keepFilenames);
    }

    if (pending.size === 0) {
      // No media at all — nothing to upload, but still a valid ref-graph
      // (identical to the input) and we "used storage" (no fallback needed).
      return { graph: out, usedStorage: true, keepFilenames };
    }

    // 2. Diff against what's already stored, upload only the new ones.
    const existing = await listProjectAssetFilenames(supabase, loc);
    for (const [hash, a] of pending) {
      const filename = assetFilename(hash, a.ext);
      if (existing.has(filename)) continue;
      const { error } = await supabase.storage
        .from(PROJECT_ASSETS_BUCKET)
        .upload(assetPath(loc, hash, a.ext), a.bytes as BufferSource, {
          contentType: a.mime,
          // Idempotent under a concurrent save of identical bytes to the
          // same content-addressed path.
          upsert: true,
          cacheControl: "31536000",
        });
      if (error) throw error;
    }

    return { graph: out, usedStorage: true, keepFilenames };
  } catch (err) {
    // Bucket missing (pre-migration) or transient Storage error — fall back
    // to the inline graph so the save still goes through the old way.
    console.warn(
      "[project-assets] Storage upload unavailable — saving inline:",
      err
    );
    return { graph, usedStorage: false, keepFilenames: new Set() };
  }
}

// Rewrite one node's inline-asset params to refs, accumulating unique
// assets into `pending` and their filenames into `keep`.
async function rewriteNodeToRefs(
  node: SavedNode,
  pending: Map<string, { bytes: Uint8Array; ext: string; mime: string }>,
  keep: Set<string>
): Promise<void> {
  for (const [key, val] of Object.entries(node.params)) {
    if (!isInlineAsset(val)) continue;
    const { bytes, mime } = await dataUrlToBytes(val.dataUrl);
    const hash = await sha256Hex(bytes);
    const ext = mimeToExt(mime);
    if (!pending.has(hash)) pending.set(hash, { bytes, ext, mime });
    keep.add(assetFilename(hash, ext));
    // Swap the inline dataUrl for a ref, preserving other envelope fields
    // (font family/filename/axes, exr filename, …).
    const ref: Record<string, unknown> = { ...val };
    delete ref.dataUrl;
    ref.asset = hash;
    ref.ext = ext;
    node.params[key] = ref;
  }
}

// Rewrite { asset, ext } refs to { …envelope, dataUrl: <public URL> } so the
// existing deserializer (which fetch()es dataUrl) resolves them lazily —
// works identically on an https: URL as on a data: URL. Synchronous: it
// only builds public URLs, no network. A ≤v8 inline graph has no refs and
// passes through untouched. `loc.userId` is the project OWNER's id (public
// projects resolve against the author's folder), NOT the viewer's.
export function resolveAssetRefs(
  supabase: SupabaseClient,
  graph: SavedProject,
  loc: AssetLocator
): SavedProject {
  let touched = false;
  const rewriteNode = (node: SavedNode): SavedNode => {
    let params: Record<string, unknown> | null = null;
    for (const [key, val] of Object.entries(node.params)) {
      if (!isAssetRef(val)) continue;
      const ext = typeof val.ext === "string" ? val.ext : "bin";
      const { data } = supabase.storage
        .from(PROJECT_ASSETS_BUCKET)
        .getPublicUrl(assetPath(loc, val.asset, ext));
      const restored: Record<string, unknown> = { ...val };
      delete restored.asset;
      delete restored.ext;
      restored.dataUrl = data.publicUrl;
      if (!params) params = { ...node.params };
      params[key] = restored;
    }
    if (!params) return node;
    touched = true;
    return { ...node, params };
  };
  const nodes = graph.nodes.map(rewriteNode);
  return touched ? { ...graph, nodes } : graph;
}

// Remove every object under a project's prefix (project delete). Best-effort
// and paginated; a failure just leaves cheap orphans.
export async function deleteProjectAssets(
  supabase: SupabaseClient,
  loc: AssetLocator
): Promise<void> {
  try {
    const filenames = await listProjectAssetFilenames(supabase, loc);
    if (filenames.size === 0) return;
    const paths = Array.from(filenames, (n) => `${loc.userId}/${loc.projectId}/${n}`);
    await supabase.storage.from(PROJECT_ASSETS_BUCKET).remove(paths);
  } catch (err) {
    console.warn("[project-assets] delete cleanup failed:", err);
  }
}

// Delete objects under the prefix NOT in `keep` — orphans left by a re-save
// that dropped or replaced media. Best-effort; safe only when called AFTER a
// successful compare-and-swap write (the caller is then the authoritative
// latest, so nothing else references the pruned assets — see spec).
export async function pruneProjectAssets(
  supabase: SupabaseClient,
  loc: AssetLocator,
  keep: Set<string>
): Promise<void> {
  try {
    const existing = await listProjectAssetFilenames(supabase, loc);
    const stale = Array.from(existing).filter((n) => !keep.has(n));
    if (stale.length === 0) return;
    const paths = stale.map((n) => `${loc.userId}/${loc.projectId}/${n}`);
    await supabase.storage.from(PROJECT_ASSETS_BUCKET).remove(paths);
  } catch (err) {
    console.warn("[project-assets] prune failed:", err);
  }
}
