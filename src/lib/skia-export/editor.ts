// The editor + MCP half of "Export for React Native Skia…"
// (specdocs/101326_skia-target.md §3.7). Resolves what was clicked (an SkSL
// Shader, a Skia Canvas, or a Skia layer) to the export target, flattens the
// editor graph the way the evaluator does, builds the frozen
// SkiaExportRequest, resolves its assets, and maps the result onto zip
// entries. No DOM, no GL — so check-skia-layer covers it; EffectsApp adds
// the download and mcp-handlers.ts the replies.
//
// ---- Assets: the URL → bytes seam (Wave 3 lane I) --------------------------
//
// exportSkia (api.ts) is synchronous and pure, so asset bytes are resolved
// BEFORE it runs, by exportSkiaFromEditor / planSkiaExportForEditor (both
// async since then):
//
//   collectSkiaExportAssets(request)  every AssetIR the bundle will draw
//                                     (lib/skia-export/assets.ts)
//   env.resolveAsset(asset)           its bytes — ONE function for every
//                                     URL kind; default
//                                     resolveSkiaAssetBytes
//                                     (engine/skia/asset-bytes.ts)
//   exportSkia({ …request, assets })  bundles them at assets/<file>
//                                     (base64 `.b64` in `files`; the zip
//                                     writer below decodes them), lists
//                                     every asset in manifest.json with its
//                                     size and `bundled`, and warns — naming
//                                     the node — for any it has no bytes for
//
//   type SkiaAssetResolver = (asset: AssetIR) => Promise<Uint8Array | null>
//
// The default understands registered schemes first, then data:, then fetch
// (project media https: URLs, `/fonts/…`, `blob:`). To add a URL kind, either
// register a scheme — `registerSkiaAssetScheme("bake", (a) => …)` makes
// every `bake:<nodeId>` URL resolve through it, in the preview's asset
// loader (engine/skia/scene-assets.ts) and in every export alike — or pass
// `resolveAsset` here to override resolution for one export (it receives
// every AssetIR, licence texts included as `{ url: asset.license }`).
// Fonts are AssetIRs too (nodes/skia/fonts.ts): their files and licence
// texts (`AssetIR.license`) ship through the same path.

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
import type { TimelineMarker } from "@/lib/timeline-markers";
import { base64ToBytes, resolveSkiaAssetBytes, type SkiaAssetResolver } from "@/engine/skia/asset-bytes";
import { bakeNodeOfUrl } from "@/engine/skia/bake-frames";
import { exportSkia, type SkiaExportRequest, type SkiaExportResult } from "./api";
import { assetBytesOf } from "./asset-bundle";
import { collectSkiaExportAssets, resolveSkiaExportAssets } from "./assets";
import {
  cachingBakeRenderer,
  makeBakeAssetResolver,
  withBakeModes,
  type BakeFrameRenderer,
  type BakeMode,
  type BakeReport,
} from "./bake";
import { planSkiaExport } from "./plan";
import { TOOLBOX_TIMELINE_SOURCE } from "./runtime.generated";
import { exportSegments, type ExportSegment } from "./segments";

import type { SkiaAnimationMode } from "./animation-modes";
export { SKIA_ANIMATION_MODES, isSkiaAnimationMode, type SkiaAnimationMode } from "./animation-modes";

