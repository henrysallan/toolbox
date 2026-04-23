import type { Edge, Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import type { PaintParamValue } from "@/engine/types";
import { getNodeDef } from "@/engine/registry";
import { withMaskInput } from "@/engine/conventions";

// Bump when the on-wire shape changes. Load path should branch on this.
export const CURRENT_SCHEMA = 1;

export interface SavedNode {
  id: string;
  defType: string;
  position: { x: number; y: number };
  params: Record<string, unknown>;
  exposedParams?: string[];
  active?: boolean;
  bypassed?: boolean;
}

export interface SavedEdge {
  id: string;
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
}

export interface SavedProject {
  schemaVersion: number;
  nodes: SavedNode[];
  edges: SavedEdge[];
}

// --- image helpers -------------------------------------------------------

async function bitmapToDataUrl(bmp: ImageBitmap): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bmp, 0, 0);
  return canvas.toDataURL("image/png");
}

async function dataUrlToBitmap(url: string): Promise<ImageBitmap> {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return createImageBitmap(blob);
}

// --- param serialization -------------------------------------------------

// `paint` and `file` params hold live DOM/ImageBitmap references, which JSON
// can't represent. Swap them to data-URL envelopes going out, and resurrect
// the real runtime values coming back.

async function serializeParams(
  defType: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const def = getNodeDef(defType);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(params)) {
    const p = def?.params.find((x) => x.name === key);
    if (!p) {
      out[key] = val;
      continue;
    }
    if (p.type === "paint") {
      const pv = val as PaintParamValue | null;
      if (pv?.canvas instanceof HTMLCanvasElement) {
        out[key] = {
          kind: "paint",
          dataUrl: pv.canvas.toDataURL("image/png"),
        };
      } else {
        out[key] = null;
      }
    } else if (p.type === "file" && val instanceof ImageBitmap) {
      out[key] = { kind: "file", dataUrl: await bitmapToDataUrl(val) };
    } else if (p.type === "font") {
      // FontFace refs don't survive a page reload — drop custom fonts on
      // save. On load the text node falls back to the `font_family` enum.
      out[key] = null;
    } else if (p.type === "video_file") {
      // Live <video> elements + ObjectURLs can't round-trip through JSON.
      // User re-picks the file on load.
      out[key] = null;
    } else if (p.type === "audio_file") {
      // Same story as video_file — live HTMLAudioElement + ObjectURL
      // don't survive serialization. User re-uploads on reload.
      out[key] = null;
    } else {
      out[key] = val;
    }
  }
  return out;
}

async function deserializeParams(
  defType: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const def = getNodeDef(defType);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(params)) {
    const p = def?.params.find((x) => x.name === key);
    if (!p) {
      out[key] = val;
      continue;
    }
    if (p.type === "paint") {
      const envelope = val as { kind?: string; dataUrl?: string } | null;
      if (envelope?.kind === "paint" && envelope.dataUrl) {
        const canvas = document.createElement("canvas");
        const bmp = await dataUrlToBitmap(envelope.dataUrl);
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        canvas.getContext("2d")?.drawImage(bmp, 0, 0);
        const snapshot = await createImageBitmap(canvas);
        out[key] = { canvas, snapshot } satisfies PaintParamValue;
      } else {
        out[key] = null;
      }
    } else if (p.type === "file") {
      const envelope = val as { kind?: string; dataUrl?: string } | null;
      if (envelope?.kind === "file" && envelope.dataUrl) {
        out[key] = await dataUrlToBitmap(envelope.dataUrl);
      } else {
        out[key] = null;
      }
    } else if (p.type === "font") {
      // Always null on load — user re-uploads the custom font if they need it.
      out[key] = null;
    } else if (p.type === "video_file") {
      out[key] = null;
    } else if (p.type === "audio_file") {
      out[key] = null;
    } else {
      out[key] = val;
    }
  }
  return out;
}

// --- graph round-trip ----------------------------------------------------

export interface ProgressCallback {
  // Fraction is in [0, 1]. Reported after each node finishes processing, so
  // the caller can drive a progress bar without knowing about the internals.
  (fraction: number): void;
}

