import type {
  ImageValue,
  NodeDefinition,
  RenderContext,
  SplineValue,
} from "@/engine/types";
import { measureSpline, sampleSplineAt } from "@/engine/spline-math";
import {
  sampleColorRampRgba01,
  type ColorRampInterp,
  type ColorRampStop,
} from "@/engine/color-ramp";
import {
  defaultFloatCurve,
  sampleFloatCurve,
  sanitizeFloatCurve,
} from "@/engine/float-curve";
import { solvePoisson, resampleImage } from "@/engine/poisson";
import { OPACITY_PARAM } from "@/engine/conventions";

// Diffusion Curves — Orzan et al. 2008 (spec 072726_diffusion-curves.md).
// Each subpath of the input spline is a curve carrying colors on its left
// and right sides (the two ramps, stop position = t along the curve) and
// a blur amount; the output is the steady-state diffusion of those colors
// over the canvas — a Poisson solve whose constraints are 1px color-source
// bands at ±d along the curve normals plus the sharp color-jump gradient
// on the curve itself. Complex smooth shading from a handful of strokes.
//
// Pipeline (all fullscreen passes, no custom geometry):
//   CPU: arc-length-uniform samples per subpath (positions in solve texel
//        space, per-sample ramp colors + blur σ) → node-owned RGBA32F
//        data texture (N wide × 3 rows: pos+σ+segflag / left / right).
//   1. nearest — brute-force point-to-segment over all segments, once,
//      into (segIdx, u, side, dist). Every later raster is a texelFetch
//      through this; nearest-segment-wins replaces the paper's stencil
//      discard where curves crowd. The dominant cost, paid on recompute
//      only (steady-state solve → normal caching, NOT stable:false).
//   2. color sources C + mask M (band |dist−d| ≤ ~0.5) — ramp colors
//      lerped along u, or the trace image sampled at the pixel's own UV.
//   3. Wx/Wy (on-curve, w = (cl−cr)·N per RGBA channel — alpha jumps
//      diffuse too) → RHS = div w via backward differences.
//   4. engine/poisson.ts multigrid solve ∆I = div w, I = C on M.
//   5. blur map B = same solver on on-curve σ (∆B = 0), then a
//      spatially-varying separable Gaussian with per-pixel radius B.
//      Both skipped while blur_max is 0.
//
// Space: everything runs in GL texel coords of the solve grid (spline
// y-down normalized → y flip at the CPU upload boundary, once). The
// segment normal N = rot90ccw(B−A) points to the visual LEFT of the
// stroke direction. Sign sanity (1D): a vertical line with cl=1 right of
// travel-up... see the spec's step-image test.

const MAX_SAMPLES = 2048; // segIdx must stay half-float-exact (≤ 2048)
const SPACING_PX = 2.5;
const MAX_BLUR = 64;

// ---------------------------------------------------------------------------
// CPU: curve sampling → data texture payload
// ---------------------------------------------------------------------------

interface CurveSamples {
  data: Float32Array; // count × 3 rows × RGBA
  count: number;
  maxSigma: number;
}

