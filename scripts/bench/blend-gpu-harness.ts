// Renderer-side harness for bench-blend-gpu.cjs: times Blend Intersections'
// REAL field evaluators (evaluateFieldCpu vs evaluateFieldGpu — no
// transcriptions) and the full node-level blendIntersections, on the
// hardware GL context of a hidden Electron window.
//
// Why this exists: bench:nodes cannot measure this node — its compute keeps
// a geometry-signature cache, so identical repeated inputs cache-hit and
// report ~0.1 ms (a known limitation recorded in the profiler doc). And
// bench:spline runs under tsx with no GL, so it can only ever see the CPU
// path. This harness is the one place both paths run side by side on real
// hardware.
//
// Timing notes: min over reps (same reasoning as bench-spline-chain.mts);
// the GPU number is WALL CLOCK for pack + upload + draw + readPixels —
// the synchronous readback closes the pipeline, so no timer queries are
// needed and nothing is deferred out of the measurement. performance.now()
// is 100 µs-coarsened without cross-origin isolation, so the sub-ms GPU
// path is timed over an inner batch and divided.

import { buildCorpus } from "../blend-gpu-corpus.mts";
import {
  blendIntersections,
  buildFieldJob,
  evaluateFieldCpu,
} from "@/engine/spline-blend-intersections";
import {
  evaluateFieldGpu,
  type BlendFieldGpuContext,
} from "@/engine/spline-blend-intersections-gpu";

// gl.ts FULLSCREEN_VS — the engine VS shape the field shader pairs with.
const FULLSCREEN_VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  v_uv = (p + 1.0) * 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

interface CaseResult {
  name: string;
  gw: number;
  gh: number;
  segCount: number;
  samples: number;
  setupMs: number;
  cpuFieldMs: number;
  gpuFieldMs: number | null; // null = GPU path unavailable/fell back
  nodeCpuMs: number;
  nodeGpuMs: number | null;
}

function minOverReps(reps: number, inner: number, fn: () => void): number {
  fn(); // warm
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    for (let j = 0; j < inner; j++) fn();
    const dt = (performance.now() - t0) / inner;
    if (dt < best) best = dt;
  }
  return best;
}

export function run(opts: { reps?: number } = {}): {
  gl: string;
  results: CaseResult[];
} {
  const reps = opts.reps ?? 7;
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    premultipliedAlpha: false,
  });
  if (!gl) throw new Error("no webgl2 context");

  // Minimal getShader with the engine's semantics (compile once per key).
  const shaderCache = new Map<string, WebGLProgram>();
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(String(gl.getShaderInfoLog(s)));
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, FULLSCREEN_VS);
  const getShader = (key: string, fsSrc: string): WebGLProgram => {
    const hit = shaderCache.get(key);
    if (hit) return hit;
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(String(gl.getProgramInfoLog(p)));
    }
    shaderCache.set(key, p);
    return p;
  };
  const gpu: BlendFieldGpuContext = { gl, getShader };

  const results: CaseResult[] = [];
  for (const c of buildCorpus()) {
    if (c.jitterFrame !== undefined) continue; // timing adds nothing there
    const job = buildFieldJob(c.spline, c.canvasW, c.canvasH, c.opts)!;

    const setupMs = minOverReps(reps, 1, () => {
      buildFieldJob(c.spline, c.canvasW, c.canvasH, c.opts);
    });
    const cpuFieldMs = minOverReps(reps, 1, () => {
      evaluateFieldCpu(job);
    });

    let gpuFieldMs: number | null = null;
    if (evaluateFieldGpu(gpu, job)) {
      gpuFieldMs = minOverReps(reps, 3, () => {
        evaluateFieldGpu(gpu, job);
      });
    }

    const nodeCpuMs = minOverReps(reps, 1, () => {
      blendIntersections(c.spline, c.canvasW, c.canvasH, c.opts, null);
    });
    let nodeGpuMs: number | null = null;
    if (gpuFieldMs !== null) {
      nodeGpuMs = minOverReps(reps, 1, () => {
        blendIntersections(c.spline, c.canvasW, c.canvasH, c.opts, gpu);
      });
    }

    results.push({
      name: c.name,
      gw: job.gw,
      gh: job.gh,
      segCount: job.segCount,
      samples: job.gw * job.gh,
      setupMs,
      cpuFieldMs,
      gpuFieldMs,
      nodeCpuMs,
      nodeGpuMs,
    });
  }

  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = dbg
    ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
    : "unknown renderer";
  return { gl: renderer, results };
}
