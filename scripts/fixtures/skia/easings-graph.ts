// Every easing kind on one SkSL Shader node — the native-mode fixture
// (specdocs/101326_skia-target.md §3.5c; M3 lane D, check-skia-native and
// `npm run parity:skia -- --bundle native-easings`).
//
// One channel per toolbox easing (the 16 presets, the 3 legacy aliases,
// hold, customBezier with explicit and default handles, cubicBezier with an
// ordinary shape and one with a vertical tangent that Reanimated's solver
// misses, and two springs — one resting at the key, one at 60% of the
// segment), all keyed ON the node (`ch:<name>`, lane L4) with the same
// rhythm so the drift is comparable across easings:
//
//   f10  0    (easing) — a lead before the first key (withDelay)
//   f57  1    (easing) — 47 frames: a duration that isn't a whole ms
//   f150 0.2  linear   — 93 frames, then a short 13-frame step
//   f163 0.6  (easing)
//   f240 1             — then it holds to the end (f299)
//
// plus a toggle (hold steps carrying 0/1) and three colors: OKLab with an
// overshooting easeOutBack segment (extrapolated past the keys), RGB with
// an overshooting cubicBezier and the custom easeOutElastic, and an OKLab
// spring.
//
// The shader draws one row per value: a white bar whose right edge sits at
// x = (0.25 + 0.5·v)·width, anti-aliased over one pixel, so a value change
// of ~2e-5 moves an edge pixel by one 8-bit step; the color rows are the
// colors themselves.
//
// Pure (no fs): the Electron parity page bundles it.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { BezierEasing, BezierHandles, EasingPreset, Keyframe, KeyframeAnimationBlock } from "@/engine/keyframes";
import type { SpringEasing } from "@/engine/spring-easing";
import type { TimelineMarker } from "@/lib/timeline-markers";
import { syncChannelInputs } from "@/engine/expr-channels";
import type { ExprInput } from "@/engine/types";
import type { SkiaGraphFixture } from "../../skia/fixture";

// Markers (lane B → SEGMENTS; native mode's playSegment): on a key (f57),
// inside key segments (f100 cuts 57→150, the "settle" range 163–223 cuts
// 163→240 at both ends and a color's spring and easeOutBack segments), so
// segment playback has to start and stop partway along curves.
const EASINGS_MARKERS: TimelineMarker[] = [
  { id: "mk-intro", name: "intro", frame: 0 },
  { id: "mk-rise", name: "rise", frame: 57 },
  { id: "mk-mid", name: "mid", frame: 100 },
  { id: "mk-settle", name: "settle", frame: 163, duration: 60 },
  { id: "mk-tail", name: "tail", frame: 240 },
];
export const EASINGS_TIMELINE = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 300_000, markers: EASINGS_MARKERS };
export const EASINGS_FRAMES = [0, 10, 30, 57, 58, 90, 120, 150, 151, 163, 200, 240, 299];
export const EASINGS_SIZE = 512;

interface ScalarSpec {
  name: string;
  easing: EasingPreset;
  bezier?: BezierEasing;
  spring?: SpringEasing;
  // customBezier: the handles each key carries (value units, dx in ticks).
  handles?: (span: number, dv: number, i: number) => BezierHandles;
}

