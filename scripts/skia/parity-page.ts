// Renderer half of `npm run parity:skia` (scripts/skia-parity.cjs). Bundled
// by esbuild and loaded into a hidden Electron window with real WebGL2.
//
// renderToolbox() renders the Aurora fixture through toolbox's REAL path —
// evaluateGraph → Animated Value / Color drivers → SkSL Shader node →
// CanvasKit → the engine image → readImagePixels — i.e. exactly what the
// editor shows. compare() runs the same metrics compare_renders reports
// (src/lib/glsl-translation/compare.ts) on the device frames the main
// process captured from the React Native Skia harness.

import { registerAllNodes } from "@/nodes/index";
import { createEngineBackend } from "@/engine/gl";
import { evaluateGraph, type EvalCache } from "@/engine/evaluator";
import { setCanvasKit, CANVASKIT_BASE } from "@/engine/skia/canvaskit";
import { sceneAssetsSettled } from "@/engine/skia/scene-assets";
import { renderScene } from "@/engine/skia/scene-render";
import { makeSceneSampler } from "@/lib/skia-export/scene-sample";
import { compareRgba, diffHeatRgba } from "@/lib/glsl-translation/compare";
import { auroraGraph, AURORA_TIMELINE } from "../fixtures/skia/aurora-graph";
import { auroraSceneGraph } from "../fixtures/skia/aurora-scene-graph";
import { easingsGraph, EASINGS_TIMELINE } from "../fixtures/skia/easings-graph";
import { atlasGraph, ATLAS_TIMELINE } from "../fixtures/skia/atlas-graph";
import { imageEffectGraph, imageFixtureReady, IMAGE_TIMELINE } from "../fixtures/skia/image-graph";
import { proceduralAuroraGraph } from "../fixtures/skia/procedural-graph";
import { textBundleGraph, TEXT_TIMELINE } from "../fixtures/skia/text-graph";
import { filtersGraph, FILTERS_HARNESS_CANVAS, FILTERS_SIZE, FILTERS_TIMELINE } from "../fixtures/skia/filters-graph";
import { splitGraph, SPLIT_PARITY_CANVAS, SPLIT_TIMELINE } from "../fixtures/skia/split-graph";
import { bakeGraph, BAKE_TIMELINE } from "../fixtures/skia/bake-graph";
import { evaluateKeyframesAt } from "@/engine/keyframes";
// esbuild --loader:.sksl=text
import AURORA_SKSL from "../fixtures/skia/aurora.sksl";

function toB64(bytes: Uint8Array | Uint8ClampedArray): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// One CanvasKit per page: the engine's shared Skia surface and the SkSL
// compile cache hold objects of the instance that made them, so a second
// CanvasKitInit would mix two instances (a fused program then fails to
// draw on the first one's surface).
let kitPromise: Promise<never> | null = null;
function loadKit(): Promise<never> {
  if (!kitPromise) {
    const init = (window as unknown as { CanvasKitInit: (o: object) => Promise<never> }).CanvasKitInit;
    kitPromise = init({ locateFile: (f: string) => CANVASKIT_BASE + f }).then((kit) => {
      setCanvasKit(kit);
      return kit;
    });
  }
  return kitPromise;
}

