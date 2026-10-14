// Merge & blend (specdocs/101326_skia-target.md §7 Wave 2, family 6): every
// Merge blend mode three ways over the SAME translucent, overlapping
// upstreams, so each formula sees dark and light, opaque and see-through
// pixels on both inputs:
//
//   nat_<mode>   native Merge (base = ramp A, one layer = ramp B)
//   skc_<mode>   Merge (Skia) → Skia Fill → Skia Canvas, same layers param
//                and the same layer-opacity keyframes (layer_opacity:L)
//   gbc_<mode>   Skia's native per-draw blendMode (React Native Skia's
//                blend): Fill(ramp A), then a Group{opacity keyframed the
//                same} holding Fill(ramp B){blendMode} — only modes Skia has
//                a name for (MERGE_TO_SKIA_BLEND)
//   …_opq        the same three over an OPAQUE base (ramp A with alpha 1),
//                where the shared modes' formulas should agree
//
// plus `nat_stack` / `skc_stack`: a 9-entry stack (8 enabled layers, one
// disabled) with per-layer masks, an inverted mask, a base mask and an
// animated layer — native Merge splits it into two GL passes on a
// 16-texture-unit GPU, Merge (Skia) runs one shader.
//
//   npm run compare:skia -- --a merge:nat_multiply --b merge:skc_multiply
//   npm run compare:skia -- --a merge:nat_overlay --b merge:gbc_overlay --expect off
//   npm run compare:skia -- --a merge:nat_stack --b merge:skc_stack
//
// Upstreams: simplex Noise (black → white) into Color Ramp, natively and as
// Noise (Skia) → Color Ramp (Skia) (proven equal by the aurora-scene
// fixture). Ramp stops carry alpha 0.4–1, colors span each channel's range.
// One Animated Value drifts layer B's noise so frames differ; the layer
// opacity eases 0.35 → 1 over the 60 frames (no overshoot, so it exports as
// a track).
//
// Measured 2026-10-13 (256², frames 0/30/60, ANGLE Metal, CanvasKit bin/full):
//   skc vs nat, all 29 modes   MATCH; meanAbs 0.0010–0.0012 (opaque base
//                              0.0003–0.0004), p95 1/255. Discontinuous modes
//                              (hard-mix, lighter/darker color, glow,
//                              color-burn, vivid-light) flip ≤ 0.14% of pixels
//                              sitting on a threshold (max up to 242/255).
//   skc_stack vs nat_stack     MATCH, meanAbs 0.0011, p95 1/255
//   gbc vs nat, opaque base    MATCH for every shared mode but add /
//                              linear-dodge → plus (OFF, meanAbs 0.036)
//   gbc vs nat, translucent    only normal / mix MATCH; the rest CLOSE (meanAbs
//                              0.007–0.017) or OFF (difference, color-burn,
//                              plus: 0.021–0.047)

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { KeyframeAnimationBlock } from "@/engine/keyframes";
import { BLEND_MODE_ORDER, type BlendMode, type MergeLayer } from "@/nodes/effect/merge";
import { MERGE_TO_SKIA_BLEND } from "@/nodes/skia/merge";
import type { SkiaGraphFixture } from "../../skia/fixture";

export const MERGE_TIMELINE = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 60_000 };
export const MERGE_FRAMES = [0, 30, 60];

export const MERGE_MODES: readonly BlendMode[] = BLEND_MODE_ORDER;

// Layer opacity keys (frames → value), shared by every Merge layer "L",
// every Skia Group's opacity, and the stack's animated layer.
export const LAYER_OPACITY_KEYS: [number, number][] = [
  [0, 0.35],
  [60, 1],
];

export function opacityBlock(keys: [number, number][] = LAYER_OPACITY_KEYS): KeyframeAnimationBlock {
  return {
    animated: true,
    trackVisible: true,
    keyframes: keys.map(([f, value], i) => ({ tick: f * 1000, value, easingOut: i < keys.length - 1 ? "easeInOutSine" : "linear" })),
  };
}

const noise = (seed: number, scale: number, contrast: number) => ({
  type: "simplex",
  scale,
  octaves: 4,
  persistence: 0.5,
  lacunarity: 2,
  offset_x: 0,
  offset_y: 0,
  seed,
  w: 0,
  contrast,
  color_a: "#000000",
  color_b: "#ffffff",
  alpha: 1,
});

// Upstream params (exported for check:skia-merge's export graph).
export const NOISE_A = noise(1, 3, 1.3);
export const NOISE_B = noise(7, 5, 1.5);
export const NOISE_C = noise(11, 8, 1.4);
export const NOISE_M = noise(3, 2, 1.8);