export async function serializeGraph(
  nodes: Node<NodeDataPayload>[],
  edges: Edge[],
  onProgress?: ProgressCallback
): Promise<SavedProject> {
  // Sequential (not Promise.all) so progress is monotonic and the main
  // thread isn't thrashed decoding many large paint canvases in parallel.
  const total = Math.max(1, nodes.length);
  const savedNodes: SavedNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    savedNodes.push({
      id: n.id,
      defType: n.data.defType,
      position: { x: n.position.x, y: n.position.y },
      params: await serializeParams(n.data.defType, n.data.params),
      exposedParams: n.data.exposedParams,
      active: n.data.active,
      bypassed: n.data.bypassed,
    });
    onProgress?.((i + 1) / total);
  }
  const savedEdges: SavedEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle ?? null,
    target: e.target,
    targetHandle: e.targetHandle ?? null,
  }));
  return {
    schemaVersion: CURRENT_SCHEMA,
    nodes: savedNodes,
    edges: savedEdges,
  };
}

export async function deserializeGraph(
  saved: SavedProject,
  onProgress?: ProgressCallback
): Promise<{
  nodes: Node<NodeDataPayload>[];
  edges: Edge[];
}> {
  const total = Math.max(1, saved.nodes.length);
  const nodes: Node<NodeDataPayload>[] = [];
  for (let i = 0; i < saved.nodes.length; i++) {
    const sn = saved.nodes[i];
    const def = getNodeDef(sn.defType);
    const params = await deserializeParams(sn.defType, sn.params);
    const inputs = def
      ? withMaskInput(def.resolveInputs?.(params) ?? def.inputs).map((inp) => ({
          name: inp.name,
          label: inp.label,
          type: inp.type,
        }))
      : [];
    const auxDefs = def
      ? def.resolveAuxOutputs?.(params) ?? def.auxOutputs
      : [];
    nodes.push({
      id: sn.id,
      type: "effect",
      position: sn.position,
      data: {
        defType: sn.defType,
        params,
        exposedParams: sn.exposedParams ?? [],
        name: def?.name ?? sn.defType,
        inputs,
        auxOutputs: auxDefs.map((a) => ({
          name: a.name,
          type: a.type,
          disabled: a.disabled,
        })),
        primaryOutput:
          def?.resolvePrimaryOutput?.(params) ?? def?.primaryOutput ?? null,
        terminal: def?.terminal,
        active: sn.active ?? !!def?.terminal,
        bypassed: sn.bypassed ?? false,
      },
    } satisfies Node<NodeDataPayload>);
    onProgress?.((i + 1) / total);
  }
  const edges: Edge[] = saved.edges.map((se) => ({
    id: se.id,
    source: se.source,
    sourceHandle: se.sourceHandle ?? undefined,
    target: se.target,
    targetHandle: se.targetHandle ?? undefined,
  }));
  return { nodes, edges };
}

// --- thumbnail -----------------------------------------------------------

// Increment the trailing number on a filename-style string. Preserves the
// digit width of the existing number (so "foo_01" → "foo_02", "foo_99" →
// "foo_100"). No trailing number means we append `_01`.
export function incrementName(name: string): string {
  const trimmed = name.trimEnd();
  const match = trimmed.match(/(\d+)$/);
  if (!match) return `${trimmed}_01`;
  const digits = match[1];
  const next = String(parseInt(digits, 10) + 1).padStart(digits.length, "0");
  return trimmed.slice(0, match.index) + next;
}

export function generateThumbnail(
  canvas: HTMLCanvasElement,
  size = 256
): string | null {
  if (canvas.width === 0 || canvas.height === 0) return null;
  const tmp = document.createElement("canvas");
  const aspect = canvas.width / canvas.height;
  if (aspect >= 1) {
    tmp.width = size;
    tmp.height = Math.max(1, Math.round(size / aspect));
  } else {
    tmp.height = size;
    tmp.width = Math.max(1, Math.round(size * aspect));
  }
  const ctx = tmp.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, tmp.width, tmp.height);
  return tmp.toDataURL("image/jpeg", 0.8);
}
