// The vector-shapes family fixture (specdocs/101326_skia-target.md §7 Wave 2
// family 7), shared by compare:skia and the check:skia-shapes gate.
//
// Every spline generator twice over, on the same keyframes:
//   native  the generator's own `image` aux (its bundled rasterizer: fill,
//           then the stroke over it — what the editor shows)
//   Skia    the same node's spline → Skia Shape (fill) + Skia Shape (stroke)
//           → Skia Group → Skia Canvas (`<id>_skc`)
// and the three direct-bind primitives beside the node they mirror:
//   skia-circle / skia-rect / skia-line (`sk<id>` → `sk<id>_skc`) on a copy
//   of circle / rectangle / line's params and keyframes.
//
//   npm run compare:skia -- --a shapes:star:aux:image --b shapes:star_skc --expect close
//   npm run compare:skia -- --a shapes:circle:aux:image --b shapes:skcircle_skc --expect close
//
// Open generators (wave, spiral, cross, line) are stroke-only: with fill on,
// the bundled rasterizer strokes the fill's CLOSED path (closing edge
// included) while Skia Shape strokes the spline as authored.
//
// Pure (no node: imports): compare:skia bundles it for the browser. Defaults
// come from the defs themselves, as the editor's add-node does.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { EasingPreset, KeyframeAnimationBlock } from "@/engine/keyframes";
import type { NodeDefinition, SplineSubpath } from "@/engine/types";
import { arcNode } from "@/nodes/source/arc";
import { arrowNode } from "@/nodes/source/arrow";
import { circleNode } from "@/nodes/source/circle";
import { crossNode } from "@/nodes/source/cross";
import { lineNode } from "@/nodes/source/line";
import { polygonNode } from "@/nodes/source/polygon";
import { rectangleNode } from "@/nodes/source/rectangle";
import { spiralNode } from "@/nodes/source/spiral";
import { splineDrawNode } from "@/nodes/source/spline-draw";
import { starNode } from "@/nodes/source/star";
import { svgSourceNode } from "@/nodes/source/svg-source";
import { waveNode } from "@/nodes/source/wave";
import { skiaCircleNode } from "@/nodes/skia/circle";
import { skiaLineNode } from "@/nodes/skia/line";
import { skiaRectNode } from "@/nodes/skia/rect";
import type { SkiaGraphFixture } from "../../skia/fixture";

export const SHAPES_TIMELINE = { fps: 30, ticksPerFrame: 1000 };
// What check:skia-shapes exports (61 frames).
export const SHAPES_EXPORT_TIMELINE = { ...SHAPES_TIMELINE, sceneDurationTicks: 60_000 };
export const SHAPES_FRAMES = [0, 20, 40, 60] as const;

export const FILL = "#3d7cff";
export const STROKE = "#ffb020";
export const STROKE_PX = 6;

const F = (frame: number) => frame * SHAPES_TIMELINE.ticksPerFrame;

export function kf(frames: [number, unknown][], easing: EasingPreset = "easeInOutCubic"): KeyframeAnimationBlock {
  return { animated: true, trackVisible: true, keyframes: frames.map(([f, value]) => ({ tick: F(f), value, easingOut: easing })) };
}

export function defaultsOf(def: NodeDefinition): Record<string, unknown> {
  return Object.fromEntries(def.params.map((p) => [p.name, p.default]));
}

// A closed bezier blob (spline-draw's Path Animation) in two poses with the
// same anchor count, so the keys lerp anchor by anchor.
function blob(k: number): { subpaths: SplineSubpath[] } {
  const pts: [number, number][] = [
    [0.5, 0.22 + 0.04 * k],
    [0.76 - 0.05 * k, 0.45],
    [0.6, 0.78],
    [0.3 + 0.04 * k, 0.7],
    [0.24, 0.4 - 0.05 * k],
  ];
  const h = 0.09;
  return {
    subpaths: [
      {
        closed: true,
        anchors: pts.map((pos, i) => {
          const n = pts[(i + 1) % pts.length];
          const p = pts[(i + pts.length - 1) % pts.length];
          const dx = n[0] - p[0];
          const dy = n[1] - p[1];
          const l = Math.hypot(dx, dy) || 1;
          return { pos, inHandle: [(-dx / l) * h, (-dy / l) * h] as [number, number], outHandle: [(dx / l) * h, (dy / l) * h] as [number, number] };
        }),
      },
    ],
  };
}

