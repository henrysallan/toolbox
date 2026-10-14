// Editor-side asset loading for the Skia Canvas node: a SceneAssetResolver
// (scene-render.ts) backed by the URLs in each AssetIR. Bytes come through
// the one URL → bytes seam (asset-bytes.ts: registered schemes such as
// `bake:`, data:, fetch — the exporter resolves through the same function).
// Images are decoded once by CanvasKit; fonts are kept as bytes (the
// renderer builds and caches the typeface). Loading is asynchronous while the engine
// is not, so a first request answers "pending" (undefined), and when the
// bytes land the generation counter moves and a `pipeline-bump` re-runs the
// graph — the node folds sceneAssetGeneration() into its fingerprint so the
// placeholder frame is not served from cache (the canvaskit.ts pattern).
//
// Keyed by URL, not asset id: two scenes naming the same file share one
// decode. Entries live for the session; a project's asset set is small.

import type { CanvasKit, Image } from "canvaskit-wasm";
import { resolveSkiaAssetBytes } from "./asset-bytes";
import type { AssetIR } from "./scene-ir";
import type { SceneAssetResolver } from "./scene-render";

type Entry =
  | { state: "loading" }
  | { state: "ready"; image?: Image; bytes?: ArrayBuffer }
  | { state: "error"; error: string };

const entries = new Map<string, Entry>();
let generation = 0;
// Loads in flight, for sceneAssetsSettled().
const inflight = new Set<Promise<void>>();

export function sceneAssetGeneration(): number {
  return generation;
}

// The reason an asset failed, for the node's problem list.
export function sceneAssetError(asset: AssetIR | undefined): string | null {
  const e = asset?.url ? entries.get(asset.url) : undefined;
  return e?.state === "error" ? e.error : null;
}

function landed(): void {
  generation++;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("pipeline-bump"));
}

// Resolves once nothing is loading (harnesses that render frames back to
// back wait on it before a frame that draws a not-yet-landed asset).
export async function sceneAssetsSettled(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}

function load(kit: CanvasKit, asset: AssetIR, kind: "image" | "font"): void {
  const url = asset.url;
  entries.set(url, { state: "loading" });
  const p = (async () => {
    try {
      const got = await resolveSkiaAssetBytes(asset);
      if (!got) throw new Error("no bytes for this URL");
      // A copy that owns its buffer (CanvasKit and FontMgr take ArrayBuffers).
      const bytes = got.slice().buffer;
      if (kind === "font") {
        entries.set(url, { state: "ready", bytes });
      } else {
        const image = kit.MakeImageFromEncoded(bytes);
        if (!image) throw new Error("CanvasKit could not decode the image");
        entries.set(url, { state: "ready", image });
      }
    } catch (err) {
      entries.set(url, { state: "error", error: err instanceof Error ? err.message : String(err) });
    }
    landed();
  })();
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

export function makeSceneAssetResolver(kit: CanvasKit): SceneAssetResolver {
  return (id, kind, asset) => {
    if (!asset?.url) return null;
    const e = entries.get(asset.url);
    if (!e) {
      if (typeof fetch !== "function" && !asset.url.startsWith("data:")) return null;
      load(kit, asset, kind);
      return undefined;
    }
    switch (e.state) {
      case "loading":
        return undefined;
      case "error":
        return null;
      case "ready":
        return kind === "font" ? (e.bytes ?? null) : (e.image ?? null);
    }
  };
}
