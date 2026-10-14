// The scene-export gate's fixture (scripts/check-skia-scene-export.mts):
// one data-only producer node, `test-skia-scene`, whose compute writes a
// hand-authored Skia scene IR from its evaluated params — every SkiaNode
// kind, every geometry / shader / filter / path effect the IR has, and every
// way a value can be bound:
//
//   ref → keyframed param        radius, center[0|1] (vec2, customBezier),
//                                tint (color, oklab), spin, size
//   ref → wired driver           stroke ← Animated Value, glow ← Color (rgb),
//                                gain ← Constant (static)
//   deps, animated               the star path (interpolatable), the polygon
//                                whose side count steps, atlas xforms, points
//   deps, static                 a star from `arms` only
//   no tags                      iTime (the clock), a frame-counter label
//                                (untagged animation → sampled + warning)
//   a transformed ref            radius × 2 tagged as a plain ref (→ sampled)
//
// Real Skia-layer nodes (lane L1/L2) produce the same shapes; this one only
// exists so the exporter can be proven against the real evaluator without
// them.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { Keyframe, KeyframeAnimationBlock } from "@/engine/keyframes";
import { getNodeDef, registerNode } from "@/engine/registry";
import { bindDerived, bindParam, bindStatic, type AssetIR, type Bind, type RGBA, type SkiaNode } from "@/engine/skia/scene-ir";
import { hexToRgba01 } from "@/engine/spline-fill";
import type { NodeDefinition, SkiaDrawValue } from "@/engine/types";

export const SCENE_TIMELINE = { fps: 30, ticksPerFrame: 1000, sceneDurationTicks: 60_000 };
export const SCENE_CANVAS = { width: 512, height: 512 };

const F = (frame: number) => frame * SCENE_TIMELINE.ticksPerFrame;

export const FILL_SKSL = `uniform float3 iResolution;
uniform float iTime;
uniform float k;
layout(color) uniform float4 tint;
uniform shader s0;
half4 main(float2 fc) {
  float2 uv = fc / iResolution.xy;
  float4 c = float4(s0.eval(fc));
  float w = 0.5 + 0.5 * sin(iTime * 2.0 + uv.x * k);
  float4 o = float4(mix(c.rgb, tint.rgb, w), 1.0);
  return half4(o.rgb * o.a, o.a);
}
`;

export const INVERT_SKSL = `uniform shader content;
uniform float amount;
half4 main(float2 p) {
  float4 c = float4(content.eval(p));
  return half4(mix(c.rgb, c.a - c.rgb, amount), c.a);
}
`;

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const SCENE_ASSETS: Record<string, AssetIR> = {
  logo: { id: "logo", kind: "image", mime: "image/png", url: PNG_1PX, width: 1, height: 1 },
  inter: { id: "inter", kind: "font", mime: "font/ttf", url: "data:font/ttf;base64,AAEAAAALAIAAAwAwT1MvMg==" },
  sprites: { id: "sprites", kind: "image", mime: "image/png", url: "https://media.example.com/project/sprites.png", width: 64, height: 32 },
};

const fx = (x: number) => Number(x.toFixed(3));

function starPath(cx: number, cy: number, R: number, r: number, arms: number, spin: number): string {
  const n = Math.max(2, Math.round(arms)) * 2;
  let d = "";
  for (let i = 0; i < n; i++) {
    const a = spin + (i / n) * Math.PI * 2;
    const rr = i % 2 ? r : R;
    d += `${i ? "L" : "M"}${fx(cx + Math.cos(a) * rr)} ${fx(cy + Math.sin(a) * rr)}`;
  }
  return d + "Z";
}

