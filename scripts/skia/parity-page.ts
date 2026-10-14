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
import { compareRgba, diffHeatRgba } from "@/lib/glsl-translation/compare";
import { auroraGraph, AURORA_TIMELINE } from "../fixtures/skia/aurora-graph";
import { auroraSceneGraph } from "../fixtures/skia/aurora-scene-graph";
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

// `which`: "effect" renders the M0 SkSL Shader node (src/bundle), "scene"
// the Skia-layer chain's Skia Canvas (src/bundle-scene).
export async function renderToolbox(frames: number[], size: number, which: "effect" | "scene" = "effect"): Promise<string[]> {
  registerAllNodes();
  const init = (window as unknown as { CanvasKitInit: (o: object) => Promise<never> }).CanvasKitInit;
  setCanvasKit(await init({ locateFile: (f: string) => CANVASKIT_BASE + f }));
  const backend = createEngineBackend(size, size);
  const { nodes, edges, targetId } =
    which === "scene" ? { ...auroraSceneGraph(AURORA_SKSL), targetId: "skc" } : auroraGraph(AURORA_SKSL);
  const { fps, ticksPerFrame } = AURORA_TIMELINE;
  const out: string[] = [];
  for (const f of frames) {
    const ctx = backend.makeContext(f / fps, f, undefined, false, { tick: f * ticksPerFrame, ticksPerFrame, fps }, true);
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
