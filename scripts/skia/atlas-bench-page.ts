// Renderer half of `npm run bench:skia-atlas` (scripts/skia-atlas-bench.cjs):
// what one frame of Copy to Points (Skia) costs to DRAW, groups vs atlas, on
// CanvasKit's WebGL backend (Ganesh) — the Skia build React Native Skia's web
// target runs (specdocs/101326_skia-target.md §3.4 built and measured).
//
// Each config builds its scene through the real node (a Grid of N points →
// Copy to Points (Skia) → Skia Canvas's scene input, sampled data-only),
// with the instance a star (Skia Shape fill + stroke: two anti-aliased
// paths). Scenes for every frame are sampled first — the evaluator's CPU
// time is not what is measured — then each frame is drawn with
// renderScene on a WebGL surface and the GPU is waited for (a 1-px
// readPixels), so the time is recording + submit + GPU. The atlas's sprite
// sheet comes from a texture cache (it renders once, as useTexture does);
// its one-time raster is reported separately.
//
// Not measured here: React Native's reconciler / Reanimated mappers (the
// emitted bundle's per-frame JS: N derived transforms for animated groups vs
// one RSXform buffer), Graphite on device.

import { registerAllNodes } from "@/nodes/index";
import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { Image, Surface } from "canvaskit-wasm";
import { canvasKit, canvasKitBase, setCanvasKit } from "@/engine/skia/canvaskit";
import { renderScene } from "@/engine/skia/scene-render";
import type { SkiaScene } from "@/engine/skia/scene-ir";
import { makeSceneSampler } from "@/lib/skia-export/scene-sample";
import { atlasGraph } from "../fixtures/skia/atlas-graph";

const TL = { fps: 30, ticksPerFrame: 1000 };
let shared: { size: number; surface: Surface } | null = null;

export async function init() {
  registerAllNodes();
  const g = window as unknown as { CanvasKitInit?: (o: object) => Promise<never> };
  if (!g.CanvasKitInit) throw new Error("canvaskit.js did not load");
  setCanvasKit(await g.CanvasKitInit({ locateFile: (f: string) => canvasKitBase() + f }));
  return { ok: true };
}

function graphFor(n: number, strategy: "groups" | "atlas", animated: boolean): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const g = atlasGraph({});
  const side = Math.round(Math.sqrt(n));
  const grid = g.nodes.find((x) => x.id === "grid")!;
  Object.assign(grid.params, { countX: side, countY: Math.ceil(n / side), width: 0.92, height: 0.92 });
  const id = strategy === "atlas" ? "ska_grid" : "skg_grid";
  const node = g.nodes.find((x) => x.id === id)!;
  // Scale the copies so the grid stays legible at every N.
  node.params.scale_mul_default = Math.min(1, 6 / side);
  if (!animated) delete node.animation;
  else node.animation = { rotate_add_default: { animated: true, trackVisible: true, keyframes: [{ tick: 0, value: 0, easingOut: "linear" }, { tick: 60_000, value: Math.PI, easingOut: "linear" }] } };
  return g;
}

export function bench(n: number, strategy: "groups" | "atlas", size: number, frames: number, animated: boolean) {
  const kit = canvasKit()!;
  const { nodes, edges } = graphFor(n, strategy, animated);
  const canvasId = strategy === "atlas" ? "ska_grid_skc" : "skg_grid_skc";
  const s = makeSceneSampler(nodes, edges, canvasId, { width: size, height: size }, TL);
  if ("problem" in s) throw new Error(s.problem);
  const scenes: SkiaScene[] = [];
  for (let f = 0; f < frames; f++) {
    const sc = s.sampleAt(((animated ? f : 0) % 61) * TL.ticksPerFrame);
    if (!sc) throw new Error(s.lastProblem() ?? "no scene");
    scenes.push(sc);
  }
  const root = scenes[0].root;
  const kind = root.k === "atlas" ? "atlas" : `groups(${root.k === "group" ? root.children.length : 0})`;
  // One WebGL context for the whole run (browsers cap live contexts).
  if (!shared || shared.size !== size) {
    const el = document.createElement("canvas");
    el.width = size;
    el.height = size;
    document.body.appendChild(el);
    const surface = kit.MakeWebGLCanvasSurface(el);
    if (!surface) throw new Error("no WebGL surface");
    shared = { size, surface };
  }
  const surface = shared.surface;
  const canvas = surface.getCanvas();
  const cache = new Map<string, Image>();
  const px = { width: 1, height: 1, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB };
  const draw = (sc: SkiaScene) => {
    canvas.clear(kit.TRANSPARENT);
    const r = renderScene(kit, canvas, sc, { textureCache: cache });
    surface.flush();
    canvas.readPixels(0, 0, px);
    r.release();
    if (r.problems.length) throw new Error(r.problems.join("; "));
  };
  // First frame: includes the atlas's one-time sheet raster.
  const t0 = performance.now();
  draw(scenes[0]);
  const first = performance.now() - t0;
  // Warm up, then time. performance.now() is coarse in Electron (0.1 ms),
  // so the mean comes from one timed run of every frame, the spread from
  // per-frame samples.
  for (let i = 0; i < 5; i++) draw(scenes[i % scenes.length]);
  const times: number[] = [];
  const r0 = performance.now();
  for (const sc of scenes) {
    const a = performance.now();
    draw(sc);
    times.push(performance.now() - a);
  }
  const mean = (performance.now() - r0) / scenes.length;
  times.sort((a, b) => a - b);
  const med = mean;
  const p90 = times[Math.floor(times.length * 0.9)];
  for (const img of cache.values()) img.delete();
  return { n, strategy, kind, size, frames, animated, firstMs: first, medianMs: med, p90Ms: p90 };
}

export function renderer() {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2");
  const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
  return gl ? String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : "none";
}
