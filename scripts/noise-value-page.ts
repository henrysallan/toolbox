// Renderer half of scripts/noise-value-gl.cjs: the Noise node's `value` aux
// against its own GL image, through the real node on real WebGL2.
//
// For each case the node renders once and the image is read back as float
// (RGBA16F → Float32, row 0 = bottom = v_uv.y ≈ 0, no flip). Colour A is
// pure green and colour B pure red, so R = t and G = 1 − t and the decoder
// reads t from whichever channel is below 0.5 — half-float spacing there is
// ≤ 2⁻¹², so the decoded noise is good to ~2.4e-4 (~4.9e-4 on Metal, whose
// half conversion truncates). Then, for every sample point, the node runs
// again with `position` wired to that pixel's centre and its `value` aux is
// recorded beside the GL decode.
//
// type = curl writes the signed curl vector into RG (colours ignored); the
// decode there is (2R − 1) / contrast, the x component `value` reports.

import { registerAllNodes } from "@/nodes/index";
import { createEngineBackend, type EngineBackend } from "@/engine/gl";
import { getNodeDef } from "@/engine/registry";
import { loopEvolutionOffset, noiseSamplePoint, noiseValueOnCpu } from "@/engine/noise";
import type { ImageValue, NodeDefinition, RenderContext } from "@/engine/types";

export interface NoiseValueCaseSpec {
  // A short label for the report.
  name: string;
  // Params beyond the node's defaults.
  params: Record<string, unknown>;
  // Timeline frame (60 fps, 1000 ticks per frame); default 0.
  frame?: number;
}

export interface NoiseValuePoint {
  u: number;
  v: number;
  // The GL image decoded back to the signed noise value (curl: the x
  // component). `clip` = the pixel saturated (|n · contrast| ≥ 1), so `gl`
  // is a bound, not a value: -1 = at or below, +1 = at or above.
  gl: number;
  clip: -1 | 0 | 1;
  value: number;
  // Which evaluation the node picked for `value` here.
  path: "cpu" | "gpu";
}

export interface NoiseValueCaseResult extends NoiseValueCaseSpec {
  path: "cpu" | "gpu" | "mixed";
  points: NoiseValuePoint[];
}

type NoiseOut = { primary: ImageValue; aux: { value: { value: number } } };

let backend: EngineBackend | null = null;
let def: NodeDefinition | null = null;

export function init(width: number, height: number) {
  registerAllNodes();
  def = getNodeDef("noise") ?? null;
  if (!def) throw new Error("the noise node is not registered");
  backend = createEngineBackend(width, height);
  const gl = backend.gl;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    renderer: String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
    colorBufferFloat: !!gl.getExtension("EXT_color_buffer_float"),
  };
}

function defaults(d: NodeDefinition): Record<string, unknown> {
  return Object.fromEntries(d.params.map((p) => [p.name, p.default]));
}

function contextAt(b: EngineBackend, frame = 0): RenderContext {
  return b.makeContext(frame / 60, Math.floor(frame), undefined, false, { tick: Math.round(frame * 1000), ticksPerFrame: 1000, fps: 60 }, true);
}

function computeAt(d: NodeDefinition, ctx: RenderContext, params: Record<string, unknown>, u: number, v: number, consumed?: Set<string>): NoiseOut {
  return d.compute({
    inputs: { position: { kind: "vec2", value: [u, v] } },
    auxIn: {},
    params,
    ctx,
    nodeId: "noise",
    consumedOutputs: consumed,
  }) as unknown as NoiseOut;
}

// Pixel centres on a gx × gy grid spread over the canvas.
function grid(width: number, height: number, gx: number, gy: number): [number, number][] {
  const out: [number, number][] = [];
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      out.push([Math.floor(((i + 0.5) * width) / gx), Math.floor(((j + 0.5) * height) / gy)]);
    }
  }
  return out;
}

