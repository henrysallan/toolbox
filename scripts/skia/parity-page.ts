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
import { compareRgba, diffHeatRgba } from "@/lib/glsl-translation/compare";
import { auroraGraph, AURORA_TIMELINE } from "../fixtures/skia/aurora-graph";
import { auroraSceneGraph } from "../fixtures/skia/aurora-scene-graph";
import { easingsGraph, EASINGS_TIMELINE } from "../fixtures/skia/easings-graph";
import { atlasGraph, ATLAS_TIMELINE } from "../fixtures/skia/atlas-graph";
import { imageEffectGraph, imageFixtureReady, IMAGE_TIMELINE } from "../fixtures/skia/image-graph";
import { proceduralAuroraGraph } from "../fixtures/skia/procedural-graph";
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
// "procedural" / "procedural-baked" (Wave 3 lane P) the Aurora node on
// procedural drivers (procedural-graph.ts) — the graph both slots export.
// "bake" (Wave 3 lane B) renders the Skia Bake fixture's canvas
// (bake-graph.ts, src/bundle-bake) — the live engine frames (Noise → Blur
// → Skia Bake's preview) the shipped sprite sheet was baked from.
export async function renderToolbox(
  frames: number[],
  size: number,
  which: "effect" | "scene" | "baked" | "native" | "native-easings" | "native-scene" | "atlas" | "image" | "procedural" | "procedural-baked" | "bake" = "effect"
): Promise<string[]> {
  registerAllNodes();
  const init = (window as unknown as { CanvasKitInit: (o: object) => Promise<never> }).CanvasKitInit;
  setCanvasKit(await init({ locateFile: (f: string) => CANVASKIT_BASE + f }));
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
            : which === "bake"
              ? bakeGraph()
              : auroraGraph(AURORA_SKSL);
  const { fps, ticksPerFrame } =
    which === "native-easings" ? EASINGS_TIMELINE : which === "atlas" ? ATLAS_TIMELINE : which === "image" ? IMAGE_TIMELINE : which === "bake" ? BAKE_TIMELINE : AURORA_TIMELINE;
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
