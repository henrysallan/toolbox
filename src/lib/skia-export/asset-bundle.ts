// The bundle's asset section, shared by both bundle kinds (the Skia Canvas
// scene, scene-emit.ts, and the SkSL Shader effect, emit.ts) and by their
// planners, so a planner's "not bundled" warning and the emitter's files
// can never disagree about which asset has bytes.
//
// Bytes for an asset come from SkiaExportRequest.assets (resolved before the
// synchronous export through the URL → bytes seam, engine/skia/asset-bytes.ts)
// or, for a data: URL, from the URL itself. They ride through
// SkiaExportResult.files as base64 at `assets/<file>.b64` (the zip writer
// and the CLI decode them; MCP returns them as they are). A licence that
// must travel with an asset (AssetIR.license: Geist's OFL text) lands as a
// plain text file beside it.

import { dataUrlBytes, bytesToBase64 } from "@/engine/skia/asset-bytes";
import type { AssetIR, AssetSheetIR } from "@/engine/skia/scene-ir";
import type { SkiaExportAssets } from "./api";

export interface AssetUse {
  asset: AssetIR;
  // Who draws it, for the warnings: `skia-image "img"` (type + node id).
  owners: string[];
}

export interface ManifestAsset {
  id: string;
  kind: AssetIR["kind"];
  mime: string;
  file: string;
  bundled: boolean;
  // Size of the bundled file in bytes.
  bytes?: number;
  // The editor URL of an asset that did not bundle (never a data: URL).
  url?: string;
  width?: number;
  height?: number;
  // The licence file shipped beside it.
  license?: string;
  // A sprite sheet's layout (Skia Bake, AssetIR.sheet): cell size, grid,
  // gutter, the tick each cell holds, cells per second. Additive (lane B).
  sheet?: AssetSheetIR;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "application/x-font-ttf": "ttf",
  "application/font-sfnt": "ttf",
};

function urlExt(url: string): string | undefined {
  if (url.startsWith("data:") || url.startsWith("blob:")) return undefined;
  return /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
}

// assets/<id>.<ext>: the extension from the MIME type (Metro picks the
// loader by it), else the URL's, else .bin.
export function assetFile(a: Pick<AssetIR, "id" | "mime" | "url">): string {
  const ext = EXT[a.mime.toLowerCase()] ?? urlExt(a.url) ?? "bin";
  return `assets/${a.id.replace(/[^A-Za-z0-9_-]/g, "_")}.${ext}`;
}

// assets/<the licence URL's file name>, or <id>-LICENSE.txt.
export function licenseFile(a: AssetIR): string | null {
  if (!a.license) return null;
  const base = /([^/?#]+)(?:[?#].*)?$/.exec(a.license.startsWith("data:") ? "" : a.license)?.[1];
  const safe = base?.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `assets/${safe && /\.[A-Za-z0-9]+$/.test(safe) ? safe : `${a.id.replace(/[^A-Za-z0-9_-]/g, "_")}-LICENSE.txt`}`;
}

export function assetBytesOf(url: string | undefined, assets: SkiaExportAssets | undefined): Uint8Array | null {
  if (!url) return null;
  const got = assets?.bytes[url];
  if (got) return got;
  return url.startsWith("data:") ? dataUrlBytes(url) : null;
}

function describeUrl(url: string): string {
  if (url.startsWith("data:")) return "an inline data: URL";
  if (url.startsWith("blob:")) return "an in-memory file (blob: URL)";
  return url;
}

// One warning per asset (or licence) that will ship without bytes.
export function assetWarnings(uses: AssetUse[], assets: SkiaExportAssets | undefined): string[] {
  const out: string[] = [];
  for (const { asset: a, owners } of uses) {
    const by = owners.length ? ` used by ${owners.join(", ")}` : "";
    if (!assetBytesOf(a.url, assets)) {
      const why = assets?.failed?.[a.url];
      out.push(
        `Asset "${a.id}" (${a.kind}, ${describeUrl(a.url)})${by} was not bundled: ` +
          (why ? `it could not be loaded (${why})` : "the exporter was given no bytes for it (export from the editor or the CLI, which resolve every asset first)") +
          ` — manifest.json lists it and the app draws nothing for it.`
      );
    }
    if (a.license && !assetBytesOf(a.license, assets)) {
      const why = assets?.failed?.[a.license];
      out.push(`The licence of asset "${a.id}" (${a.license})${by} was not bundled${why ? `: ${why}` : ""} — ship it with the app yourself.`);
    }
  }
  return out;
}

// Writes `assets/<file>.b64` (+ licence text) into `files` for every asset
// with bytes and returns the manifest rows, in `uses` order.
export function writeAssetFiles(
  uses: AssetUse[],
  assets: SkiaExportAssets | undefined,
  files: Record<string, string>
): (ManifestAsset & { asset: AssetIR })[] {
  return uses.map(({ asset: a }) => {
    const file = assetFile(a);
    const bytes = assetBytesOf(a.url, assets);
    if (bytes) files[`${file}.b64`] = bytesToBase64(bytes);
    const lic = licenseFile(a);
    const licBytes = lic ? assetBytesOf(a.license, assets) : null;
    if (lic && licBytes) files[lic] = new TextDecoder().decode(licBytes);
    return {
      asset: a,
      id: a.id,
      kind: a.kind,
      mime: a.mime,
      file,
      bundled: !!bytes,
      ...(bytes ? { bytes: bytes.length } : !a.url.startsWith("data:") ? { url: a.url } : {}),
      ...(a.width ? { width: a.width } : {}),
      ...(a.height ? { height: a.height } : {}),
      ...(lic && licBytes ? { license: lic } : {}),
      ...(a.sheet ? { sheet: a.sheet } : {}),
    };
  });
}

// assets.ts: ASSET_SOURCES by IR id — `require()` of each bundled file
// (Metro resolves it; useImage / useFont / useTypeface take the module),
// `null` for an asset that has no bytes (those hooks accept null and the
// drawing stays empty). `what` finishes "Every asset …".
export function assetSourcesModule(header: string, what: string, entries: ManifestAsset[]): string {
  return (
    header +
    `\n// Every asset ${what}, by IR id. Files the exporter had bytes for\n// are in ./assets/; manifest.json lists the rest with their editor URLs.\n` +
    (entries.length
      ? `export const ASSET_SOURCES = {\n${entries
          .map((e) => `  ${JSON.stringify(e.id)}: ${e.bundled ? `require(${JSON.stringify(`./${e.file}`)})` : "null"},`)
          .join("\n")}\n} as const;\n`
      : `export const ASSET_SOURCES = {} as const;\n`)
  );
}

// The manifest row without the AssetIR the emitter keeps beside it.
export function manifestAsset(row: ManifestAsset & { asset?: AssetIR }): ManifestAsset {
  const { asset: _a, ...rest } = row;
  void _a;
  return rest;
}