// `which`: "effect" renders the M0 SkSL Shader node (src/bundle) — also the
// reference for "baked" (src/bundle-baked, the same node exported with its
// timeline inside the SkSL) — "scene" the Skia-layer chain's Skia Canvas
// (src/bundle-scene); the native-mode slots render the graphs they were
// exported from — "native" the same Aurora SkSL node (src/bundle-native),
// "native-easings" the every-easing node (easings-graph.ts,
// src/bundle-native-easings), "native-scene" the Skia-layer Aurora
// (src/bundle-native-scene).
// "atlas" (Copy to Points (Skia), atlas-graph.ts `combo_skc`) runs at 30 fps:
// its frames are given at the capture's 60 Hz and rendered at that time.
// "image" (Wave 3 lane I) renders image-graph.ts's SkSL Shader: an Image
// Source into iImage1 + ramp / curve LUT channels (src/bundle-image).
// "text" (Wave 3 lane T) renders text-graph.ts textBundleGraph (src/bundle-text):
// its bundled fonts load in the warm-up frame like any asset.
// "procedural" / "procedural-baked" (Wave 3 lane P) the Aurora node on
// procedural drivers (procedural-graph.ts) — the graph both slots export.
// "filters" (src/bundle-filters) is the Skia filter family's web-playable
// canvas (filters-graph.ts native_all_s), whose params are canvas PIXELS: at
// the composition's own size (512) it renders through the real path like
// every slot; at any other size the export's root group scales the 512 px
// scene to the device canvas, blur sigmas and offsets with it, so toolbox
// draws the same scene IR under that scale (renderScene on a CanvasKit
// WebGL surface with canvas.scale(size / 512), what React Native Skia
// replays) — and renderFiltersReference gives the editor's 512² frames
// box-downsampled, the density cross-check.
// "split" (Wave 3 lane S) the stage splitter's two-layer canvas
// (split-graph.ts `c_combo`, src/bundle-split).
// "bake" (Wave 3 lane B) renders the Skia Bake fixture's canvas
// (bake-graph.ts, src/bundle-bake) — the live engine frames (Noise → Blur
// → Skia Bake's preview) the shipped sprite sheet was baked from.
export async function renderToolbox(
  frames: number[],
  size: number,
  which: "effect" | "scene" | "baked" | "native" | "native-easings" | "native-scene" | "atlas" | "image" | "procedural" | "procedural-baked" | "text" | "filters" | "split" | "bake" = "effect"
): Promise<string[]> {
  registerAllNodes();
  const kit = await loadKit();
  if (which === "filters" && size !== FILTERS_SIZE) return renderFiltersScaled(kit, frames, size);
  if (which === "filters") return renderFiltersReal(frames, FILTERS_SIZE);
  const backend = createEngineBackend(size, size);
  const { nodes, edges, targetId } =
    which === "scene" || which === "native-scene"
      ? { ...auroraSceneGraph(AURORA_SKSL), targetId: "skc" }
      : which === "native-easings"
        ? easingsGraph()
        : which === "atlas"
          ? { ...atlasGraph(), targetId: "combo_skc" }
          : which === "image"
            ? imageEffectGraph(await imageFixtureReady())
            : which === "procedural" || which === "procedural-baked"
              ? proceduralAuroraGraph(AURORA_SKSL)
              : which === "text"
                ? textBundleGraph()
                : which === "split"
                  ? { ...splitGraph(), targetId: SPLIT_PARITY_CANVAS }
                  : which === "bake"
                    ? bakeGraph()
                    : auroraGraph(AURORA_SKSL);
  const { fps, ticksPerFrame } =
    which === "native-easings"
      ? EASINGS_TIMELINE
      : which === "atlas"
        ? ATLAS_TIMELINE
        : which === "image"
          ? IMAGE_TIMELINE
          : which === "text"
            ? TEXT_TIMELINE
            : which === "split"
              ? SPLIT_TIMELINE
              : which === "bake"
                ? BAKE_TIMELINE
                : AURORA_TIMELINE;
  const out: string[] = [];
  // Images / fonts load asynchronously (scene-assets.ts): one warm-up frame
  // asks for them, and every frame below renders with them decoded.
  {
    const ctx = backend.makeContext(0, 0, undefined, false, { tick: 0, ticksPerFrame, fps }, true);
    evaluateGraph(nodes, edges, ctx, new Map() as EvalCache, targetId);
    await sceneAssetsSettled();
  }
  for (const capture of frames) {
    const f = which === "atlas" ? (capture * fps) / 60 : capture;
    const ctx = backend.makeContext(f / fps, f, undefined, false, { tick: Math.round(f * ticksPerFrame), ticksPerFrame, fps }, true);
    const r = evaluateGraph(nodes, edges, ctx, new Map() as EvalCache, targetId);
    const img = r.outputs.get(targetId)?.primary;
    if (!img || img.kind !== "image") throw new Error(`frame ${f}: no image (${JSON.stringify(r.errors)})`);
    const px = backend.readImagePixels(img);
    if (!px) throw new Error(`frame ${f}: readback failed`);
    out.push(toB64(px));
  }
  backend.destroy();
  return out;
}

// The filters canvas through toolbox's real path (evaluateGraph → Skia
// Canvas → engine image → readImagePixels) at `size`.
function renderFiltersReal(frames: number[], size: number): string[] {
  const backend = createEngineBackend(size, size);
  const { nodes, edges } = filtersGraph();
  const { fps, ticksPerFrame } = FILTERS_TIMELINE;
  const out: string[] = [];
  for (const f of frames) {
    const ctx = backend.makeContext(f / fps, f, undefined, false, { tick: f * ticksPerFrame, ticksPerFrame, fps }, true);
    const r = evaluateGraph(nodes, edges, ctx, new Map() as EvalCache, FILTERS_HARNESS_CANVAS);
    const img = r.outputs.get(FILTERS_HARNESS_CANVAS)?.primary;
    if (!img || img.kind !== "image") throw new Error(`frame ${f}: no image (${JSON.stringify(r.errors)})`);
    const px = backend.readImagePixels(img);
    if (!px) throw new Error(`frame ${f}: readback failed`);
    out.push(toB64(px));
  }
  backend.destroy();
  return out;
}

