// The noise & fields family (specdocs/101326_skia-target.md §7 Wave 2,
// family 1) against the native nodes it mirrors. Every pair is the native
// node beside the Skia-layer chain port → Skia Fill → Skia Canvas (what
// ships), on the SAME Animated Value drivers, at non-default params:
//
//   npm run compare:skia -- --a noise:n_<case> --b noise:c_<case> [--expect …]
//
// Cases (n_<case> native, k_<case> port, f_/c_ its fill and canvas):
//   perlin simplex value opensimplex os2 os2s supersimplex deriv flow curl
//   phasor        one per Noise type; scale, offset_x, contrast, w driven
//                 (flow: flow_time; phasor: phasor_orientation too)
//   loop_simplex loop_flow loop_curl loop_phasor
//                 animated=true (the looping evolution off the shader clock)
//   alpha         value noise at alpha 0.6, opacity 0.75
//   tc            Texture Coordinate → Noise's UV input (perlin)
//   warp          simplex Noise → value Noise's UV (domain warp)
//   lya           Lyapunov, signed, a_min driven            (--expect close)
//   lya_exp       Lyapunov, exponent mode, custom sequence, warmup +
//                 iterations over the 1024-step cap
//   lya_tc        Texture Coordinate → Lyapunov's UV input  (--expect close)
//   cells_circle  Shape Cells, hash-free layout (one shape, one locked copy,
//   cells_tri     one-stop ramp): geometry + AA vs the GL node
//   cells         Shape Cells defaults: the float hash re-draws every cell,
//                 so this pair is `--expect off` by design
//
// Every other pair is `match`. Lyapunov's chaotic regions amplify any fp32
// difference between the two compiled shaders into a different λ (the
// periodic regions are identical); lya_tc adds the GL node's half-float uv
// texture, which quantizes (a, b) before that amplification.
//
// Canvas 640×360 (non-square: the aspect terms are exercised).

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { EasingPreset, KeyframeAnimationBlock } from "@/engine/keyframes";
import type { SkiaGraphFixture } from "../../skia/fixture";

export const NOISE_TIMELINE = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 300_000 };
export const NOISE_FRAMES = [0, 37, 90, 150, 233, 299];

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

const DRIVERS: GraphNode[] = [
  driver("d_drift", [[0, 0, "linear"], [300, 2.5, "linear"]]),
  driver("d_scale", [[0, 5, "easeInOutCubic"], [150, 7.5, "easeInOutCubic"], [300, 5, "linear"]]),
  driver("d_contrast", [[0, 1.3, "easeInOutSine"], [120, 0.8, "easeInOutSine"], [300, 1.3, "linear"]]),
  driver("d_w", [[0, 0, "linear"], [300, 3.4, "linear"]]),
  driver("d_flow", [[0, 0, "linear"], [300, 6, "linear"]]),
  driver("d_orient", [[0, -30, "easeInOutQuad"], [300, 60, "linear"]]),
  driver("d_amin", [[0, 2.5, "easeInOutSine"], [300, 3.2, "linear"]]),
];

export const NOISE_TYPES = [
  "perlin",
  "simplex",
  "value",
  "opensimplex",
  "opensimplex2",
  "opensimplex2s",
  "super-simplex",
  "perlin-deriv",
  "flow",
  "curl",
  "phasor",
] as const;

// Case names (node ids can't hold ":" or the type's dashes ambiguously).
export const NOISE_CASE: Record<(typeof NOISE_TYPES)[number], string> = {
  perlin: "perlin",
  simplex: "simplex",
  value: "value",
  opensimplex: "opensimplex",
  opensimplex2: "os2",
  opensimplex2s: "os2s",
  "super-simplex": "supersimplex",
  "perlin-deriv": "deriv",
  flow: "flow",
  curl: "curl",
  phasor: "phasor",
};

export const NOISE_BASE = {
  scale: 5,
  octaves: 5,
  persistence: 0.55,
  lacunarity: 2.1,
  offset_x: 0,
  offset_y: -0.7,
  seed: 3,
  w: 0,
  contrast: 1.3,
  flow_time: 0,
  phasor_frequency: 3.5,
  phasor_orientation: -30,
  phasor_isotropy: 0.35,
  color_a: "#1b2a6b",
  color_b: "#ffd27a",
  alpha: 1,
  opacity: 1,
  animated: false,
  anim_start: 10,
  anim_end: 130,
  anim_rate: 1.5,
};

