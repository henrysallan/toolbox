// Renderer half of scripts/ae-export-spike/calibrate/tbx-render.cjs: renders
// toolbox nodes on exact test images with the REAL engine and node code, so
// they can be compared with After Effects renders of the same images.
//
// A test-only source node, "calib-input", uploads a straight-alpha float RGBA
// image (row 0 = top) into an engine image texture as is; the node under test
// is wired to it and evaluated as the terminal, then read back as floats
// (straight alpha, row 0 = top). Frames run in ascending order on one backend
// and one evaluation cache, so time-driven nodes (trails) accumulate as in the
// editor. calib-input exists only in this page's registry.

import { registerAllNodes } from "@/nodes/index";
import { registerNode } from "@/engine/registry";
import { createEngineBackend } from "@/engine/gl";
import { evaluateGraph, type EvalCache, type GraphEdge, type GraphNode } from "@/engine/evaluator";
import { pickInspectSocket } from "@/engine/socket-inspect";
import type { ImageValue, ModelFileParamValue, NodeDefinition, RenderContext } from "@/engine/types";
import { acquireModelIndex } from "@/engine/model-cache";

export interface TbxRender {
  id: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  // Node to read back (its primary output unless `handle`).
  target: string;
  handle?: string;
  // Frames to read back (ascending); the input image may change per frame.
  frames?: number[];
  // Evaluate every frame from 0 to the last one asked for (history-dependent
  // nodes: trails), reading back only `frames`.
  sequential?: boolean;
}

export interface TbxJob {
  size: { width: number; height: number };
  fps?: number;
  renders: TbxRender[];
}

// slot → frame → pixels. Frame -1 = every frame.
const INPUTS = new Map<string, Map<number, Float32Array>>();

const calibInput: NodeDefinition = {
  type: "calib-input",
  name: "Calibration input",
  category: "image",
  backend: "webgl2",
  // Uncacheable: a sequence input changes every frame with the same params.
  stable: false,
  inputs: [],
  params: [{ name: "slot", label: "Slot", type: "string", default: "" }],
  primaryOutput: "image",
  auxOutputs: [],
  compute({ params, ctx }: { params: Record<string, unknown>; ctx: RenderContext }) {
    const out = ctx.allocImage();
    const frames = INPUTS.get(String(params.slot));
    const px = frames?.get(ctx.frame) ?? frames?.get(-1);
    if (!px) {
      ctx.clearTarget(out, [0, 0, 0, 0]);
      return { primary: out };
    }
    const gl = ctx.gl;
    const w = out.width;
    const h = out.height;
    // GL rows run bottom-up: flip so the readback's row 0 is the file's row 0.
    const flipped = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) flipped.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    gl.bindTexture(gl.TEXTURE_2D, out.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, flipped);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { primary: out };
  },
} as unknown as NodeDefinition;

export function init() {
  registerAllNodes();
  registerNode(calibInput);
  return { ok: true };
}

export async function loadInput(slot: string, frame: number, url: string) {
  const buf = await (await fetch(url)).arrayBuffer();
  let m = INPUTS.get(slot);
  if (!m) INPUTS.set(slot, (m = new Map()));
  m.set(frame, new Float32Array(buf));
  return { slot, frame, floats: buf.byteLength / 4 };
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}

// Float readback of an engine image: straight RGBA, row 0 = top.
function readFloat(gl: WebGL2RenderingContext, img: ImageValue): Float32Array {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, img.texture, 0);
  const w = img.width;
  const h = img.height;
  const raw = new Float32Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, raw);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  return out;
}

// Import 3D loads its file asynchronously (the model cache): parse every
// model a render names before its first evaluation, so frame 0 has geometry.
const MODEL_TOKEN = {};
async function preloadModels(nodes: GraphNode[]) {
  for (const n of nodes) {
    const m = n.type === "import-3d" ? (n.params?.model as ModelFileParamValue | null | undefined) : null;
    if (m?.url && !(await acquireModelIndex(m.url, m.format, MODEL_TOKEN))) throw new Error(`${n.id}: could not load ${m.url}`);
  }
}

// One render: base64 float32 RGBA per frame (null where nothing rendered).
export async function render(job: TbxJob, index: number): Promise<{ frame: number; b64: string | null; error?: string }[]> {
  const r = job.renders[index];
  await preloadModels(r.nodes);
  const { width, height } = job.size;
  const fps = job.fps ?? 30;
  const backend = createEngineBackend(width, height);
  const cache: EvalCache = new Map();
  const handle = r.handle ?? "out:primary";
  const socket = handle === "out:primary" ? "out" : handle.replace(/^out:/, "");
  const out: { frame: number; b64: string | null; error?: string }[] = [];
  try {
    const want = r.frames ?? [0];
    const order = r.sequential ? Array.from({ length: Math.max(...want) + 1 }, (_, f) => f) : want;
    for (const frame of order) {
      const tick = frame * 1000;
      const ctx = backend.makeContext(frame / fps, frame, undefined, true, { tick, ticksPerFrame: 1000, fps }, true);
      const res = evaluateGraph(r.nodes, r.edges, ctx, cache, r.target, undefined, undefined, {
        forceHandle: handle,
        extraConsumed: new Map([[r.target, [handle === "out:primary" ? "primary" : handle.replace(/^out:/, "")]]]),
      });
      if (!want.includes(frame)) continue;
      const v = pickInspectSocket(res.outputs.get(r.target), socket).value;
      if (!v || v.kind !== "image") {
        out.push({ frame, b64: null, error: res.errors[r.target] ?? `no image (${v ? v.kind : "nothing"})` });
        continue;
      }
      const gl = (ctx as unknown as { gl: WebGL2RenderingContext }).gl;
      const f = readFloat(gl, v as ImageValue);
      out.push({ frame, b64: toB64(new Uint8Array(f.buffer)) });
    }
  } finally {
    backend.destroy();
  }
  return out;
}
