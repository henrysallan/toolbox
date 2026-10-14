import type { NodeDefinition } from "@/engine/types";
import { bindDerived, type Bind } from "@/engine/skia/scene-ir";
import { mirrorParams, type SkslLibFunctionDef } from "@/engine/skia/library";
import {
  lyapunovNode,
  MAX_LYAPUNOV_SEQ,
  MAX_LYAPUNOV_STEPS,
  sequenceFromParams,
} from "../source/lyapunov";
import { defineSkslVariantNode } from "./sksl-variants";

// Lyapunov Fractal (Skia) — the Skia-layer port of Lyapunov Fractal
// (LYAPUNOV_FS, src/nodes/source/lyapunov.ts), exact rather than
// re-hashed: the GL shader's only uint is the A/B sequence packed into
// bits (`u_seqBits >> (i % seqLen)`), which needs uint, shifts, `%` and a
// dynamic index — all four rejected by Skia's strict ES2. Here the sequence
// is a uniform float array (1 = B) walked by an INNER loop index, the only
// legal array read: the outer loop counts periods, the inner one the
// letters, and a step counter breaks both once warmup + iterations steps
// ran. Same steps, same order, same float math.
//
// warmup / iterations are clamped exactly as the GL node does (rounded,
// rescaled to fit 1024 steps) in JS and bound as derived values, so the
// in-shader counts match it at every boundary. Two variants: the canvas
// uv, or the R/G of a shader wired into UV.

const SEQ = MAX_LYAPUNOV_SEQ;
const STEPS = MAX_LYAPUNOV_STEPS;

function lyapunovFunction(uv: boolean): SkslLibFunctionDef {
  // Neither entry may prefix the other (gather copies rename by prefix).
  const entry = uv ? "tbx_uvlyapunov" : "tbx_lyapunov";
  return {
    id: uv ? "tbx.lyapunov.uv@1" : "tbx.lyapunov@1",
    entry,
    source: `float4 ${entry}(float2 uv, float2 res, float a_min, float a_max, float b_min, float b_max,
                    float seq[${SEQ}], float seq_len, float warmup, float iterations, float x0,
                    int color_mode, float4 color_stable, float4 color_chaos, float4 color_div,
                    float lambda_neg, float lambda_pos, float lambda_lo, float lambda_hi,
                    float opacity${uv ? ", float4 uv_in" : ""}) {
  float2 q = ${uv ? "uv_in.rg" : "uv"};
  float a = mix(a_min, a_max, q.x);
  float b = mix(b_min, b_max, q.y);

  float x = x0;
  float sum = 0.0;
  float n = 0.0;
  bool diverged = false;
  float total = warmup + iterations;
  float len = max(seq_len, 1.0);
  float i = 0.0;
  bool done = false;
  for (int period = 0; period < ${STEPS}; period++) {
    for (int k = 0; k < ${SEQ}; k++) {
      if (float(k) >= len) break;
      if (i >= total) {
        done = true;
        break;
      }
      float r = seq[k] > 0.5 ? b : a;
      // Derivative at the current x with this step's r, then iterate.
      if (i >= warmup) {
        float deriv = abs(r * (1.0 - 2.0 * x));
        sum += log(max(deriv, 1.0e-20));
        n += 1.0;
      }
      x = r * x * (1.0 - x);
      if (!(x > 0.0 && x < 1.0)) {
        diverged = true;
        done = true;
        break;
      }
      i += 1.0;
    }
    if (done) break;
  }

  if (diverged || n == 0.0) {
    return color_mode == 1 ? float4(0.0, 0.0, 0.0, opacity) : float4(color_div.rgb, opacity);
  }

  float lam = sum / n;

  if (color_mode == 1) {
    float t = (lam - lambda_lo) / max(lambda_hi - lambda_lo, 1.0e-6);
    t = clamp(t, 0.0, 1.0);
    return float4(float3(t), opacity);
  }

  float3 col;
  if (lam >= 0.0) {
    float t = clamp(lam / max(lambda_pos, 1.0e-6), 0.0, 1.0);
    col = mix(color_stable.rgb, color_chaos.rgb, t);
  } else {
    float t = clamp((-lam) / max(lambda_neg, 1.0e-6), 0.0, 1.0);
    col = mix(color_stable.rgb, color_div.rgb, t);
  }
  return float4(col, opacity);
}`,
    params: [
      { name: "a_min", type: "float" },
      { name: "a_max", type: "float" },
      { name: "b_min", type: "float" },
      { name: "b_max", type: "float" },
      { name: "seq", type: "float", count: SEQ },
      { name: "seq_len", type: "float" },
      { name: "warmup", type: "float" },
      { name: "iterations", type: "float" },
      { name: "x0", type: "float" },
      { name: "color_mode", type: "int" },
      { name: "color_stable", type: "color" },
      { name: "color_chaos", type: "color" },
      { name: "color_div", type: "color" },
      { name: "lambda_neg", type: "float" },
      { name: "lambda_pos", type: "float" },
      { name: "lambda_lo", type: "float" },
      { name: "lambda_hi", type: "float" },
      { name: "opacity", type: "float" },
    ],
    inputs: uv ? [{ name: "uv_in", mode: "pure" }] : [],
    // Up to 1024 logistic steps with a log each: by far the heaviest
    // per-pixel function in the family (default 400 steps).
    cost: 40,
  };
}