function polygonPath(cx: number, cy: number, R: number, sides: number): string {
  const n = Math.max(3, Math.round(sides));
  let d = `M${fx(cx + R)} ${fx(cy)}`;
  for (let i = 1; i < n; i++) d += ` L${fx(cx + Math.cos((i / n) * Math.PI * 2) * R)} ${fx(cy + Math.sin((i / n) * Math.PI * 2) * R)}`;
  return d + " Z";
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function buildScene(P: Record<string, unknown>, id: string, frame: number, time: number): SkiaNode {
  const ref = (param: string, component?: number) => (component === undefined ? { node: id, param } : { node: id, param, component });
  const s = <T>(v: T): Bind<T> => bindStatic(v);
  const center = Array.isArray(P.center) ? (P.center as number[]) : [256, 256];
  const radius = num(P.radius, 60);
  const spin = num(P.spin);
  const arms = num(P.arms, 5);
  const gain = num(P.gain, 0.5);
  const tint = hexToRgba01(String(P.tint)) as RGBA;
  const glow = hexToRgba01(String(P.glow)) as RGBA;
  const R = bindParam(radius, id, "radius");
  const xforms: number[] = [];
  for (let i = 0; i < 2; i++) xforms.push(Math.cos(spin + i), Math.sin(spin + i), fx(100 + i * 60), fx(400 + Math.sin(spin) * 20));
  const pts: number[] = [];
  for (let i = 0; i < 5; i++) pts.push(fx(380 + Math.cos(spin + i * 1.2566) * 40), fx(380 + Math.sin(spin + i * 1.2566) * 40));

  const children: SkiaNode[] = [
    // 0 — a fused-style runtime program over a gradient child.
    {
      k: "fill",
      id,
      paint: {
        style: "fill",
        shader: {
          k: "runtime",
          program: {
            sksl: FILL_SKSL,
            uniforms: {
              iResolution: s([SCENE_CANVAS.width, SCENE_CANVAS.height, 1]),
              iTime: { v: time },
              k: s(6),
              tint: bindParam(tint, id, "tint"),
            },
            children: [
              {
                name: "s0",
                shader: {
                  k: "linear",
                  start: [s(0), s(0)],
                  end: [s(512), s(512)],
                  stops: [
                    { pos: s(0), color: bindParam(glow, id, "glow") },
                    { pos: s(1), color: s([0.05, 0.05, 0.1, 1] as RGBA) },
                  ],
                  tile: "clamp",
                },
              },
            ],
            fused: ["tbx.test.mix@1"],
          },
        },
      },
    },
    // 1 — transformed, clipped, layered group of primitives.
    {
      k: "group",
      id,
      transform: {
        translate: [bindParam(center[0], id, "center", 0), bindParam(center[1], id, "center", 1)],
        // `spin` is degrees; the IR wants radians (BindRef.scale).
        rotate: { v: spin * (Math.PI / 180), ref: { node: id, param: "spin", scale: Math.PI / 180 } },
        scale: [bindParam(gain, id, "gain"), bindParam(gain, id, "gain")],
        origin: [s(0), s(0)],
      },
      opacity: s(0.9),
      blendMode: "screen",
      clip: { geom: { k: "rect", x: s(-150), y: s(-150), w: s(300), h: s(300), r: s(24) } },
      layer: {
        imageFilters: [
          { k: "blur", sx: bindParam(num(P.stroke), id, "stroke"), sy: bindParam(num(P.stroke), id, "stroke"), tile: "decal" },
          { k: "shadow", dx: s(4), dy: s(6), blur: s(3), color: s([0, 0, 0, 0.5] as RGBA) },
          { k: "offset", dx: s(2), dy: s(-2) },
          { k: "morphology", op: "dilate", r: s(1) },
          { k: "displacement", channelX: "r", channelY: "g", scale: s(8), map: { k: "color", color: s([0.5, 0.5, 0, 1] as RGBA) } },
          { k: "runtime", program: { sksl: INVERT_SKSL, uniforms: { amount: s(0.25) }, children: [] }, content: "content" },
        ],
        colorFilters: [{ k: "luma" }],
      },
      children: [
        {
          k: "shape",
          id,
          geom: { k: "circle", cx: s(0), cy: s(0), r: R },
          paint: {
            style: "stroke",
            color: bindParam(tint, id, "tint"),
            strokeWidth: bindParam(num(P.stroke), id, "stroke"),
            strokeCap: "round",
            strokeJoin: "round",
            pathEffects: [{ k: "trim", start: s(0), end: bindParam(gain, id, "gain") }],
            colorFilters: [
              { k: "matrix", m: s([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]) },
              { k: "blend", color: s([1, 0, 0, 0.25] as RGBA), mode: "multiply" },
              { k: "lerp", t: s(0.5), a: { k: "luma" }, b: { k: "linearToSrgb" } },
              { k: "srgbToLinear" },
            ],
          },
        },
        {
          k: "shape",
          geom: { k: "rect", x: s(-100), y: s(-100), w: s(60), h: s(40) },
          paint: {
            style: "fill",
            shader: { k: "radial", c: [s(-70), s(-80)], r: R, stops: [{ pos: s(0), color: s([1, 1, 1, 1] as RGBA) }, { pos: s(1), color: s([0, 0, 0, 0] as RGBA) }] },
          },
        },
        {
          k: "shape",
          geom: { k: "rect", x: s(20), y: s(-100), w: s(80), h: s(40), r: s(8) },
          paint: { style: "fill", color: s([0.2, 0.8, 0.4, 1] as RGBA), antiAlias: true },
        },
        {
          k: "shape",
          geom: { k: "oval", x: s(-100), y: s(40), w: s(80), h: s(50) },
          paint: {
            style: "fill",
            shader: { k: "sweep", c: [s(-60), s(65)], start: s(0), end: s(Math.PI), stops: [{ pos: s(0), color: bindParam(tint, id, "tint") }, { pos: s(1), color: s([0, 0, 1, 1] as RGBA) }] },
          },
        },
        {
          k: "shape",
          geom: { k: "line", p1: [s(0), s(0)], p2: [R, s(0)] },
          paint: {
            style: "stroke",
            strokeWidth: s(2),
            color: s([1, 1, 1, 1] as RGBA),
            pathEffects: [{ k: "dash", intervals: [s(6), s(4)], phase: bindParam(spin, id, "spin") }, { k: "corner", r: s(3) }],
          },
        },
      ],
    },
    // 2 — matrix + inverted circle clip; generator paths.
    {
      k: "group",
      transform: { matrix: s([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
      clip: { geom: { k: "circle", cx: s(256), cy: s(256), r: s(40) }, invert: true },
      children: [
        {
          k: "shape",
          id,
          geom: { k: "path", d: bindDerived(starPath(256, 256, 120, 50, arms, spin), [ref("spin"), ref("arms")]), fillType: "evenOdd" },
          paint: {
            style: "fill",
            shader: {
              k: "conical",
              c0: [s(256), s(256)],
              r0: s(10),
              c1: [s(256), s(200)],
              r1: s(140),
              stops: [{ pos: s(0), color: s([1, 0.9, 0.2, 1] as RGBA) }, { pos: s(1), color: s([0.9, 0.2, 0.4, 1] as RGBA) }],
              tile: "mirror",
            },
            maskFilter: { k: "blur", sigma: s(2), style: "solid" },
            pathEffects: [{ k: "discrete", length: s(10), deviation: s(1.5), seed: 7 }],
          },
        },
        {
          k: "shape",
          id,
          geom: { k: "path", d: bindDerived(polygonPath(120, 120, 50, num(P.steps, 3)), [ref("steps")]) },
          paint: {
            style: "stroke",
            strokeWidth: s(3),
            color: s([0.4, 0.9, 1, 1] as RGBA),
            // Two trims compose: [0, 0.75] then [0.2, 1] of what is left.
            pathEffects: [{ k: "trim", start: s(0), end: s(0.75) }, { k: "trim", start: s(0.2), end: bindParam(gain + 0.25, id, "gain") }],
          },
        },
        {
          k: "shape",
          id,
          geom: { k: "path", d: bindDerived(starPath(120, 400, 40, 18, arms, 0), [ref("arms")]) },
          paint: { style: "fill", color: s([1, 1, 1, 0.8] as RGBA), blendMode: "plus" },
        },
        {
          k: "shape",
          id,
          geom: { k: "points", pts: bindDerived(pts, [ref("spin")]), mode: "polygon" },
          paint: { style: "stroke", strokeWidth: s(2), color: s([1, 0.5, 0, 1] as RGBA), pathEffects: [{ k: "trim", start: s(0.1), end: s(0.9) }] },
        },
        {
          k: "shape",
          geom: { k: "points", pts: s([10, 10, 20, 20, 30, 10]), mode: "points" },
          paint: { style: "stroke", strokeWidth: s(4), strokeCap: "round", color: s([1, 1, 1, 1] as RGBA) },
        },
        {
          k: "shape",
          // An open polyline (mode "lines") trimmed: drawn as its open path.
          geom: { k: "points", pts: s([40, 10, 60, 30, 80, 10]), mode: "lines" },
          paint: { style: "stroke", strokeWidth: s(2), color: s([1, 1, 0, 1] as RGBA), pathEffects: [{ k: "trim", start: s(0), end: s(0.5) }] },
        },
        {
          k: "shape",
          id,
          // `deps: []` — derived from the producer's inputs (Skia Shape's
          // spline path): the exporter walks the producer's wires.
          geom: { k: "path", d: bindDerived(starPath(400, 260, 30, 12, 4, spin * 0.5), []) },
          paint: { style: "stroke", strokeWidth: s(4), strokeCap: "round", color: s([1, 1, 1, 1] as RGBA) },
        },
      ],
    },
    // 3 — image.
    { k: "image", id, asset: "logo", x: s(16), y: s(16), w: s(48), h: s(48), fit: "contain" },
    // 4 — centered text whose content changes each frame without tags.
    {
      k: "text",
      id,
      text: s(`frame ${frame}`),
      font: { asset: "inter", size: s(24) },
      x: s(156),
      y: s(480),
      // Single-line text (no width): y is the baseline; align anchors at x.
      align: "center",
      paint: { style: "fill", color: s([1, 1, 1, 1] as RGBA) },
    },
    // 5 — text with a keyframed size.
    {
      k: "text",
      id,
      text: bindParam(String(P.label), id, "label"),
      font: { asset: "inter", size: bindParam(num(P.size, 24), id, "size") },
      x: s(24),
      y: s(110),
      paint: { style: "fill", color: s([1, 1, 1, 1] as RGBA), opacity: s(0.8) },
    },
    // 6 — atlas with derived xforms.
    { k: "atlas", id, asset: "sprites", sprites: [[0, 0, 32, 32], [32, 0, 32, 32]], xforms: bindDerived(xforms, [ref("spin")]) },
    // 7 — image shader fill.
    {
      k: "shape",
      geom: { k: "rect", x: s(400), y: s(16), w: s(96), h: s(96) },
      paint: { style: "fill", shader: { k: "image", asset: "logo", fit: "cover", rect: [s(400), s(16), s(96), s(96)], tile: "repeat" } },
    },
    // 8 — a ref whose value the producer transformed (radius × 2).
    { k: "shape", id, geom: { k: "circle", cx: s(450), cy: s(450), r: bindParam(radius * 2, id, "radius") }, paint: { style: "stroke", strokeWidth: s(1), color: s([1, 1, 1, 0.5] as RGBA) } },
    // 9 — path clip over a solid color shader.
    {
      k: "group",
      clip: { geom: { k: "path", d: s("M400 400 L500 400 L450 500 Z") } },
      children: [{ k: "fill", paint: { style: "fill", shader: { k: "color", color: s([0.1, 0.6, 0.3, 1] as RGBA) }, opacity: bindParam(gain, id, "gain") } }],
    },
    // 10 — a paragraph (width set: top-left at x, y, centered in the width)
    //      whose color is keyframed and whose content changes untagged.
    {
      k: "text",
      id,
      text: s(`para ${frame}`),
      font: { asset: "inter", size: s(20) },
      x: s(156),
      y: s(420),
      width: s(200),
      align: "center",
      paint: { style: "fill", color: bindParam(tint, id, "tint") },
    },
    // 11 — one line at the baseline, right-anchored at x, keyframed size.
    {
      k: "text",
      id,
      text: s("Right"),
      font: { asset: "inter", size: bindParam(num(P.size, 24), id, "size") },
      x: s(500),
      y: s(140),
      align: "right",
      paint: { style: "fill", color: s([1, 1, 1, 1] as RGBA) },
    },
    // 12 — Skia Group's own rounding of a degrees param: (deg · π) / 180,
    //      not deg · (π / 180) — equal to the scaled track within an ulp.
    {
      k: "group",
      id,
      transform: { rotate: { v: (num(P.turn) * Math.PI) / 180, ref: { node: id, param: "turn", scale: Math.PI / 180 } }, origin: [s(256), s(256)] },
      children: [{ k: "shape", geom: { k: "rect", x: s(236), y: s(236), w: s(40), h: s(40) }, paint: { style: "stroke", strokeWidth: s(2) } }],
    },
  ];
  if (P.extra === true) children.push({ k: "fill", paint: { style: "fill", color: s([1, 0, 0, 0.1] as RGBA) } });
  return { k: "group", id, children };
}

const producer: NodeDefinition = {
  type: "test-skia-scene",
  name: "Test Skia Scene",
  category: "utility",
  hidden: true,
  backend: "webgl2",
  // Reads ctx.frame / ctx.time for the untagged values: never cache.
  stable: false,
  inputs: [],
  params: [
    { name: "radius", label: "Radius", type: "scalar", default: 60 },
    { name: "center", label: "Center", type: "vec2", default: [256, 256] },
    { name: "tint", label: "Tint", type: "color", default: "#ff7a45" },
    { name: "stroke", label: "Stroke", type: "scalar", default: 4 },
    { name: "glow", label: "Glow", type: "color", default: "#3355ff" },
    { name: "gain", label: "Gain", type: "scalar", default: 0.5 },
    { name: "spin", label: "Spin", type: "scalar", default: 0 },
    { name: "arms", label: "Arms", type: "scalar", default: 5 },
    { name: "steps", label: "Steps", type: "scalar", default: 3 },
    { name: "size", label: "Size", type: "scalar", default: 24 },
    { name: "label", label: "Label", type: "string", default: "Hello" },
    { name: "extra", label: "Extra", type: "boolean", default: false },
    { name: "turn", label: "Turn (°)", type: "scalar", default: 0 },
    { name: "mode", label: "Mode", type: "enum", options: ["soft", "hard", "wild"], default: "soft" },
    { name: "fail", label: "Fail", type: "boolean", default: false },
    { name: "ink", label: "Ink", type: "color", alpha: true, default: "#ffffff" },
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],
  compute({ params, ctx, nodeId }) {
    // `problems` is SkiaDrawValue's additive producer-failure list.
    const value: SkiaDrawValue = {
      kind: "skia_draw",
      node: buildScene(params, nodeId, ctx.frame, ctx.time),
      assets: SCENE_ASSETS,
      ...(params.fail === true ? { problems: [`Test Skia Scene ${nodeId}: asked to fail`] } : {}),
    };
    return { primary: value };
  },
};

export function registerSceneFixture() {
  if (!getNodeDef(producer.type)) registerNode(producer);
}

const block = (keyframes: Keyframe[], colorSpace?: "oklab" | "rgb"): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes,
  ...(colorSpace ? { colorSpace } : {}),
});

function defaults(type: string): Record<string, unknown> {
  const def = getNodeDef(type);
  if (!def) throw new Error(`scene fixture: no def "${type}"`);
  return Object.fromEntries(def.params.map((p) => [p.name, p.default]));
}

export function sceneFixtureGraph(): { nodes: GraphNode[]; edges: GraphEdge[]; canvasId: string; producerId: string } {
  registerSceneFixture();
  const nodes: GraphNode[] = [
    {
      id: "scene",
      type: "test-skia-scene",
      params: defaults("test-skia-scene"),
      exposedParams: ["stroke", "glow", "gain"],
      animation: {
        radius: block([
          { tick: F(0), value: 40, easingOut: "easeOutBack" },
          { tick: F(20), value: 90, easingOut: "hold" },
          { tick: F(35), value: 70, easingOut: "cubicBezier", bezier: { x1: 0.2, y1: 1.4, x2: 0.4, y2: -0.2 } },
          { tick: F(60), value: 60, easingOut: "linear" },
        ]),
        center: block([
          { tick: F(0), value: [200, 256], easingOut: "customBezier", bezierHandles: { rightHandle: { dx: 9000, dy: 40 }, leftHandle: { dx: -1, dy: 0 } } },
          { tick: F(40), value: [312, 200], easingOut: "easeInOutCubic" },
          { tick: F(60), value: [256, 256], easingOut: "linear" },
        ]),
        tint: block([
          { tick: F(0), value: "#ff7a45", easingOut: "easeInOutQuad" },
          { tick: F(60), value: "#1b2cff", easingOut: "linear" },
        ]),
        spin: block([
          { tick: F(0), value: 0, easingOut: "linear" },
          { tick: F(60), value: Math.PI, easingOut: "linear" },
        ]),
        turn: block([
          { tick: F(0), value: 0, easingOut: "easeInOutSine" },
          { tick: F(60), value: 90, easingOut: "linear" },
        ]),
        steps: block([
          { tick: F(0), value: 3, easingOut: "hold" },
          { tick: F(30), value: 6, easingOut: "linear" },
        ]),
        size: block([
          { tick: F(0), value: 18, easingOut: "easeInOutSine" },
          { tick: F(60), value: 30, easingOut: "linear" },
        ]),
      },
    },
    {
      id: "av",
      type: "animated-value",
      params: defaults("animated-value"),
      animation: {
        value: block([
          { tick: F(0), value: 2, easingOut: "easeOutElastic" },
          { tick: F(45), value: 12, easingOut: "linear" },
        ]),
      },
    },
    {
      id: "col",
      type: "color-literal",
      params: { ...defaults("color-literal"), color: "#3355ff", alpha: 1 },
      animation: {
        color: block(
          [
            { tick: F(0), value: "#3355ff", easingOut: "easeOutCubic" },
            { tick: F(50), value: "#ffd23f", easingOut: "linear" },
          ],
          "rgb"
        ),
      },
    },
    { id: "k", type: "constant", params: { ...defaults("constant"), value: 0.75 } },
    // Skia Canvas params (lane L1): background_on + an alpha color.
    { id: "canvas", type: "skia-canvas", params: { background_on: true, background: "#10203080" } },
  ];
  const edges: GraphEdge[] = [
    { id: "e1", source: "av", sourceHandle: "out:primary", target: "scene", targetHandle: "in:param:stroke" },
    { id: "e2", source: "col", sourceHandle: "out:primary", target: "scene", targetHandle: "in:param:glow" },
    { id: "e3", source: "k", sourceHandle: "out:primary", target: "scene", targetHandle: "in:param:gain" },
    { id: "e4", source: "scene", sourceHandle: "out:primary", target: "canvas", targetHandle: "in:scene" },
  ];
  return { nodes, edges, canvasId: "canvas", producerId: "scene" };
}

// A scene with nothing animated: the bundle must not touch the clock.
export function staticSceneFixture(): { scene: import("@/engine/skia/scene-ir").SkiaScene } {
  const s = <T>(v: T): Bind<T> => bindStatic(v);
  return {
    scene: {
      version: 1,
      width: 256,
      height: 128,
      background: [0.02, 0.02, 0.05, 1],
      assets: {},
      root: {
        k: "group",
        children: [
          { k: "shape", geom: { k: "circle", cx: s(64), cy: s(64), r: s(40) }, paint: { style: "fill", color: s([1, 0.4, 0.2, 1] as RGBA) } },
          { k: "shape", geom: { k: "path", d: s("M150 20 L230 64 L150 108 Z") }, paint: { style: "stroke", strokeWidth: s(4), color: s([0.3, 0.7, 1, 1] as RGBA), strokeJoin: "round" } },
        ],
      },
    },
  };
}