const stop = (id: string, position: number, color: string, alpha: number) => ({ id, position, color, alpha });
export const RAMP_A = [
  stop("a0", 0, "#101418", 0.5),
  stop("a1", 0.35, "#2f7bff", 0.9),
  stop("a2", 0.65, "#ff5a36", 1),
  stop("a3", 1, "#fff1c4", 0.65),
];
export const RAMP_A_OPAQUE = RAMP_A.map((s) => ({ ...s, alpha: 1 }));
export const RAMP_B = [
  stop("b0", 0, "#f8f8f8", 0.4),
  stop("b1", 0.3, "#00c2a8", 0.85),
  stop("b2", 0.7, "#7a1fff", 0.95),
  stop("b3", 1, "#121212", 0.6),
];
export const RAMP_C = [
  stop("c0", 0, "#ffd400", 0.55),
  stop("c1", 0.5, "#e01e5a", 1),
  stop("c2", 1, "#1e90ff", 0.7),
];
const ramp = (stops: typeof RAMP_A) => ({ stops, offset: 0, interpolation: "linear", space: "srgb" });

// The stack: 9 entries, 8 enabled (Merge (Skia)'s cap), every one of the
// per-layer features once. `src` names the upstream ramp.
export const STACK: (MergeLayer & { src: "A" | "B" | "C"; mask?: boolean })[] = [
  { id: "s1", mode: "multiply", opacity: 0.8, src: "B", mask: true },
  { id: "s2", mode: "screen", opacity: 0.6, src: "C", mask: true, maskInvert: true },
  { id: "s3", mode: "overlay", opacity: 1, src: "B" },
  { id: "s4", mode: "difference", opacity: 1, src: "C", enabled: false },
  { id: "s5", mode: "hard-mix", opacity: 0.5, src: "C" },
  { id: "s6", mode: "soft-light", opacity: 0.9, src: "A", mask: true },
  { id: "s7", mode: "color-burn", opacity: 0.7, src: "B" },
  { id: "s8", mode: "linear-light", opacity: 0.45, src: "C" },
  { id: "s9", mode: "phoenix", opacity: 1, src: "B", mask: true },
];
// The stack's keyframed layer.
export const STACK_ANIMATED = "s3";

const e = (source: string, target: string, targetHandle: string): GraphEdge => ({
  id: `${source}->${target}:${targetHandle}`,
  source,
  sourceHandle: "out:primary",
  target,
  targetHandle,
});