export function run(cases: NoiseValueCaseSpec[], gx: number, gy: number): NoiseValueCaseResult[] {
  if (!backend || !def) throw new Error("init() first");
  const b = backend;
  const d = def;
  const W = b.width;
  const H = b.height;
  const out: NoiseValueCaseResult[] = [];
  for (const c of cases) {
    const params = { ...defaults(d), ...c.params };
    const contrast = params.contrast as number;
    const ctx = contextAt(b, c.frame);
    const first = computeAt(d, ctx, params, 0.5, 0.5);
    const px = ctx.readImageToFloat32(first.primary);
    ctx.releaseTexture(first.primary.texture);
    const points: NoiseValuePoint[] = [];
    for (const [x, y] of grid(W, H, gx, gy)) {
      const u = (x + 0.5) / W;
      const v = (y + 0.5) / H;
      const i = (y * W + x) * 4;
      const R = px[i];
      const G = px[i + 1];
      let gl: number;
      let clip: -1 | 0 | 1 = 0;
      if (params.type === "curl") {
        gl = (2 * R - 1) / contrast;
        if (R <= 0) clip = -1;
        else if (R >= 1) clip = 1;
      } else {
        const t = R < 0.5 ? R : 1 - G;
        gl = ((t - 0.5) * 2) / contrast;
        if (R <= 0) clip = -1;
        else if (G <= 0) clip = 1;
      }
      const r = computeAt(d, ctx, params, u, v);
      ctx.releaseTexture(r.primary.texture);
      points.push({ u, v, gl, clip, value: r.aux.value.value, path: pathAt(params, ctx, c.frame ?? 0, u, v) });
    }
    const paths = new Set(points.map((p) => p.path));
    out.push({ ...c, path: paths.size === 1 ? points[0].path : "mixed", points });
  }
  return out;
}

// Which evaluation the node picks for `value` at (u, v): the same inputs to
// noiseValueOnCpu that compute builds.
function pathAt(params: Record<string, unknown>, ctx: RenderContext, frame: number, u: number, v: number): "cpu" | "gpu" {
  const animated = params.animated === true;
  const [ax, ay] =
    animated && params.type !== "flow"
      ? loopEvolutionOffset(frame, params.anim_start as number, params.anim_end as number, params.anim_rate as number)
      : [0, 0];
  const [sx, sy] = noiseSamplePoint(u, v, {
    width: ctx.width,
    height: ctx.height,
    scale: params.scale as number,
    offsetX: params.offset_x as number,
    offsetY: params.offset_y as number,
    seed: params.seed as number,
    animOffsetX: ax,
    animOffsetY: ay,
  });
  const octaves = Math.max(1, Math.min(8, Math.round(params.octaves as number)));
  return noiseValueOnCpu(params.type as string, animated ? 0 : (params.w as number), sx, sy, octaves, params.lacunarity as number) ? "cpu" : "gpu";
}

// What the GPU evaluation costs: `n` computes of one case on a fresh
// width × height backend, with and without `aux:value` consumed. Every
// iteration ends in a 1-px readback of the image, so both columns include
// the GPU work and the probe's own sync point is the difference.
export function bench(c: NoiseValueCaseSpec, n: number, width: number, height: number) {
  if (!def) throw new Error("init() first");
  const d = def;
  const b = createEngineBackend(width, height);
  try {
    const params = { ...defaults(d), ...c.params };
    const ctx = contextAt(b, c.frame);
    const time = (consumed: string[]) => {
      const set = new Set(consumed);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        const r = computeAt(d, ctx, params, 0.25 + (i % 7) * 0.05, 0.5, set);
        b.readImagePixels(r.primary, 1, 1);
        ctx.releaseTexture(r.primary.texture);
      }
      return (performance.now() - t0) / n;
    };
    time(["primary", "aux:value"]); // warm-up: shader compile, probe target
    const imageOnlyMs = time(["primary"]);
    const withValueMs = time(["primary", "aux:value"]);
    return { imageOnlyMs, withValueMs };
  } finally {
    b.destroy();
  }
}

// The `value` aux at arbitrary positions (debugging one case).
export function valuesAt(c: NoiseValueCaseSpec, uvs: [number, number][]): number[] {
  if (!backend || !def) throw new Error("init() first");
  const d = def;
  const params = { ...defaults(d), ...c.params };
  const ctx = contextAt(backend, c.frame);
  return uvs.map(([u, v]) => {
    const r = computeAt(d, ctx, params, u, v);
    ctx.releaseTexture(r.primary.texture);
    return r.aux.value.value;
  });
}
