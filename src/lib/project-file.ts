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

// An asset-bearing param after extraction. Mirrors the inline envelope
// ({ kind, dataUrl }) but points at an asset id instead.
interface AssetRef {
  kind?: string;
  asset: string;
}

// --- data-url <-> bytes --------------------------------------------------

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(5, comma); // strip leading "data:"
  const mime = header.split(";")[0] || "application/octet-stream";
  const isBase64 = header.includes(";base64");
  const dataPart = dataUrl.slice(comma + 1);
  if (isBase64) {
    const bin = atob(dataPart);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime };
  }
  // URL-encoded (non-base64) data URLs are rare here but cheap to support.
  const bytes = new TextEncoder().encode(decodeURIComponent(dataPart));
  return { bytes, mime };
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function mimeToExt(mime: string): string {
  return MIME_TO_EXT[mime] ?? "bin";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Detect the inline asset envelope serializeParams emits: an object with a
// `data:` URL under `dataUrl` (paint layers, image files).
function isInlineAsset(
  val: unknown
): val is { kind?: string; dataUrl: string } {
  return (
    !!val &&
    typeof val === "object" &&
    typeof (val as { dataUrl?: unknown }).dataUrl === "string" &&
    (val as { dataUrl: string }).dataUrl.startsWith("data:")
  );
}

function isAssetRef(val: unknown): val is AssetRef {
  return (
    !!val &&
    typeof val === "object" &&
    typeof (val as { asset?: unknown }).asset === "string"
  );
}

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

  // Clone so we don't mutate the caller's graph while swapping envelopes
  // for references.
  const graph = structuredClone(opts.graph) as SavedProject;

  for (const node of graph.nodes) {
    for (const [key, val] of Object.entries(node.params)) {
      if (!isInlineAsset(val)) continue;
      const { bytes, mime } = dataUrlToBytes(val.dataUrl);
      const id = await sha256Hex(bytes);
      let asset = seen.get(id);
      if (!asset) {
        const ext = mimeToExt(mime);
        asset = { id, mime, ext, bytes: bytes.length };
        seen.set(id, asset);
        assets.push(asset);
        zip.file(`assets/${id}.${ext}`, bytes);
      }
      node.params[key] = { kind: val.kind, asset: id } satisfies AssetRef;
    }
  }

  let thumbnail: string | undefined;
  if (opts.thumbnailDataUrl) {
    const { bytes } = dataUrlToBytes(opts.thumbnailDataUrl);
    thumbnail = "thumbnail.jpg";
    zip.file(thumbnail, bytes);
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
      node.params[key] = {
        kind: val.kind,
        dataUrl: `data:${meta.mime};base64,${b64}`,
      };
    }
  }

  return { name: manifest.name || "Untitled", graph };
}
