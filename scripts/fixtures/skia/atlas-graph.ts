// The Copy to Points (Skia) fixture (specdocs/101326_skia-target.md §7 Wave 3
// lane A, §3.4 built and measured), shared by compare:skia, check:skia-atlas,
// export-skia.mts (`--fixture atlas` → skia-harness/src/bundle-atlas) and
// parity:skia (`--bundle atlas`).
//
// One instance drawing — a five-point star, Skia Shape fill + stroke in a
// Skia Group (`inst`) — copied onto three point sets, each three ways:
//
//   gl_<case>          the GL Copy to Points (image mode) over the instance
//                      rendered by a Skia Canvas (`inst_skc`): the same
//                      CanvasKit raster both Skia strategies start from, so
//                      the comparison isolates the copying
//   skg_<case>_skc     Copy to Points (Skia), strategy groups
//   ska_<case>_skc     Copy to Points (Skia), strategy atlas
//
//   grid   a 5×5 Grid, Rotate + keyframed 0 → 90°, Scale × 0.6 → 1.2 (tracks)
//   vor    Voronoi (scatter) centers: 24 points, per-cell uniform scale
//   pt     a Point whose x is keyframed (moving points → sampled), 30°, 1.4×
//   gridc  the grid anchored at the canvas centre (no content-centre texel)
//   opq    an opaque instance (`inst_o`) on a 3×3 grid
//   id     one copy at the identity: `gl_id` ≡ its own instance `inst_skc`
//
// plus `combo_skc` — the three atlas / groups mixes in one Skia Group, the
// export the harness's ?bundle=atlas slot plays, and a dense case
// (`dense`: a 40×40 grid, 1,600 copies) for cost.
//
//   npm run compare:skia -- --a atlas:gl_gridc --b atlas:ska_gridc_skc
//   npm run compare:skia -- --a atlas:gl_id --b atlas:inst_skc
//   npm run compare:skia -- --a atlas:gl_opq --b atlas:ska_opq_skc
//   npm run compare:skia -- --a atlas:gl_gridc --b atlas:skg_gridc_skc --expect close
//
// The GL node composites premultiplied since 2026-10-16, so transparent
// instances compare without `--premul-a`. The content-centre cases (grid,
// vor, pt) still sit a readback texel apart (§3.4a): compare them with
// edge-band.cjs, not for MATCH.
//
// Pure (no node: imports): compare:skia bundles it for the browser.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { EasingPreset, KeyframeAnimationBlock } from "@/engine/keyframes";
import type { NodeDefinition } from "@/engine/types";
import { copyToPointsNode } from "@/nodes/effect/copy-to-points";
import { gridNode } from "@/nodes/source/grid";
import { pointNode } from "@/nodes/source/point";
import { starNode } from "@/nodes/source/star";
import { voronoiNode } from "@/nodes/source/voronoi";
import { skiaCopyToPointsNode } from "@/nodes/skia/copy-to-points";
import type { SkiaGraphFixture } from "../../skia/fixture";

export const ATLAS_TIMELINE = { fps: 30, ticksPerFrame: 1000 };
// What check:skia-atlas and the harness export (61 frames).
export const ATLAS_EXPORT_TIMELINE = { ...ATLAS_TIMELINE, sceneDurationTicks: 60_000 };
export const ATLAS_FRAMES = [0, 20, 40, 60] as const;
export const ATLAS_SIZE = 512;

export const FILL = "#3d7cff";
export const STROKE = "#ffb020";
export const STROKE_PX = 3;

const F = (frame: number) => frame * ATLAS_TIMELINE.ticksPerFrame;

function kf(frames: [number, unknown][], easing: EasingPreset = "easeInOutCubic"): KeyframeAnimationBlock {
  return { animated: true, trackVisible: true, keyframes: frames.map(([f, value]) => ({ tick: F(f), value, easingOut: easing })) };
}

function defaultsOf(def: NodeDefinition): Record<string, unknown> {
  return Object.fromEntries(def.params.map((p) => [p.name, p.default]));
}

const edge = (source: string, target: string, targetHandle: string, sourceHandle = "out:primary"): GraphEdge => ({
  id: `${source}:${sourceHandle}->${target}:${targetHandle}`,
  source,
  sourceHandle,
  target,
  targetHandle,
});

