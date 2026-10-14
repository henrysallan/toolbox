// The ONE seam between a Skia asset's URL and its bytes
// (specdocs/101326_skia-target.md §3.8 items 2–3, Wave 3 lane I).
//
// Every AssetIR names its bytes by `url` (scene-ir.ts). Two consumers need
// those bytes and both come through here:
//   preview  engine/skia/scene-assets.ts — the Skia Canvas (and any node
//            preview that draws assets) decodes them with CanvasKit;
//   export   lib/skia-export/assets.ts — the editor / MCP / CLI export
//            resolves every asset before calling the synchronous
//            exportSkia, which bundles the bytes under assets/.
//
// What resolveSkiaAssetBytes understands, in order:
//   1. a registered scheme — `registerSkiaAssetScheme("bake", fn)` makes
//      every `bake:<nodeId>` URL resolve through `fn` (lane B's bake node);
//      other lanes register their own the same way;
//   2. `data:` — decoded in place (base64 or percent-encoded), no fetch;
//   3. anything else — `fetch(url)`: project media (`https:` Storage URLs),
//      root-relative editor files (`/fonts/Geist-Regular.ttf`), `blob:`
//      URLs (Image (Skia) hands its bitmap's original file over as one).
// A failure throws with the reason (HTTP status, decode error); callers
// that want `null` catch it. Pure apart from fetch — runs in the editor,
// in Node gates (Node 18+ fetches data: and blob: URLs) and in the CLI,
// which swaps in its own resolver for root-relative paths
// (scripts/skia/node-assets.ts).

import type { AssetIR } from "./scene-ir";

// The seam's signature. `null` = there are no bytes (the caller warns);
// a throw carries the reason.
export type SkiaAssetResolver = (asset: AssetIR) => Promise<Uint8Array | null>;

const schemes = new Map<string, SkiaAssetResolver>();

// `scheme` without the colon ("bake"). Returns an unregister function.
// Registering a scheme again replaces it (module hot reload).
export function registerSkiaAssetScheme(scheme: string, resolve: SkiaAssetResolver): () => void {
  const key = scheme.toLowerCase().replace(/:$/, "");
  schemes.set(key, resolve);
  return () => {
    if (schemes.get(key) === resolve) schemes.delete(key);
  };
}

export function skiaAssetScheme(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

// A `data:` URL's payload as bytes (null when it is not a data URL).
export function dataUrlBytes(url: string): Uint8Array | null {
  const m = /^data:[^,]*?(;base64)?,([\s\S]*)$/.exec(url);
  if (!m) return null;
  if (m[1]) return base64ToBytes(m[2]);
  return new TextEncoder().encode(decodeURIComponent(m[2]));
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}

// The default resolver (see the header): registered schemes, data:, fetch.
export async function resolveSkiaAssetBytes(asset: AssetIR): Promise<Uint8Array | null> {
  const url = asset.url;
  if (typeof url !== "string" || !url) return null;
  const scheme = skiaAssetScheme(url);
  const custom = scheme ? schemes.get(scheme) : undefined;
  if (custom) return custom(asset);
  if (scheme === "data") return dataUrlBytes(url);
  if (typeof fetch !== "function") throw new Error("no fetch in this environment");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
  return new Uint8Array(await res.arrayBuffer());
}
