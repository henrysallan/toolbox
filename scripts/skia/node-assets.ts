// The asset seam's Node resolver (engine/skia/asset-bytes.ts SkiaAssetResolver)
// for the CLI (scripts/export-skia.mts) and the Node gates: what the editor
// fetches, read from disk instead.
//
//   /fonts/Geist-Regular.ttf   root-relative editor paths → public/<path>
//   data:, blob:               the default resolver (Node 18+ fetches both)
//   file:// URLs               read from disk
//   http(s):                   fetched only with `remote: true` (the CLI's
//                              --fetch); otherwise left unresolved, so the
//                              export warns exactly as an export given no
//                              bytes does
//
// nodeAssetFilter tells which URLs this resolver handles at all; the callers
// resolve only those (resolveSkiaExportAssets marks a URL it TRIED and
// failed as failed, with the reason).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSkiaAssetBytes, skiaAssetScheme, type SkiaAssetResolver } from "@/engine/skia/asset-bytes";
import type { AssetIR } from "@/engine/skia/scene-ir";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC = path.join(ROOT, "public");

export interface NodeAssetOptions {
  // Fetch http(s) URLs too (default off: gates and the CLI stay offline).
  remote?: boolean;
}

export function nodeAssetHandles(url: string, opts: NodeAssetOptions = {}): boolean {
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  const scheme = skiaAssetScheme(url);
  if (scheme === "data" || scheme === "blob" || scheme === "file") return true;
  if (scheme === "http" || scheme === "https") return !!opts.remote;
  // A registered scheme (bake:…) resolves through the default resolver.
  return scheme !== null;
}

export function nodeResolveAsset(opts: NodeAssetOptions = {}): SkiaAssetResolver {
  return async (asset: AssetIR) => {
    const url = asset.url;
    if (url.startsWith("/") && !url.startsWith("//")) {
      const file = path.resolve(PUBLIC, `.${decodeURIComponent(url.split(/[?#]/)[0])}`);
      if (!file.startsWith(PUBLIC + path.sep)) throw new Error(`${url} leaves public/`);
      if (!fs.existsSync(file)) throw new Error(`public${url} does not exist`);
      return new Uint8Array(fs.readFileSync(file));
    }
    if (skiaAssetScheme(url) === "file") return new Uint8Array(fs.readFileSync(fileURLToPath(url)));
    if (!nodeAssetHandles(url, opts)) return null;
    return resolveSkiaAssetBytes(asset);
  };
}
