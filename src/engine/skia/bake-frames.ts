// Skia Bake's live preview frames (specdocs/101326_skia-target.md §3.2,
// the `bake` class). A Skia Bake node turns the ENGINE image wired into it
// into an `image` draw whose asset URL is `bake:<nodeId>`. In the editor
// that asset is the engine's frame right now: the node reads the image back
// (RGBA8, canvas size), makes a CanvasKit image of it, and files it here
// under the AssetIR object its output carries; the Skia Canvas's asset
// resolver (withBakeFrames) hands that image to the scene renderer. At
// export the same URL resolves to the rendered PNG / sprite sheet instead
// (lib/skia-export/bake.ts).
//
// Frames live in the render context's node state (`skia-bake:<nodeId>`, so
// the evaluator's sweep runs the node's dispose and deletes them) and are
// looked up by AssetIR IDENTITY, not by node id: a cached Skia Bake output
// and the frame it was computed with stay paired whichever eval (split
// viewport, compare_renders, an offline pass) computed the node last. Each
// node keeps its last RING frames; older CanvasKit images are deleted when
// a newer frame lands (by then every render that drew them has flushed —
// renders run synchronously inside the eval that computed the node).
//
// The image stays UNPREMULTIPLIED, as CanvasKit (React Native Skia web)
// decodes the PNG the export ships (MakeImageFromEncoded keeps a PNG's
// alpha unpremul): drawn 1:1 the two are byte-identical, and scaled they
// filter alike — a premultiplied copy filters differently wherever alpha
// < 1 (up to 31/255 at 2×, measured in check:skia-bake).

import type { CanvasKit, Image } from "canvaskit-wasm";
import type { RenderContext } from "../types";
import { registerSkiaAssetScheme } from "./asset-bytes";
import type { AssetIR } from "./scene-ir";
import type { SceneAssetResolver } from "./scene-render";

export const SKIA_BAKE_TYPE = "skia-bake";
export const BAKE_URL_PREFIX = "bake:";
// The Skia Bake input the engine image arrives on.
export const BAKE_IMAGE_HANDLE = "in:image";

// The IR asset id of a bake node's frames (scene-emit turns it into a file
// name, so keep it to [A-Za-z0-9_-] where the node id allows).
export function bakeAssetId(nodeId: string): string {
  return `bake_${nodeId}`;
}

export function bakeUrl(nodeId: string): string {
  return `${BAKE_URL_PREFIX}${nodeId}`;
}

// The bake node id behind a `bake:<nodeId>` URL, or null.
export function bakeNodeOfUrl(url: string | undefined | null): string | null {
  return typeof url === "string" && url.startsWith(BAKE_URL_PREFIX) && url.length > BAKE_URL_PREFIX.length
    ? url.slice(BAKE_URL_PREFIX.length)
    : null;
}

// `bake:` on the one URL → bytes seam (asset-bytes.ts). A bake's bytes are
// FRAMES the engine renders at export, so they only exist where a host
// supplies a frame renderer: the export pre-pass (lib/skia-export/editor.ts
// exportSkiaWithBakes, with SkiaExportEnv.renderBakeFrames) answers bake
// URLs itself before any resolver sees them, and the preview draws the
// live frames filed here (withBakeFrames) instead of decoding bytes. Any
// other resolution of a bake URL — a plan, a host with no renderer — lands
// here and fails with the reason, which the export's warning quotes.
registerSkiaAssetScheme("bake", async (asset) => {
  throw new Error(
    `Skia Bake "${bakeNodeOfUrl(asset.url) ?? asset.url}" renders with the engine at export — the editor's Export, export_skia and the CLI render it; this resolution had no frame renderer`
  );
});

// A CanvasKit image of straight-alpha RGBA8 pixels (row 0 = top), kept
// unpremultiplied as a decoded PNG is. Null if CanvasKit refuses.
export function makeBakeImage(kit: CanvasKit, rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Image | null {
  return kit.MakeImage(
    {
      width,
      height,
      alphaType: kit.AlphaType.Unpremul,
      colorType: kit.ColorType.RGBA_8888,
      colorSpace: kit.ColorSpace.SRGB,
    },
    rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    width * 4
  );
}

const RING = 4;

interface BakeState {
  ring: { asset: AssetIR; image: Image }[];
}

function stateKey(nodeId: string): string {
  return `${SKIA_BAKE_TYPE}:${nodeId}`;
}

function stateOf(ctx: RenderContext, nodeId: string, create: boolean): BakeState | undefined {
  const key = stateKey(nodeId);
  let s = ctx.state[key] as BakeState | undefined;
  if (!s && create) ctx.state[key] = s = { ring: [] };
  return s;
}

// File `image` as bake node `nodeId`'s frame for `asset` (the AssetIR
// object its output carries). The ring's oldest image is deleted.
export function registerBakeFrame(ctx: RenderContext, nodeId: string, asset: AssetIR, image: Image): void {
  const ring = stateOf(ctx, nodeId, true)!.ring;
  ring.push({ asset, image });
  while (ring.length > RING) ring.shift()?.image.delete();
}

// The frame filed in `ctx` for exactly this AssetIR object, or null.
export function bakeFrameImage(ctx: RenderContext, asset: AssetIR | undefined): Image | null {
  const id = bakeNodeOfUrl(asset?.url);
  if (!id || !asset) return null;
  const ring = stateOf(ctx, id, false)?.ring ?? [];
  for (let i = ring.length - 1; i >= 0; i--) if (ring[i].asset === asset) return ring[i].image;
  return null;
}

// The node's dispose: delete every frame it filed in `ctx`.
export function releaseBakeFrames(ctx: RenderContext, nodeId: string): void {
  for (const f of stateOf(ctx, nodeId, false)?.ring ?? []) f.image.delete();
  delete ctx.state[stateKey(nodeId)];
}

// A scene asset resolver that answers `bake:` URLs from the frames filed in
// `ctx` and everything else from `base`. A bake asset with no frame is
// unavailable (null): the Skia Canvas lists it as a problem.
export function withBakeFrames(ctx: RenderContext, base: SceneAssetResolver | undefined): SceneAssetResolver {
  return (id, kind, asset) => {
    if (bakeNodeOfUrl(asset?.url)) return kind === "image" ? bakeFrameImage(ctx, asset) : null;
    return base ? base(id, kind, asset) : null;
  };
}
