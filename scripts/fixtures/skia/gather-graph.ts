// The gather family's compare:skia fixture (specdocs/101326_skia-target.md
// §7 Wave 2, family 4): every gather port beside the GL node it mirrors,
// at non-default params, on the same upstream and the same animated drivers.
//
//   native side   Noise (nA, nB) → <gather> (e.g. `disp`)
//   Skia side     Noise (Skia) (sA, sB) → <gather> (Skia) (`k_disp`)
//                 → Skia Fill (`f_disp`) → Skia Canvas (`c_disp`)
//
// The two noises are equal within 1/255 (Wave 1), so what a pair measures
// is the gather: the GL node samples a fp16 bilinear TEXTURE of its
// upstream, the port re-evaluates the upstream function at the tap.
//
//   npm run compare:skia -- --a gather:disp --b gather:c_disp
//
// Measured 2026-10-13 (512², frames 0/40/80/120, Apple M5 Pro ANGLE Metal):
// all 15 pairs MATCH. Texel-grid ports (sharpen, edge, emboss, kuwahara)
// sit at max 1–2/255; the off-grid ones too, except where the GL node's own
// math is ill-conditioned — Edge Detect's hard threshold (max 11/255) and
// Vector Field's g/|g| at gradient-free points (isolated pixels up to
// 202/255), which Flow Blur and anisotropic Kuwahara inherit through vf.
//
// GATHER_PAIRS lists every pair with the band it is expected in; the gate
// (scripts/check-skia-gather.mts) exports every canvas. Drivers mix both
// binding kinds the exporter reads: Animated Value wires into exposed
// params, and keyframes on the param itself.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { EasingPreset, KeyframeAnimationBlock } from "@/engine/keyframes";
import type { SkiaGraphFixture } from "../../skia/fixture";

export const GATHER_TIMELINE = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 120_000 };
export const GATHER_FRAMES = [0, 40, 80, 120];

type K = [frame: number, value: number, easing: EasingPreset];
const block = (keys: K[]): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes: keys.map(([f, value, easingOut]) => ({ tick: f * GATHER_TIMELINE.ticksPerFrame, value, easingOut })),
});

export interface GatherPair {
  // The node the port mirrors (default-layer GL node).
  native: string;
  // The skia-* port node, and the Skia Canvas that draws it.
  port: string;
  canvas: string;
  type: string;
  // The band compare:skia is expected to land in (scripts/skia-compare.cjs).
  expect: "match" | "close";
  note: string;
}

const NOISE_A = {
  type: "simplex",
  scale: 5,
  octaves: 3,
  persistence: 0.5,
  lacunarity: 2,
  offset_x: 0,
  offset_y: 0.3,
  seed: 2,
  w: 0,
  contrast: 1.3,
  color_a: "#1a2b6d",
  color_b: "#ffcc33",
  alpha: 1,
};
const NOISE_B = { ...NOISE_A, scale: 3, octaves: 2, offset_y: -0.4, seed: 7, contrast: 1, color_a: "#000000", color_b: "#ffffff" };

interface PairSpec {
  id: string;
  type: string;
  params: Record<string, unknown>;
  // Socket → upstream: "A" / "B" (the noises) or another pair's id.
  inputs: Record<string, string>;
  // Exposed param → driver node id.
  drivers?: Record<string, string>;
  animation?: Record<string, KeyframeAnimationBlock>;
  expect: "match" | "close";
  note: string;
}