// The 512 px scene IR drawn at size × size under the export's root scale.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderFiltersScaled(kit: any, frames: number[], size: number): string[] {
  const { nodes, edges } = filtersGraph();
  const comp = { width: FILTERS_SIZE, height: FILTERS_SIZE };
  const sampler = makeSceneSampler(nodes, edges, FILTERS_HARNESS_CANVAS, comp, FILTERS_TIMELINE);
  if ("problem" in sampler) throw new Error(sampler.problem);
  const el = document.createElement("canvas");
  el.width = size;
  el.height = size;
  const surface = kit.MakeWebGLCanvasSurface(el, kit.ColorSpace.SRGB, { premultipliedAlpha: 0, preserveDrawingBuffer: 1 });
  if (!surface) throw new Error("no CanvasKit WebGL surface");
  const out: string[] = [];
  for (const f of frames) {
    const scene = sampler.sampleAt(f * FILTERS_TIMELINE.ticksPerFrame);
    if (!scene) throw new Error(`frame ${f}: ${sampler.lastProblem()}`);
    const c = surface.getCanvas();
    c.clear(kit.TRANSPARENT);
    c.save();
    c.scale(size / FILTERS_SIZE, size / FILTERS_SIZE);
    const r = renderScene(kit, c, scene, { surfaceSize: [size, size] });
    c.restore();
    surface.flush();
    if (r.problems.length) throw new Error(`frame ${f}: ${r.problems.join(" | ")}`);
    const px = c.readPixels(0, 0, { width: size, height: size, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    r.release();
    if (!px) throw new Error(`frame ${f}: readPixels failed`);
    out.push(toB64(new Uint8Array(px)));
  }
  surface.delete();
  return out;
}

// The editor's frames (the real path at the composition's 512²), box-
// downsampled to `size` (512 must be a multiple): the density cross-check
// for a parity run at another size. Premultiplied box average, then
// unpremultiplied, so transparent pixels don't darken edges.
export async function renderFiltersReference(frames: number[], size: number): Promise<string[]> {
  registerAllNodes();
  await loadKit();
  const k = FILTERS_SIZE / size;
  if (!Number.isInteger(k)) throw new Error(`${FILTERS_SIZE} is not a multiple of ${size}`);
  return renderFiltersReal(frames, FILTERS_SIZE).map((b64) => {
    const src = fromB64(b64);
    const out = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const acc = [0, 0, 0, 0];
        for (let dy = 0; dy < k; dy++) {
          for (let dx = 0; dx < k; dx++) {
            const i = ((y * k + dy) * FILTERS_SIZE + (x * k + dx)) * 4;
            const a = src[i + 3] / 255;
            acc[0] += src[i] * a;
            acc[1] += src[i + 1] * a;
            acc[2] += src[i + 2] * a;
            acc[3] += src[i + 3];
          }
        }
        const o = (y * size + x) * 4;
        const a = acc[3] / (k * k);
        const al = a / 255;
        out[o] = al > 0 ? Math.round(acc[0] / (k * k) / al) : 0;
        out[o + 1] = al > 0 ? Math.round(acc[1] / (k * k) / al) : 0;
        out[o + 2] = al > 0 ? Math.round(acc[2] / (k * k) / al) : 0;
        out[o + 3] = Math.round(a);
      }
    }
    return toB64(out);
  });
}

export function compare(a: string, b: string, width: number, height: number) {
  const pa = fromB64(a);
  const pb = fromB64(b);
  const m = compareRgba(pa, pb, width, height);
  // compareRgba reports means and percentiles; the spike also wants the
  // worst single channel (in 8-bit steps) and how many pixels are identical.
  let maxSteps = 0;
  let identical = 0;
  for (let i = 0; i < width * height; i++) {
    let px = 0;
    for (let c = 0; c < 4; c++) px = Math.max(px, Math.abs(pa[i * 4 + c] - pb[i * 4 + c]));
    if (px === 0) identical++;
    if (px > maxSteps) maxSteps = px;
  }
  return {
    metrics: { ...m, maxSteps, identical: identical / (width * height) },
    heat: toB64(diffHeatRgba(pa, pb, width, height)),
  };
}

// The bake fixture between frames (skia-parity.cjs `bake`, the hold check):
// toolbox frame f vs a device capture at f + δ, outside the band the ring
// sweeps over [f, f + 1] (its radius is a track and moves between frames;
// the baked noise must not). The ring is centred on the canvas, radius ×
// width, 3 px stroke; 3 px of anti-aliasing margin either side.
export function compareOutsideRing(a: string, b: string, width: number, height: number, frame: number) {
  const pa = fromB64(a);
  const pb = fromB64(b);
  const ring = bakeGraph().nodes.find((n) => n.id === "ring")!;
  const rAt = (f: number) =>
    (evaluateKeyframesAt(ring.animation!.radiusX, "scalar", f * BAKE_TIMELINE.ticksPerFrame) as number) * width;
  const r0 = Math.min(rAt(frame), rAt(frame + 1)) - 1.5 - 3;
  const r1 = Math.max(rAt(frame), rAt(frame + 1)) + 1.5 + 3;
  let maxSteps = 0;
  let identical = 0;
  let pixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2);
      if (d >= r0 && d <= r1) continue;
      pixels++;
      const i = y * width + x;
      let px = 0;
      for (let c = 0; c < 4; c++) px = Math.max(px, Math.abs(pa[i * 4 + c] - pb[i * 4 + c]));
      if (px === 0) identical++;
      if (px > maxSteps) maxSteps = px;
    }
  }
  return { metrics: { verdict: maxSteps === 0 ? "match" : "off", maxSteps, identical: identical / pixels, pixels } };
}
