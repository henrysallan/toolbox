// Stage splitting's compare:skia + parity fixture (specdocs/101326_skia-target.md
// §3.3 "built and measured", Wave 3 lane S). Every Skia side here is over
// the phone budget, so its Skia Fill splits (engine/skia/split.ts): the
// gather's upstream renders once into a layer and the gather runs as a
// runtime image filter over it.
//
//   chain   Edge Detect(Kuwahara(Noise))       two nested layers: noise →
//                                              kuwahara filter → edge filter
//   fan     Merge(Sharpen(Noise), Edge(Noise)) ONE layer read by both gathers
//   combo   Merge(Edge(Kuwahara(Noise)),       both: the outer layer
//               Kuwahara(Noise))               (Kuwahara(Noise)) is read by the
//                                              edge gather AND plainly by the
//                                              merge; the parity slot
//                                              (skia-harness/src/bundle-split,
//                                              ?bundle=split)
//
// (Sharpen and Edge Detect overshoot [0, 1], so the splitter never renders
// THEM into a layer — a gather over a sharpen stays fused; the chains stage
// Kuwahara, which averages.)
//
// Each `<id>` is the GL graph, `c_<id>` the Skia Canvas, `s_<id>` the Skia
// side's root shader node (its aux `preview` is the same expression FUSED,
// unsplit — the reference a split must reproduce):
//
//   npm run compare:skia -- --a split:chain --b split:c_chain
//   npm run compare:skia -- --a split:s_chain:aux:preview --b split:c_chain
//
// The timeline is Aurora's (5 s, AURORA_MARKERS) so the parity bundle
// shares the harness's segment names. Drivers are keyframes on the params
// themselves (tracks in the export): the noise drifts, the sharpen amount,
// the kuwahara hardness, the edge strength and the merge layer's opacity
// move.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { EasingPreset, KeyframeAnimationBlock } from "@/engine/keyframes";
import type { MergeLayer } from "@/nodes/effect/merge";
import type { SkiaGraphFixture } from "../../skia/fixture";
import { AURORA_MARKERS } from "./aurora-graph";

export const SPLIT_TIMELINE = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 300_000 };
export const SPLIT_FRAMES = [0, 90, 200, 299];
export const SPLIT_MARKERS = AURORA_MARKERS;
// The parity slot's canvas.
export const SPLIT_PARITY_CANVAS = "c_combo";

type K = [frame: number, value: number, easing: EasingPreset];
const block = (keys: K[]): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes: keys.map(([f, value, easingOut]) => ({ tick: f * SPLIT_TIMELINE.ticksPerFrame, value, easingOut })),
});

const NOISE = {
  type: "simplex",
  scale: 6,
  octaves: 3,
  persistence: 0.5,
  lacunarity: 2,
  offset_x: 0,
  offset_y: 0.2,
  seed: 4,
  w: 0,
  contrast: 1.2,
  color_a: "#14233f",
  color_b: "#ffc94a",
  alpha: 1,
};
const NOISE_ANIM = { offset_x: block([[0, 0, "linear"], [299, 0.9, "linear"]]) };
const SHARPEN = { algorithm: "unsharp", amount: 1.2 };
const SHARPEN_ANIM = { amount: block([[0, 0.6, "easeInOutSine"], [150, 2, "easeInOutSine"], [299, 0.6, "linear"]]) };
const KUWAHARA = { radius: 3, mode: "generalized", sharpness: 6, hardness: 10, anisotropy: 1, min_coherence: 0, smooth: 4, opacity: 1 };
const KUWAHARA_ANIM = { hardness: block([[0, 4, "easeInOutSine"], [299, 16, "linear"]]) };
const EDGE = { algorithm: "sobel", strength: 2.5, threshold: 0.02 };
const EDGE_ANIM = { strength: block([[0, 1.5, "easeInOutQuad"], [299, 4, "linear"]]) };
const LAYERS: MergeLayer[] = [{ id: "L", mode: "screen", opacity: 0.8 }];
const LAYER_ANIM = { "layer_opacity:L": block([[0, 0.35, "easeInOutSine"], [299, 1, "linear"]]) };

