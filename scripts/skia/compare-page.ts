// Renderer half of `npm run compare:skia` (scripts/skia-compare.cjs). Bundled
// by esbuild behind a generated entry that registers the fixture modules
// and text assets, then loaded into an offscreen Electron window with real
// WebGL2.
//
// Each side (A, B) is one node of one fixture graph, rendered through
// toolbox's REAL path — evaluateGraph with the node forced as the terminal
// (the same `activeNodeId` + `forceHandle` the editor's compare_renders
// uses), SkSL nodes through CanvasKit — and read back with the engine's
// readImagePixels (RGBA8, row 0 = top). Each side gets its own engine
// backend: the evaluator's end-of-eval state sweep would otherwise dispose
// the other fixture's node state on every switch. The metrics are
// compare_renders' own (src/lib/glsl-translation/compare.ts) plus the worst
// single channel and the identical-pixel fraction.

import { registerAllNodes } from "@/nodes/index";
import { createEngineBackend, type EngineBackend } from "@/engine/gl";
import { evaluateGraph, type EvalCache, type GraphEdge, type GraphNode } from "@/engine/evaluator";
import { pickInspectSocket } from "@/engine/socket-inspect";
import type { ImageValue } from "@/engine/types";
import { canvasKitBase, setCanvasKit } from "@/engine/skia/canvaskit";
import { sceneAssetGeneration, sceneAssetsSettled } from "@/engine/skia/scene-assets";
import { compareRgba, diffHeatRgba } from "@/lib/glsl-translation/compare";
import type { SkiaGraphFixture } from "./fixture";

export interface SideSpec {
  fixture: string;
  node: string;
  // "primary" or "aux:<name>"
  handle: string;
}

interface Side {
  spec: SideSpec;
  fx: SkiaGraphFixture;
  nodes: GraphNode[];
  edges: GraphEdge[];
  backend: EngineBackend;
}

let modules: Record<string, Record<string, unknown>> = {};
let assets: Record<string, string> = {};
let size: [number, number] = [512, 512];
const sides: Record<string, Side> = {};

// Called by the generated entry with every fixture module and text asset.
export function install(m: Record<string, Record<string, unknown>>, a: Record<string, string>) {
  modules = m;
  assets = a;
}

function fixtureOf(name: string): SkiaGraphFixture {
  const mod = modules[name];
  if (!mod) throw new Error(`no fixture module "${name}" was bundled`);
  const fx = mod.fixture as SkiaGraphFixture | undefined;
  if (!fx || typeof fx.build !== "function" || !fx.timeline) {
    const exported = Object.keys(mod).join(", ") || "nothing";
    throw new Error(
      `scripts/fixtures/skia/${name}-graph.ts must export \`fixture: SkiaGraphFixture\` (scripts/skia/fixture.ts); it exports ${exported}`
    );
  }
  return fx;
}

function build(name: string) {
  const fx = fixtureOf(name);
  const g = fx.build({
    text(file: string) {
      const t = assets[file];
      if (t === undefined) {
        throw new Error(
          `fixture "${name}" asked for text asset "${file}"; have: ${Object.keys(assets).join(", ") || "none"}`
        );
      }
      return t;
    },
  });
  return { fx, ...g };
}

// Fixture metadata, before any GL exists — the main process picks the
// default frames and canvas size from side A.
export function info(name: string) {
  const { fx, nodes } = build(name);
  return {
    description: fx.description ?? null,
    timeline: fx.timeline,
    frames: fx.frames ? [...fx.frames] : null,
    size: fx.size === undefined ? null : typeof fx.size === "number" ? [fx.size, fx.size] : [...fx.size],
    nodes: nodes.map((n) => ({ id: n.id, type: n.type })),
  };
}

// Await a fixture's `ready()` (fonts, assets) — after init, before prepare.
export async function settle(name: string) {
  const fx = fixtureOf(name);
  if (fx.ready) await fx.ready();
  return true;
}

export async function init(width: number, height: number) {
  registerAllNodes();
  size = [width, height];
  const g = window as unknown as { CanvasKitInit?: (o: object) => Promise<never> };
  if (!g.CanvasKitInit) throw new Error(`canvaskit.js did not load from ${canvasKitBase()}`);
  setCanvasKit(await g.CanvasKitInit({ locateFile: (f: string) => canvasKitBase() + f }));
  return { canvasKitBase: canvasKitBase() };
}

export async function prepare(key: string, spec: SideSpec) {
  // A fixture that needs something asynchronous (a decoded bitmap) started
  // it on its first build (info); wait for it before building the sides.
  await fixtureOf(spec.fixture).ready?.();
  const { fx, nodes, edges } = build(spec.fixture);
  const node = nodes.find((n) => n.id === spec.node);
  if (!node) {
    throw new Error(
      `${key}: fixture "${spec.fixture}" has no node "${spec.node}" (nodes: ${nodes.map((n) => `${n.id} [${n.type}]`).join(", ")})`
    );
  }
  const backend = createEngineBackend(size[0], size[1]);
  sides[key] = { spec, fx, nodes, edges, backend };
  const gl = backend.gl;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return { nodeType: node.type, renderer: String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) };
}