const PAIRS: PairSpec[] = [
  {
    id: "disp",
    type: "displace",
    params: { amountX: 0.05, amountY: -0.06, channelX: "r", channelY: "luminance", midlevel: 0.45, rotate: true, rotateAmount: 30, wrap: "mirror" },
    inputs: { image: "A", displacement: "B" },
    drivers: { amountX: "d_disp" },
    expect: "match",
    note: "1 off-grid tap: exact function vs bilinear fp16 texel blend",
  },
  {
    id: "ca",
    type: "chromatic-aberration",
    params: { amount: 0.01, mode: "radial", center: [0.35, 0.6], falloff: 1.4, angle: 0, opacity: 0.85 },
    inputs: { image: "A" },
    drivers: { amount: "d_ca" },
    expect: "match",
    note: "3 off-grid taps",
  },
  {
    id: "ca_dir",
    type: "chromatic-aberration",
    params: { amount: 0.012, mode: "directional", center: [0.5, 0.5], falloff: 1, angle: 30, opacity: 1 },
    inputs: { image: "A" },
    animation: { angle: block([[0, 30, "easeInOutSine"], [120, 150, "linear"]]) },
    expect: "match",
    note: "3 off-grid taps",
  },
  {
    id: "shp",
    type: "sharpen",
    params: { algorithm: "unsharp", amount: 1 },
    inputs: { image: "A" },
    drivers: { amount: "d_shp" },
    expect: "match",
    note: "9 taps on texel centres",
  },
  {
    id: "shp_x",
    type: "sharpen",
    params: { algorithm: "cross", amount: 1.5 },
    inputs: { image: "A" },
    expect: "match",
    note: "5 taps on texel centres",
  },
  {
    id: "edge",
    type: "edge-detect",
    params: { algorithm: "prewitt", strength: 3, threshold: 0.04 },
    inputs: { image: "A" },
    drivers: { strength: "d_edge" },
    expect: "match",
    note: "8 taps on texel centres",
  },
  {
    id: "bev",
    type: "bevel-emboss",
    params: {
      style: "emboss",
      depth: 20,
      soften: 2,
      feather: 0,
      l1_angle: 135,
      l1_elevation: 40,
      l1_hi_op: 0.9,
      l1_sh_op: 0.6,
      l2_angle: -30,
      l2_elevation: 55,
      l2_hi_op: 0.4,
      l2_sh_op: 0.3,
      highlight_color: "#fff1c9",
      shadow_color: "#1d1b4f",
      highlight_blend: "add",
      shadow_blend: "color-burn",
    },
    inputs: { image: "A" },
    drivers: { l1_angle: "d_bev" },
    animation: { feather: block([[0, 0, "linear"], [80, 3, "linear"], [120, 3, "linear"]]) },
    expect: "match",
    note: "4 taps (36 once feather ≥ 0.5) at soften- and feather-scaled, off-grid offsets",
  },
  {
    id: "bev_h",
    type: "bevel-emboss",
    params: {
      style: "emboss",
      depth: 12,
      soften: 0,
      feather: 0,
      l1_angle: 60,
      l1_elevation: 25,
      l1_hi_op: 1,
      l1_sh_op: 0.8,
      l2_angle: -45,
      l2_elevation: 60,
      l2_hi_op: 0,
      l2_sh_op: 0,
      highlight_color: "#ffffff",
      shadow_color: "#000000",
      highlight_blend: "screen",
      shadow_blend: "linear-burn",
    },
    inputs: { image: "A", height: "B" },
    expect: "match",
    note: "wired height override, 4 taps on texel centres (soften 0)",
  },
  {
    id: "vf",
    type: "vector-field",
    params: { mode: "orbit", strength: 0.6, radius: 0.04, invert: true, aspect_correct: true },
    inputs: { source: "B" },
    drivers: { strength: "d_vf" },
    expect: "match",
    note: "4 off-grid taps radius apart",
  },
  {
    id: "vf2",
    type: "vector-field",
    params: { mode: "attract", strength: 0.8, radius: 0.02, invert: false, aspect_correct: true },
    inputs: { source: "B", field: "A" },
    expect: "match",
    note: "4 off-grid taps + a summed field",
  },
  {
    id: "fb",
    type: "flow-blur",
    params: { length: 0.06, samples: 24, mode: "velocity", falloff: "gauss", smooth: 4, opacity: 1 },
    inputs: { image: "A", field: "vf" },
    drivers: { length: "d_fb" },
    expect: "match",
    note: "a 49-step walk re-reading a gathered field (vf) at every step",
  },
  {
    id: "fb_t",
    type: "flow-blur",
    params: { length: 0.08, samples: 12, mode: "tangent", falloff: "box", smooth: 4, opacity: 0.9 },
    inputs: { image: "A", field: "vf2" },
    expect: "match",
    note: "tangent walk (sign-coherent), box weights",
  },
  {
    id: "fb_n",
    type: "flow-blur",
    params: { length: 0.05, samples: 16, mode: "tangent", falloff: "gauss", smooth: 4, opacity: 1 },
    inputs: { image: "B", field: "A" },
    expect: "match",
    note: "tangent walk over a smooth field (a noise, no vector-field singularities) — isolates the walk from fb_t's field",
  },
  {
    id: "kuw",
    type: "kuwahara",
    params: { radius: 5, mode: "generalized", sharpness: 6, hardness: 12, anisotropy: 1, min_coherence: 0, smooth: 4, opacity: 0.9 },
    inputs: { image: "A" },
    animation: { radius: block([[0, 3, "easeInOutCubic"], [120, 7, "linear"]]) },
    expect: "match",
    note: "≈ π r² taps on texel centres",
  },
  {
    id: "kuw_a",
    type: "kuwahara",
    params: { radius: 5, mode: "anisotropic", sharpness: 8, hardness: 8, anisotropy: 1.5, min_coherence: 0.6, smooth: 4, opacity: 1 },
    inputs: { image: "A", field: "vf" },
    expect: "match",
    note: "ellipse frame from a gathered field (vf) — off-grid frame, on-grid taps",
  },
];