function buildSamples(
  spline: SplineValue,
  solveW: number,
  solveH: number,
  leftStops: ColorRampStop[],
  rightStops: ColorRampStop[],
  interp: ColorRampInterp,
  wholeSplineT: boolean,
  blurMax: number,
  blurCurve: ReturnType<typeof sanitizeFloatCurve>
): CurveSamples | null {
  const lengths = measureSpline(spline);
  if (lengths.total <= 1e-6) return null;
  const pxScale = Math.max(solveW, solveH);

  // Per-subpath sample counts at ~SPACING_PX, scaled down to the global cap.
  const counts: number[] = lengths.perSubpath.map((m) =>
    m.total <= 1e-6
      ? 0
      : Math.max(2, Math.ceil((m.total * pxScale) / SPACING_PX) + 1)
  );
  const requested = counts.reduce((a, b) => a + b, 0);
  if (requested === 0) return null;
  if (requested > MAX_SAMPLES) {
    const scale = MAX_SAMPLES / requested;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] > 0) counts[i] = Math.max(2, Math.floor(counts[i] * scale));
    }
  }
  const total = counts.reduce((a, b) => a + b, 0);
  if (total < 2) return null;

  const data = new Float32Array(total * 3 * 4);
  const row = (r: number, k: number) => (r * total + k) * 4;
  let k = 0;
  let maxSigma = 0;
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i];
    if (n === 0) continue;
    const subTotal = lengths.perSubpath[i].total;
    for (let j = 0; j < n; j++) {
      const frac = j / (n - 1);
      // Bias a hair inside the subpath so the global-t lookup can't land
      // on the NEXT subpath's start at frac = 1 (closed wraps included in
      // the measured length, so frac 1 still reaches the loop seam).
      const arc = Math.min(frac * subTotal, subTotal * (1 - 1e-5));
      const tGlobal = (lengths.offsets[i] + arc) / lengths.total;
      const s = sampleSplineAt(spline, lengths, tGlobal);
      const tRamp = wholeSplineT ? tGlobal : frac;
      const cl = sampleColorRampRgba01(leftStops, tRamp, interp);
      const cr = sampleColorRampRgba01(rightStops, tRamp, interp);
      const sigma =
        blurMax > 0
          ? Math.min(
              MAX_BLUR,
              Math.max(0, sampleFloatCurve(blurCurve, tRamp) * blurMax)
            )
          : 0;
      if (sigma > maxSigma) maxSigma = sigma;
      const o0 = row(0, k);
      data[o0] = s.pos[0] * solveW; // GL texel space: y flips here, once
      data[o0 + 1] = (1 - s.pos[1]) * solveH;
      data[o0 + 2] = sigma;
      data[o0 + 3] = j < n - 1 ? 1 : 0; // segment k→k+1 exists
      data.set(cl, row(1, k));
      data.set(cr, row(2, k));
      k++;
    }
  }
  return { data, count: total, maxSigma };
}

// ---------------------------------------------------------------------------
// GPU
// ---------------------------------------------------------------------------

interface DcState {
  dataTex: WebGLTexture | null;
}

const stateKey = (nodeId: string) => `diffusion-curves:${nodeId}`;

// Node-owned RGBA32F data texture (NEAREST, clamped) — the
// adaptive-pixelate upload pattern; 32F because half-float positions
// wobble ~1px at 2K canvases.
function uploadData(
  ctx: RenderContext,
  state: DcState,
  data: Float32Array,
  count: number
): WebGLTexture | null {
  const gl = ctx.gl;
  const tex = state.dataTex ?? gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, count, 3, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  state.dataTex = tex;
  return tex;
}

// Pass 1: nearest segment per pixel → (segIdx, u, side, dist). segIdx is
// half-float-exact up to MAX_SAMPLES; dist precision only matters near
// the curve where half floats are dense. side +1 = visual left of the
// stroke direction (N = rot90ccw of the segment chord).
const NEAREST_FS = `#version 300 es
precision highp float;
uniform sampler2D u_data;
uniform int u_count;
out vec4 outColor;
void main() {
  vec2 p = gl_FragCoord.xy;
  float bestD = 60000.0;
  float bestI = -1.0;
  float bestU = 0.0;
  float bestS = 1.0;
  for (int i = 0; i < ${MAX_SAMPLES}; i++) {
    if (i >= u_count - 1) break;
    vec4 a = texelFetch(u_data, ivec2(i, 0), 0);
    if (a.w < 0.5) continue;
    vec2 A = a.xy;
    vec2 B = texelFetch(u_data, ivec2(i + 1, 0), 0).xy;
    vec2 AB = B - A;
    float l2 = dot(AB, AB);
    float u = l2 > 1e-9 ? clamp(dot(p - A, AB) / l2, 0.0, 1.0) : 0.0;
    vec2 d = p - (A + u * AB);
    float dist = length(d);
    if (dist < bestD) {
      bestD = dist;
      bestI = float(i);
      bestU = u;
      bestS = (d.y * AB.x - d.x * AB.y) >= 0.0 ? 1.0 : -1.0;
    }
  }
  outColor = vec4(bestI, bestU, bestS, bestD);
}`;