export const EASING_CHANNELS: ScalarSpec[] = [
  { name: "e_linear", easing: "linear" },
  { name: "e_in_sine", easing: "easeInSine" },
  { name: "e_out_sine", easing: "easeOutSine" },
  { name: "e_inout_sine", easing: "easeInOutSine" },
  { name: "e_in_quad", easing: "easeInQuad" },
  { name: "e_out_quad", easing: "easeOutQuad" },
  { name: "e_inout_quad", easing: "easeInOutQuad" },
  { name: "e_in_cubic", easing: "easeInCubic" },
  { name: "e_out_cubic", easing: "easeOutCubic" },
  { name: "e_inout_cubic", easing: "easeInOutCubic" },
  { name: "e_in_expo", easing: "easeInExpo" },
  { name: "e_out_expo", easing: "easeOutExpo" },
  { name: "e_in_back", easing: "easeInBack" },
  { name: "e_out_back", easing: "easeOutBack" },
  { name: "e_out_bounce", easing: "easeOutBounce" },
  { name: "e_out_elastic", easing: "easeOutElastic" },
  { name: "e_ease_in", easing: "easeIn" },
  { name: "e_ease_out", easing: "easeOut" },
  { name: "e_ease_inout", easing: "easeInOut" },
  { name: "e_hold", easing: "hold" },
  {
    name: "e_custom",
    easing: "customBezier",
    // An overshooting S: out-handle rises past the next key, in-handle dips.
    handles: (span, dv) => ({ rightHandle: { dx: span * 0.45, dy: dv * 1.3 }, leftHandle: { dx: -span * 0.2, dy: dv * 0.4 } }),
  },
  { name: "e_custom_def", easing: "customBezier" },
  { name: "e_bezier", easing: "cubicBezier", bezier: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } },
  // Vertical tangent at x = ½: Reanimated's Bezier solver misses by ~0.1,
  // so the exporter ships toolbox's solver for it.
  { name: "e_bezier_steep", easing: "cubicBezier", bezier: { x1: 1, y1: 0, x2: 0, y2: 1 } },
  // Lane C's spring (Reanimated's withSpring): bouncy, resting at the key;
  // and critically damped, resting 60% into the segment.
  { name: "e_spring", easing: "spring", spring: { dampingRatio: 0.35 } },
  { name: "e_spring_settle", easing: "spring", spring: { dampingRatio: 1.2, settle: 0.6 } },
];

// The keys every scalar channel carries: [frame, value, easing-or-linear].
const RHYTHM: [number, number, "x" | "linear"][] = [
  [10, 0, "x"],
  [57, 1, "x"],
  [150, 0.2, "linear"],
  [163, 0.6, "x"],
  [240, 1, "x"],
];

const COLORS = ["c_oklab", "c_rgb", "c_spring"] as const;

function block(keyframes: Keyframe[], colorSpace?: "oklab" | "rgb"): KeyframeAnimationBlock {
  return { animated: true, trackVisible: true, keyframes, ...(colorSpace ? { colorSpace } : {}) };
}

export function easingsSksl(): string {
  const rows = [...EASING_CHANNELS.map((c) => c.name), "t_flag", ...COLORS];
  const decl = [
    ...EASING_CHANNELS.map((c) => `// ch("${c.name}", 0, -1, 2)`),
    `// toggle("t_flag", false)`,
    `// color("c_oklab", "#1d4ed8")`,
    `// color("c_rgb", "#000000")`,
    `// color("c_spring", "#0ea5e9")`,
  ];
  const n = rows.length;
  const pick = rows
    .map((r, i) => {
      if (COLORS.includes(r as (typeof COLORS)[number])) return `  if (row == ${i}) return half4(${r}.rgb * ${r}.a, ${r}.a);`;
      const v = r === "t_flag" ? "float(t_flag)" : r;
      return `  if (row == ${i}) return half4(bar(p.x, ${v}, inRow));`;
    })
    .join("\n");
  return `// Easings fixture: one row per value (scripts/fixtures/skia/easings-graph.ts).
${decl.join("\n")}

// A white bar to x = (0.25 + 0.5·v)·width, anti-aliased over one pixel, on
// a dark row with a 1-px gap underneath.
float4 bar(float x, float v, float inRow) {
  float edge = (0.25 + 0.5 * v) * iResolution.x;
  float a = clamp(edge - x + 0.5, 0.0, 1.0) * inRow;
  float3 c = mix(float3(0.07, 0.08, 0.1), float3(1.0), a);
  return float4(c, 1.0);
}

half4 main(float2 p) {
  float rowH = iResolution.y / ${n}.0;
  int row = int(floor(p.y / rowH));
  float inRow = step(1.0, rowH - (p.y - float(row) * rowH));
${pick}
  return half4(0.0, 0.0, 0.0, 1.0);
}
`;
}

