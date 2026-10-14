// The warp family's compare:skia fixture (specdocs/101326_skia-target.md §7
// Wave 2, family F3): every warp node beside its Skia-layer port, fed the
// SAME upstream (native Noise vs Noise (Skia), proven equal within 1/255 by
// the aurora fixtures) and driven by the SAME Animated Value drivers, so the
// warp is the only thing compared. Each port runs through Skia Fill → Skia
// Canvas, the path that ships:
//
//   pair  native (A)            port (B)      what it exercises
//   xf    transform    xf_n     xf_c          rotate (deg, animated), translate (animated), non-uniform scale, off-center pivot, tile + unfold, uneven extents
//   mr    mirror       mr_n     mr_c          radial ×7 + kaleidoscope (14 taps over a 30%-alpha noise), center animated
//   mb    mirror       mb_n     mb_c          bisect keep −y, center animated, includeSource
//   pr    polar-coords pr_n     pr_c          rect-to-polar, rotation animated, radius 1.3, wrap mirror
//   pp    polar-coords pp_n     pp_c          polar-to-rect, radius animated, wrap transparent
//   px    pixelate     px_n     px_c          size animated, circle cells, aspect 1.4, opacity 0.85
//   ar    array        ar_n     ar_c          4×3 fit grid, pattern offset, copy offset / scale, localRotate animated, mod_rot wired
//   ch    transform(mirror)     ch_c          gather of gather: mirror both → transform
//   nz    noise        noise    nz_c          no warp: the upstream floor every pair sits on
//
//   npm run compare:skia -- --a warp:xf_n --b warp:xf_c
//
// The canvas is 512×320 so every aspect term (Mirror's isotropic rotation,
// Pixelate's pixel cells, Polar's per-axis radius) is exercised.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { EasingPreset, KeyframeAnimationBlock } from "@/engine/keyframes";
import type { SkiaGraphFixture } from "../../skia/fixture";

export const WARP_TIMELINE = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 120_000 };
export const WARP_FRAMES = [0, 30, 60, 90, 120];
export const WARP_SIZE: [number, number] = [512, 320];

// Native id / port canvas id per pair, for the gate and the report.
export const WARP_PAIRS = [
  { pair: "xf", native: "xf_n", port: "xf_s", canvas: "xf_c", type: "transform" },
  { pair: "mr", native: "mr_n", port: "mr_s", canvas: "mr_c", type: "mirror" },
  { pair: "mb", native: "mb_n", port: "mb_s", canvas: "mb_c", type: "mirror" },
  { pair: "pr", native: "pr_n", port: "pr_s", canvas: "pr_c", type: "polar-coords" },
  { pair: "pp", native: "pp_n", port: "pp_s", canvas: "pp_c", type: "polar-coords" },
  { pair: "px", native: "px_n", port: "px_s", canvas: "px_c", type: "pixelate" },
  { pair: "ar", native: "ar_n", port: "ar_s", canvas: "ar_c", type: "array" },
  { pair: "ch", native: "ch_n", port: "ch_s", canvas: "ch_c", type: "transform" },
] as const;

type K = [frame: number, value: number, easing: EasingPreset];
const block = (keys: K[]): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes: keys.map(([f, value, easingOut]) => ({ tick: f * 1000, value, easingOut })),
});
const driver = (id: string, keys: K[]): GraphNode => ({
  id,
  type: "animated-value",
  params: { value: keys[0][1], unit: "frames" },
  animation: { value: block(keys) },
});

const NOISE = {
  type: "simplex",
  scale: 4,
  octaves: 4,
  persistence: 0.5,
  lacunarity: 2,
  offset_x: 0.3,
  offset_y: -0.2,
  seed: 2,
  contrast: 1.3,
  color_a: "#1b2cff",
  color_b: "#ffd23f",
  alpha: 1,
};
// Translucent copy for the radial mirror, so all 14 copies composite
// (with an opaque source the last copy inside the canvas would win).
const GLASS_NOISE = { ...NOISE, alpha: 0.3 };
// The array's rotation modulator: a second, coarser field.
const MOD_NOISE = { ...NOISE, scale: 2, seed: 7, contrast: 1, color_a: "#000000", color_b: "#ffffff" };