// A heart in [0,1]² (svg-source's `file` param holds normalized subpaths).
const HEART: SplineSubpath[] = [
  {
    closed: true,
    anchors: [
      { pos: [0.5, 0.32], inHandle: [-0.06, -0.12], outHandle: [0.06, -0.12] },
      { pos: [0.78, 0.4], inHandle: [0, -0.14], outHandle: [0, 0.14] },
      { pos: [0.5, 0.78], inHandle: [0.16, -0.1], outHandle: [-0.16, -0.1] },
      { pos: [0.22, 0.4], inHandle: [0, 0.14], outHandle: [0, -0.14] },
    ],
  },
];

export interface ShapeCase {
  // The generator / native node, and its compared output.
  id: string;
  type: string;
  native: string;
  // The Skia Canvas that draws the Skia version.
  skia: string;
  kind: "generator" | "primitive";
  fill: boolean;
  // The keyframed params (the export must not ship them static).
  animated: string[];
}

interface GenSpec {
  def: NodeDefinition;
  fill: boolean;
  params?: Record<string, unknown>;
  animation: Record<string, KeyframeAnimationBlock>;
}

// Each generator's look + motion. Every one is keyframed: compare:skia
// measures motion, the gate wants sampled paths.
const GENERATORS: Record<string, GenSpec> = {
  circle: {
    def: circleNode,
    fill: true,
    params: { radiusX: 0.2, radiusY: 0.2 },
    animation: { centerX: kf([[0, 0.42], [60, 0.58]]), radiusX: kf([[0, 0.18], [60, 0.3]]), radiusY: kf([[0, 0.18], [60, 0.24]]) },
  },
  rectangle: {
    def: rectangleNode,
    fill: true,
    params: { width: 0.5, height: 0.34, corner_radius: 0.05 },
    animation: { rotate: kf([[0, 0], [60, 30]]), width: kf([[0, 0.44], [60, 0.56]]) },
  },
  polygon: { def: polygonNode, fill: true, params: { sides: 6 }, animation: { rotation: kf([[0, 0], [60, 60]]), radius: kf([[0, 0.26], [60, 0.34]]) } },
  star: { def: starNode, fill: true, params: { outerRadius: 0.33 }, animation: { rotation: kf([[0, 0], [60, 36]]), innerRadius: kf([[0, 0.13], [60, 0.2]]) } },
  arc: { def: arcNode, fill: true, params: { mode: "pie", radius: 0.32 }, animation: { endAngle: kf([[0, 200], [60, 320]]), startAngle: kf([[0, -20], [60, 20]]) } },
  wave: { def: waveNode, fill: false, params: { amplitude: 0.16, cycles: 2.5 }, animation: { phase: kf([[0, 0], [60, 1]], "linear") } },
  spiral: { def: spiralNode, fill: false, animation: { outerRadius: kf([[0, 0.3], [60, 0.42]]), startAngle: kf([[0, 0], [60, 90]]) } },
  cross: { def: crossNode, fill: false, params: { length: 0.2, startOffset: 0.05 }, animation: { rotation: kf([[0, 0], [60, 45]]) } },
  arrow: { def: arrowNode, fill: true, params: { shaftThickness: 0.06, headWidth: 0.18 }, animation: { tipX: kf([[0, 0.7], [60, 0.82]]), tipY: kf([[0, 0.42], [60, 0.58]]) } },
  "spline-draw": { def: splineDrawNode, fill: true, params: { spline: blob(0) }, animation: { spline: kf([[0, blob(0)], [60, blob(1)]]) } },
  "svg-source": {
    def: svgSourceNode,
    fill: true,
    params: { file: { subpaths: HEART, aspect: 1, filename: "heart.svg" } },
    animation: { rotate: kf([[0, 0], [60, 20]]), scaleX: kf([[0, 1], [60, 1.2]]) },
  },
  line: { def: lineNode, fill: false, animation: { endY: kf([[0, 0.3], [60, 0.7]]), startX: kf([[0, 0.2], [60, 0.3]]) } },
};

