import { OPACITY_PARAM } from "@/engine/conventions";
import type { NodeDefinition, UvValue } from "@/engine/types";
import {
  disposePlaceholderTex,
  getPlaceholderTex,
} from "@/engine/placeholder-tex";

// Markus–Lyapunov fractal: each pixel is a pair (A, B) in logistic-map
// parameter space. The map x → r x (1 − x) is iterated with r cycling
// through a two-letter sequence (A or B), and the pixel is colored by
// the Lyapunov exponent λ = mean(ln |r (1 − 2x)|).
//
// Negative λ (stable / periodic) vs positive λ (chaotic) is the classic
// yellow/blue split; orbits that leave (0, 1) are treated as diverged.

export const MAX_LYAPUNOV_SEQ = 32;
export const MAX_LYAPUNOV_STEPS = 1024;

export const LYAPUNOV_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_aRange;
uniform vec2 u_bRange;
uniform uint u_seqBits;
uniform int u_seqLen;
uniform int u_warmup;
uniform int u_iters;
uniform float u_x0;
uniform int u_colorMode;
uniform vec3 u_colorStable;
uniform vec3 u_colorChaos;
uniform vec3 u_colorDiv;
uniform float u_lambdaNeg;
uniform float u_lambdaPos;
uniform float u_lambdaLo;
uniform float u_lambdaHi;
uniform int u_hasUvIn;
uniform sampler2D u_uvIn;
uniform vec2 u_uvConst;
out vec4 outColor;

const int MAX_STEPS = 1024;