// Per pair: the warp's params (shared by native and port), the drivers
// wired into both, and the native / port types.
interface Warp {
  pair: string;
  native: string;
  port: string;
  params: Record<string, unknown>;
  drive: Record<string, string>;
  input: string;
  // Upstream pair: [native, port] (default the opaque noise).
  src?: [string, string];
}

const WARPS: Warp[] = [
  {
    pair: "xf",
    native: "transform",
    port: "skia-transform",
    input: "image",
    params: {
      translateX: 0,
      translateY: 0.06,
      scaleX: 0.6,
      scaleY: 0.75,
      rotate: 0,
      pivotX: 0.4,
      pivotY: 0.55,
      tile: true,
      tileLeft: 1,
      tileRight: 0.5,
      tileUp: 1.5,
      tileDown: 0.25,
      tileUnfold: true,
    },
    drive: { rotate: "rot", translateX: "tx" },
  },
  {
    pair: "mr",
    native: "mirror",
    port: "skia-mirror",
    input: "source",
    params: { mode: "radial", keep: "x", centerX: 0.5, centerY: 0.45, count: 7, kaleidoscope: true, includeSource: true },
    drive: { centerX: "cx" },
    src: ["glass", "skglass"],
  },
  {
    pair: "mb",
    native: "mirror",
    port: "skia-mirror",
    input: "source",
    params: { mode: "bisect", keep: "-y", centerX: 0.5, centerY: 0.5, count: 6, kaleidoscope: false, includeSource: true },
    drive: { centerY: "cy" },
  },
  {
    pair: "pr",
    native: "polar-coords",
    port: "skia-polar-coords",
    input: "image",
    params: { mode: "rect-to-polar", center_x: 0.45, center_y: 0.52, rotation: 0, scale_radius: 1.3, wrap: "mirror" },
    drive: { rotation: "prot" },
  },
  {
    pair: "pp",
    native: "polar-coords",
    port: "skia-polar-coords",
    input: "image",
    params: { mode: "polar-to-rect", center_x: 0.5, center_y: 0.5, rotation: 0.4, scale_radius: 0.6, wrap: "transparent" },
    drive: { scale_radius: "rad" },
  },
  {
    pair: "px",
    native: "pixelate",
    port: "skia-pixelate",
    input: "image",
    params: { size: 9, shape: "circle", aspect: 1.4, opacity: 0.85 },
    drive: { size: "size" },
  },
  {
    pair: "ar",
    native: "array",
    port: "skia-array",
    input: "instance",
    params: {
      mode: "image",
      distribution: "grid",
      countX: 4,
      countY: 3,
      sizeMode: "fit",
      sizeW: 0.333,
      sizeH: 0.333,
      patternOffsetX: 0.05,
      patternOffsetY: -0.04,
      localX: 0.05,
      localY: -0.03,
      localRotate: 0,
      localScaleX: 0.8,
      localScaleY: 0.9,
      modScaleAmount: 1,
      modPosAmount: 0.25,
      modRotAmount: 40,
    },
    drive: { localRotate: "lrot" },
  },
];

// The port params each pair's drivers animate (the export gate expects
// each to ship as a track).
export function warpDrivenParams(pair: string): string[] {
  if (pair === "ch") return ["rotate"];
  return Object.keys(WARPS.find((w) => w.pair === pair)?.drive ?? {});
}

