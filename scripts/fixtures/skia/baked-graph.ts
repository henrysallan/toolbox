// check:skia-baked's synthetic fixture (specdocs/101326_skia-target.md
// §3.5b): one SkSL Shader node whose channels carry EVERY easing the
// timeline has, so the baked program and the worklet-driven one can be
// rendered side by side at every frame.
//
//   e0..e<n>  scalar channel keyframes, one easing preset each (+ the legacy
//             easeIn / easeOut / easeInOut aliases, cubicBezier with an
//             overshooting shape, customBezier with explicit and default
//             handles, hold), with a sub-frame key and a same-tick jump
//   ok        color channel, OKLab, translucent keys (quantizeAlpha)
//   rg        color channel, RGB
//   nd        wired from a Color node (alpha 0.75, OKLab keys: quantize8 +
//             the node's alpha)
//   av        wired from an Animated Value (cubicBezier + hold)
//   tg / pk   toggle / pick channels (hold ints)
//
// The shader draws one vertical stripe per value over a vertical ramp, so
// every uniform reaches pixels.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import { syncChannelInputs } from "@/engine/expr-channels";
import type { EasingPreset, Keyframe, KeyframeAnimationBlock } from "@/engine/keyframes";

export const BAKED_TIMELINE = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 120_000 };

const F = (f: number) => f * BAKED_TIMELINE.ticksPerFrame;

export const BAKED_EASINGS: EasingPreset[] = [
  "linear",
  "easeInSine",
  "easeOutSine",
  "easeInOutSine",
  "easeInQuad",
  "easeOutQuad",
  "easeInOutQuad",
  "easeInCubic",
  "easeOutCubic",
  "easeInOutCubic",
  "easeInExpo",
  "easeOutExpo",
  "easeInBack",
  "easeOutBack",
  "easeOutBounce",
  "easeOutElastic",
  "hold",
  "easeIn",
  "easeOut",
  "easeInOut",
  "cubicBezier",
  "customBezier",
];

const block = (keyframes: Keyframe[], colorSpace?: "oklab" | "rgb"): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes,
  ...(colorSpace ? { colorSpace } : {}),
});

// One scalar channel's keys for preset `p` (index i staggers the values).
export function easingKeys(p: EasingPreset, i: number): Keyframe[] {
  const lo = -0.5 + (i % 3) * 0.1;
  const hi = 1.25 - (i % 4) * 0.05;
  const k = (tick: number, value: number, easingOut: EasingPreset, extra: Partial<Keyframe> = {}): Keyframe => ({ tick, value, easingOut, ...extra });
  if (p === "customBezier") {
    return [
      k(0, lo, "customBezier", { bezierHandles: { rightHandle: { dx: F(25), dy: 1.4 }, leftHandle: { dx: -1, dy: 0 } } }),
      k(F(40), hi, "customBezier", { bezierHandles: { rightHandle: { dx: F(2), dy: -0.6 }, leftHandle: { dx: -F(30), dy: 0.4 } } }),
      // default handles (chord thirds) on this segment
      k(F(80), 0.1, "customBezier"),
      k(F(110), 0.6, "linear"),
    ];
  }
  const shape = p === "cubicBezier" ? { bezier: { x1: 0.2, y1: 1.6, x2: 0.3, y2: -0.4 } } : {};
  return [
    k(F(4), lo, p, shape),
    k(F(40), hi, p, p === "cubicBezier" ? { bezier: { x1: 0.9, y1: 0, x2: 0.1, y2: 1 } } : {}),
    // a sub-frame key, then a same-tick jump
    k(95_500, 0.25, "easeOutCubic"),
    k(F(100), 0.9, "linear"),
    k(F(100), 0.1, "easeInOutSine"),
    k(F(116), 0.4, "linear"),
  ];
}

