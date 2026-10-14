// The Skia filter family's parity fixture (specdocs/101326_skia-target.md
// §7 Wave 3, lane F): every filter mirror beside the GL node it mirrors,
// both over the SAME drawing. The content is one Skia-layer drawing (Noise
// (Skia) → Color Ramp (Skia) → Skia Fill background, a rotated orange
// rectangle, a white disc, a cyan ring), drifting so frames differ:
//
//   GL side (…_n)    content → Skia Canvas `src` → the GL node (Blur, Bloom,
//                    Grain, Lens Flare) — the engine's own implementation
//                    over the CanvasKit-rendered content
//   Skia side (…_s)  content → the Skia filter node → its own Skia Canvas
//
// so a pair differs only by the filter.
//
//   npm run compare:skia -- --a filters:blur_lin_n --b filters:blur_lin_s
//   npm run compare:skia -- --a filters:bloom_n --b filters:bloom_s
//
// Skia-only canvases (no toolbox node to mirror; check:skia-filters holds
// them to CPU references): shadow_s, shadow_inner_s, morph_dilate_s,
// morph_erode_s, matrix_s, matrix_custom_s, sksl_s. `native_all_s` stacks
// the web-playable ones (blur, shadow, morphology, colour matrix, keyframed)
// for the harness's ?bundle=filters slot; `runtime_all_s` the runtime ones
// (grain, bloom, SkSL filter, lens flare — native React Native Skia only).

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { KeyframeAnimationBlock } from "@/engine/keyframes";
import { syncChannelInputs } from "@/engine/expr-channels";
import type { SkiaGraphFixture } from "../../skia/fixture";

// 300 frames like the other harness slots (the drawing animates over the
// first 120 and holds); the harness bundle ships the same markers as
// Aurora's (one SegmentName type across the slots in App.tsx).
export const FILTERS_TIMELINE = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 300_000 };
export const FILTERS_MARKERS = [
  { id: "mk-intro", name: "intro", frame: 0 },
  { id: "mk-loop", name: "loop", frame: 120 },
  { id: "mk-flash", name: "flash", frame: 150, duration: 30 },
];
// The harness slot (?bundle=filters): the web-playable canvas.
export const FILTERS_HARNESS_CANVAS = "native_all_s";
export const FILTERS_FRAMES = [0, 60, 120];
export const FILTERS_SIZE = 512;

const e = (source: string, target: string, targetHandle: string): GraphEdge => ({
  id: `${source}->${target}:${targetHandle}`,
  source,
  sourceHandle: "out:primary",
  target,
  targetHandle,
});

// [frame, value] keys, eased.
export function keyed(keys: [number, number][], easing = "easeInOutSine"): KeyframeAnimationBlock {
  return {
    animated: true,
    trackVisible: true,
    keyframes: keys.map(([f, value], i) => ({ tick: f * FILTERS_TIMELINE.ticksPerFrame, value, easingOut: (i < keys.length - 1 ? easing : "linear") as "linear" })),
  };
}

const NOISE = {
  type: "simplex",
  scale: 3,
  octaves: 4,
  persistence: 0.5,
  lacunarity: 2,
  offset_x: 0,
  offset_y: 0,
  seed: 4,
  w: 0,
  contrast: 1.3,
  color_a: "#000000",
  color_b: "#ffffff",
  alpha: 1,
};
const RAMP = {
  stops: [
    { id: "r0", position: 0, color: "#081028", alpha: 1 },
    { id: "r1", position: 0.45, color: "#2c2a6e", alpha: 1 },
    { id: "r2", position: 0.8, color: "#7a62d8", alpha: 1 },
    { id: "r3", position: 1, color: "#d8c8ff", alpha: 1 },
  ],
  offset: 0,
  interpolation: "linear",
  space: "srgb",
};

// The params each pair shares (exported for check:skia-filters).
export const BLUR_LIN = { mode: "gaussian", radius: 12, linearize: true };
export const BLUR_SRGB = { mode: "gaussian", radius: 12, linearize: false };
export const BLUR_BIG = { mode: "gaussian", radius: 70, linearize: false };
export const BLOOM_DEFAULT = {
  threshold: 0.7,
  soft_knee: 0.5,
  intensity: 1,
  levels: 6,
  karis_average: true,
  quality: "high",
  anamorphic: 0,
  tint_low: "#ffffff",
  tint_high: "#ffffff",
  tint_amount: 0,
};
export const GRAIN_CLASSIC = { scale: 1, luminance: 0.06, chromatic: 0, seed: 0, mix_mode: "overlay", mix: 1, view: "result" };
export const FLARE_DEFAULT = {
  threshold: 0.8,
  soft_knee: 0.4,
  intensity: 1,
  tint: "#ffffff",
  num_ghosts: 4,
  ghost_dispersal: 0.4,
  chromatic_aberration: 0.015,
  halo_width: 0.5,
  halo_intensity: 1,
  streak_strength: 0.6,
  streak_length: 0.2,
  streak_axis: "horizontal",
};

