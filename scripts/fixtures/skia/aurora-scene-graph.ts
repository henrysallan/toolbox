// Aurora through the Skia-layer node set, end to end: Noise (Skia) →
// Color Ramp (Skia) → Skia Fill → Skia Canvas, beside toolbox's native
// Noise → Color Ramp, all on the same four drivers. One fixture proves the
// Wave 1 lanes together — the library ports and fuser (L2), the scene IR
// renderer and terminal (L1) — against the nodes they mirror:
//
//   npm run compare:skia -- --a aurora-scene:ramp --b aurora-scene:skc
//
// (Skia Fill + Skia Canvas draw the fused shader over the whole canvas, so
// the canvas output is the ramp's image.)

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { SkiaGraphFixture } from "../../skia/fixture";
import { AURORA_FRAMES, AURORA_RAMP_STOPS, AURORA_TIMELINE, auroraNativeGraph } from "./aurora-graph";

export function auroraSceneGraph(sksl: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const g = auroraNativeGraph(sksl);
  const noise = g.nodes.find((n) => n.id === "noise")!;
  const c2 = "ramp_c:stops:stop-c2";
  const nodes: GraphNode[] = [
    ...g.nodes,
    { id: "skn", type: "skia-noise", params: { ...noise.params }, exposedParams: ["scale", "offset_x", "contrast"] },
    {
      id: "skr",
      type: "skia-color-ramp",
      params: { stops: AURORA_RAMP_STOPS, offset: 0, interpolation: "linear", space: "oklab" },
      exposedParams: [c2],
    },
    { id: "skf", type: "skia-fill", params: { color: "#ffffff", opacity: 1, blendMode: "srcOver" } },
    { id: "skc", type: "skia-canvas", params: { background_on: false } },
  ];
  const e = (source: string, target: string, targetHandle: string): GraphEdge => ({
    id: `${source}->${target}:${targetHandle}`,
    source,
    sourceHandle: "out:primary",
    target,
    targetHandle,
  });
  const edges: GraphEdge[] = [
    ...g.edges,
    e("drift", "skn", "in:param:offset_x"),
    e("scale", "skn", "in:param:scale"),
    e("contrast", "skn", "in:param:contrast"),
    e("skn", "skr", "in:image"),
    e("glow", "skr", `in:param:${c2}`),
    e("skr", "skf", "in:shader"),
    e("skf", "skc", "in:scene"),
  ];
  return { nodes, edges };
}

export const fixture: SkiaGraphFixture = {
  description: "Aurora: native Noise → Color Ramp (`ramp`) vs the Skia-layer chain Noise (Skia) → Color Ramp (Skia) → Skia Fill → Skia Canvas (`skc`)",
  timeline: AURORA_TIMELINE,
  frames: AURORA_FRAMES,
  size: 512,
  build: ({ text }) => auroraSceneGraph(text("aurora.sksl")),
};
