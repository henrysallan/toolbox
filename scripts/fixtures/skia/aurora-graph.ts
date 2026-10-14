// The Aurora spike fixture (specdocs/101326_skia-target.md §M0 results): the
// SkSL port in aurora.sksl plus the keyframed drivers that animate it, as
// the flattened engine graph the evaluator and planSkiaExport both read.
// The live editor copy was built from the same values over MCP; the gates
// and the device harness use this one so they run without an editor.
//
//   drift    Animated Value → drift_x   0 → 1.5           linear
//   scale    Animated Value → scale     3 → 4.2 → 3       easeOutBack, easeInOutCubic
//   contrast Animated Value → contrast  0.8 → 1.6 → 1.2   easeOutElastic, easeInOutSine, hold
//   glow     Color          → c2        #ff7a45 → #ff3d8b → #ff7a45  easeInOutQuad (OKLab)

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { EasingPreset, KeyframeAnimationBlock } from "@/engine/keyframes";
import { syncChannelInputs } from "@/engine/expr-channels";
import type { ExprInput } from "@/engine/types";

export const AURORA_TIMELINE = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 300_000 };
export const AURORA_FRAMES = [0, 45, 90, 120, 150, 200, 240, 299];

type K = [frame: number, value: number | string, easing: EasingPreset];
const block = (keys: K[]): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes: keys.map(([f, value, easingOut]) => ({ tick: f * 1000, value, easingOut })),
});

// Pure (no fs) so the Electron parity harness can bundle it with the SkSL
// text inlined; Node callers use aurora.ts, which reads aurora.sksl.
export function auroraGraph(sksl: string): { nodes: GraphNode[]; edges: GraphEdge[]; targetId: string } {
  const inputs: ExprInput[] = syncChannelInputs([], sksl);
  const chan = (name: string) => {
    const row = inputs.find((e) => e.name === name);
    if (!row) throw new Error(`aurora.sksl declares no channel "${name}"`);
    return `in:in:${row.id}`;
  };
  const nodes: GraphNode[] = [
    {
      id: "drift",
      type: "animated-value",
      params: { value: 0, unit: "frames" },
      animation: { value: block([[0, 0, "linear"], [300, 1.5, "linear"]]) },
    },
    {
      id: "scale",
      type: "animated-value",
      params: { value: 3, unit: "frames" },
      animation: { value: block([[0, 3, "easeOutBack"], [120, 4.2, "easeInOutCubic"], [300, 3, "linear"]]) },
    },
    {
      id: "contrast",
      type: "animated-value",
      params: { value: 1.2, unit: "frames" },
      animation: {
        value: block([
          [0, 0.8, "easeOutElastic"],
          [90, 1.6, "easeInOutSine"],
          [240, 1.2, "hold"],
          [300, 1.2, "linear"],
        ]),
      },
    },
    {
      id: "glow",
      type: "color-literal",
      params: { color: "#ff7a45", alpha: 1, count: 1 },
      animation: {
        color: block([
          [0, "#ff7a45", "easeInOutQuad"],
          [150, "#ff3d8b", "easeInOutQuad"],
          [300, "#ff7a45", "linear"],
        ]),
      },
    },
    {
      id: "aurora",
      type: "sksl-shader",
      params: { inputs, expression: sksl, on_error: "transparent" },
    },
  ];
  const e = (source: string, target: string, targetHandle: string): GraphEdge => ({
    id: `${source}->${target}:${targetHandle}`,
    source,
    sourceHandle: "out:primary",
    target,
    targetHandle,
  });
  const edges: GraphEdge[] = [
    e("drift", "aurora", chan("drift_x")),
    e("scale", "aurora", chan("scale")),
    e("contrast", "aurora", chan("contrast")),
    e("glow", "aurora", chan("c2")),
  ];
  return { nodes, edges, targetId: "aurora" };
}
