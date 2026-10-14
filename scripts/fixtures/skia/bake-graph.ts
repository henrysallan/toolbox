// The Skia Bake fixture (specdocs/101326_skia-target.md §3.2 `bake`, Wave 3
// lane B): an ENGINE effect no Skia node can express live — animated Noise
// through a Gaussian Blur — baked into a Skia layer, under a native ring
// whose radius is keyframed:
//
//   noise (animated, looping over the timeline) → blur ─┐
//                                                       ├→ bk (Skia Bake) ─┬→ skb (Skia Canvas: the bake alone)
//   ring (Circle (Skia), radius keyframed) ─────────────┘                  └→ grp (Skia Group: bake, ring) → skc (Skia Canvas)
//
// In the editor the blur sits OUTSIDE the Skia layer and reaches the bake
// through a Layer Input socket; flatten splices that wire straight
// through, so the flat graph here is what the evaluator and the exporter
// see.
//
//   npm run compare:skia -- --a bake:blur --b bake:skb          # the preview draws the engine frame exactly
//   npx tsx scripts/export-skia.mts --fixture bake --out skia-harness/src/bundle-bake
//   npm run parity:skia -- --bundle bake                         # the shipped sprite sheet replays the editor's frames
//
// Pure (no node: imports): compare:skia and the parity page bundle it.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { KeyframeAnimationBlock } from "@/engine/keyframes";
import type { NodeDefinition } from "@/engine/types";
import { blurNode } from "@/nodes/effect/blur";
import { skiaBakeNode } from "@/nodes/skia/bake";
import { skiaCircleNode } from "@/nodes/skia/circle";
import { perlinNoiseNode } from "@/nodes/source/perlin-noise";
import type { SkiaGraphFixture } from "../../skia/fixture";

// 60 frames at 60 fps, 128² canvas: 61 sheet cells (frames 0…60) fit one
// 4030×260 sheet at full size.
export const BAKE_TIMELINE = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 60_000 };
export const BAKE_SIZE = 128;
export const BAKE_FRAMES = [0, 7, 15, 29, 30, 31, 44, 59] as const;
export const BAKE_CANVAS_ID = "skc";

function defaultsOf(def: NodeDefinition): Record<string, unknown> {
  return Object.fromEntries(def.params.map((p) => [p.name, p.default]));
}

const kf = (keys: [number, number][]): KeyframeAnimationBlock => ({
  animated: true,
  trackVisible: true,
  keyframes: keys.map(([f, value]) => ({ tick: f * BAKE_TIMELINE.ticksPerFrame, value, easingOut: "easeInOutCubic" })),
});

export interface BakeGraphOptions {
  // Skia Bake's own params (mode / fps / max_sheet).
  bake?: Record<string, unknown>;
  // Noise animated (the default) or a still frame.
  animated?: boolean;
}

export function bakeGraph(o: BakeGraphOptions = {}): { nodes: GraphNode[]; edges: GraphEdge[]; targetId: string } {
  const nodes: GraphNode[] = [
    {
      id: "noise",
      type: "noise",
      params: {
        ...defaultsOf(perlinNoiseNode),
        type: "simplex",
        scale: 2.5,
        octaves: 4,
        contrast: 1.3,
        animated: o.animated ?? true,
        anim_start: 0,
        anim_end: 60,
        anim_rate: 1,
        color_a: "#120a3a",
        color_b: "#ffb347",
      },
    },
    { id: "blur", type: "blur", params: { ...defaultsOf(blurNode), mode: "gaussian", radius: 8 } },
    { id: "bk", type: "skia-bake", params: { ...defaultsOf(skiaBakeNode), ...(o.bake ?? {}) } },
    {
      id: "ring",
      type: "skia-circle",
      params: {
        ...defaultsOf(skiaCircleNode),
        centerX: 0.5,
        centerY: 0.5,
        radiusX: 0.25,
        radiusY: 0.25,
        fill_enabled: false,
        stroke_enabled: true,
        stroke_thickness: 3,
        stroke_units: "px",
        stroke_color: "#ffffff",
      },
      animation: { radiusX: kf([[0, 0.18], [30, 0.36], [60, 0.18]]), radiusY: kf([[0, 0.18], [30, 0.36], [60, 0.18]]) },
    },
    { id: "grp", type: "skia-group", params: { translateX: 0, translateY: 0, rotate: 0, scaleX: 1, scaleY: 1, originX: 0, originY: 0, opacity: 1, blendMode: "srcOver" } },
    { id: "skc", type: "skia-canvas", params: { background_on: false } },
    { id: "skb", type: "skia-canvas", params: { background_on: false } },
  ];
  const e = (source: string, target: string, targetHandle: string): GraphEdge => ({
    id: `${source}->${target}:${targetHandle}`,
    source,
    sourceHandle: "out:primary",
    target,
    targetHandle,
  });
  const edges: GraphEdge[] = [
    e("noise", "blur", "in:image"),
    e("blur", "bk", "in:image"),
    e("bk", "grp", "in:child1"),
    e("ring", "grp", "in:child2"),
    e("grp", "skc", "in:scene"),
    e("bk", "skb", "in:scene"),
  ];
  return { nodes, edges, targetId: BAKE_CANVAS_ID };
}

export const fixture: SkiaGraphFixture = {
  description: "Skia Bake: animated Noise → Gaussian Blur (engine) baked into a Skia layer — `skb` draws the bake alone (≡ `blur`), `skc` under a keyframed native ring",
  timeline: BAKE_TIMELINE,
  frames: BAKE_FRAMES,
  size: BAKE_SIZE,
  build: () => {
    const { nodes, edges } = bakeGraph();
    return { nodes, edges };
  },
};