export const SKSL_FILTER_SOURCE = `// ch("amount", 0.6, 0, 1)
// color("tint", "#ffb070")
half4 main(float2 fragCoord) {
  float4 c = content.eval(fragCoord);
  float2 uv = fragCoord / iResolution.xy;
  float vignette = 1.0 - amount * smoothstep(0.25, 0.75, length(uv - 0.5));
  float3 rgb = mix(c.rgb, c.rgb * tint.rgb, 0.5 * amount) * vignette;
  return half4(float4(rgb, c.a));
}`;

// The source's channels exactly as Sync mints them.
export const SKSL_FILTER_CHANNELS = syncChannelInputs([], SKSL_FILTER_SOURCE);

export function filtersGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const add = (n: GraphNode) => nodes.push(n);

  // ---- the content -------------------------------------------------------------------
  add({
    id: "drift",
    type: "animated-value",
    params: { value: 0, unit: "frames" },
    animation: { value: keyed([[0, 0], [120, 0.5]], "linear") },
  });
  add({ id: "bg_noise", type: "skia-noise", params: { ...NOISE }, exposedParams: ["offset_x"] });
  add({ id: "bg_ramp", type: "skia-color-ramp", params: { ...RAMP } });
  add({ id: "bg", type: "skia-fill", params: { color: "#ffffff", opacity: 1, blendMode: "srcOver" } });
  edges.push(e("drift", "bg_noise", "in:param:offset_x"), e("bg_noise", "bg_ramp", "in:image"), e("bg_ramp", "bg", "in:shader"));
  add({
    id: "rect",
    type: "skia-rect",
    params: { originX: 0.66, originY: 0.62, width: 0.34, height: 0.2, corner_radius: 0.03, rotate: -18, stroke_enabled: false, stroke_thickness: 2, stroke_units: "px", stroke_color: "#ffffff", fill_enabled: true, fill_color: "#ff8a3d", opacity: 1 },
    animation: { rotate: keyed([[0, -18], [120, 12]]) },
  });
  add({
    id: "disc",
    type: "skia-circle",
    params: { centerX: 0.34, centerY: 0.36, radiusX: 0.085, radiusY: 0.085, stroke_enabled: false, stroke_thickness: 2, stroke_units: "px", stroke_color: "#ffffff", fill_enabled: true, fill_color: "#ffffff", opacity: 1 },
  });
  add({
    id: "ring",
    type: "skia-circle",
    params: { centerX: 0.3, centerY: 0.72, radiusX: 0.11, radiusY: 0.11, stroke_enabled: true, stroke_thickness: 6, stroke_units: "px", stroke_color: "#39c6ff", fill_enabled: false, fill_color: "#ffffff", opacity: 1 },
  });
  add({ id: "content", type: "skia-group", params: {} });
  edges.push(e("bg", "content", "in:child1"), e("rect", "content", "in:child2"), e("disc", "content", "in:child3"), e("ring", "content", "in:child4"));
  // What the GL nodes filter: the content rendered by CanvasKit.
  add({ id: "src", type: "skia-canvas", params: { background_on: false } });
  edges.push(e("content", "src", "in:scene"));

  // A GL node over `src` (…_n) and the Skia filter over the content (…_s).
  const pair = (
    name: string,
    glType: string | null,
    glParams: Record<string, unknown> | null,
    skType: string,
    skParams: Record<string, unknown>,
    animation?: GraphNode["animation"]
  ) => {
    if (glType && glParams) {
      add({ id: `${name}_n`, type: glType, params: { ...glParams }, ...(animation ? { animation } : {}) });
      edges.push(e("src", `${name}_n`, "in:image"));
    }
    add({ id: `${name}_f`, type: skType, params: { ...skParams }, ...(animation ? { animation } : {}) });
    add({ id: `${name}_s`, type: "skia-canvas", params: { background_on: false } });
    edges.push(e("content", `${name}_f`, "in:content"), e(`${name}_f`, `${name}_s`, "in:scene"));
  };

  // Blur (Gaussian) — linear light, sRGB, past the GL tap cap, keyframed.
  pair("blur_lin", "blur", BLUR_LIN, "skia-blur", BLUR_LIN);
  pair("blur_srgb", "blur", BLUR_SRGB, "skia-blur", BLUR_SRGB);
  pair("blur_big", "blur", BLUR_BIG, "skia-blur", BLUR_BIG);
  pair("blur_anim", "blur", BLUR_LIN, "skia-blur", BLUR_LIN, { radius: keyed([[0, 2], [120, 24]]) });
  pair("blur_small", "blur", { ...BLUR_LIN, radius: 3 }, "skia-blur", { ...BLUR_LIN, radius: 3 });

  // Bloom — defaults, Karis off, the cheaper qualities, tint + anamorphic.
  pair("bloom", "bloom", BLOOM_DEFAULT, "skia-bloom", BLOOM_DEFAULT);
  pair("bloom_nokaris", "bloom", { ...BLOOM_DEFAULT, karis_average: false }, "skia-bloom", { ...BLOOM_DEFAULT, karis_average: false });
  pair("bloom_bal", "bloom", { ...BLOOM_DEFAULT, quality: "balanced" }, "skia-bloom", { ...BLOOM_DEFAULT, quality: "balanced" });
  pair("bloom_perf", "bloom", { ...BLOOM_DEFAULT, quality: "performance" }, "skia-bloom", { ...BLOOM_DEFAULT, quality: "performance" });
  const tinted = { ...BLOOM_DEFAULT, threshold: 0.55, intensity: 1.4, levels: 5, anamorphic: 0.6, tint_low: "#ffd27a", tint_high: "#5a7dff", tint_amount: 0.8 };
  pair("bloom_tint", "bloom", tinted, "skia-bloom", tinted);
  // Past Skia's 8-bit layers: a bright pass × intensity above 1 clips
  // before its blur (Bloom keeps float16) — the documented limit.
  const hot = { ...BLOOM_DEFAULT, intensity: 4.5 };
  pair("bloom_hot", "bloom", hot, "skia-bloom", hot);

  // Grain (classic) — default overlay, chromatic add, soft-light, the grain
  // view, a keyframed seed.
  const gl = (p: Record<string, unknown>) => ({ preset: "custom", model: "classic", ...p });
  pair("grain", "grain", gl(GRAIN_CLASSIC), "skia-grain", { model: "classic", ...GRAIN_CLASSIC });
  const chr = { ...GRAIN_CLASSIC, scale: 3, luminance: 0.15, chromatic: 0.1, mix_mode: "add" };
  pair("grain_chr", "grain", gl(chr), "skia-grain", { model: "classic", ...chr });
  const soft = { ...GRAIN_CLASSIC, scale: 2, luminance: 0.3, seed: 17, mix_mode: "soft-light", mix: 0.6 };
  pair("grain_soft", "grain", gl(soft), "skia-grain", { model: "classic", ...soft });
  const view = { ...GRAIN_CLASSIC, luminance: 0.2, chromatic: 0.05, view: "grain" };
  pair("grain_view", "grain", gl(view), "skia-grain", { model: "classic", ...view });
  pair("grain_anim", "grain", gl({ ...GRAIN_CLASSIC, luminance: 0.12 }), "skia-grain", { model: "classic", ...GRAIN_CLASSIC, luminance: 0.12 }, { seed: keyed([[0, 0], [120, 240]], "linear") });

  // Lens Flare — defaults, and every ghost + diagonal streak.
  pair("flare", "lens-flare", FLARE_DEFAULT, "skia-lens-flare", FLARE_DEFAULT);
  const diag = { ...FLARE_DEFAULT, threshold: 0.6, num_ghosts: 8, chromatic_aberration: 0.05, halo_width: 0.4, streak_axis: "diagonal", streak_length: 0.3, tint: "#ffe0b0", intensity: 1.3 };
  pair("flare_diag", "lens-flare", diag, "skia-lens-flare", diag);

  // ---- Skia-only filters --------------------------------------------------------------
  pair("shadow", null, null, "skia-drop-shadow", { dx: 10, dy: 14, blur: 18, color: "#000000cc", mode: "drop", shadow_only: false });
  pair("shadow_inner", null, null, "skia-drop-shadow", { dx: 6, dy: 6, blur: 10, color: "#1a0030e6", mode: "inner", shadow_only: false });
  pair("morph_dilate", null, null, "skia-morphology", { op: "dilate", radius: 4 });
  pair("morph_erode", null, null, "skia-morphology", { op: "erode", radius: 3 });
  pair("matrix", null, null, "skia-color-matrix", { mode: "adjust", brightness: 0.05, contrast: 1.2, saturation: 0.4, hue: 35, sepia: 0.2, invert: 0, opacity: 1 });
  pair("matrix_custom", null, null, "skia-color-matrix", { mode: "custom", matrix: "0 0 1 0 0, 0 1 0 0 0, 1 0 0 0 0, 0 0 0 1 0" });
  pair("sksl", null, null, "skia-sksl-filter", {
    expression: SKSL_FILTER_SOURCE,
    inputs: SKSL_FILTER_CHANNELS,
  });

  // ---- stacked canvases (the harness slots / export checks) ------------------------
  // Web-playable: a keyframed blur → a drop shadow → morphology → a
  // keyframed colour matrix, each wrapping the one before.
  const chain = (prefix: string, steps: { type: string; params: Record<string, unknown>; animation?: GraphNode["animation"] }[]) => {
    let prev = "content";
    steps.forEach((s, i) => {
      const id = `${prefix}_${i}`;
      add({ id, type: s.type, params: { ...s.params }, ...(s.animation ? { animation: s.animation } : {}) });
      edges.push(e(prev, id, "in:content"));
      prev = id;
    });
    add({ id: `${prefix}_s`, type: "skia-canvas", params: { background_on: false } });
    edges.push(e(prev, `${prefix}_s`, "in:scene"));
  };
  chain("native_all", [
    { type: "skia-morphology", params: { op: "dilate", radius: 2 }, animation: { radius: keyed([[0, 1], [120, 5]]) } },
    { type: "skia-blur", params: { ...BLUR_SRGB, radius: 6 }, animation: { radius: keyed([[0, 3], [120, 16]]) } },
    { type: "skia-drop-shadow", params: { dx: 8, dy: 10, blur: 14, color: "#000000b3", mode: "drop", shadow_only: false }, animation: { dx: keyed([[0, -10], [120, 12]]) } },
    { type: "skia-color-matrix", params: { mode: "adjust", brightness: 0, contrast: 1.1, saturation: 1.5, hue: 0, sepia: 0, invert: 0, opacity: 1 }, animation: { hue: keyed([[0, 0], [120, 90]]) } },
  ]);
  chain("runtime_all", [
    { type: "skia-grain", params: { model: "classic", ...GRAIN_CLASSIC, luminance: 0.1 }, animation: { seed: keyed([[0, 0], [120, 120]], "linear") } },
    { type: "skia-bloom", params: { ...BLOOM_DEFAULT }, animation: { intensity: keyed([[0, 0.5], [120, 1.5]]) } },
    {
      type: "skia-sksl-filter",
      params: {
        expression: SKSL_FILTER_SOURCE,
        inputs: SKSL_FILTER_CHANNELS,
      },
      animation: { "ch:amount": keyed([[0, 0.2], [120, 0.9]]) },
    },
  ]);
  // Lens flare added over its source: natively Lens Flare → Merge (add)
  // over `src`; in Skia, output: over.
  pair("flare_over", null, null, "skia-lens-flare", { ...FLARE_DEFAULT, output: "over" });
  add({ id: "flare_over_gl", type: "lens-flare", params: { ...FLARE_DEFAULT } });
  add({ id: "flare_over_n", type: "merge", params: { layers: [{ id: "L", mode: "add", opacity: 1 }] } });
  edges.push(e("src", "flare_over_gl", "in:image"), e("src", "flare_over_n", "in:base"), e("flare_over_gl", "flare_over_n", "in:layer:L"));
  return { nodes, edges };
}

export const fixture: SkiaGraphFixture = {
  description:
    "Skia filters: GL Blur / Bloom / Grain / Lens Flare over the CanvasKit-rendered content (…_n) vs their Skia mirrors (…_s); Skia-only Drop Shadow / Morphology / Color Matrix / SkSL Filter canvases",
  timeline: { fps: FILTERS_TIMELINE.fps, ticksPerFrame: FILTERS_TIMELINE.ticksPerFrame },
  frames: FILTERS_FRAMES,
  size: FILTERS_SIZE,
  build: () => filtersGraph(),
};
