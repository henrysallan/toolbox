// The color family's compare:skia fixture (specdocs/101326_skia-target.md
// §7 Wave 2, family 2): every Skia port beside the native node it mirrors,
// fed the same picture. Each pair `<id>` is
//
//   <id>_n   the native node (fed by a native source)
//   <id>_c   Skia Canvas ← Skia Fill ← the port (fed by the source's port)
//
//   npm run compare:skia -- --a color:<id>_n --b color:<id>_c
//
// Sources (proven first, then reused): `noise` (simplex, black → white —
// a luminance field), `rainbow` (multipoint gradient: red / green / blue /
// yellow points — a color field) and `ramp` (black → white linear gradient
// along x). The native side reads each through the engine's RGBA16F
// textures, the port fuses it into the same runtime shader.
//
// Animated: the wave's angle, the threshold, a multipoint point's x
// (gpoint_x), a ramp stop's color (ramp_c) and a color-correction wheel —
// compare frames 0 / 30 / 60 cover them.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { EasingPreset, KeyframeAnimationBlock } from "@/engine/keyframes";
import type { SkiaGraphFixture } from "../../skia/fixture";

export const COLOR_TIMELINE = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 60_000 };
export const COLOR_FRAMES = [0, 30, 60];

type K = [frame: number, value: number | string, easing?: EasingPreset];
export const keys = (k: K[]): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes: k.map(([f, value, easingOut]) => ({ tick: f * 1000, value, easingOut: easingOut ?? "easeInOutCubic" })),
});

export const NOISE_PARAMS = {
  type: "simplex",
  scale: 3,
  octaves: 4,
  persistence: 0.5,
  lacunarity: 2,
  offset_x: 0.2,
  offset_y: -0.1,
  seed: 0,
  w: 0,
  contrast: 1.3,
  color_a: "#000000",
  color_b: "#ffffff",
  alpha: 1,
};

export const RAINBOW_POINTS = [
  { id: "gp-r", x: 0.2, y: 0.75, color: "#ff2a2a" },
  { id: "gp-g", x: 0.8, y: 0.7, color: "#21d13b" },
  { id: "gp-b", x: 0.45, y: 0.2, color: "#2a4bff" },
  { id: "gp-y", x: 0.85, y: 0.15, color: "#ffd21f" },
];

const RAMP_STOPS = [
  { id: "s0", position: 0.05, color: "#101a5e" },
  { id: "s1", position: 0.35, color: "#e8327c" },
  { id: "s2", position: 0.6, color: "#ffd43b", alpha: 0.8 },
  { id: "s3", position: 0.9, color: "#2fd6a0" },
];

const S_CURVE = [
  { id: "c0", x: 0, y: 0 },
  { id: "c1", x: 0.25, y: 0.15 },
  { id: "c2", x: 0.7, y: 0.85 },
  { id: "c3", x: 1, y: 1 },
];
const RED_CURVE = [
  { id: "r0", x: 0, y: 0.1 },
  { id: "r1", x: 0.5, y: 0.62 },
  { id: "r2", x: 1, y: 0.9 },
];
const ID = (p: string) => [
  { id: `${p}0`, x: 0, y: 0 },
  { id: `${p}1`, x: 1, y: 1 },
];

type Source = "noise" | "rainbow" | "ramp" | null;

interface Pair {
  id: string;
  type: string;
  params: Record<string, unknown>;
  animation?: Record<string, KeyframeAnimationBlock>;
  src: Source;
  // A second shader input (Gradient's angle mod): native image ↔ port shader.
  extra?: { socket: string; src: Exclude<Source, null> };
}