export function warpGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    driver("rot", [[0, 0, "easeInOutCubic"], [60, 90, "easeOutBack"], [120, -30, "linear"]]),
    driver("tx", [[0, 0, "easeInOutSine"], [120, 0.2, "linear"]]),
    driver("cx", [[0, 0.4, "easeInOutQuad"], [120, 0.62, "linear"]]),
    driver("cy", [[0, 0.38, "easeOutCubic"], [120, 0.6, "linear"]]),
    driver("prot", [[0, 0, "linear"], [120, 2.4, "linear"]]),
    driver("rad", [[0, 0.45, "easeInOutCubic"], [120, 0.75, "linear"]]),
    driver("size", [[0, 9, "easeInQuad"], [120, 24, "linear"]]),
    driver("lrot", [[0, 0, "easeInOutSine"], [120, 75, "linear"]]),
    { id: "noise", type: "noise", params: { ...NOISE } },
    { id: "skn", type: "skia-noise", params: { ...NOISE } },
    { id: "glass", type: "noise", params: { ...GLASS_NOISE } },
    { id: "skglass", type: "skia-noise", params: { ...GLASS_NOISE } },
    { id: "mod_noise", type: "noise", params: { ...MOD_NOISE } },
    { id: "mod_skn", type: "skia-noise", params: { ...MOD_NOISE } },
  ];
  const edges: GraphEdge[] = [];
  const e = (source: string, target: string, targetHandle: string) =>
    edges.push({ id: `${source}->${target}:${targetHandle}`, source, sourceHandle: "out:primary", target, targetHandle });
  // Port tail: shader → Skia Fill → Skia Canvas (`<pair>_c`).
  const tail = (pair: string, port: string) => {
    nodes.push(
      { id: `${pair}_f`, type: "skia-fill", params: { color: "#ffffff", opacity: 1, blendMode: "srcOver" } },
      { id: `${pair}_c`, type: "skia-canvas", params: { background_on: false } }
    );
    e(port, `${pair}_f`, "in:shader");
    e(`${pair}_f`, `${pair}_c`, "in:scene");
  };

  for (const w of WARPS) {
    const exposed = Object.keys(w.drive);
    nodes.push(
      { id: `${w.pair}_n`, type: w.native, params: { ...w.params }, exposedParams: exposed },
      { id: `${w.pair}_s`, type: w.port, params: { ...w.params }, exposedParams: exposed }
    );
    const [srcN, srcS] = w.src ?? ["noise", "skn"];
    e(srcN, `${w.pair}_n`, `in:${w.input}`);
    e(srcS, `${w.pair}_s`, `in:${w.input}`);
    for (const [param, d] of Object.entries(w.drive)) {
      e(d, `${w.pair}_n`, `in:param:${param}`);
      e(d, `${w.pair}_s`, `in:param:${param}`);
    }
    tail(w.pair, `${w.pair}_s`);
  }
  // Array's rotation modulator, the same field on both sides.
  e("mod_noise", "ar_n", "in:mod_rot");
  e("mod_skn", "ar_s", "in:mod_rot");

  // Gather of gather: Mirror (both, off-center, no source) → Transform.
  const chMirror = { mode: "both", keep: "x", centerX: 0.42, centerY: 0.56, count: 6, kaleidoscope: false, includeSource: false };
  const chXf = { translateX: 0.05, translateY: 0, scaleX: 1.25, scaleY: 1.25, rotate: 0, pivotX: 0.5, pivotY: 0.5, tile: false, tileLeft: 1, tileRight: 1, tileUp: 1, tileDown: 1, tileUnfold: false };
  nodes.push(
    { id: "ch_mn", type: "mirror", params: chMirror },
    { id: "ch_ms", type: "skia-mirror", params: chMirror },
    { id: "ch_n", type: "transform", params: chXf, exposedParams: ["rotate"] },
    { id: "ch_s", type: "skia-transform", params: chXf, exposedParams: ["rotate"] }
  );
  e("noise", "ch_mn", "in:source");
  e("ch_mn", "ch_n", "in:image");
  e("rot", "ch_n", "in:param:rotate");
  e("skn", "ch_ms", "in:source");
  e("ch_ms", "ch_s", "in:image");
  e("rot", "ch_s", "in:param:rotate");
  tail("ch", "ch_s");

  // The floor every pair sits on: the upstream alone (noise vs nz_c).
  tail("nz", "skn");
  return { nodes, edges };
}

export const fixture: SkiaGraphFixture = {
  description: "Warps: native transform / mirror / polar-coords / pixelate / array (`<pair>_n`) vs their Skia ports through Skia Fill → Skia Canvas (`<pair>_c`), same Noise upstream and drivers",
  timeline: WARP_TIMELINE,
  frames: WARP_FRAMES,
  size: WARP_SIZE,
  build: () => warpGraph(),
};