void main() {
  vec2 uv;
  if (u_hasUvIn == 1) uv = texture(u_uvIn, v_uv).rg;
  else if (u_hasUvIn == 2) uv = u_uvConst;
  else uv = v_uv;

  float a = mix(u_aRange.x, u_aRange.y, uv.x);
  float b = mix(u_bRange.x, u_bRange.y, uv.y);

  float x = u_x0;
  float sum = 0.0;
  int n = 0;
  bool diverged = false;
  int total = u_warmup + u_iters;
  int seqLen = max(u_seqLen, 1);

  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= total) break;
    uint bit = (u_seqBits >> uint(i % seqLen)) & 1u;
    float r = bit == 1u ? b : a;
    // Derivative at the current x with this step's r, then iterate.
    // Matches lyapunovExponent() on the CPU (natural log).
    if (i >= u_warmup) {
      float deriv = abs(r * (1.0 - 2.0 * x));
      sum += log(max(deriv, 1.0e-20));
      n += 1;
    }
    x = r * x * (1.0 - x);
    if (!(x > 0.0 && x < 1.0)) {
      diverged = true;
      break;
    }
  }

  if (diverged || n == 0) {
    outColor = u_colorMode == 1 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(u_colorDiv, 1.0);
    return;
  }

  float lam = sum / float(n);

  if (u_colorMode == 1) {
    float t = (lam - u_lambdaLo) / max(u_lambdaHi - u_lambdaLo, 1.0e-6);
    t = clamp(t, 0.0, 1.0);
    outColor = vec4(vec3(t), 1.0);
    return;
  }

  vec3 col;
  if (lam >= 0.0) {
    float t = clamp(lam / max(u_lambdaPos, 1.0e-6), 0.0, 1.0);
    col = mix(u_colorStable, u_colorChaos, t);
  } else {
    float t = clamp((-lam) / max(u_lambdaNeg, 1.0e-6), 0.0, 1.0);
    col = mix(u_colorStable, u_colorDiv, t);
  }
  outColor = vec4(col, 1.0);
}`;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ];
}

/** A = 0, B = 1. Unknown characters dropped; empty → AB. Truncated at 32. */
export function parseLyapunovSequence(raw: string): number[] {
  const out: number[] = [];
  const s = raw ?? "";
  for (let i = 0; i < s.length && out.length < MAX_LYAPUNOV_SEQ; i++) {
    const c = s.charCodeAt(i);
    if (c === 65 || c === 97) out.push(0);
    else if (c === 66 || c === 98) out.push(1);
  }
  return out.length > 0 ? out : [0, 1];
}

export function packLyapunovBits(seq: number[]): number {
  let bits = 0;
  const n = Math.min(seq.length, MAX_LYAPUNOV_SEQ);
  for (let i = 0; i < n; i++) {
    if (seq[i]) bits |= 1 << i;
  }
  return bits >>> 0;
}

export function sequenceFromParams(params: Record<string, unknown>): number[] {
  const preset = (params.preset as string) ?? "AABAB";
  const raw = preset === "custom" ? String(params.sequence ?? "") : preset;
  return parseLyapunovSequence(raw);
}

export function lyapunovExponent(opts: {
  sequence: number[];
  a: number;
  b: number;
  x0?: number;
  warmup?: number;
  iterations?: number;
}): { lambda: number; diverged: boolean; n: number } {
  const seq = opts.sequence.length > 0 ? opts.sequence : [0, 1];
  const warmup = Math.max(0, Math.floor(opts.warmup ?? 0));
  const iterations = Math.max(1, Math.floor(opts.iterations ?? 1));
  const total = Math.min(MAX_LYAPUNOV_STEPS, warmup + iterations);
  let x = opts.x0 ?? 0.5;
  let sum = 0;
  let n = 0;
  const len = seq.length;
  for (let i = 0; i < total; i++) {
    const r = seq[i % len] ? opts.b : opts.a;
    if (i >= warmup) {
      const deriv = Math.abs(r * (1 - 2 * x));
      sum += Math.log(Math.max(deriv, 1e-20));
      n++;
    }
    x = r * x * (1 - x);
    if (!(x > 0 && x < 1)) {
      return { lambda: n > 0 ? sum / n : 0, diverged: true, n };
    }
  }
  return { lambda: n > 0 ? sum / n : 0, diverged: false, n };
}

export const lyapunovNode: NodeDefinition = {
  type: "lyapunov",
  name: "Lyapunov Fractal",
  category: "image",
  subcategory: "generator",
  description:
    "Iterate the logistic map with a two-letter A/B sequence of r values and color each pixel by its Lyapunov exponent.",
  facts: {
    gotchas: [
      "uv.x maps to A in [a_min, a_max] and uv.y (Y-up) maps to B in [b_min, b_max]; the parameter rectangle fills the frame with no aspect correction.",
      "Sequence letters are A and B only (case-insensitive); other characters are dropped, an empty string falls back to AB, and more than 32 letters are truncated.",
      "warmup iterates without accumulating; iterations is the count in λ = mean(ln|r(1-2x)|); warmup+iterations is capped at 1024.",
      "color_mode=signed paints λ≈0 with color_stable, negative toward color_div, positive toward color_chaos; color_mode=exponent emits λ remapped through [lambda_lo, lambda_hi] as grayscale.",
      "x0=0.5 is the logistic-map critical point; a sequence that drives x to 0 or 1 (the r=4 edge with x0=0.5) is colored with color_div.",
      "uv_in replaces v_uv when wired (image R/G, or a scalar broadcast to both axes), so the sample is taken at that parameter-space coordinate.",
    ],
  },
  backend: "webgl2",
  headerControl: { paramName: "preset" },
  inputs: [
    { name: "uv_in", label: "UV", type: "uv", required: false },
  ],
  params: [
    OPACITY_PARAM,
    {
      name: "preset",
      label: "Sequence",
      type: "enum",
      options: ["AABAB", "AB", "BBBBBAAAAA", "BBABABA", "custom"],
      optionLabels: {
        AABAB: "AABAB",
        AB: "AB",
        BBBBBAAAAA: "BBBBBAAAAA",
        BBABABA: "BBABABA",
        custom: "Custom",
      },
      default: "AABAB",
    },
    {
      name: "sequence",
      label: "Custom",
      type: "string",
      default: "AABAB",
      placeholder: "AABAB",
      visibleIf: (p) => p.preset === "custom",
    },
    {
      name: "a_min",
      label: "A min",
      type: "scalar",
      min: 0,
      max: 4,
      step: 0.001,
      default: 2,
    },
    {
      name: "a_max",
      label: "A max",
      type: "scalar",
      min: 0,
      max: 4,
      step: 0.001,
      default: 4,
    },
    {
      name: "b_min",
      label: "B min",
      type: "scalar",
      min: 0,
      max: 4,
      step: 0.001,
      default: 2,
    },
    {
      name: "b_max",
      label: "B max",
      type: "scalar",
      min: 0,
      max: 4,
      step: 0.001,
      default: 4,
    },
    {
      name: "warmup",
      label: "Warmup",
      type: "scalar",
      min: 0,
      max: 800,
      softMax: 400,
      step: 1,
      default: 200,
    },
    {
      name: "iterations",
      label: "Iterations",
      type: "scalar",
      min: 1,
      max: 800,
      softMax: 400,
      step: 1,
      default: 200,
    },
    {
      name: "x0",
      label: "x₀",
      type: "scalar",
      min: 0.001,
      max: 0.999,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "color_mode",
      label: "Color",
      type: "enum",
      options: ["signed", "exponent"],
      optionLabels: { signed: "Signed", exponent: "Exponent" },
      control: "segmented",
      default: "signed",
    },
    {
      name: "color_stable",
      label: "Stable",
      type: "color",
      default: "#f2d14b",
      visibleIf: (p) => p.color_mode !== "exponent",
    },
    {
      name: "color_chaos",
      label: "Chaos",
      type: "color",
      default: "#1e3a8a",
      visibleIf: (p) => p.color_mode !== "exponent",
    },
    {
      name: "color_div",
      label: "Diverged",
      type: "color",
      default: "#0a0612",
      visibleIf: (p) => p.color_mode !== "exponent",
    },
    {
      name: "lambda_neg",
      label: "λ− scale",
      type: "scalar",
      min: 0.01,
      max: 4,
      softMax: 1.5,
      step: 0.01,
      default: 0.6,
      visibleIf: (p) => p.color_mode !== "exponent",
    },
    {
      name: "lambda_pos",
      label: "λ+ scale",
      type: "scalar",
      min: 0.01,
      max: 4,
      softMax: 1.5,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => p.color_mode !== "exponent",
    },
    {
      name: "lambda_lo",
      label: "λ lo",
      type: "scalar",
      min: -4,
      max: 2,
      step: 0.01,
      default: -1,
      visibleIf: (p) => p.color_mode === "exponent",
    },
    {
      name: "lambda_hi",
      label: "λ hi",
      type: "scalar",
      min: -4,
      max: 2,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => p.color_mode === "exponent",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const seq = sequenceFromParams(params);
    const bits = packLyapunovBits(seq);
    const aMin = (params.a_min as number) ?? 2;
    const aMax = (params.a_max as number) ?? 4;
    const bMin = (params.b_min as number) ?? 2;
    const bMax = (params.b_max as number) ?? 4;
    let warmup = Math.max(0, Math.round((params.warmup as number) ?? 200));
    let iters = Math.max(1, Math.round((params.iterations as number) ?? 200));
    if (warmup + iters > MAX_LYAPUNOV_STEPS) {
      const scale = MAX_LYAPUNOV_STEPS / (warmup + iters);
      warmup = Math.floor(warmup * scale);
      iters = MAX_LYAPUNOV_STEPS - warmup;
    }
    const x0 = (params.x0 as number) ?? 0.5;
    const colorMode = (params.color_mode as string) === "exponent" ? 1 : 0;
    const [sr, sg, sb] = hexToRgb((params.color_stable as string) ?? "#f2d14b");
    const [cr, cg, cb] = hexToRgb((params.color_chaos as string) ?? "#1e3a8a");
    const [dr, dg, db] = hexToRgb((params.color_div as string) ?? "#0a0612");
    const lambdaNeg = (params.lambda_neg as number) ?? 0.6;
    const lambdaPos = (params.lambda_pos as number) ?? 0.5;
    const lambdaLo = (params.lambda_lo as number) ?? -1;
    const lambdaHi = (params.lambda_hi as number) ?? 0.5;

    const uvIn = inputs.uv_in;
    const placeholderKey = `lyapunov:${nodeId}:zero`;
    let uvInMode = 0;
    let uvInTex: WebGLTexture = getPlaceholderTex(
      ctx.gl,
      ctx.state,
      placeholderKey
    );
    let uvConst: [number, number] = [0, 0];
    if (uvIn) {
      if (uvIn.kind === "uv") {
        uvInMode = 1;
        uvInTex = (uvIn as UvValue).texture;
      } else if (uvIn.kind === "scalar") {
        uvInMode = 2;
        uvConst = [uvIn.value, uvIn.value];
      }
    }

    const prog = ctx.getShader("lyapunov/fs", LYAPUNOV_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.uniform2f(gl.getUniformLocation(prog, "u_aRange"), aMin, aMax);
      gl.uniform2f(gl.getUniformLocation(prog, "u_bRange"), bMin, bMax);
      gl.uniform1ui(gl.getUniformLocation(prog, "u_seqBits"), bits);
      gl.uniform1i(gl.getUniformLocation(prog, "u_seqLen"), seq.length);
      gl.uniform1i(gl.getUniformLocation(prog, "u_warmup"), warmup);
      gl.uniform1i(gl.getUniformLocation(prog, "u_iters"), iters);
      gl.uniform1f(gl.getUniformLocation(prog, "u_x0"), x0);
      gl.uniform1i(gl.getUniformLocation(prog, "u_colorMode"), colorMode);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorStable"), sr, sg, sb);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorChaos"), cr, cg, cb);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorDiv"), dr, dg, db);
      gl.uniform1f(gl.getUniformLocation(prog, "u_lambdaNeg"), lambdaNeg);
      gl.uniform1f(gl.getUniformLocation(prog, "u_lambdaPos"), lambdaPos);
      gl.uniform1f(gl.getUniformLocation(prog, "u_lambdaLo"), lambdaLo);
      gl.uniform1f(gl.getUniformLocation(prog, "u_lambdaHi"), lambdaHi);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, uvInTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_uvIn"), 0);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasUvIn"), uvInMode);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_uvConst"),
        uvConst[0],
        uvConst[1]
      );
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    disposePlaceholderTex(ctx.gl, ctx.state, `lyapunov:${nodeId}:zero`);
  },
};