// The GL node's step budget (lyapunovNode.compute), verbatim.
export function lyapunovSteps(params: Record<string, unknown>): { warmup: number; iterations: number } {
  let warmup = Math.max(0, Math.round((params.warmup as number) ?? 200));
  let iters = Math.max(1, Math.round((params.iterations as number) ?? 200));
  if (warmup + iters > STEPS) {
    const scale = STEPS / (warmup + iters);
    warmup = Math.floor(warmup * scale);
    iters = STEPS - warmup;
  }
  return { warmup, iterations: iters };
}

function lyapunovBinds({ params, nodeId }: { params: Record<string, unknown>; nodeId: string }): Record<string, Bind<number | number[]>> {
  const seq = sequenceFromParams(params);
  const arr = new Array<number>(SEQ).fill(0);
  seq.forEach((v, i) => (arr[i] = v ? 1 : 0));
  const seqDeps = [
    { node: nodeId, param: "preset" },
    { node: nodeId, param: "sequence" },
  ];
  const steps = lyapunovSteps(params);
  const stepDeps = [
    { node: nodeId, param: "warmup" },
    { node: nodeId, param: "iterations" },
  ];
  return {
    seq: bindDerived(arr, seqDeps),
    seq_len: bindDerived(seq.length, seqDeps),
    warmup: bindDerived(steps.warmup, stepDeps),
    iterations: bindDerived(steps.iterations, stepDeps),
  };
}

const UV_SOCKET = { name: "uv_in", label: "UV" };

const skiaLyapunovDef = defineSkslVariantNode({
  type: "skia-lyapunov",
  name: "Lyapunov Fractal (Skia)",
  mirrors: "lyapunov",
  subcategory: "generator",
  description:
    "Skia-layer Lyapunov Fractal: iterates the logistic map with the A/B sequence per pixel and colors by the Lyapunov exponent, as an SkSL function that fuses into the layer's one runtime shader. Same params as Lyapunov Fractal; `UV` re-samples at a wired shader's R/G.",
  searchAliases: ["lyapunov", "fractal", "logistic map", "skia", "sksl"],
  facts: {
    gotchas: [
      "uv.x maps to A in [a_min, a_max] and uv.y (Y-up) to B in [b_min, b_max] with no aspect correction, as in Lyapunov Fractal.",
      "The sequence is a 32-float uniform array walked by an inner loop index (Skia has no uint or bit shifts); preset/sequence and warmup/iterations bind as derived values.",
      "warmup + iterations is capped at 1024 steps exactly as Lyapunov Fractal rescales it; every step costs a log, so this is the heaviest shader in the family.",
      "color_mode=exponent paints λ through [lambda_lo, lambda_hi] as grey; diverged orbits are black there and color_div in signed mode.",
      "uv_in replaces the canvas uv with the wired shader's R/G at the same pixel; opacity is folded into the shader's alpha.",
      "Chaotic regions (λ > 0) amplify fp32 rounding: their speckle differs pixel to pixel from Lyapunov Fractal (and between GPUs); periodic regions match it.",
    ],
  },
  variants: [false, true].map((uv) => ({
    key: uv ? "uv" : "canvas",
    fn: lyapunovFunction(uv),
    ...(uv ? { inputs: [UV_SOCKET] } : {}),
    binds: lyapunovBinds,
  })),
  sockets: [UV_SOCKET],
  pick: (_params, wired) => (wired("uv_in") ? "uv" : "canvas"),
  params: mirrorParams(lyapunovNode, [
    "opacity",
    "preset",
    "sequence",
    "a_min",
    "a_max",
    "b_min",
    "b_max",
    "warmup",
    "iterations",
    "x0",
    "color_mode",
    "color_stable",
    "color_chaos",
    "color_div",
    "lambda_neg",
    "lambda_pos",
    "lambda_lo",
    "lambda_hi",
  ]),
});

// The sequence preset in the node header, as on Lyapunov Fractal.
export const skiaLyapunovNode: NodeDefinition = {
  ...skiaLyapunovDef,
  ...(lyapunovNode.headerControl ? { headerControl: lyapunovNode.headerControl } : {}),
};