// One entry per compared pair (the gate exports every port's graph too).
export const COLOR_PAIRS: Pair[] = [
  // ---- generators -----------------------------------------------------------------
  { id: "solid", type: "solid-color", params: { color: "#3a7bd5", alpha: 0.7, opacity: 0.8 }, src: null },
  { id: "grad_linear", type: "gradient", params: { mode: "linear", color_a: "#0b1d51", color_b: "#ffb347", start_x: 0.1, start_y: 0.2, end_x: 0.85, end_y: 0.9, softness: 0.6 }, src: null },
  { id: "grad_mod", type: "gradient", params: { mode: "linear", color_a: "#000000", color_b: "#ffffff", start_x: 0.2, start_y: 0.5, end_x: 0.8, end_y: 0.5, angle_mod_amount: 40 }, src: null, extra: { socket: "angle_mod", src: "noise" } },
  { id: "grad_radial", type: "gradient", params: { mode: "radial", color_a: "#fff1c1", color_b: "#3b0a45", center_x: 0.4, center_y: 0.55, radius: 0.6, softness: 1.7, alpha: 0.9 }, src: null },
  { id: "grad_polar", type: "gradient", params: { mode: "polar", color_a: "#ff0066", color_b: "#00e0ff", center_x: 0.55, center_y: 0.45, angle_offset: 30 }, src: null },
  {
    id: "grad_wave",
    type: "gradient",
    params: { mode: "wave", wave_mode: "linear", color_a: "#1a1a1a", color_b: "#f5f5f5", frequency: 5, phase: 40, angle: 20 },
    animation: { angle: keys([[0, 20], [60, 110]]) },
    src: null,
  },
  { id: "grad_ring", type: "gradient", params: { mode: "wave", wave_mode: "ring", color_a: "#002b36", color_b: "#b58900", center_x: 0.5, center_y: 0.5, frequency: 7, phase: 90, opacity: 0.75 }, src: null },
  {
    id: "grad_multi",
    type: "gradient",
    params: { mode: "multipoint", points: RAINBOW_POINTS, idw_power: 2.5 },
    animation: { "gpoint_x:gp-b": keys([[0, 0.45], [60, 0.15]]) },
    src: null,
  },

  // ---- Color Ramp: the modes Wave 2 added -------------------------------------------
  { id: "ramp_cardinal", type: "color-ramp", params: { stops: RAMP_STOPS, interpolation: "cardinal", space: "srgb" }, src: "noise" },
  { id: "ramp_monotone", type: "color-ramp", params: { stops: RAMP_STOPS, interpolation: "monotone", space: "linear" }, src: "noise" },
  { id: "ramp_bspline", type: "color-ramp", params: { stops: RAMP_STOPS, interpolation: "bspline", space: "oklab", offset: 0.3 }, src: "noise" },
  { id: "ramp_smooth", type: "color-ramp", params: { stops: RAMP_STOPS, interpolation: "smooth", space: "srgb" }, src: "noise" },
  {
    id: "ramp_oklch",
    type: "color-ramp",
    params: { stops: RAMP_STOPS, interpolation: "linear", space: "oklch" },
    animation: { "ramp_c:stops:s1": keys([[0, "#e8327c"], [60, "#3dd5ff"]]) },
    src: "noise",
  },
  { id: "ramp_oklch_long", type: "color-ramp", params: { stops: RAMP_STOPS.slice(0, 3), interpolation: "monotone", space: "oklch_long" }, src: "noise" },
  { id: "ramp_smooth_oklch", type: "color-ramp", params: { stops: RAMP_STOPS, interpolation: "smooth", space: "oklch" }, src: "noise" },

  // ---- modifiers ----------------------------------------------------------------------
  {
    id: "cc",
    type: "color-correction",
    params: {
      hue: 25, saturation: 1.3, contrast: 1.15, brightness: 0.03, temp: 0.3, tint: -0.15, pivot: 0.45, md: 0.4, boffset: 0.05,
      darkX: 0.2, darkY: -0.3, darkLum: 0.1, darkSat: 1.2, shadowX: -0.3, shadowY: 0.1, shadowExp: 0.2,
      lightX: 0.1, lightY: 0.4, lightLum: -0.1, lightExp: -0.3, lightSat: 0.8, globalExp: 0.1, globalSat: 1.1,
      curves: { rgb: S_CURVE, r: RED_CURVE, g: ID("g"), b: ID("b") },
    },
    animation: { darkX: keys([[0, 0.2], [60, -0.4]]) },
    src: "rainbow",
  },
  { id: "curves", type: "rgb-curves", params: { curves: { rgb: S_CURVE, r: RED_CURVE, g: [{ id: "g0", x: 0, y: 0.2 }, { id: "g1", x: 0.4, y: 0.3 }, { id: "g2", x: 1, y: 1 }], b: ID("b") } }, src: "rainbow" },
  { id: "post_rgb", type: "posterize", params: { levels: 5, channels: "rgb", gamma: 1.4, opacity: 0.9 }, src: "rainbow" },
  { id: "post_luma", type: "posterize", params: { levels: 4, channels: "luma", gamma: 0.8 }, src: "noise" },
  { id: "thr_hard", type: "threshold", params: { threshold: 0.5, softness: 0 }, animation: { threshold: keys([[0, 0.35], [60, 0.65]]) }, src: "noise" },
  { id: "thr_soft", type: "threshold", params: { threshold: 0.45, softness: 0.25, invert: true }, src: "rainbow" },
  { id: "csp_default", type: "color-space-transform", params: { from: "Linear sRGB", to: "sRGB", view: "None" }, src: "rainbow" },
  { id: "csp_aces", type: "color-space-transform", params: { from: "ACEScg", to: "sRGB", view: "ACES" }, src: "rainbow" },
  { id: "csp_agx", type: "color-space-transform", params: { from: "sRGB", to: "Display P3", view: "AgX", opacity: 0.85 }, src: "rainbow" },
  // Hable's curve has a pole at negative linear input, so Filmic is compared
  // on an in-gamut conversion; ACES2065-1 (the composite AP0 matrix) without a view.
  { id: "csp_filmic", type: "color-space-transform", params: { from: "sRGB", to: "Rec.709", view: "Filmic" }, src: "rainbow" },
  { id: "csp_ap0", type: "color-space-transform", params: { from: "ACES2065-1", to: "Gamma 2.2", view: "None" }, src: "rainbow" },
  { id: "key_luma", type: "keyer", params: { mode: "luma", threshold: 0.45, softness: 0.2 }, src: "noise" },
  { id: "key_color", type: "keyer", params: { mode: "color", key_color: "#ff2a2a", tolerance: 0.25, softness: 0.15, spill: 0.6 }, src: "rainbow" },
  { id: "key_chroma", type: "keyer", params: { mode: "chroma", key_color: "#21d13b", tolerance: 0.15, softness: 0.1, spill: 1, invert: true }, src: "rainbow" },
  { id: "key_sample", type: "keyer", params: { mode: "sample", sample_colors: ["#2a4bff", "#ffd21f"], tolerance: 0.2, softness: 0.1, spill: 0.5 }, src: "rainbow" },
  { id: "dither_bw", type: "dither", params: { algorithm: "ordered", pixel_scale: 1, threshold: 128 }, src: "noise" },
  { id: "dither_color", type: "dither", params: { algorithm: "ordered", pixel_scale: 3, color_mode: true, levels: 3 }, src: "rainbow" },
  { id: "dither_thr", type: "dither", params: { algorithm: "threshold", pixel_scale: 2, threshold: 100 }, src: "ramp" },
  { id: "dither_ps2", type: "dither", params: { algorithm: "ordered", pixel_scale: 2, threshold: 140 }, src: "ramp" },
];

