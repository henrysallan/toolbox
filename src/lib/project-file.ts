// =====================================================================
// .toolbox project file — a self-contained, desktop-loadable container
// =====================================================================
//
// A `.toolbox` file is a zip with this layout:
//
//   manifest.json   format version, app/project metadata, scene settings,
//                   thumbnail ref, and the asset index
//   project.json    the SavedProject graph (see lib/project.ts) — identical
//                   to the cloud-saved shape, except image/paint params hold
//                   an asset REFERENCE ({ kind, asset: <hash> }) instead of an
//                   inline data-URL
//   thumbnail.jpg   256px preview (so Finder/OS can show it)
//   assets/<hash>.<ext>   binary asset blobs, named by content hash (dedup)
//
// Why a container and not a single JSON: avoids base64 bloat (critical once
// video lands), stores binaries raw, and is trivially readable by a future
// native (Rust/Tauri) build — one format for web and desktop.
//
// This layer is deliberately thin over serializeGraph/deserializeGraph: on
// write we pull inline data-URLs out into `assets/` and leave a reference;
// on read we re-inline them, handing the existing deserializer a graph it
// already understands. So the graph round-trip code stays untouched.
//
// Scope (v1): images + paint layers are embedded. Video / audio / custom
// fonts are still re-picked on load (same as the cloud save today) — the
// asset index is forward-compatible, so they slot in later without a format
// bump for existing files.

import JSZip from "jszip";
import type { SavedProject } from "./project";
import {
  dataUrlToBytes,
  isAssetRef,
  isInlineAsset,
  mimeToExt,
  PRECOMPRESSED_MIMES,
  sha256Hex,
} from "./asset-envelope";

// Bump when the container layout changes in a non-back-compatible way.
// The reader refuses files with a HIGHER formatVersion than it knows.
export const FORMAT_VERSION = 1;

export const TOOLBOX_EXTENSION = "toolbox";

export interface ToolboxAsset {
  // Content hash (SHA-256 hex) — also the file stem under assets/.
  id: string;
  mime: string;
  ext: string;
  // Decoded byte length, for display / sanity checks.
  bytes: number;
}

export interface ToolboxManifest {
  formatVersion: number;
  app: "toolbox";
  // Human-readable project name (also used as the default download name).
  name: string;
  createdAt: string;
  modifiedAt: string;
  // Mirrors SavedProject.schemaVersion for at-a-glance compatibility.
  schemaVersion: number;
  // Duplicated from the graph for native readers that want scene info
  // without parsing project.json. project.json remains the source of truth.
  scene?: SavedProject["scene"];
  thumbnail?: string;
  assets: ToolboxAsset[];
}

// Asset envelope primitives (isInlineAsset / isAssetRef / dataUrlToBytes /
// sha256Hex / mimeToExt / PRECOMPRESSED_MIMES) are shared with the cloud
// Storage path — see lib/asset-envelope.ts. STORE-vs-DEFLATE for the zip
// uses PRECOMPRESSED_MIMES below (already-compressed bytes gain ~nothing
// from DEFLATE and STORE is still a standard zip every reader handles).

// --- write ---------------------------------------------------------------

export interface WriteProjectFileOptions {
  name: string;
  // Output of serializeGraph — assets still inline as data-URLs.
  graph: SavedProject;
  // Output of generateThumbnail (a jpeg data-URL), or null.
  thumbnailDataUrl?: string | null;
}

