import type { ImageValue, NodeDefinition } from "@/engine/types";
import { OPACITY_PARAM } from "@/engine/conventions";
import {
  blurSeparable,
  computeOrientationField,
  ORIENTATION_DECODE_GLSL,
} from "@/engine/orientation-field";

// Line Art — XDoG / FDoG line extraction (spec
// painterlyspec/082426_line-extraction.md; Winnemöller 2011, Kang 2007).
// The "ink" layer: nearly every good painterly composite is a region
// filter with one of these over it. XDoG's tunable soft threshold sweeps
// from clean line art through charcoal; the `flow` toggle turns the DoG
// into FDoG — measured 1D ACROSS the local flow, integrated ALONG the
// tangent streamline — which consolidates broken contours into coherent,
// hand-drawn-looking strokes.
//
// Output is INK ON TRANSPARENCY (straight alpha: rgb = ink color,
// a = line coverage) so it composites over any region filter through
// Merge with no matte step. `noMaskBase`: the source is an ANALYSIS
// input, not a blend base — a wired universal mask mattes the ink.
//
// The sharpened DoG U = (1+p)·G_σ − p·G_kσ can swing ±p, so
// intermediates store it affinely encoded ((U + p) / (1 + 2p)) — safe on
// the RGBA8 pool fallback, and affine-safe under the along-flow
// integration's normalized weights (the tensor-packing precedent).
//
// Ink color is 6-digit hex only for now — the alpha opt-in
// (ParamDef.alpha) waits on the 8-digit parse audit the spec flags.
//
// Pure/stateless — normal caching. Consumer contract: `field` unwired ⇒
// internal structure tensor (flow mode only).

const ACROSS_TAPS = 24;
const ALONG_TAPS = 24;

// Exported for scripts/emit-shaders.mts (check:shaders compile coverage).
export const LINE_LUM_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  vec4 c = texture(u_src, v_uv);
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) * c.a;
  outColor = vec4(l, l, l, 1.0);
}`;

// Exported for scripts/emit-shaders.mts (check:shaders compile coverage).
export const LINE_COMBINE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_fine;   // G_σ of lum·a
uniform sampler2D u_coarse; // G_kσ of lum·a
uniform float u_p;
out vec4 outColor;
void main() {
  float u = (1.0 + u_p) * texture(u_fine, v_uv).r -
            u_p * texture(u_coarse, v_uv).r;
  float e = (u + u_p) / (1.0 + 2.0 * u_p);
  outColor = vec4(e, e, e, 1.0);
}`;

// Exported for scripts/emit-shaders.mts (check:shaders compile coverage).
export const FDOG_ACROSS_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_field;
uniform vec2 u_invRes;
uniform float u_sigmaE; // fine σ, px
uniform float u_k;      // σ ratio
uniform float u_p;      // sharpening
out vec4 outColor;
${ORIENTATION_DECODE_GLSL}

float clum(vec2 uv) {
  vec4 c = texture(u_src, uv);
  return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) * c.a;
}

void main() {
  vec2 t = decodeTangent(texture(u_field, v_uv));
  if (dot(t, t) < 0.5) t = vec2(1.0, 0.0);
  vec2 g = vec2(t.y, t.x); // gradient axis in Y-UP pixel steps

  float sC = u_sigmaE * u_k;
  float twoE2 = 2.0 * u_sigmaE * u_sigmaE;
  float twoC2 = 2.0 * sC * sC;
  int radius = int(min(ceil(sC * 3.0), float(${ACROSS_TAPS})));

  float l0 = clum(v_uv);
  float accE = l0, wE = 1.0;
  float accC = l0, wC = 1.0;
  for (int i = 1; i <= ${ACROSS_TAPS}; i++) {
    if (i > radius) break;
    vec2 off = g * float(i) * u_invRes;
    float l = clum(v_uv + off) + clum(v_uv - off);
    float we = exp(-float(i * i) / twoE2);
    float wc = exp(-float(i * i) / twoC2);
    accE += we * l; wE += 2.0 * we;
    accC += wc * l; wC += 2.0 * wc;
  }
  float u = (1.0 + u_p) * (accE / wE) - u_p * (accC / wC);
  float e = (u + u_p) / (1.0 + 2.0 * u_p);
  outColor = vec4(e, e, e, 1.0);
}`;

// Exported for scripts/emit-shaders.mts (check:shaders compile coverage).
export const FDOG_ALONG_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;   // encoded across-DoG response
uniform sampler2D u_field;
uniform vec2 u_invRes;
uniform float u_aspect;
uniform float u_sigmaM;    // px along the streamline
out vec4 outColor;
${ORIENTATION_DECODE_GLSL}

void main() {
  float acc = texture(u_src, v_uv).r;
  float wsum = 1.0;
  int radius = int(min(ceil(u_sigmaM * 3.0), float(${ALONG_TAPS})));
  float twoS2 = 2.0 * u_sigmaM * u_sigmaM;
  float stepPx = u_invRes.x; // 1px expressed as canvas-width fraction

  vec2 t0 = decodeTangent(texture(u_field, v_uv));
  if (dot(t0, t0) < 0.5) { outColor = vec4(vec3(acc), 1.0); return; }

  for (int side = 0; side < 2; side++) {
    vec2 uv = v_uv;
    vec2 prev = side == 0 ? t0 : -t0;
    for (int i = 1; i <= ${ALONG_TAPS}; i++) {
      if (i > radius) break;
      vec2 t = coherentStep(decodeTangent(texture(u_field, uv)), prev);
      uv += vec2(t.x, -t.y * u_aspect) * stepPx;
      prev = t;
      float w = exp(-float(i * i) / twoS2);
      acc += w * texture(u_src, uv).r;
      wsum += w;
    }
  }
  float e = acc / wsum;
  outColor = vec4(e, e, e, 1.0);
}`;

