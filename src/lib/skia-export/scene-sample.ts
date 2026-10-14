// Evaluate what reaches a Skia Canvas's `scene` input at any tick — the
// sampler exportSkia hands planSceneExport (specdocs/101326_skia-target.md
// §3.4 "derived binds").
//
// Skia-layer nodes are data-only (they return IR, like the SDF socket), so
// this runs the real evaluator on the canvas's upstream closure with a
// RenderContext that has no GL: it works in the editor, in Node gates and
// in the CLI alike. A GL node upstream would get no-op stubs — the planner
// then sees whatever IR it produced (the Skia library has none).

import { evaluateGraph, type EvalCache, type GraphEdge, type GraphNode } from "@/engine/evaluator";
import type { ImageValue, MaskValue, RenderContext, SkiaDrawValue, SocketValue, UvValue } from "@/engine/types";
import { SKIA_IR_VERSION, type RGBA, type SkiaScene } from "@/engine/skia/scene-ir";
import { BAKE_IMAGE_HANDLE, SKIA_BAKE_TYPE } from "@/engine/skia/bake-frames";

export const SKIA_CANVAS_TYPE = "skia-canvas";
export const SKIA_CANVAS_SCENE_HANDLE = "in:scene";

// Every node the target depends on (following edges upstream), with the
// edges among them. `stop` (additive, Wave 3 lane B): edges not followed.
export function upstreamClosure(
  nodes: GraphNode[],
  edges: GraphEdge[],
  rootId: string,
  stop?: (e: GraphEdge) => boolean
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const keep = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of edges) {
      if (e.target === id && !keep.has(e.source) && !stop?.(e)) {
        keep.add(e.source);
        stack.push(e.source);
      }
    }
  }
  return {
    nodes: nodes.filter((n) => keep.has(n.id)),
    edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target) && !stop?.(e)),
  };
}

export function dataOnlyContext(canvas: { width: number; height: number }, timeline: { fps: number; ticksPerFrame: number }): RenderContext {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = {
    gl: {} as WebGL2RenderingContext,
    width: w,
    height: h,
    time: 0,
    frame: 0,
    tick: 0,
    ticksPerFrame: timeline.ticksPerFrame,
    fps: timeline.fps,
    playing: false,
    offline: true,
    cursor: { x: 0, y: 0, active: false },
    state: {},
    allocImage: (o?: { width?: number; height?: number }): ImageValue =>
      ({ kind: "image", texture: {} as WebGLTexture, width: o?.width ?? w, height: o?.height ?? h }) as ImageValue,
    allocMask: (o?: { width?: number; height?: number }): MaskValue =>
      ({ kind: "mask", texture: {} as WebGLTexture, width: o?.width ?? w, height: o?.height ?? h }) as MaskValue,
    allocUv: (o?: { width?: number; height?: number }): UvValue =>
      ({ kind: "uv", texture: {} as WebGLTexture, width: o?.width ?? w, height: o?.height ?? h }) as UvValue,
    releaseTexture: () => {},
    drawFullscreen: () => {},
    clearTarget: () => {},
    getShader: () => ({}) as WebGLProgram,
    tryShader: () => ({ program: {} as WebGLProgram, error: null }),
    blitToCanvas: () => {},
    blitToGLCanvas: () => {},
  };
  return ctx as unknown as RenderContext;
}

export interface SceneSampler {
  // The scene at `tick`, or null when nothing (no skia_draw) arrives.
  sampleAt(tick: number): SkiaScene | null;
  // Why the last null happened.
  lastProblem(): string | null;
  // Every distinct producer failure (SkiaDrawValue.problems) seen at any
  // sampled tick, in first-seen order.
  producerProblems(): string[];
}

// Evaluates the producer wired into `canvasId`'s scene input. One cache
// across calls: tick-independent nodes compute once.
export function makeSceneSampler(
  nodes: GraphNode[],
  edges: GraphEdge[],
  canvasId: string,
  canvas: { width: number; height: number },
  timeline: { fps: number; ticksPerFrame: number },
  background?: RGBA
): SceneSampler | { problem: string } {
  const edge = edges.find((e) => e.target === canvasId && e.targetHandle === SKIA_CANVAS_SCENE_HANDLE);
  if (!edge) return { problem: `Nothing is wired into the Skia Canvas "${canvasId}"'s scene input.` };
  // A Skia Bake's input is ENGINE content: the bake renderer draws it with
  // GL at export (bake.ts). Here the bake node sees it unwired and returns
  // its asset draw, so the engine graph behind it never runs on this
  // GL-less context.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sub = upstreamClosure(
    nodes,
    edges,
    edge.source,
    (e) => e.targetHandle === BAKE_IMAGE_HANDLE && byId.get(e.target)?.type === SKIA_BAKE_TYPE
  );
  const ctx = dataOnlyContext(canvas, timeline);
  const cache: EvalCache = new Map();
  const handle = edge.sourceHandle;
  let last: string | null = null;
  const seen = new Set<string>();
  return {
    lastProblem: () => last,
    producerProblems: () => [...seen],
    sampleAt(tick: number) {
      ctx.tick = tick;
      ctx.frame = Math.floor(tick / timeline.ticksPerFrame);
      ctx.time = tick / (timeline.ticksPerFrame * timeline.fps);
      const r = evaluateGraph(sub.nodes, sub.edges, ctx, cache, null, undefined, null, {
        extraTargets: [edge.source],
        extraConsumed: new Map([[edge.source, [handle === "out:primary" ? "primary" : handle.replace(/^out:/, "")]]]),
      });
      const out = r.outputs.get(edge.source);
      const v: SocketValue | undefined =
        handle === "out:primary" ? out?.primary : out?.aux?.[handle.replace(/^out:aux:/, "")];
      if (!v || v.kind !== "skia_draw") {
        const err = r.errors[edge.source];
        last = err
          ? `"${edge.source}" failed at tick ${tick}: ${err}`
          : `"${edge.source}" (${handle}) produced ${v ? v.kind : "nothing"} at tick ${tick}, not a Skia drawing.`;
        return null;
      }
      last = null;
      for (const p of (v as SkiaDrawValue).problems ?? []) seen.add(p);
      // An upstream compute that threw left its consumers without input
      // (a Skia Shape with no spline exports an empty path): refuse, don't
      // ship a scene the editor never drew.
      for (const [id, msg] of Object.entries(r.errors)) seen.add(`Node "${id}" failed while sampling the scene: ${msg}`);
      return {
        version: SKIA_IR_VERSION,
        width: canvas.width,
        height: canvas.height,
        ...(background ? { background } : {}),
        root: v.node,
        assets: v.assets ?? {},
      };
    },
  };
}
