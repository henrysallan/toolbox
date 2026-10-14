// The one entry point the editor and MCP call to export for React Native
// Skia (specdocs/101326_skia-target.md §3.7). FROZEN signature for the
// Wave 1 lanes: the editor/MCP lane builds against it while the scene
// exporter lane fills in the `skia-canvas` branch.
//
// Targets:
//   sksl-shader  one runtime effect + its driver timeline (M0, plan.ts/emit.ts)
//   skia-canvas  a whole Skia layer's scene IR (scene-plan.ts/scene-emit.ts)

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { RGBA, SkiaScene } from "@/engine/skia/scene-ir";
import { hexToRgba01 } from "@/engine/spline-fill";
import type { TimelineMarker } from "@/lib/timeline-markers";
import { emitSkiaBundle } from "./emit";
import { planSkiaExport } from "./plan";
import { emitSceneBundle } from "./scene-emit";
import { planSceneExport, type PlannedBind } from "./scene-plan";
import { makeSceneSampler, SKIA_CANVAS_TYPE } from "./scene-sample";
import { exportSegments } from "./segments";

export interface SkiaExportRequest {
  // The FLATTENED graph the evaluator sees (group/layer shells dissolved).
  nodes: GraphNode[];
  edges: GraphEdge[];
  targetId: string;
  name: string;
  canvas: { width: number; height: number };
  // `markers` (additive, M3): the composition's timeline markers in frames
  // on the TARGET's clock (editor.ts shifts them for a late layer). They
  // become the bundle's SEGMENTS / MARKERS (segments.ts); absent = none.
  timeline: { fps: number; ticksPerFrame: number; sceneDurationTicks: number; markers?: readonly TimelineMarker[] };
  // src/lib/skia-export/runtime/toolbox-timeline.ts, verbatim. The CLI reads
  // it from disk; the editor imports the generated string module.
  runtimeSource: string;
}

export interface SkiaExportResult {
  // Relative path → file contents (text). Binary assets ride as base64 under
  // `assets/` with a `.b64` suffix the writer decodes.
  files: Record<string, string> | null;
  problems: string[];
  warnings: string[];
}

export interface SkiaSceneExportOptions {
  name: string;
  timeline: SkiaExportRequest["timeline"];
  runtimeSource: string;
  // The producer re-evaluated at another tick (see scene-sample.ts). Without
  // it, binds derived from animated params refuse and nothing is verified.
  sampleAt?: (tick: number) => SkiaScene | null;
}

// Export a scene directly — the skia-canvas branch below after it has
// evaluated the canvas's input, and the entry point for IR fixtures.
// `nodes`/`edges` are the flattened graph the binds' refs point into.
export function exportSkiaScene(
  scene: SkiaScene,
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: SkiaSceneExportOptions
): SkiaExportResult & { binds: PlannedBind[] } {
  const { plan, problems, binds } = planSceneExport(scene, nodes, edges, {
    name: opts.name,
    timeline: opts.timeline,
    sampleAt: opts.sampleAt,
  });
  if (!plan) return { files: null, problems, warnings: [], binds };
  const segments = exportSegments(opts.timeline.markers, opts.timeline);
  return {
    files: emitSceneBundle(plan, opts.runtimeSource, segments),
    problems: [],
    warnings: [...plan.warnings, ...segments.warnings],
    binds,
  };
}

export function exportSkia(req: SkiaExportRequest): SkiaExportResult {
  const target = req.nodes.find((n) => n.id === req.targetId);
  if (!target) return { files: null, problems: [`No node "${req.targetId}" in the graph.`], warnings: [] };
  switch (target.type) {
    case "sksl-shader": {
      const { plan, problems } = planSkiaExport(req.nodes, req.edges, req.targetId, {
        name: req.name,
        canvas: req.canvas,
        timeline: req.timeline,
      });
      if (!plan) return { files: null, problems, warnings: [] };
      const segments = exportSegments(req.timeline.markers, req.timeline);
      return {
        files: emitSkiaBundle(plan, req.runtimeSource, segments),
        problems: [],
        warnings: [...plan.warnings, ...segments.warnings],
      };
    }
    case SKIA_CANVAS_TYPE: {
      // The canvas's own background (skia-canvas: background_on + an alpha
      // color) is static in the IR.
      const bg = canvasBackground(target, req.edges);
      if (typeof bg === "string") return { files: null, problems: [bg], warnings: [] };
      // Interior nodes run on the layer's local clock from 0 — the editor's
      // export action says so when the layer starts later (L6).
      const sampler = makeSceneSampler(req.nodes, req.edges, target.id, req.canvas, req.timeline, bg);
      if ("problem" in sampler) return { files: null, problems: [sampler.problem], warnings: [] };
      const scene = sampler.sampleAt(0);
      if (!scene) return { files: null, problems: [sampler.lastProblem() ?? "The scene input produced nothing."], warnings: [] };
      const r = exportSkiaScene(scene, req.nodes, req.edges, {
        name: req.name,
        timeline: req.timeline,
        runtimeSource: req.runtimeSource,
        sampleAt: (tick) => sampler.sampleAt(tick),
      });
      // What the producers themselves could not express (an unfused shader,
      // an unported option) refuses the export, as it fails the preview.
      const producer = sampler.producerProblems();
      if (producer.length) return { files: null, problems: [...producer, ...r.problems], warnings: r.warnings };
      return { files: r.files, problems: r.problems, warnings: r.warnings };
    }
    default:
      return {
        files: null,
        problems: [`"${req.targetId}" is a ${target.type} — export targets are SkSL Shader and Skia Canvas nodes.`],
        warnings: [],
      };
  }
}

// The Skia Canvas background as the IR's static RGBA (undefined = off), or
// a problem when it animates.
function canvasBackground(canvas: GraphNode, edges: GraphEdge[]): RGBA | undefined | string {
  for (const p of ["background_on", "background"]) {
    const keyed = canvas.animation?.[p];
    const wired = (canvas.exposedParams ?? []).includes(p) && edges.some((e) => e.target === canvas.id && e.targetHandle === `in:param:${p}`);
    if ((keyed?.animated && keyed.keyframes.length) || wired) {
      return `The Skia Canvas "${canvas.id}" has an animated background (${p}) — the exported canvas background is static; animate a Skia Fill under the scene instead.`;
    }
  }
  if (canvas.params.background_on !== true) return undefined;
  const v = canvas.params.background;
  return hexToRgba01(typeof v === "string" ? v : "#000000");
}
