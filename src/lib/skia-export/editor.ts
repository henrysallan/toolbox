// The editor + MCP half of "Export for React Native Skia…"
// (specdocs/101326_skia-target.md §3.7). Resolves what was clicked (an SkSL
// Shader, a Skia Canvas, or a Skia layer) to the export target, flattens the
// editor graph the way the evaluator does, builds the frozen
// SkiaExportRequest, and maps the result onto zip entries. Pure — no DOM, no
// GL — so check-skia-layer covers it; EffectsApp adds the download and
// mcp-handlers.ts the replies.

import type { Edge } from "@xyflow/react";
import type { GraphEdge, GraphNode as EngineNode } from "@/engine/evaluator";
import { flattenGraph } from "@/engine/flatten";
import { LAYER_TYPE } from "@/engine/groups";
import { DEFAULT_TICKS_PER_FRAME } from "@/engine/keyframes";
import { getNodeDef } from "@/engine/registry";
import {
  readLayerTarget,
  SKIA_EXPORT_TARGET_TYPES,
} from "@/engine/skia/layer-target";
import type { GraphNode } from "@/state/graph-ops";
import { exportSkia, type SkiaExportRequest, type SkiaExportResult } from "./api";
import { planSkiaExport } from "./plan";
import { TOOLBOX_TIMELINE_SOURCE } from "./runtime.generated";

export interface SkiaExportEnv {
  // The composition canvas in px.
  canvas: { width: number; height: number };
  fps: number;
  // Scene length in frames (the timeline's loop length).
  frames: number;
  // Defaults to the generated runtime module; the gate passes the file on
  // disk to prove the two agree.
  runtimeSource?: string;
}

export interface SkiaExportNodeRef {
  id: string;
  type: string;
  name: string;
}

export interface PreparedSkiaExport {
  // Null when `problems` says why nothing can be exported.
  request: SkiaExportRequest | null;
  clicked: SkiaExportNodeRef | null;
  // What exports: the clicked node, or the producer feeding a Skia layer's
  // Layer Output.
  target: SkiaExportNodeRef | null;
  // The layer the target sits in, if any.
  layer: { id: string; name: string; target: "default" | "skia" } | null;
  problems: string[];
  warnings: string[];
}

const TARGET_HINT =
  "export targets are SkSL Shader and Skia Canvas nodes, or a Skia layer whose Layer Output one of them feeds";

function refOf(n: GraphNode): SkiaExportNodeRef {
  return {
    id: n.id,
    type: n.data.defType,
    name: n.data.name || getNodeDef(n.data.defType)?.name || n.data.defType,
  };
}

// Editor nodes → the engine graph, with EffectsApp.renderFrame's handle
// defaults, so the flatten below sees exactly what the preview evaluates.
function toEngineGraph(
  nodes: GraphNode[],
  edges: Edge[]
): { nodes: EngineNode[]; edges: GraphEdge[] } {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.defType,
      parentId: n.data.parentId,
      params: n.data.params,
      exposedParams: n.data.exposedParams,
      animation: n.data.animation,
      clips: n.data.clips,
      bypassed: !!n.data.bypassed,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? "out:primary",
      target: e.target,
      targetHandle: e.targetHandle ?? "in:image",
    })),
  };
}

