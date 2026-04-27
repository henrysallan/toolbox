import type { SavedProject } from "@/lib/project";
import type { ExportManifest } from "@/lib/live-viewer/manifest-types";

async function readJson<T>(scriptId: string, filename: string): Promise<T> {
  const el = document.getElementById(scriptId);
  if (el && el.textContent) {
    try {
      return JSON.parse(el.textContent) as T;
    } catch (err) {
      throw new Error(
        `Failed to parse inlined ${scriptId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  try {
    const resp = await fetch(`./${filename}`);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return (await resp.json()) as T;
  } catch (err) {
    throw new Error(
      `No inlined <script id="${scriptId}"> and ./${filename} fetch failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

export interface ExportData {
  graph: SavedProject;
  manifest: ExportManifest;
}

export async function loadData(): Promise<ExportData> {
  const [graph, manifest] = await Promise.all([
    readJson<SavedProject>("export-graph", "graph.json"),
    readJson<ExportManifest>("export-manifest", "manifest.json"),
  ]);
  return { graph, manifest };
}
