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
import type { SkiaGraphFixture } from "../../skia/fixture";

export const AURORA_TIMELINE = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 300_000 };
export const AURORA_FRAMES = [0, 45, 90, 120, 150, 200, 240, 299];
// Timeline markers (M3 lane B) the harness bundles ship as SEGMENTS:
// intro [0, 120) → loop [120, 300), plus a ranged "flash" [150, 180) over
// the glow's pink peak. `?segment=loop` in skia-harness plays one.
export const AURORA_MARKERS = [
  { id: "mk-intro", name: "intro", frame: 0 },
  { id: "mk-loop", name: "loop", frame: 120 },
  { id: "mk-flash", name: "flash", frame: 150, duration: 30 },
];

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

// ---- compare:skia fixture (scripts/skia-compare.cjs) ----------------------
// The graph the port was made from: toolbox's native Noise → Color Ramp,
// driven by the SAME four drivers as the SkSL node, so the port can be
// proven against its source without an editor:
//
//   npm run compare:skia -- --a aurora:ramp --b aurora:aurora
//
// Noise: simplex fBm, 4 octaves, black → white (so the ramp's Rec.709
// luminance is exactly the noise value t). Color Ramp: the SkSL's four
// stops, linear in OKLab; the glow Color drives stop c2 through the
// per-stop exposed socket (ramp_c:stops:<id>), as the editor wires it.
export const AURORA_RAMP_STOPS = [
  { id: "stop-c0", position: 0, color: "#0a0f2c" },
  { id: "stop-c1", position: 0.45, color: "#3d5afe" },
  { id: "stop-c2", position: 0.75, color: "#ff7a45" },
  { id: "stop-c3", position: 1, color: "#ffe3c2" },
];

export function auroraNativeGraph(sksl: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const g = auroraGraph(sksl);
  const c2 = "ramp_c:stops:stop-c2";
  const nodes: GraphNode[] = [
    ...g.nodes,
    {
      id: "noise",
      type: "noise",
      params: {
        type: "simplex",
        scale: 3,
        octaves: 4,
        persistence: 0.5,
        lacunarity: 2,
        offset_x: 0,
        offset_y: 0,
        seed: 0,
        contrast: 1.2,
        color_a: "#000000",
        color_b: "#ffffff",
        alpha: 1,
      },
      exposedParams: ["scale", "offset_x", "contrast"],
    },
    {
      id: "ramp",
      type: "color-ramp",
      params: { stops: AURORA_RAMP_STOPS, offset: 0, interpolation: "linear", space: "oklab" },
      exposedParams: [c2],
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
    ...g.edges,
    e("drift", "noise", "in:param:offset_x"),
    e("scale", "noise", "in:param:scale"),
    e("contrast", "noise", "in:param:contrast"),
    e("noise", "ramp", "in:image"),
    e("glow", "ramp", `in:param:${c2}`),
  ];
  return { nodes, edges };
}

export const fixture: SkiaGraphFixture = {
  description: "Aurora: native Noise → Color Ramp (`ramp`) and its SkSL port (`aurora`), same drivers",
  timeline: AURORA_TIMELINE,
  frames: AURORA_FRAMES,
  size: 512,
  build: ({ text }) => auroraNativeGraph(text("aurora.sksl")),
};