export interface AtlasCase {
  id: string;
  // Where the points come from: node id + output handle.
  points: [string, string];
  params: Record<string, unknown>;
  animation?: Record<string, KeyframeAnimationBlock>;
  // The drawing copied (default `inst`, the star on transparency).
  instance?: "inst" | "inst_o";
}

export const ATLAS_CASES: AtlasCase[] = [
  {
    id: "grid",
    points: ["grid", "out:primary"],
    params: {},
    animation: {
      rotate_add_default: kf([[0, 0], [60, Math.PI / 2]]),
      scale_mul_default: kf([[0, 0.6], [60, 1.2]]),
    },
  },
  { id: "vor", points: ["vor", "out:aux:centers"], params: { scale_mul_default: 0.8 } },
  // The same grid anchored at the canvas centre (the instance's own
  // centre): no content-centre quantization in play.
  { id: "gridc", points: ["grid", "out:primary"], params: { anchor: "canvas center", scale_mul_default: 0.8, rotate_add_default: 0.3 } },
  // An OPAQUE instance (the star over a full-canvas Skia Fill): every copy
  // is a whole-canvas quad and no texel is transparent, so the pixels
  // compare the copy transform + resampling alone — and the GL node's
  // premultiplied path (2026-10-16) must leave it exactly as it was.
  {
    id: "opq",
    points: ["grid3", "out:primary"],
    instance: "inst_o",
    params: { anchor: "canvas center" },
    animation: {
      rotate_add_default: kf([[0, 0.2], [60, 1.1]]),
      scale_mul_default: kf([[0, 0.24], [60, 0.31]]),
    },
  },
  { id: "pt", points: ["pt", "out:primary"], params: {} },
  // One copy at the identity (canvas centre, 0°, 1×, canvas-centre anchor):
  // every fragment samples a texel centre, so `gl_id` must reproduce its own
  // instance raster `inst_skc`, anti-aliased edges included. Before
  // 2026-10-16 the GL node stored rgb·a there (edges dark by a factor of a).
  { id: "id", points: ["pt_id", "out:primary"], params: { anchor: "canvas center" } },
];

const CANVAS = { background_on: false, background: "#000000" };