const e = (source: string, target: string, targetHandle: string): GraphEdge => ({
  id: `${source}->${target}:${targetHandle}`,
  source,
  sourceHandle: "out:primary",
  target,
  targetHandle,
});

interface Pair {
  name: string;
  native: GraphNode;
  port: GraphNode;
  // Drivers wired into BOTH as in:param:<param>.
  drive?: [driver: string, param: string][];
  // Upstream sockets: [native source, port source, input socket].
  feed?: [string, string, string][];
}

function noisePair(name: string, params: Record<string, unknown>, drive: [string, string][]): Pair {
  const exposed = drive.map(([, p]) => p);
  return {
    name,
    native: { id: `n_${name}`, type: "noise", params: { ...NOISE_BASE, ...params }, exposedParams: exposed },
    port: { id: `k_${name}`, type: "skia-noise", params: { ...NOISE_BASE, ...params }, exposedParams: exposed },
    drive,
  };
}

const MAIN_DRIVES: [string, string][] = [
  ["d_drift", "offset_x"],
  ["d_scale", "scale"],
  ["d_contrast", "contrast"],
  ["d_w", "w"],
];

const LYA = {
  preset: "AABAB",
  sequence: "AABAB",
  a_min: 2.5,
  a_max: 4,
  b_min: 2.5,
  b_max: 4,
  warmup: 150,
  iterations: 250,
  x0: 0.5,
  color_mode: "signed",
  color_stable: "#f2d14b",
  color_chaos: "#1e3a8a",
  color_div: "#0a0612",
  lambda_neg: 0.7,
  lambda_pos: 0.45,
  lambda_lo: -1,
  lambda_hi: 0.5,
  opacity: 1,
};

const CELLS = {
  rows: 5,
  cols: 9,
  cellSize: 0.8,
  lockBaseShape: true,
  useCircle: true,
  useSquare: true,
  useTriangle: true,
  copiesMin: 1,
  copiesMax: 3,
  scaleMin: 0.15,
  scaleMax: 1,
  ramp: [
    { id: "sc-stop-0", position: 0.0, color: "#e9479f" },
    { id: "sc-stop-1", position: 0.17, color: "#e32826" },
    { id: "sc-stop-2", position: 0.34, color: "#dba232" },
    { id: "sc-stop-3", position: 0.51, color: "#243e8a" },
    { id: "sc-stop-4", position: 0.68, color: "#f4ecd5" },
    { id: "sc-stop-5", position: 0.85, color: "#a8a8b0" },
    { id: "sc-stop-6", position: 1.0, color: "#e9479f" },
  ],
  interpolation: "constant",
  space: "srgb",
  hueShift: 0.17,
  speed: 0.4,
  seed: 42,
  background: "#101018",
  opacity: 1,
};
// Hash-free: every random draw lands on the same result.
const CELLS_FIXED = {
  ...CELLS,
  rows: 4,
  cols: 7,
  cellSize: 0.85,
  copiesMin: 1,
  copiesMax: 1,
  scaleMax: 0.9,
  ramp: [{ id: "one", position: 0.5, color: "#ff7a45" }],
};