export function mergeGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const add = (n: GraphNode) => nodes.push(n);

  // ---- upstreams ----------------------------------------------------------------
  add({
    id: "drift",
    type: "animated-value",
    params: { value: 0, unit: "frames" },
    animation: {
      value: { animated: true, trackVisible: true, keyframes: [{ tick: 0, value: 0, easingOut: "linear" }, { tick: 60_000, value: 0.6, easingOut: "linear" }] },
    },
  });
  const upstream = (key: string, n: Record<string, unknown>, stops: typeof RAMP_A, drift = false) => {
    add({ id: `n${key}`, type: "noise", params: { ...n }, ...(drift ? { exposedParams: ["offset_x"] } : {}) });
    add({ id: `r${key}`, type: "color-ramp", params: ramp(stops) });
    add({ id: `sn${key}`, type: "skia-noise", params: { ...n }, ...(drift ? { exposedParams: ["offset_x"] } : {}) });
    add({ id: `sr${key}`, type: "skia-color-ramp", params: ramp(stops) });
    edges.push(e(`n${key}`, `r${key}`, "in:image"), e(`sn${key}`, `sr${key}`, "in:image"));
    if (drift) edges.push(e("drift", `n${key}`, "in:param:offset_x"), e("drift", `sn${key}`, "in:param:offset_x"));
  };
  upstream("A", NOISE_A, RAMP_A);
  upstream("O", NOISE_A, RAMP_A_OPAQUE);
  upstream("B", NOISE_B, RAMP_B, true);
  upstream("C", NOISE_C, RAMP_C);
  // The mask: grayscale noise, opaque (luma = the noise value).
  add({ id: "nM", type: "noise", params: { ...NOISE_M } });
  add({ id: "snM", type: "skia-noise", params: { ...NOISE_M } });

  // The base draws for the Skia-blendMode variants.
  for (const k of ["A", "O"]) {
    add({ id: `f${k}`, type: "skia-fill", params: { color: "#ffffff", opacity: 1, blendMode: "srcOver" } });
    edges.push(e(`sr${k}`, `f${k}`, "in:shader"));
  }

  // ---- one layer per mode ---------------------------------------------------------
  for (const [suffix, baseKey] of [["", "A"], ["_opq", "O"]] as const) {
    for (const mode of MERGE_MODES) {
      const tag = `${mode}${suffix}`;
      const layers: MergeLayer[] = [{ id: "L", mode, opacity: 1 }];
      const animation = { "layer_opacity:L": opacityBlock() };
      add({ id: `nat_${tag}`, type: "merge", params: { layers }, animation });
      edges.push(e(`r${baseKey}`, `nat_${tag}`, "in:base"), e("rB", `nat_${tag}`, "in:layer:L"));

      add({ id: `skm_${tag}`, type: "skia-merge", params: { layers }, animation });
      add({ id: `skf_${tag}`, type: "skia-fill", params: { color: "#ffffff", opacity: 1, blendMode: "srcOver" } });
      add({ id: `skc_${tag}`, type: "skia-canvas", params: { background_on: false } });
      edges.push(
        e(`sr${baseKey}`, `skm_${tag}`, "in:base"),
        e("srB", `skm_${tag}`, "in:layer:L"),
        e(`skm_${tag}`, `skf_${tag}`, "in:shader"),
        e(`skf_${tag}`, `skc_${tag}`, "in:scene")
      );

      const rn = MERGE_TO_SKIA_BLEND[mode];
      if (!rn) continue;
      // The native blend rides the layer's own Fill: Skia Fill always writes
      // a paint blendMode (srcOver by default), which overrides an enclosing
      // Skia Group's, so a Group blendMode never reaches a Fill child. The
      // Group carries the keyframed opacity (per-draw alpha, as RN applies it).
      add({ id: `gbf_${tag}`, type: "skia-fill", params: { color: "#ffffff", opacity: 1, blendMode: rn } });
      add({ id: `gbl_${tag}`, type: "skia-group", params: { opacity: 1 }, animation: { opacity: opacityBlock() } });
      add({ id: `gbt_${tag}`, type: "skia-group", params: {} });
      add({ id: `gbc_${tag}`, type: "skia-canvas", params: { background_on: false } });
      edges.push(
        e("srB", `gbf_${tag}`, "in:shader"),
        e(`gbf_${tag}`, `gbl_${tag}`, "in:child1"),
        e(`f${baseKey}`, `gbt_${tag}`, "in:child1"),
        e(`gbl_${tag}`, `gbt_${tag}`, "in:child2"),
        e(`gbt_${tag}`, `gbc_${tag}`, "in:scene")
      );
    }
  }

  // ---- the stack ----------------------------------------------------------------
  const stackLayers: MergeLayer[] = STACK.map((l) => ({
    id: l.id,
    mode: l.mode,
    opacity: l.opacity,
    ...(l.enabled === false ? { enabled: false } : {}),
    ...(l.maskInvert ? { maskInvert: true } : {}),
  }));
  const stackAnim = { [`layer_opacity:${STACK_ANIMATED}`]: opacityBlock() };
  add({ id: "nat_stack", type: "merge", params: { layers: stackLayers }, animation: stackAnim });
  add({ id: "skm_stack", type: "skia-merge", params: { layers: stackLayers }, animation: stackAnim });
  add({ id: "skf_stack", type: "skia-fill", params: { color: "#ffffff", opacity: 1, blendMode: "srcOver" } });
  add({ id: "skc_stack", type: "skia-canvas", params: { background_on: false } });
  edges.push(
    e("rA", "nat_stack", "in:base"),
    e("nM", "nat_stack", "in:mask:base"),
    e("srA", "skm_stack", "in:base"),
    e("snM", "skm_stack", "in:mask:base"),
    e("skm_stack", "skf_stack", "in:shader"),
    e("skf_stack", "skc_stack", "in:scene")
  );
  for (const l of STACK) {
    edges.push(e(`r${l.src}`, "nat_stack", `in:layer:${l.id}`), e(`sr${l.src}`, "skm_stack", `in:layer:${l.id}`));
    if (l.mask) edges.push(e("nM", "nat_stack", `in:mask:${l.id}`), e("snM", "skm_stack", `in:mask:${l.id}`));
  }
  return { nodes, edges };
}

export const fixture: SkiaGraphFixture = {
  description:
    "Merge & blend: native Merge (nat_<mode>) vs Merge (Skia) → Skia Canvas (skc_<mode>) vs Skia native per-draw blendMode (gbc_<mode>), translucent base (and _opq: opaque base); nat_stack vs skc_stack (8 layers, masks)",
  timeline: MERGE_TIMELINE,
  frames: MERGE_FRAMES,
  size: 256,
  build: () => mergeGraph(),
};