export interface SkiaExportEnv {
  // The composition canvas in px.
  canvas: { width: number; height: number };
  fps: number;
  // Scene length in frames (the timeline's loop length).
  frames: number;
  // The active composition's timeline markers (composition frames) — the
  // bundle's SEGMENTS. Shifted onto a late layer's own clock below.
  markers?: readonly TimelineMarker[];
  // Defaults to the generated runtime module; the gate passes the file on
  // disk to prove the two agree.
  runtimeSource?: string;
  // Default "worklet".
  animation?: SkiaAnimationMode;
  // URL → bytes for every asset the bundle ships (see the header). Default
  // resolveSkiaAssetBytes: registered schemes, data:, fetch.
  resolveAsset?: SkiaAssetResolver;
  // The host's real-engine frame renderer for Skia Bake (EffectsApp's
  // renderSkiaBakeFrames, the CLI's Electron harness): `bake:` URLs resolve
  // through it in exportSkiaFromEditor's asset pre-pass (lib/skia-export/
  // bake.ts makeBakeAssetResolver), ahead of `resolveAsset`. Without it a
  // bake falls to the registered `bake` scheme, which says why it can't.
  // Additive (Wave 3 lane B).
  renderBakeFrames?: BakeFrameRenderer;
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
  // The exported clock's tick 0 on the composition clock (a late layer's
  // in-point): where a Skia Bake renders its engine frames. Additive.
  clockOffsetTicks?: number;
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
  // Composition frames → the exported clock's frames (a late layer's local
  // clock starts at its in-point).
  let markerShiftFrames = 0;
  let clockOffsetTicks = 0;
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
    clockOffsetTicks = offset;
    if (windows.length > 1) {
      warnings.push(
        `Layer "${layer.name}" has ${windows.length} clip windows — the export plays its interior once on the layer's own clock, not the windows.`
      );
    } else if (offset !== 0) {
      const frames = Math.round((offset / DEFAULT_TICKS_PER_FRAME) * 100) / 100;
      markerShiftFrames = offset / DEFAULT_TICKS_PER_FRAME;
      warnings.push(
        `Layer "${layer.name}" starts at frame ${frames} of the composition — the export plays its interior from the layer's own frame 0.` +
          (env.markers?.length ? ` Timeline markers shift by −${frames} frames onto that clock.` : "")
      );
    }
  }
  const markers = env.markers?.length
    ? markerShiftFrames
      ? env.markers.map((m) => ({ ...m, frame: m.frame - markerShiftFrames }))
      : [...env.markers]
    : undefined;

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
      ...(markers ? { markers } : {}),
    },
    runtimeSource: env.runtimeSource ?? TOOLBOX_TIMELINE_SOURCE,
    ...(env.animation && env.animation !== "worklet" ? { animation: env.animation } : {}),
  };
  return { request, clicked, target, layer, clockOffsetTicks, problems, warnings };
}

