// The saved shape of a project's own asset library (SavedProject.assetLibrary)
// and the walkers the two persistence containers share with it.
//
// The Assets panel has two libraries: Server (the per-user, project-agnostic
// library — state/user-assets.ts + state/node-presets.ts) and Project (this
// one — state/project-library.ts), which travels inside the project. Image
// and SVG bytes ride as ordinary asset envelopes under `params.media`, so the
// .toolbox zip (lib/project-file.ts) and the cloud Storage path
// (lib/supabase/project-assets.ts) dedupe, extract, resolve and keep them
// alive exactly like a node's media — both containers walk
// mediaParamHolders() instead of graph.nodes. A preset's fragment nodes are
// holders too (a fragment can carry inline images).
//
// Pure: no React, no store, no network.

import type { CloudMediaRef } from "@/lib/cloud-media";
import type { SavedNode, SavedProject } from "@/lib/project";

export type ProjectAssetKind = "image" | "svg" | "video" | "preset";

export interface SavedProjectAsset {
  id: string;
  kind: ProjectAssetKind;
  name: string;
  /** Small inline `data:image/…` thumbnail (≤ MAX_THUMB_DATA_URL_CHARS). */
  thumb?: string;
  width?: number;
  height?: number;
  /** Video: seconds. */
  duration?: number;
  /**
   * Image / SVG: `{ media: { kind: "file", dataUrl, filename, mime } }` —
   * an asset envelope the containers extract to a content-hashed ref.
   */
  params?: Record<string, unknown>;
  /** Video: the clip already lives in cloud media (R2); no bytes here. */
  video?: CloudMediaRef & { filename: string; size: number };
  /** Preset: a serializeGraph fragment, as node presets store it. */
  fragment?: SavedProject;
}

const KINDS: ReadonlySet<string> = new Set(["image", "svg", "video", "preset"]);

/** The library's entries, structurally checked (the field is untrusted). */
export function savedLibraryItems(graph: SavedProject): SavedProjectAsset[] {
  const raw = (graph as { assetLibrary?: unknown }).assetLibrary;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is SavedProjectAsset => {
    if (!v || typeof v !== "object") return false;
    const a = v as Record<string, unknown>;
    if (typeof a.id !== "string" || typeof a.name !== "string") return false;
    if (typeof a.kind !== "string" || !KINDS.has(a.kind)) return false;
    if (a.params != null && typeof a.params !== "object") return false;
    if (a.fragment != null) {
      const f = a.fragment as { nodes?: unknown };
      if (typeof f !== "object" || !Array.isArray(f.nodes)) return false;
    }
    return true;
  });
}

/** A params record that may carry binary-media envelopes. */
export interface MediaParamHolder {
  params: Record<string, unknown>;
}

/**
 * Every params record a container must scan for media: the graph's nodes,
 * then the project library's items and their preset fragments' nodes.
 * The returned objects are the graph's own (mutate only a clone — see
 * cloneMediaParamHolders).
 */
export function mediaParamHolders(graph: SavedProject): MediaParamHolder[] {
  const out: MediaParamHolder[] = [...graph.nodes];
  for (const item of savedLibraryItems(graph)) {
    if (item.params) out.push(item as MediaParamHolder);
    for (const n of item.fragment?.nodes ?? []) {
      if (n && typeof n === "object" && n.params) out.push(n);
    }
  }
  return out;
}

function cloneNode(n: SavedNode): SavedNode {
  return { ...n, params: { ...n.params } };
}

/**
 * Shallow-clone the graph down to every params record mediaParamHolders
 * returns, so a container can rewrite envelopes without touching the
 * caller's graph (the multi-MB data-URL strings themselves are shared).
 */
export function cloneMediaParamHolders(graph: SavedProject): SavedProject {
  const out: SavedProject = { ...graph, nodes: graph.nodes.map(cloneNode) };
  const items = savedLibraryItems(graph);
  if (items.length > 0) {
    (out as { assetLibrary?: unknown }).assetLibrary = items.map((item) => ({
      ...item,
      ...(item.params ? { params: { ...item.params } } : {}),
      ...(item.fragment
        ? {
            fragment: {
              ...item.fragment,
              nodes: item.fragment.nodes.map(cloneNode),
            },
          }
        : {}),
    }));
  }
  return out;
}
