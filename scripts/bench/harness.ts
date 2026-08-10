// Per-node benchmark harness — runs INSIDE the Electron renderer, bundled by
// scripts/bench-nodes.cjs. Spec: specdocs/080726_perf-profiler.md (M4).
//
// Goal: a ranked, reproducible list of which node types are expensive, so
// optimization work is chosen from data rather than from intuition. The
// project-level profiler answers "where does THIS graph go"; this answers
// "which nodes are worth fixing at all".
//
// Method: call each `def.compute()` directly with synthesized inputs rather
// than going through evaluateGraph. That keeps every node on identical inputs
// at an identical canvas size, with no caching, no graph topology, and no
// upstream cost bleeding into the measurement.
//
// Timing: median of N reps for CPU, and real GPU time via
// EXT_disjoint_timer_query_webgl2 — the same instrument the profiler uses,
// because CPU dispatch is meaningless for a fill-bound node (a Merge chain is
// 0.02 ms of CPU and several ms of GPU).

import { registerAllNodes } from "@/nodes/index";
import { allNodeDefs } from "@/engine/registry";
import { createEngineBackend } from "@/engine/gl";
import { getGpuTimer } from "@/engine/gpu-timer";
import { makePoints } from "@/engine/points";
import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  RenderContext,
  SocketValue,
  SplineSubpath,
} from "@/engine/types";

export interface BenchRow {
  type: string;
  name: string;
  category: string;
  subcategory?: string;
  status: "ok" | "skipped" | "error";
  reason?: string;
  cpuMs?: number;
  gpuMs?: number;
  /** Textures leased during one compute. */
  allocs?: number;
  reps?: number;
}

export interface BenchResult {
  canvas: { width: number; height: number };
  gpuTimingAvailable: boolean;
  rows: BenchRow[];
}

// Nodes whose cost is dominated by I/O, model inference, or user gesture
// rather than by shader/CPU work we could optimize. Timing them produces a
// number that measures the network or a decode, not the node — worse than no
// number, because it would rank them at the top of the list forever.
const EXCLUDE = new Set([
  "video-source", "webcam", "audio-source", "image-source", "svg-source",
  "depth-anything", "bg-remove", "hand-tracker", "object-tracker",
  "image-generate", "datamosh", "segment",
  // Boundary/structural shells: meaningless without an interior graph.
  "group", "layer", "iterate", "group-output", "group-input",
  "simulation-start", "simulation-end", "iterate-source",
  "output", "render-queue", "reroute",
]);

const CANVAS_W = 1920;
const CANVAS_H = 1080;
// Synthetic geometry sizes. Deliberately mid-sized: large enough that per-item
// cost dominates fixed overhead, small enough that an O(n²) node doesn't hang
// the whole run.
const SPLINE_SUBPATHS = 8;
const SPLINE_ANCHORS = 24;
const POINT_COUNT = 2000;

// SELF-INTERSECTING Lissajous lobes, not concentric ellipses.
//
// This matters more than it looks. A whole class of spline node — Blend
// Intersections, Boolean, Offset/Overlap Resolve, Shortest Path — has cost
// driven by how many times the input CROSSES ITSELF, not by anchor count.
// Fed concentric circles, Blend Intersections measured 0.000 ms and would
// have been reported as free, when the owner already knew from real use that
// it is one of the slowest nodes in the library. Crossing curves make those
// nodes measurable; nodes whose cost is purely per-anchor are unaffected.
function makeSpline(): SocketValue {
  const subpaths: SplineSubpath[] = [];
  for (let s = 0; s < SPLINE_SUBPATHS; s++) {
    const anchors = [];
    // Coprime-ish frequency pairs give lobes that cross themselves and each
    // other many times over.
    const fx = 3 + (s % 4);
    const fy = 2 + ((s * 3) % 5);
    const phase = (s / SPLINE_SUBPATHS) * Math.PI;
    for (let a = 0; a < SPLINE_ANCHORS; a++) {
      const t = (a / SPLINE_ANCHORS) * Math.PI * 2;
      const x = 0.5 + Math.sin(fx * t + phase) * 0.36;
      const y = 0.5 + Math.sin(fy * t) * 0.36;
      // Tangent-ish handles so the curve is smooth rather than polygonal —
      // curve/curve intersection is a different (heavier) code path than
      // line/line in most of these nodes.
      const dx = Math.cos(fx * t + phase) * fx * 0.02;
      const dy = Math.cos(fy * t) * fy * 0.02;
      anchors.push({
        pos: [x, y] as [number, number],
        inHandle: [x - dx, y - dy] as [number, number],
        outHandle: [x + dx, y + dy] as [number, number],
      });
    }
    subpaths.push({ anchors, closed: true });
  }
  return { kind: "spline", subpaths };
}