// Pass 2a: color sources — 1px band at distance d, colored by the nearest
// segment's side ramp (lerped along u) or the trace image at the pixel's
// own position (paper §4.2: the source pixel IS at distance d).
const SOURCES_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_near;
uniform sampler2D u_data;
uniform sampler2D u_trace;
uniform int u_mode; // 0 = ramps, 1 = trace image
uniform float u_dist;
uniform float u_halfw;
out vec4 outColor;
void main() {
  vec4 nr = texelFetch(u_near, ivec2(gl_FragCoord.xy), 0);
  if (nr.x < -0.5 || abs(nr.w - u_dist) > u_halfw) {
    outColor = vec4(0.0);
    return;
  }
  if (u_mode == 1) {
    outColor = texture(u_trace, v_uv);
    return;
  }
  int i = int(nr.x + 0.5);
  int row = nr.z >= 0.0 ? 1 : 2;
  outColor = mix(
    texelFetch(u_data, ivec2(i, row), 0),
    texelFetch(u_data, ivec2(i + 1, row), 0),
    nr.y
  );
}`;

// Generic band mask writer: 1 where |dist − center| ≤ halfw. Used for the
// color-source mask (center d) and the blur-source mask (center 0).
const MASK_FS = `#version 300 es
precision highp float;
uniform sampler2D u_near;
uniform float u_center;
uniform float u_halfw;
out vec4 outColor;
void main() {
  vec4 nr = texelFetch(u_near, ivec2(gl_FragCoord.xy), 0);
  float m =
    (nr.x > -0.5 && abs(nr.w - u_center) <= u_halfw) ? 1.0 : 0.0;
  outColor = vec4(m, 0.0, 0.0, 1.0);
}`;

// Pass 3a: one component of the on-curve gradient field w = (cl−cr)·N.
// Trace mode reads the jump straight off the trace image at ±d across
// the curve. Band halfwidth is exactly 0.5: a wider line double-counts
// the jump in div w (overshoot), and a 0.5 band is gap-free along any
// continuous polyline.
const W_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_near;
uniform sampler2D u_data;
uniform sampler2D u_trace;
uniform int u_mode;
uniform int u_axis; // 0 = x, 1 = y
uniform float u_dist;
uniform vec2 u_texel;
out vec4 outColor;
void main() {
  vec4 nr = texelFetch(u_near, ivec2(gl_FragCoord.xy), 0);
  if (nr.x < -0.5 || nr.w > 0.5) {
    outColor = vec4(0.0);
    return;
  }
  int i = int(nr.x + 0.5);
  vec2 A = texelFetch(u_data, ivec2(i, 0), 0).xy;
  vec2 B = texelFetch(u_data, ivec2(i + 1, 0), 0).xy;
  vec2 AB = B - A;
  float l = length(AB);
  if (l < 1e-6) {
    outColor = vec4(0.0);
    return;
  }
  vec2 N = vec2(-AB.y, AB.x) / l;
  vec4 jump;
  if (u_mode == 1) {
    jump = texture(u_trace, v_uv + N * u_dist * u_texel) -
           texture(u_trace, v_uv - N * u_dist * u_texel);
  } else {
    jump = mix(texelFetch(u_data, ivec2(i, 1), 0),
               texelFetch(u_data, ivec2(i + 1, 1), 0), nr.y) -
           mix(texelFetch(u_data, ivec2(i, 2), 0),
               texelFetch(u_data, ivec2(i + 1, 2), 0), nr.y);
  }
  outColor = jump * (u_axis == 0 ? N.x : N.y);
}`;

