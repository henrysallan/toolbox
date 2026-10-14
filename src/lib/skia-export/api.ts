// The one entry point the editor and MCP call to export for React Native
// Skia (specdocs/101326_skia-target.md §3.7). FROZEN signature for the
// Wave 1 lanes: the editor/MCP lane builds against it while the scene
// exporter lane fills in the `skia-canvas` branch.
//
// Targets:
//   sksl-shader  one runtime effect + its driver timeline (M0, plan.ts/emit.ts)
//   skia-canvas  a whole Skia layer's scene IR (scene exporter lane)

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import { emitSkiaBundle } from "./emit";
import { planSkiaExport } from "./plan";

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
    default:
      return {
        files: null,
        problems: [`"${req.targetId}" is a ${target.type} — export targets are SkSL Shader and Skia Canvas nodes.`],
        warnings: [],
      };
  }
}