export const GATHER_PAIRS: GatherPair[] = PAIRS.map((p) => ({
  native: p.id,
  port: `k_${p.id}`,
  canvas: `c_${p.id}`,
  type: p.type,
  expect: p.expect,
  note: p.note,
}));

const DRIVERS: Record<string, K[]> = {
  d_drift: [[0, 0, "linear"], [120, 1.2, "linear"]],
  d_disp: [[0, 0.02, "easeInOutCubic"], [120, 0.12, "linear"]],
  d_ca: [[0, 0.004, "easeOutBack"], [120, 0.03, "linear"]],
  d_shp: [[0, 0.5, "easeInOutSine"], [120, 2.5, "linear"]],
  d_edge: [[0, 2, "linear"], [60, 6, "easeInOutQuad"], [120, 4, "linear"]],
  d_bev: [[0, 135, "easeInOutCubic"], [120, 315, "linear"]],
  d_vf: [[0, 0.3, "easeOutCubic"], [120, 1.2, "linear"]],
  d_fb: [[0, 0.03, "easeInOutSine"], [120, 0.1, "linear"]],
};

const edge = (source: string, target: string, targetHandle: string): GraphEdge => ({
  id: `${source}->${target}:${targetHandle}`,
  source,
  sourceHandle: "out:primary",
  target,
  targetHandle,
});

export function gatherGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const [id, keys] of Object.entries(DRIVERS)) {
    nodes.push({ id, type: "animated-value", params: { value: keys[0][1], unit: "frames" }, animation: { value: block(keys) } });
  }
  nodes.push(
    { id: "nA", type: "noise", params: { ...NOISE_A }, exposedParams: ["offset_x"] },
    { id: "nB", type: "noise", params: { ...NOISE_B } },
    { id: "sA", type: "skia-noise", params: { ...NOISE_A }, exposedParams: ["offset_x"] },
    { id: "sB", type: "skia-noise", params: { ...NOISE_B } }
  );
  edges.push(edge("d_drift", "nA", "in:param:offset_x"), edge("d_drift", "sA", "in:param:offset_x"));
  const upstream = (ref: string, skia: boolean) => (ref === "A" || ref === "B" ? `${skia ? "s" : "n"}${ref}` : skia ? `k_${ref}` : ref);
  for (const p of PAIRS) {
    const exposed = Object.keys(p.drivers ?? {});
    // Native and port get equal (not shared) params, drivers and keyframes.
    const common = () => ({
      params: structuredClone(p.params),
      ...(exposed.length ? { exposedParams: [...exposed] } : {}),
      ...(p.animation ? { animation: structuredClone(p.animation) } : {}),
    });
    nodes.push(
      { id: p.id, type: p.type, ...common() },
      { id: `k_${p.id}`, type: `skia-${p.type}`, ...common() },
      { id: `f_${p.id}`, type: "skia-fill", params: { color: "#ffffff", opacity: 1, blendMode: "srcOver" } },
      { id: `c_${p.id}`, type: "skia-canvas", params: { background_on: false } }
    );
    for (const [socket, ref] of Object.entries(p.inputs)) {
      edges.push(edge(upstream(ref, false), p.id, `in:${socket}`), edge(upstream(ref, true), `k_${p.id}`, `in:${socket}`));
    }
    for (const [param, driver] of Object.entries(p.drivers ?? {})) {
      edges.push(edge(driver, p.id, `in:param:${param}`), edge(driver, `k_${p.id}`, `in:param:${param}`));
    }
    edges.push(edge(`k_${p.id}`, `f_${p.id}`, "in:shader"), edge(`f_${p.id}`, `c_${p.id}`, "in:scene"));
  }
  return { nodes, edges };
}

export const fixture: SkiaGraphFixture = {
  description:
    "Gathers: each GL gather node (`disp`, `ca`, …) vs its skia-* port drawn by a Skia Canvas (`c_disp`, `c_ca`, …), same noise upstream and drivers",
  timeline: GATHER_TIMELINE,
  frames: GATHER_FRAMES,
  size: 512,
  build: () => gatherGraph(),
};