const SOURCES: Record<Exclude<Source, null>, { type: string; params: Record<string, unknown> }> = {
  noise: { type: "noise", params: NOISE_PARAMS },
  rainbow: { type: "gradient", params: { mode: "multipoint", points: RAINBOW_POINTS, idw_power: 2.5 } },
  ramp: { type: "gradient", params: { mode: "linear", color_a: "#000000", color_b: "#ffffff", start_x: 0, start_y: 0.5, end_x: 1, end_y: 0.5 } },
};

const edge = (source: string, target: string, targetHandle: string): GraphEdge => ({
  id: `${source}->${target}:${targetHandle}`,
  source,
  sourceHandle: "out:primary",
  target,
  targetHandle,
});

// The port + Skia Fill + Skia Canvas for one pair (the gate reuses it).
export function portChain(p: Pair, srcPort: (s: Exclude<Source, null>) => string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    { id: `${p.id}_s`, type: `skia-${p.type}`, params: { ...p.params }, ...(p.animation ? { animation: p.animation } : {}) },
    { id: `${p.id}_f`, type: "skia-fill", params: { color: "#ffffff", opacity: 1, blendMode: "srcOver" } },
    { id: `${p.id}_c`, type: "skia-canvas", params: { background_on: false } },
  ];
  const edges: GraphEdge[] = [edge(`${p.id}_s`, `${p.id}_f`, "in:shader"), edge(`${p.id}_f`, `${p.id}_c`, "in:scene")];
  if (p.src) edges.push(edge(srcPort(p.src), `${p.id}_s`, "in:image"));
  if (p.extra) edges.push(edge(srcPort(p.extra.src), `${p.id}_s`, `in:${p.extra.socket}`));
  return { nodes, edges };
}

export function colorGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const [name, s] of Object.entries(SOURCES)) {
    nodes.push({ id: `src_${name}_n`, type: s.type, params: { ...s.params } });
    nodes.push({ id: `src_${name}_s`, type: `skia-${s.type}`, params: { ...s.params } });
    // Each source compared on its own, through Fill + Canvas.
    nodes.push({ id: `src_${name}_f`, type: "skia-fill", params: { color: "#ffffff", opacity: 1, blendMode: "srcOver" } });
    nodes.push({ id: `src_${name}_c`, type: "skia-canvas", params: { background_on: false } });
    edges.push(edge(`src_${name}_s`, `src_${name}_f`, "in:shader"), edge(`src_${name}_f`, `src_${name}_c`, "in:scene"));
  }
  for (const p of COLOR_PAIRS) {
    nodes.push({ id: `${p.id}_n`, type: p.type, params: { ...p.params }, ...(p.animation ? { animation: p.animation } : {}) });
    if (p.src) edges.push(edge(`src_${p.src}_n`, `${p.id}_n`, "in:image"));
    if (p.extra) edges.push(edge(`src_${p.extra.src}_n`, `${p.id}_n`, `in:${p.extra.socket}`));
    const chain = portChain(p, (s) => `src_${s}_s`);
    nodes.push(...chain.nodes);
    edges.push(...chain.edges);
  }
  return { nodes, edges };
}

export const fixture: SkiaGraphFixture = {
  description: "Color family: each native color node (`<id>_n`) vs its Skia port through Skia Fill → Skia Canvas (`<id>_c`), same sources",
  timeline: COLOR_TIMELINE,
  frames: COLOR_FRAMES,
  size: [400, 300],
  build: () => colorGraph(),
};