function pairs(): Pair[] {
  const out: Pair[] = [];
  for (const type of NOISE_TYPES) {
    const drive = [...MAIN_DRIVES];
    if (type === "flow") drive.push(["d_flow", "flow_time"]);
    if (type === "phasor") drive.push(["d_orient", "phasor_orientation"]);
    out.push(noisePair(NOISE_CASE[type], { type }, drive));
  }
  for (const type of ["simplex", "flow", "curl", "phasor"] as const) {
    const drive: [string, string][] = [["d_scale", "scale"], ["d_contrast", "contrast"]];
    if (type === "phasor") drive.push(["d_orient", "phasor_orientation"]);
    out.push(noisePair(`loop_${type}`, { type, animated: true }, drive));
  }
  out.push(noisePair("alpha", { type: "value", alpha: 0.6, opacity: 0.75 }, MAIN_DRIVES));

  const tc = noisePair("tc", { type: "perlin", scale: 4, seed: 0 }, [["d_drift", "offset_x"]]);
  tc.feed = [["n_tcsrc", "k_tcsrc", "uv_in"]];
  out.push(tc);
  const warp = noisePair("warp", { type: "value", scale: 6, seed: 1 }, [["d_drift", "offset_x"]]);
  warp.feed = [["n_warpsrc", "k_warpsrc", "uv_in"]];
  out.push(warp);

  out.push({
    name: "lya",
    native: { id: "n_lya", type: "lyapunov", params: { ...LYA }, exposedParams: ["a_min"] },
    port: { id: "k_lya", type: "skia-lyapunov", params: { ...LYA }, exposedParams: ["a_min"] },
    drive: [["d_amin", "a_min"]],
  });
  const lyaExp = { ...LYA, preset: "custom", sequence: "BBABAAB", warmup: 700, iterations: 600, color_mode: "exponent", lambda_lo: -1.5, lambda_hi: 0.4, a_min: 3, b_min: 3 };
  out.push({
    name: "lya_exp",
    native: { id: "n_lya_exp", type: "lyapunov", params: lyaExp },
    port: { id: "k_lya_exp", type: "skia-lyapunov", params: lyaExp },
  });
  out.push({
    name: "lya_tc",
    native: { id: "n_lya_tc", type: "lyapunov", params: { ...LYA, preset: "BBABABA" } },
    port: { id: "k_lya_tc", type: "skia-lyapunov", params: { ...LYA, preset: "BBABABA" } },
    feed: [["n_tcsrc", "k_tcsrc", "uv_in"]],
  });

  out.push({
    name: "cells_circle",
    native: { id: "n_cells_circle", type: "shape-cells", params: { ...CELLS_FIXED, useSquare: false, useTriangle: false } },
    port: { id: "k_cells_circle", type: "skia-shape-cells", params: { ...CELLS_FIXED, useSquare: false, useTriangle: false } },
  });
  out.push({
    name: "cells_tri",
    native: { id: "n_cells_tri", type: "shape-cells", params: { ...CELLS_FIXED, useCircle: false, useSquare: false } },
    port: { id: "k_cells_tri", type: "skia-shape-cells", params: { ...CELLS_FIXED, useCircle: false, useSquare: false } },
  });
  out.push({
    name: "cells",
    native: { id: "n_cells", type: "shape-cells", params: { ...CELLS } },
    port: { id: "k_cells", type: "skia-shape-cells", params: { ...CELLS } },
  });
  return out;
}

// Upstream sources the `feed` cases read.
const SOURCES: GraphNode[] = [
  { id: "n_tcsrc", type: "texture-coordinate", params: {} },
  { id: "k_tcsrc", type: "skia-texture-coordinate", params: {} },
  { id: "n_warpsrc", type: "noise", params: { ...NOISE_BASE, type: "simplex", scale: 2, seed: 0, octaves: 3, color_a: "#000000", color_b: "#ffffff", contrast: 1 } },
  { id: "k_warpsrc", type: "skia-noise", params: { ...NOISE_BASE, type: "simplex", scale: 2, seed: 0, octaves: 3, color_a: "#000000", color_b: "#ffffff", contrast: 1 } },
];

export function noiseFamilyGraph(): { nodes: GraphNode[]; edges: GraphEdge[]; cases: string[] } {
  const nodes: GraphNode[] = [...DRIVERS, ...SOURCES];
  const edges: GraphEdge[] = [];
  const cases: string[] = [];
  for (const p of pairs()) {
    cases.push(p.name);
    nodes.push(
      p.native,
      p.port,
      { id: `f_${p.name}`, type: "skia-fill", params: { color: "#ffffff", opacity: 1, blendMode: "srcOver" } },
      { id: `c_${p.name}`, type: "skia-canvas", params: { background_on: false } }
    );
    for (const [d, param] of p.drive ?? []) {
      edges.push(e(d, p.native.id, `in:param:${param}`), e(d, p.port.id, `in:param:${param}`));
    }
    for (const [ns, ks, socket] of p.feed ?? []) {
      edges.push(e(ns, p.native.id, `in:${socket}`), e(ks, p.port.id, `in:${socket}`));
    }
    edges.push(e(p.port.id, `f_${p.name}`, "in:shader"), e(`f_${p.name}`, `c_${p.name}`, "in:scene"));
  }
  return { nodes, edges, cases };
}

export const fixture: SkiaGraphFixture = {
  description: "Noise & fields family: native Noise / Lyapunov / Shape Cells / Texture Coordinate (`n_<case>`) vs the Skia chain port → Skia Fill → Skia Canvas (`c_<case>`), same drivers",
  timeline: NOISE_TIMELINE,
  frames: NOISE_FRAMES,
  size: [640, 360],
  build: () => {
    const { nodes, edges } = noiseFamilyGraph();
    return { nodes, edges };
  },
};
