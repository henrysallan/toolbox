// The one entry point the editor and MCP call to export for React Native
// Skia (specdocs/101326_skia-target.md §3.7). FROZEN signature for the
// Wave 1 lanes: the editor/MCP lane builds against it while the scene
// exporter lane fills in the `skia-canvas` branch.
//
// Targets:
//   sksl-shader  one runtime effect + its driver timeline (M0, plan.ts/emit.ts)
//   skia-canvas  a whole Skia layer's scene IR (scene-plan.ts/scene-emit.ts)

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import { LAYER_TYPE } from "@/engine/groups";
import type { SkiaScene } from "@/engine/skia/scene-ir";
import { emitSkiaBundle } from "./emit";
import { planSkiaExport } from "./plan";
import { emitSceneBundle } from "./scene-emit";
import { planSceneExport, type PlannedBind } from "./scene-plan";
import { makeSceneSampler, SKIA_CANVAS_TYPE } from "./scene-sample";

export interface SkiaExportRequest {
  // The FLATTENED graph the evaluator sees (group/layer shells dissolved).
  nodes: GraphNode[];
  edges: GraphEdge[];
  targetId: string;
  name: string;
  canvas: { width: number; height: number };
  timeline: { fps: number; ticksPerFrame: number; sceneDurationTicks: number };
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
  return { files: emitSceneBundle(plan, opts.runtimeSource), problems: [], warnings: plan.warnings, binds };
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
      return { files: emitSkiaBundle(plan, req.runtimeSource), problems: [], warnings: plan.warnings };
    }
    case SKIA_CANVAS_TYPE: {
      const sampler = makeSceneSampler(req.nodes, req.edges, target.id, req.canvas, req.timeline);
      if ("problem" in sampler) return { files: null, problems: [sampler.problem], warnings: [] };
      const scene = sampler.sampleAt(0);
      if (!scene) return { files: null, problems: [sampler.lastProblem() ?? "The scene input produced nothing."], warnings: [] };
      const r = exportSkiaScene(scene, req.nodes, req.edges, {
        name: req.name,
        timeline: req.timeline,
        runtimeSource: req.runtimeSource,
        sampleAt: (tick) => sampler.sampleAt(tick),
      });
      const warnings = [...r.warnings];
      const layer = enclosingLayer(req.nodes, target);
      if (layer?.clips?.some((c) => c.enabled)) {
        warnings.push(`Layer "${layer.id}" has a clip window — the export plays the scene for the whole timeline; gate it in the app.`);
      }
      return { files: r.files, problems: r.problems, warnings };
    }
    default:
      return {
        files: null,
        problems: [`"${req.targetId}" is a ${target.type} — export targets are SkSL Shader and Skia Canvas nodes.`],
        warnings: [],
      };
  }
}

function enclosingLayer(nodes: GraphNode[], n: GraphNode): GraphNode | null {
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const seen = new Set<string>();
  let cur = n.parentId ? byId.get(n.parentId) : undefined;
  while (cur && !seen.has(cur.id)) {
    if (cur.type === LAYER_TYPE) return cur;
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return null;
}