// Pass 3b: RHS = div w via backward differences (clamped: the edge diff
// degenerates to 0 — Neumann-consistent).
const RHS_FS = `#version 300 es
precision highp float;
uniform sampler2D u_wx;
uniform sampler2D u_wy;
uniform ivec2 u_size;
out vec4 outColor;
ivec2 cc(ivec2 c) { return clamp(c, ivec2(0), u_size - 1); }
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  outColor =
    texelFetch(u_wx, c, 0) - texelFetch(u_wx, cc(c - ivec2(1, 0)), 0) +
    texelFetch(u_wy, c, 0) - texelFetch(u_wy, cc(c - ivec2(0, 1)), 0);
}`;

// Pass 5a: on-curve blur σ sources for the blur-map solve.
const BLURSRC_FS = `#version 300 es
precision highp float;
uniform sampler2D u_near;
uniform sampler2D u_data;
out vec4 outColor;
void main() {
  vec4 nr = texelFetch(u_near, ivec2(gl_FragCoord.xy), 0);
  if (nr.x < -0.5 || nr.w > 0.5) {
    outColor = vec4(0.0);
    return;
  }
  int i = int(nr.x + 0.5);
  float s = mix(texelFetch(u_data, ivec2(i, 0), 0).z,
                texelFetch(u_data, ivec2(i + 1, 0), 0).z, nr.y);
  outColor = vec4(s, 0.0, 0.0, 1.0);
}`;

// Pass 5b: spatially-varying separable Gaussian, per-DEST-pixel radius
// from the diffused blur map (the standard varying-kernel approximation).
const VARBLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D u_img;
uniform sampler2D u_blur;
uniform ivec2 u_size;
uniform int u_axis;
out vec4 outColor;
ivec2 cc(ivec2 c) { return clamp(c, ivec2(0), u_size - 1); }
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float r = clamp(texelFetch(u_blur, c, 0).r, 0.0, float(${MAX_BLUR}));
  vec4 acc = texelFetch(u_img, c, 0);
  if (r < 0.5) {
    outColor = acc;
    return;
  }
  float sig = r * 0.5;
  float denom = 1.0 / (2.0 * sig * sig);
  float wsum = 1.0;
  int K = int(ceil(r));
  ivec2 st = u_axis == 0 ? ivec2(1, 0) : ivec2(0, 1);
  for (int k = 1; k <= ${MAX_BLUR}; k++) {
    if (k > K) break;
    float w = exp(-float(k * k) * denom);
    acc += (texelFetch(u_img, cc(c + st * k), 0) +
            texelFetch(u_img, cc(c - st * k), 0)) * w;
    wsum += 2.0 * w;
  }
  outColor = acc / wsum;
}`;

const VIEW_BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_max;
out vec4 outColor;
void main() {
  float b = texture(u_src, v_uv).r / max(u_max, 1e-4);
  outColor = vec4(vec3(b), 1.0);
}`;

// ---------------------------------------------------------------------------
// Node definition
// ---------------------------------------------------------------------------

