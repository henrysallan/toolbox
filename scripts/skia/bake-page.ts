// Renderer half of scripts/skia-bake-frames.cjs: Skia Bake's frames for the
// CLI exporter (scripts/export-skia.mts), rendered by toolbox's REAL engine
// in an offscreen Electron window — what the editor's renderSkiaBakeFrames
// does with its own backend (EffectsApp.tsx).
//
// The job is plain JSON: the flattened export graph, the canvas size, the
// timeline, and per bake the source wired into its image plus the ticks to
// render. Each source renders on one engine backend with one evaluation
// cache, ticks ascending — playback order, so time-driven state accumulates
// as in the editor; a simulation upstream steps every frame from 0
// (bakeNeedsSequential). The source is forced as the terminal with its
// handle (compare_renders' activeNodeId + forceHandle) and read back with
// readImagePixels at the canvas size: RGBA8, straight alpha, row 0 = top.

import { registerAllNodes } from "@/nodes/index";
import { createEngineBackend } from "@/engine/gl";
import { evaluateGraph, type EvalCache, type GraphEdge, type GraphNode } from "@/engine/evaluator";
import { pickInspectSocket } from "@/engine/socket-inspect";
import type { ImageValue } from "@/engine/types";
import { canvasKitBase, setCanvasKit } from "@/engine/skia/canvaskit";
import { bakeNeedsSequential } from "@/lib/skia-export/bake";

export interface BakeJob {
  nodes: GraphNode[];
  edges: GraphEdge[];
  size: { width: number; height: number };
  timeline: { fps: number; ticksPerFrame: number };
  renders: { nodeId: string; source: { node: string; handle: string }; ticks: number[] }[];
}

function toB64(bytes: Uint8Array | Uint8ClampedArray): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}

export async function init() {
  registerAllNodes();
  const g = window as unknown as { CanvasKitInit?: (o: object) => Promise<never> };
  if (!g.CanvasKitInit) throw new Error(`canvaskit.js did not load from ${canvasKitBase()}`);
  setCanvasKit(await g.CanvasKitInit({ locateFile: (f: string) => canvasKitBase() + f }));
  return { ok: true };
}

// One render of the job: base64 RGBA per requested tick (in `ticks`
// order), or null where the source produced no image.
export function render(job: BakeJob, index: number): (string | null)[] {
  const r = job.renders[index];
  if (!r) throw new Error(`no render ${index}`);
  const { width, height } = job.size;
  const { fps, ticksPerFrame } = job.timeline;
  const backend = createEngineBackend(width, height);
  const cache: EvalCache = new Map();
  const want = new Set(r.ticks);
  const last = Math.max(0, ...r.ticks);
  const order = bakeNeedsSequential(job.nodes, job.edges, r.source.node)
    ? [...new Set([...Array.from({ length: Math.floor(last / ticksPerFrame) + 1 }, (_, f) => f * ticksPerFrame), ...r.ticks])].sort((a, b) => a - b)
    : [...want].sort((a, b) => a - b);
  const handle = r.source.handle || "out:primary";
  const socket = handle === "out:primary" ? "out" : handle.replace(/^out:/, "");
  const got = new Map<number, string | null>();
  try {
    for (const tick of order) {
      const frame = tick / ticksPerFrame;
      const ctx = backend.makeContext(frame / fps, Math.floor(frame), undefined, true, { tick, ticksPerFrame, fps }, true);
      const res = evaluateGraph(job.nodes, job.edges, ctx, cache, r.source.node, undefined, undefined, {
        forceHandle: handle,
        extraConsumed: new Map([[r.source.node, [handle === "out:primary" ? "primary" : handle.replace(/^out:/, "")]]]),
      });
      if (!want.has(tick)) continue;
      const v = pickInspectSocket(res.outputs.get(r.source.node), socket).value;
      const px = v && (v.kind === "image" || v.kind === "mask") ? backend.readImagePixels(v as ImageValue, width, height) : null;
      if (!px && res.errors[r.source.node]) console.warn(`bake ${r.nodeId} tick ${tick}: ${res.errors[r.source.node]}`);
      got.set(tick, px ? toB64(px) : null);
    }
  } finally {
    backend.destroy();
  }
  return r.ticks.map((t) => got.get(t) ?? null);
}