// Build a `.toolbox` blob from a serialized graph. Pulls inline image/paint
// data-URLs into deduped binary assets and leaves references behind.
export async function writeProjectFile(
  opts: WriteProjectFileOptions
): Promise<Blob> {
  const zip = new JSZip();
  const assets: ToolboxAsset[] = [];
  const seen = new Map<string, ToolboxAsset>(); // hash -> asset (dedup)

  // Clone just what we mutate (the params records) so the caller's graph
  // stays untouched — structuredClone walked the whole tree, copying the
  // multi-MB data-URL strings along with it. The envelope objects
  // themselves are copied via `{ ...val }` below before being edited.
  const graph: SavedProject = {
    ...opts.graph,
    nodes: opts.graph.nodes.map((n) => ({ ...n, params: { ...n.params } })),
  };

  for (const node of graph.nodes) {
    for (const [key, val] of Object.entries(node.params)) {
      if (!isInlineAsset(val)) continue;
      const { bytes, mime } = await dataUrlToBytes(val.dataUrl);
      const id = await sha256Hex(bytes);
      let asset = seen.get(id);
      if (!asset) {
        const ext = mimeToExt(mime);
        asset = { id, mime, ext, bytes: bytes.length };
        seen.set(id, asset);
        assets.push(asset);
        zip.file(`assets/${id}.${ext}`, bytes, {
          compression: PRECOMPRESSED_MIMES.has(mime) ? "STORE" : "DEFLATE",
        });
      }
      // Swap the inline `dataUrl` for an asset reference, preserving any
      // other envelope fields (e.g. a font's family/filename/axes) so they
      // survive the round-trip.
      const ref: Record<string, unknown> = { ...val };
      delete ref.dataUrl;
      ref.asset = id;
      node.params[key] = ref;
    }
  }

  let thumbnail: string | undefined;
  if (opts.thumbnailDataUrl) {
    const { bytes } = await dataUrlToBytes(opts.thumbnailDataUrl);
    thumbnail = "thumbnail.jpg";
    zip.file(thumbnail, bytes, { compression: "STORE" });
  }

  const now = new Date().toISOString();
  const manifest: ToolboxManifest = {
    formatVersion: FORMAT_VERSION,
    app: "toolbox",
    name: opts.name,
    createdAt: now,
    modifiedAt: now,
    schemaVersion: graph.schemaVersion,
    scene: graph.scene,
    thumbnail,
    assets,
  };

  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("project.json", JSON.stringify(graph));

  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

// --- read ----------------------------------------------------------------

export interface ReadProjectFileResult {
  name: string;
  // A SavedProject with assets re-inlined — ready for deserializeGraph.
  graph: SavedProject;
}

// Parse a `.toolbox` blob, re-inlining binary assets back into the graph so
// the existing deserializeGraph can consume it unchanged.
export async function readProjectFile(
  file: Blob
): Promise<ReadProjectFileResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error("That doesn't look like a .toolbox file.");
  }

  const manifestFile = zip.file("manifest.json");
  const projectFile = zip.file("project.json");
  if (!manifestFile || !projectFile) {
    throw new Error("Invalid .toolbox file — missing manifest or project.");
  }

  const manifest = JSON.parse(
    await manifestFile.async("string")
  ) as ToolboxManifest;
  if (typeof manifest.formatVersion !== "number") {
    throw new Error("Invalid .toolbox file — unreadable manifest.");
  }
  if (manifest.formatVersion > FORMAT_VERSION) {
    throw new Error(
      `This project was made with a newer version of Toolbox (file format v${manifest.formatVersion}). Update to open it.`
    );
  }

  const graph = JSON.parse(await projectFile.async("string")) as SavedProject;
  const assetById = new Map(manifest.assets.map((a) => [a.id, a]));

  for (const node of graph.nodes) {
    for (const [key, val] of Object.entries(node.params)) {
      if (!isAssetRef(val)) continue;
      const meta = assetById.get(val.asset);
      const entry = meta ? zip.file(`assets/${val.asset}.${meta.ext}`) : null;
      if (!meta || !entry) {
        // Missing/corrupt asset — degrade like a dropped file: the node
        // falls back to its empty state and the user can re-pick.
        node.params[key] = null;
        continue;
      }
      const b64 = await entry.async("base64");
      // Re-inline the bytes as a `dataUrl`, restoring any other envelope
      // fields the writer preserved (font family/filename/axes, etc.).
      const restored: Record<string, unknown> = { ...val };
      delete restored.asset;
      restored.dataUrl = `data:${meta.mime};base64,${b64}`;
      node.params[key] = restored;
    }
  }

  return { name: manifest.name || "Untitled", graph };
}