export const diffusionCurvesNode: NodeDefinition = {
  type: "diffusion-curves",
  name: "Diffusion Curves",
  category: "spline",
  subcategory: "modifier",
  description:
    "Paint with gradients by drawing their boundaries (Orzan et al. 2008). Every subpath of the wired spline becomes a diffusion curve: the Left/Right color ramps run along the curve's length and diffuse outward from its two sides, filling the whole canvas with smooth shading while staying sharp across the curve itself. Per-stop ramp alpha diffuses too, so a drawing can fade to transparent for Merge compositing. Wire an image into `Trace` (color source: image) to sample its colors along your strokes instead — a few curves over a photo reconstruct a painterly version, live when the trace input animates. Blur softens the transition across the curve, shaped along its length by the blur curve. Crossing curves compete and blend — split curves or add stops to control junctions. Quality raises solver iterations; Resolution trades edge sharpness for speed on animated curves.",
  backend: "webgl2",
  inputs: [
    { name: "spline", type: "spline", required: true },
    { name: "trace", label: "Trace", type: "image", required: false },
  ],
  params: [
    {
      name: "color_source",
      label: "Color source",
      type: "enum",
      options: ["ramps", "image"],
      control: "segmented",
      default: "ramps",
    },
    {
      name: "left_colors",
      label: "Left colors",
      type: "color_ramp",
      default: [
        { id: "dl0", position: 0, color: "#ff6b35" },
        { id: "dl1", position: 1, color: "#ffd23f" },
      ] as ColorRampStop[],
      visibleIf: (p) => p.color_source !== "image",
    },
    {
      name: "right_colors",
      label: "Right colors",
      type: "color_ramp",
      default: [
        { id: "dr0", position: 0, color: "#0a2463" },
        { id: "dr1", position: 1, color: "#3e92cc" },
      ] as ColorRampStop[],
      visibleIf: (p) => p.color_source !== "image",
    },
    {
      name: "ramp_interp",
      label: "Ramp interpolation",
      type: "enum",
      options: ["linear", "ease", "constant"],
      default: "linear",
      visibleIf: (p) => p.color_source !== "image",
    },
    {
      name: "ramp_span",
      label: "Ramp span",
      type: "enum",
      options: ["per curve", "whole spline"],
      default: "per curve",
    },
    {
      name: "blur_max",
      label: "Blur (px)",
      type: "scalar",
      min: 0,
      max: MAX_BLUR,
      softMax: 24,
      step: 0.1,
      default: 0,
    },
    {
      name: "blur_curve",
      label: "Blur along curve",
      type: "float_curve",
      default: defaultFloatCurve(1, 1),
      visibleIf: (p) => ((p.blur_max as number) ?? 0) > 0,
    },
    {
      name: "quality",
      label: "Quality",
      type: "scalar",
      min: 1,
      max: 4,
      step: 1,
      default: 2,
    },
    {
      name: "resolution",
      label: "Resolution",
      type: "scalar",
      min: 0.25,
      max: 1,
      step: 0.05,
      default: 1,
    },
    {
      name: "source_distance",
      label: "Source distance",
      type: "scalar",
      min: 1,
      max: 8,
      step: 0.5,
      default: 3,
    },
    {
      name: "view",
      label: "View",
      type: "enum",
      options: ["result", "sources", "blur map"],
      default: "result",
    },
    OPACITY_PARAM,
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const spline = inputs.spline as SplineValue | undefined;
    const traceIn = inputs.trace;
    const trace =
      traceIn && traceIn.kind === "image" ? (traceIn as ImageValue) : null;

    const emptyOut = () => {
      const out = ctx.allocImage();
      ctx.clearTarget(out, [0, 0, 0, 0]);
      return { primary: out };
    };
    if (!spline || spline.kind !== "spline" || spline.subpaths.length === 0) {
      return emptyOut();
    }

    const res = Math.min(1, Math.max(0.25, (params.resolution as number) ?? 1));
    const solveW = Math.max(32, Math.round(ctx.width * res));
    const solveH = Math.max(32, Math.round(ctx.height * res));
    const quality = Math.max(1, Math.min(4, (params.quality as number) ?? 2));
    const blurMax = Math.max(0, (params.blur_max as number) ?? 0);
    const view = (params.view as string) ?? "result";
    const useTrace = ((params.color_source as string) ?? "ramps") === "image" && !!trace;
    const dSolve = Math.max(
      1,
      ((params.source_distance as number) ?? 3) * (solveW / ctx.width)
    );

    const samples = buildSamples(
      spline,
      solveW,
      solveH,
      (params.left_colors as ColorRampStop[]) ?? [],
      (params.right_colors as ColorRampStop[]) ?? [],
      ((params.ramp_interp as string) ?? "linear") as ColorRampInterp,
      ((params.ramp_span as string) ?? "per curve") === "whole spline",
      blurMax,
      sanitizeFloatCurve(params.blur_curve, 1, 1)
    );
    if (!samples) return emptyOut();

    const key = stateKey(nodeId);
    const state = (ctx.state[key] as DcState) ?? { dataTex: null };
    ctx.state[key] = state;
    const dataTex = uploadData(ctx, state, samples.data, samples.count);
    if (!dataTex) return emptyOut();

    const solveDims = { width: solveW, height: solveH };
    const bindCommon = (
      prog: WebGLProgram,
      gl: WebGL2RenderingContext,
      near: ImageValue | null
    ) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, near ? near.texture : null);
      gl.uniform1i(gl.getUniformLocation(prog, "u_near"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, dataTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_data"), 1);
    };

    // 1 — nearest-segment field.
    const near = ctx.allocImage(solveDims);
    const nearProg = ctx.getShader("diffusion-curves/nearest", NEAREST_FS);
    ctx.drawFullscreen(nearProg, near, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dataTex);
      gl.uniform1i(gl.getUniformLocation(nearProg, "u_data"), 0);
      gl.uniform1i(gl.getUniformLocation(nearProg, "u_count"), samples.count);
    });

    // 2 — color sources + mask.
    const C = ctx.allocImage(solveDims);
    const srcProg = ctx.getShader("diffusion-curves/sources", SOURCES_FS);
    ctx.drawFullscreen(srcProg, C, (gl) => {
      bindCommon(srcProg, gl, near);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, trace ? trace.texture : null);
      gl.uniform1i(gl.getUniformLocation(srcProg, "u_trace"), 2);
      gl.uniform1i(gl.getUniformLocation(srcProg, "u_mode"), useTrace ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(srcProg, "u_dist"), dSolve);
      gl.uniform1f(gl.getUniformLocation(srcProg, "u_halfw"), 0.6);
    });
    const M = ctx.allocImage(solveDims);
    const maskProg = ctx.getShader("diffusion-curves/mask", MASK_FS);
    ctx.drawFullscreen(maskProg, M, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, near.texture);
      gl.uniform1i(gl.getUniformLocation(maskProg, "u_near"), 0);
      gl.uniform1f(gl.getUniformLocation(maskProg, "u_center"), dSolve);
      gl.uniform1f(gl.getUniformLocation(maskProg, "u_halfw"), 0.6);
    });

    // 3 — gradient constraint → RHS.
    const wProg = ctx.getShader("diffusion-curves/w", W_FS);
    const drawW = (target: ImageValue, axis: number) => {
      ctx.drawFullscreen(wProg, target, (gl) => {
        bindCommon(wProg, gl, near);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, trace ? trace.texture : null);
        gl.uniform1i(gl.getUniformLocation(wProg, "u_trace"), 2);
        gl.uniform1i(gl.getUniformLocation(wProg, "u_mode"), useTrace ? 1 : 0);
        gl.uniform1i(gl.getUniformLocation(wProg, "u_axis"), axis);
        gl.uniform1f(gl.getUniformLocation(wProg, "u_dist"), dSolve);
        gl.uniform2f(
          gl.getUniformLocation(wProg, "u_texel"),
          1 / solveW,
          1 / solveH
        );
      });
    };
    const Wx = ctx.allocImage(solveDims);
    const Wy = ctx.allocImage(solveDims);
    drawW(Wx, 0);
    drawW(Wy, 1);
    const rhs = ctx.allocImage(solveDims);
    const rhsProg = ctx.getShader("diffusion-curves/rhs", RHS_FS);
    ctx.drawFullscreen(rhsProg, rhs, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, Wx.texture);
      gl.uniform1i(gl.getUniformLocation(rhsProg, "u_wx"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, Wy.texture);
      gl.uniform1i(gl.getUniformLocation(rhsProg, "u_wy"), 1);
      gl.uniform2i(gl.getUniformLocation(rhsProg, "u_size"), solveW, solveH);
    });
    ctx.releaseTexture(Wx.texture);
    ctx.releaseTexture(Wy.texture);

    // 4 — the color diffusion.
    const solved = solvePoisson(ctx, { color: C, mask: M, rhs }, { quality });

    // 5 — blur map (trace mode has no per-curve σ ramp; the blur curve
    // still applies along each curve, so it works there too).
    const doBlur = blurMax > 0.01 && samples.maxSigma > 0.01;
    let blurMap: ImageValue | null = null;
    if (doBlur || view === "blur map") {
      const bSrc = ctx.allocImage(solveDims);
      const bsProg = ctx.getShader("diffusion-curves/blursrc", BLURSRC_FS);
      ctx.drawFullscreen(bsProg, bSrc, (gl) => bindCommon(bsProg, gl, near));
      const bMask = ctx.allocImage(solveDims);
      ctx.drawFullscreen(maskProg, bMask, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, near.texture);
        gl.uniform1i(gl.getUniformLocation(maskProg, "u_near"), 0);
        gl.uniform1f(gl.getUniformLocation(maskProg, "u_center"), 0);
        gl.uniform1f(gl.getUniformLocation(maskProg, "u_halfw"), 0.5);
      });
      blurMap = solvePoisson(ctx, { color: bSrc, mask: bMask }, { quality: 1 });
      ctx.releaseTexture(bSrc.texture);
      ctx.releaseTexture(bMask.texture);
    }
    ctx.releaseTexture(near.texture);
    ctx.releaseTexture(rhs.texture);

    // Debug views short-circuit before the blur pass.
    if (view === "sources") {
      const out = ctx.allocImage();
      resampleImage(ctx, C, out);
      ctx.releaseTexture(C.texture);
      ctx.releaseTexture(M.texture);
      ctx.releaseTexture(solved.texture);
      if (blurMap) ctx.releaseTexture(blurMap.texture);
      return { primary: out };
    }
    ctx.releaseTexture(C.texture);
    ctx.releaseTexture(M.texture);
    if (view === "blur map") {
      const out = ctx.allocImage();
      const vbProg = ctx.getShader("diffusion-curves/viewblur", VIEW_BLUR_FS);
      const src = blurMap;
      ctx.drawFullscreen(vbProg, out, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src ? src.texture : null);
        gl.uniform1i(gl.getUniformLocation(vbProg, "u_src"), 0);
        gl.uniform1f(gl.getUniformLocation(vbProg, "u_max"), blurMax);
      });
      ctx.releaseTexture(solved.texture);
      if (blurMap) ctx.releaseTexture(blurMap.texture);
      return { primary: out };
    }

    // Up to canvas res, then reblur (σ is in canvas px; blur runs at
    // canvas res so radii are exact regardless of solve resolution).
    let img = solved;
    if (img.width !== ctx.width || img.height !== ctx.height) {
      const up = ctx.allocImage();
      resampleImage(ctx, img, up);
      ctx.releaseTexture(img.texture);
      img = up;
    }
    if (doBlur && blurMap) {
      let bCanvas = blurMap;
      if (bCanvas.width !== ctx.width || bCanvas.height !== ctx.height) {
        const up = ctx.allocImage();
        resampleImage(ctx, bCanvas, up);
        ctx.releaseTexture(bCanvas.texture);
        bCanvas = up;
      }
      blurMap = null;
      const blurProg = ctx.getShader("diffusion-curves/varblur", VARBLUR_FS);
      const runBlur = (source: ImageValue, axis: number) => {
        const target = ctx.allocImage();
        ctx.drawFullscreen(blurProg, target, (gl) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, source.texture);
          gl.uniform1i(gl.getUniformLocation(blurProg, "u_img"), 0);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, bCanvas.texture);
          gl.uniform1i(gl.getUniformLocation(blurProg, "u_blur"), 1);
          gl.uniform2i(
            gl.getUniformLocation(blurProg, "u_size"),
            ctx.width,
            ctx.height
          );
          gl.uniform1i(gl.getUniformLocation(blurProg, "u_axis"), axis);
        });
        ctx.releaseTexture(source.texture);
        return target;
      };
      img = runBlur(runBlur(img, 0), 1);
      ctx.releaseTexture(bCanvas.texture);
    } else if (blurMap) {
      ctx.releaseTexture(blurMap.texture);
    }
    return { primary: img };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const state = ctx.state[key] as DcState | undefined;
    if (state?.dataTex) ctx.gl.deleteTexture(state.dataTex);
    delete ctx.state[key];
  },
};