export interface EditorSkiaExport {
  prepared: PreparedSkiaExport;
  result: SkiaExportResult;
  // Every Skia Bake the export rendered: what shipped (one PNG / a sheet),
  // frames, distinct frames, PNG bytes. Additive (Wave 3 lane B).
  bakes?: BakeReport[];
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

// The request with every asset's bytes resolved (the async pre-pass in
// front of the synchronous exportSkia — see the header).
export async function withSkiaAssets(req: SkiaExportRequest, resolve?: SkiaAssetResolver): Promise<SkiaExportRequest> {
  let uses;
  try {
    uses = collectSkiaExportAssets(req);
  } catch {
    // The exporter itself will report what broke.
    return req;
  }
  if (!uses.length) return req;
  return { ...req, assets: await resolveSkiaExportAssets(uses, resolve ?? resolveSkiaAssetBytes) };
}

// prepare + asset pre-pass + exportSkia. The prepare step's warnings ride
// ahead of the exporter's own.
export async function exportSkiaFromEditor(
  nodes: GraphNode[],
  edges: Edge[],
  clickedId: string,
  env: SkiaExportEnv
): Promise<EditorSkiaExport> {
  const prepared = prepareSkiaExport(nodes, edges, clickedId, env);
  if (!prepared.request) {
    return {
      prepared,
      result: { files: null, problems: prepared.problems, warnings: prepared.warnings },
    };
  }
  const r = await exportSkiaWithBakes(prepared.request, env, { clockOffsetTicks: prepared.clockOffsetTicks });
  return {
    prepared,
    result: { ...r.result, warnings: [...prepared.warnings, ...r.result.warnings] },
    ...(r.bakes ? { bakes: r.bakes } : {}),
  };
}

// The asset pre-pass + exportSkia for a ready request, with Skia Bake
// (lib/skia-export/bake.ts): `bake:` URLs render through the host's engine
// (env.renderBakeFrames) inside the same pre-pass — the resolver handed to
// withSkiaAssets answers them first and passes every other URL to
// env.resolveAsset (default resolveSkiaAssetBytes). A bake on Auto whose
// rendered frames contradict the graph's verdict (a "static" one whose
// probe frames move, an "animated" one whose frames are all identical) is
// exported once more in the mode the frames show — the renders are cached,
// nothing draws twice. The editor (above), MCP and the CLI call this.
// `clockOffsetTicks`: the exported clock's tick 0 on the composition clock.
export async function exportSkiaWithBakes(
  request: SkiaExportRequest,
  env: Pick<SkiaExportEnv, "resolveAsset" | "renderBakeFrames">,
  opts: { clockOffsetTicks?: number } = {}
): Promise<{ result: SkiaExportResult; bakes?: BakeReport[] }> {
  let req = request;
  const render = env.renderBakeFrames ? cachingBakeRenderer(env.renderBakeFrames) : null;
  const flips = new Map<string, BakeMode>();
  const flipNotes: string[] = [];
  for (let round = 0; ; round++) {
    const bake = render
      ? makeBakeAssetResolver({
          nodes: req.nodes,
          edges: req.edges,
          timeline: req.timeline,
          canvas: req.canvas,
          clockOffsetTicks: opts.clockOffsetTicks,
          render,
        })
      : null;
    const base = env.resolveAsset ?? resolveSkiaAssetBytes;
    const resolve: SkiaAssetResolver = bake ? (a) => (bakeNodeOfUrl(a.url) ? bake.resolveAsset(a) : base(a)) : base;
    const r = safeExport(await withSkiaAssets(req, resolve));
    const reports = bake?.reports() ?? [];
    const flipped = round === 0 && r.files ? reports.filter((x) => x.flip) : [];
    if (flipped.length) {
      for (const f of flipped) {
        flips.set(f.nodeId, f.flip!);
        flipNotes.push(
          `Skia Bake "${f.nodeId}": Auto read the graph as ${f.shipped}, but the rendered frames ${
            f.flip === "static" ? `are all identical (${f.frames} frames)` : "change over the timeline"
          } — shipped as ${f.flip === "static" ? "one PNG" : "a sprite sheet"}.`
        );
      }
      req = { ...req, nodes: withBakeModes(req.nodes, flips) };
      continue;
    }
    const bakeProblems = bake?.problems() ?? [];
    const warnings = [...r.warnings, ...flipNotes, ...(bake?.warnings() ?? [])];
    // A bake that could not render refuses the export: a hole in the scene
    // is not what the editor showed.
    if (bakeProblems.length) return { result: { files: null, problems: [...bakeProblems, ...r.problems], warnings } };
    return {
      result: { files: r.files, problems: r.problems, warnings },
      ...(reports.length ? { bakes: reports.map((x) => (flips.has(x.nodeId) ? { ...x, requested: "auto" as const } : x)) } : {}),
    };
  }
}

// ---- plan summary (MCP plan_skia_export) -------------------------------------

export interface SkiaPlanSummary {
  ok: boolean;
  clicked: SkiaExportNodeRef | null;
  target: SkiaExportNodeRef | null;
  layer: PreparedSkiaExport["layer"];
  problems: string[];
  warnings: string[];
  // The timeline shape this plan is for.
  animation: SkiaAnimationMode;
  canvas?: { width: number; height: number };
  timeline?: { fps: number; ticksPerFrame: number; durationTicks: number; frames: number; seconds: number };
  // The bundle's SEGMENTS (seconds + frames on the exported clock).
  segments?: ExportSegment[];
  usesTime?: boolean;
  // SkSL Shader targets: one row per uniform the program declares.
  uniforms?: {
    name: string;
    kind: string;
    animated: boolean;
    // A procedural driver compiled to a worklet of the tick (spec §3.5e).
    procedural?: boolean;
    from: string;
    value?: number | number[];
    keys?: number;
    // First / last keyframe, in frames.
    frames?: [number, number];
  }[];
  // SkSL Shader targets: the child shaders (iImage images, ramp / curve
  // LUTs) in declaration order, and whether each image's bytes resolved.
  children?: { name: string; kind: string; from: string; asset?: string; bundled?: boolean }[];
  // Any other target: what exportSkia would write, plus its manifest.
  files?: string[];
  manifest?: unknown;
}

// Read-only: what an export of `clickedId` would ship, or why it can't.
// SkSL Shader targets go through planSkiaExport directly (uniforms,
// provenance, keys); every other target through exportSkia, so the scene
// exporter's branch (Skia Canvas) reports here as soon as it lands.
export async function planSkiaExportForEditor(
  nodes: GraphNode[],
  edges: Edge[],
  clickedId: string,
  env: SkiaExportEnv
): Promise<SkiaPlanSummary> {
  const prepared = prepareSkiaExport(nodes, edges, clickedId, env);
  const animation: SkiaAnimationMode = env.animation ?? "worklet";
  const base = {
    clicked: prepared.clicked,
    target: prepared.target,
    layer: prepared.layer,
    animation,
  };
  if (!prepared.request) {
    return { ok: false, ...base, problems: prepared.problems, warnings: prepared.warnings };
  }
  // The export's own asset pre-pass, so the plan's warnings name every asset
  // that would ship without bytes.
  const req = await withSkiaAssets(prepared.request, env.resolveAsset);
  const tpf = req.timeline.ticksPerFrame;
  const timeline = {
    fps: req.timeline.fps,
    ticksPerFrame: tpf,
    durationTicks: req.timeline.sceneDurationTicks,
    frames: req.timeline.sceneDurationTicks / tpf,
    seconds: req.timeline.sceneDurationTicks / (tpf * req.timeline.fps),
  };
  const segs = exportSegments(req.timeline.markers, req.timeline);
  const segments = segs.segments.length ? { segments: segs.segments } : {};
  if (prepared.target?.type === "sksl-shader") {
    const { plan, problems } = planSkiaExport(req.nodes, req.edges, req.targetId, {
      name: req.name,
      canvas: req.canvas,
      timeline: req.timeline,
      ...(req.assets ? { assets: req.assets } : {}),
    });
    const warnings = [...prepared.warnings, ...(plan?.warnings ?? []), ...(plan ? segs.warnings : [])];
    if (!plan) return { ok: false, ...base, problems, warnings, canvas: req.canvas, timeline };
    // Baked / native emit from the same plan but can refuse or warn on
    // their own (an easing with no SkSL / Reanimated form): run the export.
    if (req.animation) {
      const r = safeExport(req);
      if (!r.files) return { ok: false, ...base, problems: r.problems, warnings, canvas: req.canvas, timeline };
      warnings.push(...r.warnings.filter((w) => !warnings.includes(w)));
    }
    return {
      ok: true,
      ...base,
      problems: [],
      warnings,
      canvas: plan.canvas,
      timeline,
      ...segments,
      usesTime: plan.usesTime,
      uniforms: plan.uniforms.map((u) => {
        const keys = u.track?.keys ?? [];
        return {
          name: u.name,
          kind: u.kind,
          animated: !!u.track || !!u.expr,
          ...(u.expr ? { procedural: true } : {}),
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
      ...(plan.children?.length
        ? {
            children: plan.children.map((c) => ({
              name: c.name,
              kind: c.kind,
              from: c.from,
              ...(c.kind === "image" ? { asset: c.asset.id, bundled: !!assetBytesOf(c.asset.url, req.assets) } : {}),
            })),
          }
        : {}),
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
    ...segments,
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

// The bundle's files as zip entries under `folder/`. Binary assets ride
// through SkiaExportResult as base64 text at `assets/<name>.b64` (api.ts);
// they land decoded at `assets/<name>`.
export function skiaZipEntries(files: Record<string, string>, folder: string): SkiaZipEntry[] {
  const prefix = folder ? `${folder.replace(/\/+$/, "")}/` : "";
  return Object.keys(files)
    .sort()
    .map((path) => {
      if (path.startsWith("assets/") && path.endsWith(".b64")) {
        return { path: prefix + path.slice(0, -".b64".length), bytes: base64ToBytes(files[path]) };
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
  // The timeline shape it was exported with.
  animation?: SkiaAnimationMode;
}