function renderSide(key: string, frame: number, aw: number, ah: number): Uint8ClampedArray {
  const side = sides[key];
  if (!side) throw new Error(`${key} was not prepared`);
  const { spec, fx, nodes, edges, backend } = side;
  const { fps, ticksPerFrame } = fx.timeline;
  const ctx = backend.makeContext(
    frame / fps,
    frame,
    undefined,
    false,
    { tick: Math.round(frame * ticksPerFrame), ticksPerFrame, fps },
    true
  );
  const forceHandle = spec.handle === "primary" ? "out:primary" : `out:${spec.handle}`;
  const r = evaluateGraph(nodes, edges, ctx, new Map() as EvalCache, spec.node, undefined, undefined, {
    forceHandle,
    extraConsumed: new Map([[spec.node, [spec.handle]]]),
  });
  const label = `${key} = ${spec.fixture}:${spec.node}${spec.handle === "primary" ? "" : `:${spec.handle}`}`;
  const errs = Object.entries(r.errors);
  if (r.errors[spec.node]) throw new Error(`${label} f${frame}: ${r.errors[spec.node]}`);
  const output = r.outputs.get(spec.node);
  if (!output) {
    throw new Error(
      `${label} f${frame}: the node produced no output${errs.length ? ` (errors: ${JSON.stringify(r.errors)})` : " (bypassed, clip-gated, or a group shell?)"}`
    );
  }
  if (spec.handle.startsWith("aux:") && !(spec.handle.slice(4) in (output.aux ?? {}))) {
    throw new Error(
      `${label}: no output "${spec.handle}" — this node emits primary${Object.keys(output.aux ?? {})
        .map((n) => `, aux:${n}`)
        .join("")}`
    );
  }
  const picked = pickInspectSocket(output, spec.handle === "primary" ? "out" : spec.handle);
  const v = picked.value;
  if (!v || (v.kind !== "image" && v.kind !== "mask")) {
    throw new Error(`${label} f${frame}: ${picked.socket} carries ${v ? v.kind : "nothing"}, not an image`);
  }
  for (const [id, msg] of errs) console.warn(`${label} f${frame}: node ${id}: ${msg}`);
  const px = backend.readImagePixels(v as ImageValue, aw, ah);
  if (!px) throw new Error(`${label} f${frame}: readImagePixels failed`);
  return px;
}

function toB64(bytes: Uint8Array | Uint8ClampedArray): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}

export function stats(pa: Uint8Array | Uint8ClampedArray, pb: Uint8Array | Uint8ClampedArray, w: number, h: number) {
  let maxSteps = 0;
  let identical = 0;
  for (let i = 0; i < w * h; i++) {
    let px = 0;
    for (let c = 0; c < 4; c++) px = Math.max(px, Math.abs(pa[i * 4 + c] - pb[i * 4 + c]));
    if (px === 0) identical++;
    if (px > maxSteps) maxSteps = px;
  }
  return { maxSteps, identical: identical / (w * h) };
}

// A side that wrote premultiplied rgb into its straight image (`--premul-a`;
// the GL Copy to Points' image mode did until 2026-10-16 — no fixture pair
// needs it since), made straight again.
function unpremultiply(px: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 0 || a === 255) continue;
    for (let c = 0; c < 3; c++) px[i + c] = Math.min(255, Math.round((px[i + c] * 255) / a));
  }
  return px;
}

// Render a side; when the frame asked the asset loader for an image or
// font that was not decoded yet (scene-assets.ts), wait for it and render
// again — the editor does the same through pipeline-bump.
async function renderSettled(key: string, f: number, aw: number, ah: number): Promise<Uint8ClampedArray> {
  const g0 = sceneAssetGeneration();
  const px = renderSide(key, f, aw, ah);
  await sceneAssetsSettled();
  return sceneAssetGeneration() === g0 ? px : renderSide(key, f, aw, ah);
}

// One frame: render A and B at analysis size, score them, hand back the
// three images (A, B, |A−B| heat) as base64 RGBA for the main process.
export async function frame(f: number, aw: number, ah: number, threshold?: number, premulA = false) {
  const a = await renderSettled("A", f, aw, ah);
  const pa = premulA ? unpremultiply(a) : a;
  const pb = await renderSettled("B", f, aw, ah);
  const metrics = { ...compareRgba(pa, pb, aw, ah, threshold ? { threshold } : {}), ...stats(pa, pb, aw, ah) };
  return { metrics, a: toB64(pa), b: toB64(pb), heat: toB64(diffHeatRgba(pa, pb, aw, ah)) };
}

// How much side `key` changed between two frames (meanAbs) — tells a
// static picture from a fixture whose drivers never moved.
export async function motion(key: string, f0: number, f1: number, aw: number, ah: number) {
  return compareRgba(await renderSettled(key, f0, aw, ah), await renderSettled(key, f1, aw, ah), aw, ah).meanAbs;
}

export function destroy() {
  for (const s of Object.values(sides)) s.backend.destroy();
}