function makePointsValue(): SocketValue {
  const p = makePoints(POINT_COUNT, {
    withScales: true,
    withRotations: true,
  });
  for (let i = 0; i < POINT_COUNT; i++) {
    // Deterministic scatter — no Math.random, so runs are comparable.
    const a = (i * 2.399963) % (Math.PI * 2);
    const r = Math.sqrt(i / POINT_COUNT) * 0.45;
    p.positions[i * 2] = 0.5 + Math.cos(a) * r;
    p.positions[i * 2 + 1] = 0.5 + Math.sin(a) * r;
    p.scales![i * 2] = 1;
    p.scales![i * 2 + 1] = 1;
    p.rotations![i] = a;
  }
  return p;
}

// A non-trivial test image: a gradient with bright spots, so threshold-style
// nodes have something to find and blur-style nodes have edges to work on.
const PATTERN_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
void main() {
  float d = distance(v_uv, vec2(0.5));
  float spot = smoothstep(0.12, 0.0, distance(v_uv, vec2(0.32, 0.6)));
  vec3 c = vec3(v_uv.x, v_uv.y, 1.0 - v_uv.x) * (1.0 - d);
  outColor = vec4(c + spot * 2.0, clamp(1.2 - d * 1.6, 0.0, 1.0));
}`;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export async function runBench(opts?: { reps?: number }): Promise<BenchResult> {
  const reps = opts?.reps ?? 7;
  registerAllNodes();

  const backend = createEngineBackend(CANVAS_W, CANVAS_H);
  const gl = backend.gl;
  const timer = getGpuTimer(gl);

  // A base context; each node gets a fresh one so ctx.state stays isolated.
  const baseCtx = backend.makeContext(1.0, 30, undefined, false, {
    tick: 30000,
    ticksPerFrame: 1000,
    fps: 30,
  });

  // Shared source image, rendered once and reused by every node.
  const srcImage = baseCtx.allocImage();
  {
    const prog = baseCtx.getShader("bench/pattern", PATTERN_FS);
    baseCtx.drawFullscreen(prog, srcImage, () => {});
  }
  const srcMask = baseCtx.allocMask();
  const srcUv = baseCtx.allocUv();

  const rows: BenchRow[] = [];
  const defs = allNodeDefs().filter((d) => !d.hidden);

  for (const def of defs) {
    const row: BenchRow = {
      type: def.type,
      name: def.name,
      category: def.category,
      subcategory: def.subcategory,
      status: "ok",
    };
    if (EXCLUDE.has(def.type)) {
      row.status = "skipped";
      row.reason = "I/O, model inference, or structural shell";
      rows.push(row);
      continue;
    }

    try {
      const params: Record<string, unknown> = {};
      for (const p of def.params ?? []) params[p.name] = p.default;

      const sockets: InputSocketDef[] =
        def.resolveInputs?.(params, { connectedTypes: {} }) ?? def.inputs ?? [];

      const inputs: Record<string, SocketValue | undefined> = {};
      let unsupported: string | null = null;
      for (const s of sockets) {
        const v = valueForSocket(s, srcImage, srcMask, srcUv);
        if (v === undefined && s.required) {
          unsupported = s.type;
          break;
        }
        inputs[s.name] = v;
      }
      if (unsupported) {
        row.status = "skipped";
        row.reason = `no synthetic value for required '${unsupported}' input`;
        rows.push(row);
        continue;
      }

      // Per-node context so ctx.state (and any init) is isolated; nodes that
      // stash textures there won't leak into the next node's numbers.
      const ctx: RenderContext = backend.makeContext(1.0, 30, undefined, false, {
        tick: 30000,
        ticksPerFrame: 1000,
        fps: 30,
      });
      const nodeId = `bench-${def.type}`;
      def.init?.(ctx, nodeId);

      const leased: unknown[] = [];
      let allocCount = 0;
      const countingCtx: RenderContext = {
        ...ctx,
        allocImage: (o) => {
          allocCount++;
          const v = ctx.allocImage(o);
          leased.push(v);
          return v;
        },
        allocMask: (o) => {
          allocCount++;
          const v = ctx.allocMask(o);
          leased.push(v);
          return v;
        },
        allocUv: (o) => {
          allocCount++;
          const v = ctx.allocUv(o);
          leased.push(v);
          return v;
        },
      } as RenderContext;

      const call = () =>
        def.compute({
          inputs,
          auxIn: {},
          params,
          ctx: countingCtx,
          nodeId,
          consumedOutputs: undefined,
        });

      // Warm-up: compiles shaders and fills caches. Timing this would measure
      // the shader compiler, a one-off the user pays once per session.
      const warmT0 = performance.now();
      const warm = call();
      releaseOutput(ctx, warm);
      const warmMs = performance.now() - warmT0;
      allocCount = 0;

      // A pathological node (point-labels allocates a texture PER POINT and
      // takes seconds) would otherwise dominate the whole run's wall clock.
      const n = warmMs > 200 ? 1 : warmMs > 20 ? 3 : reps;

      // ONE query spanning all reps, not one per rep. Two reasons:
      //   - performance.now() is coarsened to 100µs in Chromium without
      //     cross-origin isolation, so per-rep CPU timing quantises to 0.1ms
      //     and everything cheap reads as exactly 0. Timing the block and
      //     dividing recovers n× the resolution.
      //   - a single GPU_DISJOINT event discards every in-flight query, and
      //     the odds of tripping one scale with how many are outstanding.
      //     Per-rep queries came back empty for most image nodes.
      const opened = timer.available ? timer.begin({ seq: 0, idx: 0 }) : false;
      const t0 = performance.now();
      let cpuTotal: number;
      try {
        for (let i = 0; i < n; i++) {
          const out = call();
          releaseOutput(ctx, out);
        }
      } finally {
        cpuTotal = performance.now() - t0;
        // MUST close even when compute throws. A query left open makes every
        // later begin() return false, silently wedging GPU timing for the
        // whole rest of the run — which is exactly what happened the first
        // time this was run, and it looks like "GPU work is free" rather
        // than like a broken harness.
        if (opened) timer.end();
      }

      // Force the queries to land. A finish() is exactly the pipeline stall
      // the live profiler avoids — here it's correct, because the harness
      // wants completed numbers, not smooth frames.
      gl.finish();
      let gpuTotal: number | null = null;
      if (opened) {
        for (let tries = 0; tries < 300 && gpuTotal === null; tries++) {
          timer.poll((_seq, _idx, ms) => {
            gpuTotal = ms;
          });
          if (gpuTotal !== null) break;
          await new Promise((r) => setTimeout(r, 2));
        }
      }

      def.dispose?.(ctx, nodeId);

      row.cpuMs = +(cpuTotal / n).toFixed(4);
      // Left UNDEFINED rather than 0 when nothing resolved — a 0 here reads
      // as "this node is free on the GPU", which is the opposite of "we
      // failed to measure it".
      if (gpuTotal !== null) row.gpuMs = +((gpuTotal as number) / n).toFixed(4);
      row.allocs = Math.round(allocCount / n);
      row.reps = n;
    } catch (e) {
      row.status = "error";
      row.reason = String(e instanceof Error ? e.message : e).slice(0, 160);
      // Drop anything the failed node left in flight so the next node starts
      // from a clean timer.
      timer.reset();
    }
    rows.push(row);
  }

  const gpuTimingAvailable = timer.available;
  timer.reset();
  backend.destroy();

  return {
    canvas: { width: CANVAS_W, height: CANVAS_H },
    gpuTimingAvailable,
    rows,
  };
}

function valueForSocket(
  s: InputSocketDef,
  img: ImageValue,
  mask: SocketValue,
  uv: SocketValue
): SocketValue | undefined {
  switch (s.type) {
    case "image":
      return img;
    case "mask":
      return mask;
    case "uv":
      return uv;
    case "spline":
      return makeSpline();
    case "points":
      return makePointsValue();
    case "scalar":
      return { kind: "scalar", value: 0.5 };
    case "vec2":
      return { kind: "vec2", value: [0.5, 0.5] };
    case "vec3":
      return { kind: "vec3", value: [0.5, 0.5, 0.5] };
    case "vec4":
      return { kind: "vec4", value: [0.5, 0.5, 0.5, 1] };
    case "string":
      return { kind: "string", value: "Bench" };
    case "image_group":
      return { kind: "image_group", items: [img, img] };
    case "list":
      return { kind: "list", items: [{ kind: "scalar", value: 1 }] };
    default:
      // audio, particles, sdf, element, color_ramp, render, force/emitter/
      // collider descriptors — each needs real upstream state. Optional ones
      // just stay unwired; a required one skips the node.
      return undefined;
  }
}

// Nodes allocate their own outputs; without releasing them the run leaks a
// full-canvas texture per rep per node and the later nodes measure a GPU under
// memory pressure rather than their own cost.
function releaseOutput(ctx: RenderContext, out: unknown): void {
  const o = out as {
    primary?: SocketValue;
    aux?: Record<string, SocketValue>;
    ownsTextures?: boolean;
  };
  if (!o) return;
  // State-backed outputs (NodeOutput.ownsTextures === false — Text, the
  // rasterize-spline flat path) live in ctx.state and are torn down by the
  // def's dispose; deleting them here would leave later reps sampling a
  // dead texture.
  if (o.ownsTextures === false) return;
  const rel = (v: SocketValue | undefined) => {
    if (!v) return;
    if (v.kind === "image" || v.kind === "mask" || v.kind === "uv") {
      ctx.releaseTexture(v.texture);
    }
  };
  rel(o.primary);
  if (o.aux) for (const v of Object.values(o.aux)) rel(v);
}