export function prepareSkiaExport(
  nodes: GraphNode[],
  edges: Edge[],
  clickedId: string,
  env: SkiaExportEnv
): PreparedSkiaExport {
  const problems: string[] = [];
  const warnings: string[] = [];
  const empty = (clicked: SkiaExportNodeRef | null): PreparedSkiaExport => ({
    request: null,
    clicked,
    target: null,
    layer: null,
    problems,
    warnings,
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const clickedNode = byId.get(clickedId);
  if (!clickedNode) {
    problems.push(`No node "${clickedId}" in the graph.`);
    return empty(null);
  }
  const clicked = refOf(clickedNode);
  const graph = toEngineGraph(nodes, edges);
  const flat = flattenGraph(graph.nodes, graph.edges);

  let targetNode: GraphNode | undefined;
  if (clicked.type === LAYER_TYPE) {
    if (readLayerTarget(clickedNode.data.params) !== "skia") {
      problems.push(
        `"${clicked.name}" is a default layer — set its Target to Skia to export it, or export the SkSL Shader inside it directly.`
      );
      return empty(clicked);
    }
    // Flatten rewires the Layer Output's image onto the layer's hidden
    // `content` input, through any reroutes / nested groups.
    const into = flat.edges.find(
      (e) => e.target === clicked.id && e.targetHandle === "in:content"
    );
    targetNode = into ? byId.get(into.source) : undefined;
    if (!targetNode) {
      problems.push(
        `Skia layer "${clicked.name}" has nothing wired into its Layer Output's image — ${TARGET_HINT}.`
      );
      return empty(clicked);
    }
    if (!SKIA_EXPORT_TARGET_TYPES.has(targetNode.data.defType)) {
      const t = refOf(targetNode);
      problems.push(
        `Skia layer "${clicked.name}" renders ${t.name} (${t.type}, ${t.id}) — ${TARGET_HINT}.`
      );
      return empty(clicked);
    }
  } else if (SKIA_EXPORT_TARGET_TYPES.has(clicked.type)) {
    targetNode = clickedNode;
  } else {
    problems.push(`"${clicked.name}" is a ${clicked.type} — ${TARGET_HINT}.`);
    return empty(clicked);
  }

  const target = refOf(targetNode);
  if (!flat.nodes.some((n) => n.id === target.id)) {
    problems.push(
      `${target.name} (${target.id}) sits inside a Repeat / For Each / Iterate zone, which evaluates privately — move it out of the zone to export it.`
    );
    return empty(clicked);
  }
  if (targetNode.data.bypassed) {
    warnings.push(
      `${target.name} is bypassed in the editor — the export ships it as if it were on.`
    );
  }

  let layer: PreparedSkiaExport["layer"] = null;
  const layerId = flat.layerOf.get(target.id);
  const layerNode = layerId ? byId.get(layerId) : undefined;
  if (layerNode) {
    layer = {
      id: layerNode.id,
      name: layerNode.data.name || "Layer",
      target: readLayerTarget(layerNode.data.params),
    };
    // A layer's in/out bar sets its interior's local clock (evaluator
    // layerOffsets). The export plays the interior on that local clock
    // from 0, which is what an app embeds — say so when they differ.
    const windows = (layerNode.data.clips ?? []).filter((c) => c.enabled);
    const offset = windows.length ? windows[0].inTick - windows[0].sourceInTick : 0;
    if (windows.length > 1) {
      warnings.push(
        `Layer "${layer.name}" has ${windows.length} clip windows — the export plays its interior once on the layer's own clock, not the windows.`
      );
    } else if (offset !== 0) {
      const frames = Math.round((offset / DEFAULT_TICKS_PER_FRAME) * 100) / 100;
      warnings.push(
        `Layer "${layer.name}" starts at frame ${frames} of the composition — the export plays its interior from the layer's own frame 0.`
      );
    }
  }

  const name = clicked.type === LAYER_TYPE ? clicked.name : target.name;
  const request: SkiaExportRequest = {
    nodes: flat.nodes,
    edges: flat.edges,
    targetId: target.id,
    name,
    canvas: { width: env.canvas.width, height: env.canvas.height },
    timeline: {
      fps: env.fps,
      ticksPerFrame: DEFAULT_TICKS_PER_FRAME,
      sceneDurationTicks: Math.max(1, Math.round(env.frames)) * DEFAULT_TICKS_PER_FRAME,
    },
    runtimeSource: env.runtimeSource ?? TOOLBOX_TIMELINE_SOURCE,
  };
  return { request, clicked, target, layer, problems, warnings };
}

export interface EditorSkiaExport {
  prepared: PreparedSkiaExport;
  result: SkiaExportResult;
}

// An exporter that throws (a branch meeting a graph it doesn't expect)
// reports like any other refusal instead of escaping into the UI / MCP.
function safeExport(req: SkiaExportRequest): SkiaExportResult {
  try {
    return exportSkia(req);
  } catch (e) {
    return {
      files: null,
      problems: [`The exporter failed: ${(e as Error)?.message ?? String(e)}`],
      warnings: [],
    };
  }
}

// prepare + exportSkia. The prepare step's warnings ride ahead of the
// exporter's own.
export function exportSkiaFromEditor(
  nodes: GraphNode[],
  edges: Edge[],
  clickedId: string,
  env: SkiaExportEnv
): EditorSkiaExport {
  const prepared = prepareSkiaExport(nodes, edges, clickedId, env);
  if (!prepared.request) {
    return {
      prepared,
      result: { files: null, problems: prepared.problems, warnings: prepared.warnings },
    };
  }
  const r = safeExport(prepared.request);
  return {
    prepared,
    result: {
      files: r.files,
      problems: r.problems,
      warnings: [...prepared.warnings, ...r.warnings],
    },
  };
}

// ---- plan summary (MCP plan_skia_export) -------------------------------------

export interface SkiaPlanSummary {
  ok: boolean;
  clicked: SkiaExportNodeRef | null;
  target: SkiaExportNodeRef | null;
  layer: PreparedSkiaExport["layer"];
  problems: string[];
  warnings: string[];
  canvas?: { width: number; height: number };
  timeline?: { fps: number; ticksPerFrame: number; durationTicks: number; frames: number; seconds: number };
  usesTime?: boolean;
  // SkSL Shader targets: one row per uniform the program declares.
  uniforms?: {
    name: string;
    kind: string;
    animated: boolean;
    from: string;
    value?: number | number[];
    keys?: number;
    // First / last keyframe, in frames.
    frames?: [number, number];
  }[];
  // Any other target: what exportSkia would write, plus its manifest.
  files?: string[];
  manifest?: unknown;
}

// Read-only: what an export of `clickedId` would ship, or why it can't.
// SkSL Shader targets go through planSkiaExport directly (uniforms,
// provenance, keys); every other target through exportSkia, so the scene
// exporter's branch (Skia Canvas) reports here as soon as it lands.
export function planSkiaExportForEditor(
  nodes: GraphNode[],
  edges: Edge[],
  clickedId: string,
  env: SkiaExportEnv
): SkiaPlanSummary {
  const prepared = prepareSkiaExport(nodes, edges, clickedId, env);
  const base = {
    clicked: prepared.clicked,
    target: prepared.target,
    layer: prepared.layer,
  };
  const req = prepared.request;
  if (!req) {
    return { ok: false, ...base, problems: prepared.problems, warnings: prepared.warnings };
  }
  const tpf = req.timeline.ticksPerFrame;
  const timeline = {
    fps: req.timeline.fps,
    ticksPerFrame: tpf,
    durationTicks: req.timeline.sceneDurationTicks,
    frames: req.timeline.sceneDurationTicks / tpf,
    seconds: req.timeline.sceneDurationTicks / (tpf * req.timeline.fps),
  };
  if (prepared.target?.type === "sksl-shader") {
    const { plan, problems } = planSkiaExport(req.nodes, req.edges, req.targetId, {
      name: req.name,
      canvas: req.canvas,
      timeline: req.timeline,
    });
    const warnings = [...prepared.warnings, ...(plan?.warnings ?? [])];
    if (!plan) return { ok: false, ...base, problems, warnings, canvas: req.canvas, timeline };
    return {
      ok: true,
      ...base,
      problems: [],
      warnings,
      canvas: plan.canvas,
      timeline,
      usesTime: plan.usesTime,
      uniforms: plan.uniforms.map((u) => {
        const keys = u.track?.keys ?? [];
        return {
          name: u.name,
          kind: u.kind,
          animated: !!u.track,
          from: u.from,
          ...(u.value !== undefined ? { value: u.value } : {}),
          ...(keys.length
            ? {
                keys: keys.length,
                frames: [keys[0].tick / tpf, keys[keys.length - 1].tick / tpf] as [number, number],
              }
            : {}),
        };
      }),
    };
  }
  const r = safeExport(req);
  const warnings = [...prepared.warnings, ...r.warnings];
  if (!r.files) return { ok: false, ...base, problems: r.problems, warnings, canvas: req.canvas, timeline };
  let manifest: unknown;
  try {
    manifest = r.files["manifest.json"] ? JSON.parse(r.files["manifest.json"]) : undefined;
  } catch {
    manifest = undefined;
  }
  return {
    ok: true,
    ...base,
    problems: [],
    warnings,
    canvas: req.canvas,
    timeline,
    files: Object.keys(r.files).sort(),
    ...(manifest !== undefined ? { manifest } : {}),
  };
}

// ---- bundle → zip ------------------------------------------------------------------

// Folder / file stem for a bundle: the export's name, lower-kebab, ASCII.
export function skiaBundleSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "toolbox-effect";
}

export interface SkiaZipEntry {
  path: string;
  // Exactly one of the two.
  text?: string;
  bytes?: Uint8Array;
}

function decodeBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The bundle's files as zip entries under `folder/`. Binary assets ride
// through SkiaExportResult as base64 text at `assets/<name>.b64` (api.ts);
// they land decoded at `assets/<name>`.
export function skiaZipEntries(files: Record<string, string>, folder: string): SkiaZipEntry[] {
  const prefix = folder ? `${folder.replace(/\/+$/, "")}/` : "";
  return Object.keys(files)
    .sort()
    .map((path) => {
      if (path.startsWith("assets/") && path.endsWith(".b64")) {
        return { path: prefix + path.slice(0, -".b64".length), bytes: decodeBase64(files[path]) };
      }
      return { path: prefix + path, text: files[path] };
    });
}

// "blob" for the editor's download, "uint8array" where there is no Blob
// support (the Node gate).
export async function buildSkiaZip(entries: SkiaZipEntry[], type: "blob"): Promise<Blob>;
export async function buildSkiaZip(entries: SkiaZipEntry[], type: "uint8array"): Promise<Uint8Array>;
export async function buildSkiaZip(
  entries: SkiaZipEntry[],
  type: "blob" | "uint8array"
): Promise<Blob | Uint8Array> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  for (const e of entries) zip.file(e.path, e.bytes ?? e.text ?? "");
  return type === "blob"
    ? zip.generateAsync({ type: "blob", mimeType: "application/zip" })
    : zip.generateAsync({ type: "uint8array" });
}

// The last export attempt, as the param panel lists it under the export
// button (EffectsApp keeps one; it applies to `nodeId` only).
export interface SkiaExportReport {
  nodeId: string;
  ok: boolean;
  problems: string[];
  warnings: string[];
  // File count of a successful export.
  files?: number;
}