export function easingsGraph(): { nodes: GraphNode[]; edges: GraphEdge[]; targetId: string } {
  const sksl = easingsSksl();
  const inputs: ExprInput[] = syncChannelInputs([], sksl);
  const animation: Record<string, KeyframeAnimationBlock> = {};
  for (const c of EASING_CHANNELS) {
    const keys: Keyframe[] = RHYTHM.map(([f, value, e]) => ({
      tick: f * 1000,
      value,
      easingOut: e === "x" ? c.easing : "linear",
      ...(e === "x" && c.bezier ? { bezier: { ...c.bezier } } : {}),
      ...(e === "x" && c.spring ? { spring: { ...c.spring } } : {}),
    }));
    if (c.handles) {
      keys.forEach((k, i) => {
        const prev = keys[i - 1];
        const next = keys[i + 1];
        // Out-handle shaped by this key's segment, in-handle by the one before.
        const out = next ? c.handles!(next.tick - k.tick, (next.value as number) - (k.value as number), i) : null;
        const inn = prev ? c.handles!(k.tick - prev.tick, (k.value as number) - (prev.value as number), i - 1) : null;
        k.bezierHandles = {
          rightHandle: out ? out.rightHandle : { dx: 0, dy: 0 },
          leftHandle: inn ? inn.leftHandle : { dx: 0, dy: 0 },
        };
      });
    }
    animation[`ch:${c.name}`] = block(keys);
  }
  animation["ch:t_flag"] = block([
    { tick: 30_000, value: false, easingOut: "hold" },
    { tick: 100_000, value: true, easingOut: "hold" },
    { tick: 200_000, value: false, easingOut: "hold" },
  ]);
  animation["ch:c_oklab"] = block(
    [
      { tick: 0, value: "#1d4ed8", easingOut: "easeInOutQuad" },
      { tick: 90_000, value: "#f97316", easingOut: "hold" },
      { tick: 150_000, value: "#22c55e", easingOut: "easeOutBack" },
      { tick: 260_000, value: "#e11d48", easingOut: "linear" },
    ],
    "oklab"
  );
  animation["ch:c_rgb"] = block(
    [
      { tick: 20_000, value: "#000000", easingOut: "cubicBezier", bezier: { x1: 0.2, y1: 1.6, x2: 0.3, y2: -0.4 } },
      { tick: 140_000, value: "#ffffff", easingOut: "easeOutElastic" },
      { tick: 280_000, value: "#808080", easingOut: "linear" },
    ],
    "rgb"
  );
  // A spring segment on a color: the progress springs (and overshoots), the
  // mix stays toolbox's OKLab.
  animation["ch:c_spring"] = block(
    [
      { tick: 30_000, value: "#0ea5e9", easingOut: "spring", spring: { dampingRatio: 0.3 } },
      { tick: 150_000, value: "#facc15", easingOut: "linear" },
    ],
    "oklab"
  );
  const nodes: GraphNode[] = [
    {
      id: "easings",
      type: "sksl-shader",
      params: { inputs, expression: sksl, on_error: "transparent" },
      animation,
    },
  ];
  return { nodes, edges: [], targetId: "easings" };
}

export const fixture: SkiaGraphFixture = {
  description: "Every easing kind on one SkSL Shader node's channel keyframes (native-mode drift fixture, `easings`)",
  timeline: EASINGS_TIMELINE,
  frames: EASINGS_FRAMES,
  size: EASINGS_SIZE,
  build: () => {
    const g = easingsGraph();
    return { nodes: g.nodes, edges: g.edges };
  },
};