export function bakedSksl(n = BAKED_EASINGS.length): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`// ch("e${i}", 0, -2, 2)`);
  lines.push(
    `// color("ok", "#ff7a45")`,
    `// color("rg", "#1b2cff")`,
    `// color("nd", "#ffffff")`,
    `// ch("av", 0, -2, 2)`,
    `// toggle("tg", false)`,
    `// pick("pk", "a", "b", "c")`,
    ``,
    `half4 main(float2 p) {`,
    `  float2 uv = p / iResolution.xy;`,
    `  float col = floor(uv.x * ${n + 6}.0);`,
    `  float v = 0.0;`
  );
  for (let i = 0; i < n; i++) lines.push(`  ${i ? "else " : ""}if (col < ${i}.5) v = e${i};`);
  lines.push(
    `  else if (col < ${n + 3}.5) v = av;`,
    `  else v = float(tg) + 0.5 * float(pk);`,
    `  float4 c = float4(float3(clamp(0.3 + 0.25 * v + 0.25 * uv.y, 0.0, 1.0)), 1.0);`,
    `  if (col >= ${n}.5 && col < ${n + 1}.5) c = ok;`,
    `  if (col >= ${n + 1}.5 && col < ${n + 2}.5) c = rg;`,
    `  if (col >= ${n + 2}.5 && col < ${n + 3}.5) c = nd;`,
    `  c.rgb = mix(c.rgb, float3(uv.y), 0.2);`,
    `  return half4(c.rgb * c.a, c.a);`,
    `}`
  );
  return lines.join("\n");
}

export function bakedGraph(): { nodes: GraphNode[]; edges: GraphEdge[]; targetId: string } {
  const sksl = bakedSksl();
  const inputs = syncChannelInputs([], sksl);
  const row = (name: string) => inputs.find((r) => r.name === name)!;
  const animation: Record<string, KeyframeAnimationBlock> = {};
  BAKED_EASINGS.forEach((p, i) => (animation[`ch:e${i}`] = block(easingKeys(p, i))));
  animation["ch:ok"] = block([
    { tick: 0, value: "#ff7a45", easingOut: "easeInOutCubic" },
    { tick: F(50), value: "#3d5afe80", easingOut: "easeOutBack" },
    { tick: F(110), value: [0.1, 0.9, 0.3, 1], easingOut: "linear" },
  ]);
  animation["ch:rg"] = block(
    [
      { tick: F(10), value: "#1b2cff", easingOut: "easeInQuad" },
      { tick: F(70), value: "#00ffa2", easingOut: "cubicBezier", bezier: { x1: 0.4, y1: 0, x2: 0.2, y2: 1 } },
      { tick: F(115), value: "#ffe3c2", easingOut: "linear" },
    ],
    "rgb"
  );
  animation["ch:tg"] = block([
    { tick: F(10), value: false, easingOut: "hold" },
    { tick: F(60), value: true, easingOut: "hold" },
    { tick: F(90), value: false, easingOut: "hold" },
  ]);
  animation["ch:pk"] = block([
    { tick: 0, value: "a", easingOut: "hold" },
    { tick: F(30), value: "c", easingOut: "linear" },
    { tick: F(75), value: "b", easingOut: "hold" },
  ]);
  const nodes: GraphNode[] = [
    {
      id: "glow",
      type: "color-literal",
      params: { color: "#ff7a45", alpha: 0.75, count: 1 },
      animation: {
        color: block([
          { tick: 0, value: "#ff7a45", easingOut: "easeInOutQuad" },
          { tick: F(60), value: "#ff3d8b", easingOut: "easeOutElastic" },
          { tick: F(120), value: "#2bd9a0", easingOut: "linear" },
        ]),
      },
    },
    {
      id: "drv",
      type: "animated-value",
      params: { value: 0, unit: "frames" },
      animation: {
        value: block([
          { tick: 0, value: -1, easingOut: "cubicBezier", bezier: { x1: 0.33, y1: 1.4, x2: 0.66, y2: -0.2 } },
          { tick: F(55), value: 1.5, easingOut: "hold" },
          { tick: F(85), value: 0.5, easingOut: "easeOutBounce" },
          { tick: F(118), value: 1, easingOut: "linear" },
        ]),
      },
    },
    { id: "bk", type: "sksl-shader", params: { inputs, expression: sksl, on_error: "transparent" }, animation },
  ];
  const edges: GraphEdge[] = [
    { id: "glow->bk", source: "glow", sourceHandle: "out:primary", target: "bk", targetHandle: `in:in:${row("nd").id}` },
    { id: "drv->bk", source: "drv", sourceHandle: "out:primary", target: "bk", targetHandle: `in:in:${row("av").id}` },
  ];
  return { nodes, edges, targetId: "bk" };
}