export function atlasGraph(o: { dense?: boolean } = {}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // ---- the instance: a star at the canvas centre, fill + stroke ----
  nodes.push({
    id: "star",
    type: starNode.type,
    params: { ...defaultsOf(starNode), outerRadius: 0.07, innerRadius: 0.032, rotation: 0, stroke_enabled: false, fill_enabled: false },
  });
  nodes.push({ id: "star_f", type: "skia-shape", params: { style: "fill", color: FILL, fill_rule: "nonzero", stroke_width: STROKE_PX, cap: "round", join: "round" } });
  nodes.push({ id: "star_s", type: "skia-shape", params: { style: "stroke", color: STROKE, fill_rule: "nonzero", stroke_width: STROKE_PX, cap: "round", join: "round" } });
  edges.push(edge("star", "star_f", "in:spline"), edge("star", "star_s", "in:spline"));
  nodes.push({ id: "inst", type: "skia-group", params: { translateX: 0, translateY: 0, rotate: 0, scaleX: 1, scaleY: 1, originX: 0, originY: 0, opacity: 1, blendMode: "srcOver" } });
  edges.push(edge("star_f", "inst", "in:child1"), edge("star_s", "inst", "in:child2"));
  nodes.push({ id: "inst_skc", type: "skia-canvas", params: { ...CANVAS } });
  edges.push(edge("inst", "inst_skc", "in:scene"));
  // The opaque instance: the same star over a full-canvas fill.
  nodes.push({ id: "bg", type: "skia-fill", params: { color: "#1d2340", opacity: 1 } });
  nodes.push({ id: "inst_o", type: "skia-group", params: { translateX: 0, translateY: 0, rotate: 0, scaleX: 1, scaleY: 1, originX: 0, originY: 0, opacity: 1, blendMode: "srcOver" } });
  edges.push(edge("bg", "inst_o", "in:child1"), edge("star_f", "inst_o", "in:child2"), edge("star_s", "inst_o", "in:child3"));
  nodes.push({ id: "inst_o_skc", type: "skia-canvas", params: { ...CANVAS } });
  edges.push(edge("inst_o", "inst_o_skc", "in:scene"));

  // ---- point sets ----
  nodes.push({ id: "grid", type: gridNode.type, params: { ...defaultsOf(gridNode), countX: 5, countY: 5, width: 0.72, height: 0.72 } });
  nodes.push({ id: "grid3", type: gridNode.type, params: { ...defaultsOf(gridNode), countX: 3, countY: 3, width: 0.62, height: 0.62 } });
  nodes.push({
    id: "vor",
    type: voronoiNode.type,
    params: { ...defaultsOf(voronoiNode), source: "scatter", placement: "uniform", count: 24, seed: 7, relax: 2 },
  });
  nodes.push({
    id: "pt",
    type: pointNode.type,
    params: { ...defaultsOf(pointNode), x: 0.3, y: 0.62, rotation_deg: 30, scale: 1.4 },
    animation: { x: kf([[0, 0.3], [60, 0.7]]) },
  });
  nodes.push({ id: "pt_id", type: pointNode.type, params: { ...defaultsOf(pointNode), x: 0.5, y: 0.5, rotation_deg: 0, scale: 1 } });

  const glDefaults = defaultsOf(copyToPointsNode);
  const skDefaults = defaultsOf(skiaCopyToPointsNode);
  const cases = o.dense
    ? [...ATLAS_CASES, { id: "dense", points: ["dense_grid", "out:primary"] as [string, string], params: { scale_mul_default: 0.22 } }]
    : ATLAS_CASES;
  if (o.dense) {
    nodes.push({ id: "dense_grid", type: gridNode.type, params: { ...defaultsOf(gridNode), countX: 40, countY: 40, width: 0.94, height: 0.94 } });
  }
  for (const c of cases) {
    // GL reference: image mode over the instance's own Skia Canvas raster.
    nodes.push({
      id: `gl_${c.id}`,
      type: copyToPointsNode.type,
      params: { ...glDefaults, mode: "image", pick_mode: "all", anchor: "content center", ...c.params },
      ...(c.animation ? { animation: structuredClone(c.animation) } : {}),
    });
    const inst = c.instance ?? "inst";
    edges.push(edge(c.points[0], `gl_${c.id}`, "in:points", c.points[1]), edge(`${inst}_skc`, `gl_${c.id}`, "in:instance"));
    for (const [prefix, strategy] of [
      ["skg", "groups"],
      ["ska", "atlas"],
    ] as const) {
      const id = `${prefix}_${c.id}`;
      nodes.push({
        id,
        type: skiaCopyToPointsNode.type,
        params: { ...skDefaults, mode: "image", anchor: "content center", strategy, ...c.params },
        ...(c.animation ? { animation: structuredClone(c.animation) } : {}),
      });
      edges.push(edge(c.points[0], id, "in:points", c.points[1]), edge(inst, id, "in:instance"));
      nodes.push({ id: `${id}_skc`, type: "skia-canvas", params: { ...CANVAS } });
      edges.push(edge(id, `${id}_skc`, "in:scene"));
    }
  }

  // ---- the harness export: atlas grid (tracks) + groups point (sampled)
  // + atlas voronoi (static) in one canvas ----
  nodes.push({ id: "combo", type: "skia-group", params: { translateX: 0, translateY: 0, rotate: 0, scaleX: 1, scaleY: 1, originX: 0, originY: 0, opacity: 1, blendMode: "srcOver" } });
  edges.push(edge("ska_vor", "combo", "in:child1"), edge("ska_grid", "combo", "in:child2"), edge("skg_pt", "combo", "in:child3"));
  nodes.push({ id: "combo_skc", type: "skia-canvas", params: { ...CANVAS } });
  edges.push(edge("combo", "combo_skc", "in:scene"));
  return { nodes, edges };
}

export const fixture: SkiaGraphFixture = {
  description:
    "Copy to Points (Skia): a star drawing copied onto a keyframed grid, Voronoi centers and a moving Point — GL Copy to Points over the instance's raster (`gl_<case>`) vs Skia groups (`skg_<case>_skc`) vs Skia atlas (`ska_<case>_skc`); `combo_skc` is the harness export; `gl_dense` / `ska_dense_skc` / `skg_dense_skc` copy 1,600 times",
  timeline: ATLAS_TIMELINE,
  frames: ATLAS_FRAMES,
  size: ATLAS_SIZE,
  build: () => atlasGraph({ dense: true }),
};