// Exported for scripts/emit-shaders.mts (check:shaders compile coverage).
export const LINE_THRESH_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_u;     // encoded response
uniform sampler2D u_paper;
uniform int u_hasPaper;
uniform float u_p;
uniform float u_eps;
uniform float u_phi;
uniform float u_paperStrength;
uniform int u_invert;
uniform vec3 u_ink;
out vec4 outColor;

void main() {
  float e = texture(u_u, v_uv).r;
  float u = e * (1.0 + 2.0 * u_p) - u_p;
  float eps = u_eps;
  if (u_hasPaper == 1) {
    eps += (texture(u_paper, v_uv).r - 0.5) * u_paperStrength;
  }
  float T = u >= eps ? 1.0 : 1.0 + tanh(u_phi * (u - eps));
  float coverage = clamp(u_invert == 1 ? T : 1.0 - T, 0.0, 1.0);
  outColor = vec4(u_ink, coverage);
}`;

function hexToRgb(hex: string): [number, number, number] {
  const s = hex.replace("#", "").slice(0, 6);
  const n = parseInt(s.padEnd(6, "0"), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const lineArtNode: NodeDefinition = {
  type: "line-art",
  name: "Line Art",
  category: "image",
  subcategory: "modifier",
  description:
    "Extract stylized ink lines (XDoG): a soft-thresholded difference-of-Gaussians that sweeps from clean line art (low `Softness`) through charcoal tone (high). With `Flow` on the measurement runs across the image's flow and integrates along it (FDoG), consolidating broken contours into coherent hand-drawn strokes — visibly calmer on video than plain edge detection. Output is ink on transparency, ready to Merge over a Kuwahara / Flow Bilateral base (the painterly and toon stacks). `Size` is the line scale, `Threshold` how strong an edge must be, `Sharpen` the tone contrast. The optional `paper` mask modulates the threshold per-pixel — wire noise for hatching/charcoal texture. A wired universal mask mattes the ink.",
  backend: "webgl2",
  noMaskBase: true,
  inputs: [
    { name: "image", type: "image", required: true },
    { name: "field", label: "Field", type: "image", required: false },
    { name: "paper", label: "Paper", type: "mask", required: false },
  ],
  params: [
    { name: "flow", label: "Flow", type: "boolean", default: true },
    {
      name: "size",
      label: "Size",
      type: "scalar",
      min: 0.5,
      max: 8,
      softMax: 4,
      step: 0.1,
      default: 1.4,
    },
    {
      name: "contrast",
      label: "Contrast (k)",
      type: "scalar",
      min: 1.2,
      max: 3,
      step: 0.05,
      default: 1.6,
    },
    {
      name: "sharpen",
      label: "Sharpen",
      type: "scalar",
      min: 1,
      max: 50,
      softMax: 30,
      step: 0.5,
      default: 20,
    },
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "softness",
      label: "Softness",
      type: "scalar",
      min: 0.01,
      max: 2,
      softMax: 1,
      step: 0.01,
      default: 0.3,
    },
    {
      name: "flow_length",
      label: "Flow length",
      type: "scalar",
      min: 0,
      max: 16,
      softMax: 12,
      step: 0.5,
      default: 4,
      visibleIf: (p) => (p.flow ?? true) !== false,
    },
    {
      name: "paper_strength",
      label: "Paper strength",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    { name: "color", label: "Ink", type: "color", default: "#000000" },
    { name: "invert", label: "Invert", type: "boolean", default: false },
    {
      // Internal-field fallback only — ignored while `field` is wired;
      // flow mode only.
      name: "smooth",
      label: "Internal smooth",
      type: "scalar",
      min: 0,
      max: 32,
      softMax: 16,
      step: 0.5,
      default: 4,
      visibleIf: (p) => (p.flow ?? true) !== false,
    },
    OPACITY_PARAM,
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const src = inputs.image;
    const output = ctx.allocImage();
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const flow = (params.flow as boolean) ?? true;
    const p = (params.sharpen as number) ?? 20;
    const sigmaE = (params.size as number) ?? 1.4;
    const k = (params.contrast as number) ?? 1.6;

    // The encoded response the threshold pass reads.
    let responseTex: ImageValue;

    let internal: ImageValue | null = null;
    if (flow) {
      const wired = inputs.field;
      const wiredField = wired && wired.kind === "image" ? wired : null;
      internal = wiredField
        ? null
        : computeOrientationField(ctx, src, {
            preBlur: 1,
            smooth: (params.smooth as number) ?? 4,
          });
      const fieldTex = (wiredField ?? internal)!.texture;

      const across = ctx.allocImage();
      const acrossProg = ctx.getShader("line-art/across", FDOG_ACROSS_FS);
      ctx.drawFullscreen(acrossProg, across, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform1i(gl.getUniformLocation(acrossProg, "u_src"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, fieldTex);
        gl.uniform1i(gl.getUniformLocation(acrossProg, "u_field"), 1);
        gl.uniform2f(
          gl.getUniformLocation(acrossProg, "u_invRes"),
          1 / ctx.width,
          1 / ctx.height
        );
        gl.uniform1f(gl.getUniformLocation(acrossProg, "u_sigmaE"), sigmaE);
        gl.uniform1f(gl.getUniformLocation(acrossProg, "u_k"), k);
        gl.uniform1f(gl.getUniformLocation(acrossProg, "u_p"), p);
      });

      responseTex = ctx.allocImage();
      const alongProg = ctx.getShader("line-art/along", FDOG_ALONG_FS);
      ctx.drawFullscreen(alongProg, responseTex, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, across.texture);
        gl.uniform1i(gl.getUniformLocation(alongProg, "u_src"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, fieldTex);
        gl.uniform1i(gl.getUniformLocation(alongProg, "u_field"), 1);
        gl.uniform2f(
          gl.getUniformLocation(alongProg, "u_invRes"),
          1 / ctx.width,
          1 / ctx.height
        );
        gl.uniform1f(
          gl.getUniformLocation(alongProg, "u_aspect"),
          ctx.width / ctx.height
        );
        gl.uniform1f(
          gl.getUniformLocation(alongProg, "u_sigmaM"),
          (params.flow_length as number) ?? 4
        );
      });
      ctx.releaseTexture(across.texture);
    } else {
      // Isotropic XDoG: lum·a → two separable Gaussians → combine.
      const lum = ctx.allocImage();
      const lumProg = ctx.getShader("line-art/lum", LINE_LUM_FS);
      ctx.drawFullscreen(lumProg, lum, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform1i(gl.getUniformLocation(lumProg, "u_src"), 0);
      });
      const fine = ctx.allocImage();
      const coarse = ctx.allocImage();
      blurSeparable(ctx, lum.texture, fine, sigmaE);
      blurSeparable(ctx, lum.texture, coarse, sigmaE * k);
      ctx.releaseTexture(lum.texture);

      responseTex = ctx.allocImage();
      const combineProg = ctx.getShader("line-art/combine", LINE_COMBINE_FS);
      ctx.drawFullscreen(combineProg, responseTex, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fine.texture);
        gl.uniform1i(gl.getUniformLocation(combineProg, "u_fine"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, coarse.texture);
        gl.uniform1i(gl.getUniformLocation(combineProg, "u_coarse"), 1);
        gl.uniform1f(gl.getUniformLocation(combineProg, "u_p"), p);
      });
      ctx.releaseTexture(fine.texture);
      ctx.releaseTexture(coarse.texture);
    }

    const paper = inputs.paper;
    const paperTex =
      paper && (paper.kind === "mask" || paper.kind === "image")
        ? paper.texture
        : null;
    const softness = Math.max(0.01, (params.softness as number) ?? 0.3);
    const ink = hexToRgb((params.color as string) ?? "#000000");

    const threshProg = ctx.getShader("line-art/thresh", LINE_THRESH_FS);
    ctx.drawFullscreen(threshProg, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, responseTex.texture);
      gl.uniform1i(gl.getUniformLocation(threshProg, "u_u"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, paperTex);
      gl.uniform1i(gl.getUniformLocation(threshProg, "u_paper"), 1);
      gl.uniform1i(
        gl.getUniformLocation(threshProg, "u_hasPaper"),
        paperTex ? 1 : 0
      );
      gl.uniform1f(gl.getUniformLocation(threshProg, "u_p"), p);
      gl.uniform1f(
        gl.getUniformLocation(threshProg, "u_eps"),
        (params.threshold as number) ?? 0.5
      );
      gl.uniform1f(gl.getUniformLocation(threshProg, "u_phi"), 5 / softness);
      gl.uniform1f(
        gl.getUniformLocation(threshProg, "u_paperStrength"),
        (params.paper_strength as number) ?? 0.5
      );
      gl.uniform1i(
        gl.getUniformLocation(threshProg, "u_invert"),
        (params.invert as boolean) ? 1 : 0
      );
      gl.uniform3f(
        gl.getUniformLocation(threshProg, "u_ink"),
        ink[0],
        ink[1],
        ink[2]
      );
    });
    ctx.releaseTexture(responseTex.texture);

    if (internal) ctx.releaseTexture(internal.texture);
    return { primary: output };
  },
};