const PRIMITIVES: Record<string, NodeDefinition> = { circle: skiaCircleNode, rectangle: skiaRectNode, line: skiaLineNode };

export const SHAPE_CASES: ShapeCase[] = [
  ...Object.entries(GENERATORS).map(([id, g]) => ({
    id,
    type: g.def.type,
    native: `${id}:aux:image`,
    skia: `${id}_skc`,
    kind: "generator" as const,
    fill: g.fill,
    animated: Object.keys(g.animation),
  })),
  ...Object.entries(PRIMITIVES).map(([id, def]) => ({
    id: `sk${id}`,
    type: def.type,
    native: `${id}:aux:image`,
    skia: `sk${id}_skc`,
    kind: "primitive" as const,
    fill: GENERATORS[id].fill,
    animated: Object.keys(GENERATORS[id].animation),
  })),
];

const edge = (source: string, target: string, targetHandle: string): GraphEdge => ({
  id: `${source}->${target}:${targetHandle}`,
  source,
  sourceHandle: "out:primary",
  target,
  targetHandle,
});

// The generator's look: the bundled rasterizer's stroke over its fill
// (only the params the def has — SVG Source has no stroke_units).
function look(def: NodeDefinition, fill: boolean): Record<string, unknown> {
  const all: Record<string, unknown> = {
    stroke_enabled: true,
    stroke_thickness: STROKE_PX,
    stroke_units: "px",
    stroke_color: STROKE,
    fill_enabled: fill,
    fill_color: FILL,
    opacity: 1,
  };
  return Object.fromEntries(Object.entries(all).filter(([k]) => def.params.some((p) => p.name === k)));
}

export function shapesGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const [id, g] of Object.entries(GENERATORS)) {
    nodes.push({ id, type: g.def.type, params: { ...defaultsOf(g.def), ...g.params, ...look(g.def, g.fill) }, animation: g.animation });
    const shape = (sid: string, style: "fill" | "stroke") => {
      nodes.push({
        id: sid,
        type: "skia-shape",
        params: { style, color: style === "fill" ? FILL : STROKE, fill_rule: "evenodd", stroke_width: STROKE_PX, cap: "round", join: "round" },
      });
      edges.push(edge(id, sid, "in:spline"));
    };
    if (g.fill) shape(`${id}_f`, "fill");
    shape(`${id}_s`, "stroke");
    nodes.push({ id: `${id}_g`, type: "skia-group", params: { translateX: 0, translateY: 0, rotate: 0, scaleX: 1, scaleY: 1, originX: 0, originY: 0, opacity: 1, blendMode: "srcOver" } });
    if (g.fill) edges.push(edge(`${id}_f`, `${id}_g`, "in:child1"));
    edges.push(edge(`${id}_s`, `${id}_g`, g.fill ? "in:child2" : "in:child1"));
    nodes.push({ id: `${id}_skc`, type: "skia-canvas", params: { background_on: false, background: "#000000" } });
    edges.push(edge(`${id}_g`, `${id}_skc`, "in:scene"));
  }
  // The primitives: the mirrored node's params (the ones the port takes)
  // and keyframes, verbatim.
  for (const [id, def] of Object.entries(PRIMITIVES)) {
    const src = nodes.find((n) => n.id === id)!;
    const params = Object.fromEntries(def.params.map((p) => [p.name, src.params[p.name] ?? p.default]));
    nodes.push({ id: `sk${id}`, type: def.type, params, animation: { ...src.animation } });
    nodes.push({ id: `sk${id}_skc`, type: "skia-canvas", params: { background_on: false, background: "#000000" } });
    edges.push(edge(`sk${id}`, `sk${id}_skc`, "in:scene"));
  }
  return { nodes, edges };
}

export const fixture: SkiaGraphFixture = {
  description:
    "Vector shapes: each spline generator's own raster (`<id>:aux:image`) vs its spline → Skia Shape fill + stroke → Skia Group → Skia Canvas (`<id>_skc`); circle / rectangle / line vs Circle / Rectangle / Line (Skia) (`sk<id>_skc`)",
  timeline: SHAPES_TIMELINE,
  frames: SHAPES_FRAMES,
  size: 512,
  build: () => shapesGraph(),
};
