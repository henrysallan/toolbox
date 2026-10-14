// The async asset pre-pass in front of the synchronous exportSkia
// (specdocs/101326_skia-target.md §3.8 items 2–3, Wave 3 lane I).
//
//   collectSkiaExportAssets(req)   which assets would ship (sync): the SkSL
//                                  Shader planner's image children, or the
//                                  Skia Canvas scene at tick 0 — the same
//                                  scene the planner bundles from
//   resolveSkiaExportAssets(uses)  their bytes (and licence texts) through
//                                  ONE resolver: SkiaExportEnv.resolveAsset,
//                                  default resolveSkiaAssetBytes
//                                  (engine/skia/asset-bytes.ts — registered
//                                  schemes such as lane B's `bake:`, data:,
//                                  fetch)
//   exportSkiaWithAssets(req)      both, then exportSkia({ …req, assets })
//
// exportSkia stays pure and synchronous: it only reads the bytes map. The
// editor (editor.ts), MCP and the CLI (scripts/export-skia.mts, with a
// Node resolver for root-relative paths) all go through
// exportSkiaWithAssets, so every asset a bundle draws has its bytes under
// assets/ — or a warning naming the node that draws it.

import { resolveSkiaAssetBytes, type SkiaAssetResolver } from "@/engine/skia/asset-bytes";
import type { AssetIR, SkiaNode, SkiaScene } from "@/engine/skia/scene-ir";
import { exportSkia, type SkiaExportAssets, type SkiaExportRequest, type SkiaExportResult } from "./api";
import type { AssetUse } from "./asset-bundle";
import { planSkiaExport } from "./plan";
import { makeSceneSampler, SKIA_CANVAS_TYPE } from "./scene-sample";

export type { SkiaAssetResolver } from "@/engine/skia/asset-bytes";

// Every asset id a drawing tree references, with the drawing (SkiaNode id)
// that references it: image / atlas draws, text fonts, image shaders in
// paints, program children and image filters.
export function sceneAssetIds(root: SkiaNode): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const note = (id: unknown, owner: string | undefined) => {
    if (typeof id !== "string") return;
    const set = out.get(id) ?? new Set<string>();
    if (owner) set.add(owner);
    out.set(id, set);
  };
  const visit = (x: unknown, owner: string | undefined, depth: number) => {
    if (depth > 512 || !x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (const c of x) visit(c, owner, depth + 1);
      return;
    }
    const o = x as Record<string, unknown>;
    const own = typeof o.k === "string" && typeof o.id === "string" ? o.id : owner;
    if ((o.k === "image" || o.k === "atlas") && typeof o.asset === "string") note(o.asset, own);
    if (o.k === "text" && o.font && typeof o.font === "object") note((o.font as { asset?: unknown }).asset, own);
    for (const [key, c] of Object.entries(o)) {
      // Binds hold values, never drawings.
      if (key === "v" || key === "ref" || key === "deps") continue;
      visit(c, own, depth + 1);
    }
  };
  visit(root, undefined, 0);
  return out;
}

function sceneUses(scene: SkiaScene, typeOf: (id: string) => string | undefined): AssetUse[] {
  const uses: AssetUse[] = [];
  for (const [id, owners] of sceneAssetIds(scene.root)) {
    const asset = scene.assets?.[id];
    if (!asset) continue;
    uses.push({ asset, owners: [...owners].map((o) => (typeOf(o) ? `${typeOf(o)} "${o}"` : `"${o}"`)) });
  }
  return uses;
}

// What an export of `req` would bundle (sync, pure). Nothing when the
// target can't export — exportSkia then refuses on its own.
export function collectSkiaExportAssets(req: SkiaExportRequest): AssetUse[] {
  const target = req.nodes.find((n) => n.id === req.targetId);
  if (!target) return [];
  const typeOf = (id: string) => req.nodes.find((n) => n.id === id)?.type;
  if (target.type === "sksl-shader") {
    const { plan } = planSkiaExport(req.nodes, req.edges, req.targetId, {
      name: req.name,
      canvas: req.canvas,
      timeline: req.timeline,
    });
    return plan?.assetUses ?? [];
  }
  if (target.type === SKIA_CANVAS_TYPE) {
    const sampler = makeSceneSampler(req.nodes, req.edges, target.id, req.canvas, req.timeline);
    if ("problem" in sampler) return [];
    const scene = sampler.sampleAt(0);
    return scene ? sceneUses(scene, typeOf) : [];
  }
  return [];
}

// The bytes of every asset (and licence) in `uses`, by URL, through one
// resolver. data: URLs are left to the exporter (it decodes them itself).
// Never throws: a URL that fails lands in `failed` with the reason.
export async function resolveSkiaExportAssets(
  uses: AssetUse[],
  resolve: SkiaAssetResolver = resolveSkiaAssetBytes
): Promise<SkiaExportAssets> {
  const want = new Map<string, AssetIR>();
  for (const { asset } of uses) {
    if (asset.url && !asset.url.startsWith("data:")) want.set(asset.url, asset);
    if (asset.license && !asset.license.startsWith("data:") && !want.has(asset.license)) {
      want.set(asset.license, { id: `${asset.id}-license`, kind: asset.kind, mime: "text/plain", url: asset.license });
    }
  }
  const bytes: Record<string, Uint8Array> = {};
  const failed: Record<string, string> = {};
  await Promise.all(
    [...want].map(async ([url, asset]) => {
      try {
        const got = await resolve(asset);
        if (got && got.length) bytes[url] = got;
        else failed[url] = got ? "the file is empty" : "nothing resolved it";
      } catch (e) {
        failed[url] = e instanceof Error ? e.message : String(e);
      }
    })
  );
  return Object.keys(failed).length ? { bytes, failed } : { bytes };
}

// The editor / MCP / CLI export: resolve every asset, then the synchronous
// exportSkia with the bytes in hand.
export async function exportSkiaWithAssets(
  req: SkiaExportRequest,
  resolve: SkiaAssetResolver = resolveSkiaAssetBytes
): Promise<SkiaExportResult> {
  const assets = await resolveSkiaExportAssets(collectSkiaExportAssets(req), resolve);
  return exportSkia({ ...req, assets });
}