const e = (source: string, target: string, targetHandle: string): GraphEdge => ({
  id: `${source}->${target}:${targetHandle}`,
  source,
  sourceHandle: "out:primary",
  target,
  targetHandle,
});

export function splitGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  // Both sides of every pair get EQUAL (not shared) params and keyframes.
  const pair = (id: string, type: string, params: Record<string, unknown>, animation?: Record<string, KeyframeAnimationBlock>) => {
    const common = () => ({ params: structuredClone(params), ...(animation ? { animation: structuredClone(animation) } : {}) });
    nodes.push({ id, type, ...common() }, { id: `s_${id}`, type: `skia-${type}`, ...common() });
  };
  const wire = (from: string, to: string, socket: string) => edges.push(e(from, to, `in:${socket}`), e(`s_${from}`, `s_${to}`, `in:${socket}`));
  const canvas = (id: string, root: string) => {
    nodes.push(
      { id: `f_${id}`, type: "skia-fill", params: { color: "#ffffff", opacity: 1, blendMode: "srcOver" } },
      { id: `c_${id}`, type: "skia-canvas", params: { background_on: false } }
    );
    edges.push(e(`s_${root}`, `f_${id}`, "in:shader"), e(`f_${id}`, `c_${id}`, "in:scene"));
  };

  pair("n", "noise", NOISE, NOISE_ANIM);

  // chain: Edge(Kuwahara(N)).
  pair("chain_kuw", "kuwahara", KUWAHARA, KUWAHARA_ANIM);
  pair("chain", "edge-detect", EDGE, EDGE_ANIM);
  wire("n", "chain_kuw", "image");
  wire("chain_kuw", "chain", "image");
  canvas("chain", "chain");

  // fan: Merge(base = Sharpen(N), L = Edge(N)) — one layer, two gathers.
  pair("fan_shp", "sharpen", SHARPEN, SHARPEN_ANIM);
  pair("fan_edge", "edge-detect", EDGE, EDGE_ANIM);
  pair("fan", "merge", { layers: LAYERS }, LAYER_ANIM);
  wire("n", "fan_shp", "image");
  wire("n", "fan_edge", "image");
  wire("fan_shp", "fan", "base");
  wire("fan_edge", "fan", "layer:L");
  canvas("fan", "fan");

  // combo: Merge(base = Edge(Kuwahara(N)), L = Kuwahara(N)).
  pair("combo_kuw", "kuwahara", KUWAHARA, KUWAHARA_ANIM);
  pair("combo_edge", "edge-detect", EDGE, EDGE_ANIM);
  pair("combo", "merge", { layers: LAYERS }, LAYER_ANIM);
  wire("n", "combo_kuw", "image");
  wire("combo_kuw", "combo_edge", "image");
  wire("combo_edge", "combo", "base");
  wire("combo_kuw", "combo", "layer:L");
  canvas("combo", "combo");

  return { nodes, edges };
}

// Every pair: the GL node, the Skia side's root shader node (`s_<id>`, its
// aux preview = fused), the Skia Canvas, and the layers its Fill splits into.
export const SPLIT_PAIRS = [
  { id: "chain", gl: "chain", root: "s_chain", canvas: "c_chain", layers: 2 },
  { id: "fan", gl: "fan", root: "s_fan", canvas: "c_fan", layers: 1 },
  { id: "combo", gl: "combo", root: "s_combo", canvas: "c_combo", layers: 2 },
] as const;

export const fixture: SkiaGraphFixture = {
  description:
    "Stage splitting: GL chains (`chain`, `fan`, `combo`) vs their Skia layers (`c_chain`, …), every one over the phone budget and split; `s_<id>:aux:preview` is the same expression fused (unsplit)",
  timeline: SPLIT_TIMELINE,
  frames: SPLIT_FRAMES,
  size: 512,
  build: () => splitGraph(),
};
