import type { NodeDefinition } from "@/engine/types";
import { OPACITY_PARAM } from "@/engine/conventions";
import {
  computeOrientationField,
  ORIENTATION_DECODE_GLSL,
} from "@/engine/orientation-field";

// Kuwahara — the flagship painterly region filter (spec
// painterlyspec/082426_kuwahara.md): per pixel, partition the
// neighborhood into 8 overlapping sectors, keep the low-variance ones.
// Flat regions pool into paint-like facets while edges stay crisp.
//
// Two modes, per the spec's scope decisions (no classic 4-box — blocky
// and temporally unstable; no LUT textures — sector weights are the
// Kyprianidis/Kang/Döllner closed-form polynomial):
//   anisotropic — sectors live in an ELLIPSE aligned to the local flow
//     (tangent from the orientation field, eccentricity from coherence),
//     so facets stretch into strokes that follow edges. The video-stable
//     variant, and the default.
//   generalized — Papari-style isotropic disc sectors (identity frame,
//     zero eccentricity — same shader, degenerate transform). Rounder,
//     cheaper look.
//
// Consumer contract (082426_orientation-field.md): `field` unwired ⇒
// internal structure-tensor field from the source via the shared engine
// helper; wired ⇒ any orientation/velocity field steers the strokes
// (B = 0 velocity fields behave isotropically unless `min_coherence`
// floors them up).
//
// Premultiply rule: sector means/variances accumulate in PREMULTIPLIED
// color and the result un-premultiplies on write (the convolve/
// boundary.ts fringe rationale).
//
// Register-pressure note: 8 sectors × (Σw·rgba + Σw + Σw·rgb²) ≈ 64
// accumulator floats. This matches the reference implementations and is
// fine on desktop GL; if a low-end device chokes, the split is sectors
// 0–3 / 4–7 over two passes — don't shrink the sector count.

const MAX_EXTENT = 48; // px cap on the ellipse major half-axis

const KUWAHARA_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_field;
uniform vec2 u_invRes;
uniform float u_radius;     // px
uniform float u_q;          // sharpness exponent
uniform float u_hardness;   // variance scale inside the sector weight
uniform float u_anisotropy; // scales field coherence into eccentricity
uniform float u_minCoh;     // coherence floor
uniform int u_mode;         // 0 anisotropic, 1 generalized
out vec4 outColor;
${ORIENTATION_DECODE_GLSL}

// Polynomial sector-weight constants (Kyprianidis et al. 2010): the
// sector lobe is (v·axis + zeta - eta*(v·axis⊥)²)₊², tuned so adjacent
// lobes cross at equal weight 22.5° apart (N = 8).
const float ZETA = 0.33;
const float ZERO_CROSS = 0.58;

void main() {
  vec4 f = texture(u_field, v_uv);
  vec2 t = decodeTangent(f);
  float A = max(decodeCoherence(f), u_minCoh) * u_anisotropy;
  if (u_mode == 1 || dot(t, t) < 0.5) { t = vec2(1.0, 0.0); A = 0.0; }
  A = clamp(A, 0.0, 2.0);

  // Ellipse frame in pixel space. Tangent is Y-DOWN screen space; +y
  // pixel offsets below are Y-UP v_uv steps, so flip.
  vec2 major = vec2(t.x, -t.y);
  vec2 minor = vec2(-major.y, major.x);
  float a = u_radius * (1.0 + A);
  float b = u_radius / (1.0 + A);
  int ext = int(min(ceil(a), float(${MAX_EXTENT})));

  float eta = (ZETA + cos(ZERO_CROSS)) / (sin(ZERO_CROSS) * sin(ZERO_CROSS));

  vec4 m[8];   // Σ w·(rgb_pm, alpha)
  float wsum[8];
  vec3 s[8];   // Σ w·rgb_pm²
  for (int k = 0; k < 8; k++) {
    m[k] = vec4(0.0);
    wsum[k] = 0.0;
    s[k] = vec3(0.0);
  }

  for (int dy = -${MAX_EXTENT}; dy <= ${MAX_EXTENT}; dy++) {
    if (dy < -ext || dy > ext) continue;
    for (int dx = -${MAX_EXTENT}; dx <= ${MAX_EXTENT}; dx++) {
      if (dx < -ext || dx > ext) continue;
      vec2 off = vec2(float(dx), float(dy));
      // Into the unit disc of the ellipse frame.
      vec2 v = vec2(dot(off, major) / a, dot(off, minor) / b);
      float r2 = dot(v, v);
      if (r2 > 1.0) continue;

      vec4 c = texture(u_src, v_uv + off * u_invRes);
      vec4 pm = vec4(c.rgb * c.a, c.a);

      float w[8];
      float zsum = 0.0;
      float vxx = ZETA - eta * v.x * v.x;
      float vyy = ZETA - eta * v.y * v.y;
      float z;
      z = max(0.0,  v.y + vxx); w[0] = z * z; zsum += w[0];
      z = max(0.0, -v.x + vyy); w[2] = z * z; zsum += w[2];
      z = max(0.0, -v.y + vxx); w[4] = z * z; zsum += w[4];
      z = max(0.0,  v.x + vyy); w[6] = z * z; zsum += w[6];
      vec2 vr = 0.7071068 * vec2(v.x - v.y, v.x + v.y);
      vxx = ZETA - eta * vr.x * vr.x;
      vyy = ZETA - eta * vr.y * vr.y;
      z = max(0.0,  vr.y + vxx); w[1] = z * z; zsum += w[1];
      z = max(0.0, -vr.x + vyy); w[3] = z * z; zsum += w[3];
      z = max(0.0, -vr.y + vxx); w[5] = z * z; zsum += w[5];
      z = max(0.0,  vr.x + vyy); w[7] = z * z; zsum += w[7];

      float g = exp(-3.125 * r2) / max(zsum, 1e-5);
      for (int k = 0; k < 8; k++) {
        float wk = w[k] * g;
        m[k] += pm * wk;
        wsum[k] += wk;
        s[k] += pm.rgb * pm.rgb * wk;
      }
    }
  }

  vec4 acc = vec4(0.0);
  float accW = 0.0;
  for (int k = 0; k < 8; k++) {
    if (wsum[k] < 1e-6) continue;
    vec4 mean = m[k] / wsum[k];
    vec3 varc = max(s[k] / wsum[k] - mean.rgb * mean.rgb, 0.0);
    float sigma2 = varc.r + varc.g + varc.b;
    float wk = 1.0 / (1.0 + pow(u_hardness * 1000.0 * sigma2, 0.5 * u_q));
    acc += mean * wk;
    accW += wk;
  }
  vec4 c = accW > 1e-6 ? acc / accW : texture(u_src, v_uv);
  outColor = vec4(c.a > 1e-5 ? c.rgb / c.a : vec3(0.0), c.a);
}`;

// Exported for scripts/emit-shaders.mts (check:shaders compile coverage).
export { KUWAHARA_FS };

export const kuwaharaNode: NodeDefinition = {
  type: "kuwahara",
  name: "Kuwahara",
  category: "image",
  subcategory: "modifier",
  description:
    "Painterly smoothing: each pixel pools the least-varying sectors of its neighborhood, flattening texture into paint-like facets while edges stay crisp. `Anisotropic` (default) stretches the facets into strokes along the local flow — steered by the `field` input (Image Flow Field, or any velocity field), or by an internal estimate when unwired — and is the temporally stable choice for video. `Generalized` keeps round isotropic facets. `Radius` is the brush size (cost grows with its square); `Sharpness`/`Hardness` set how crisply the winning facet dominates; `Anisotropy` scales how strongly flow coherence elongates strokes, with `Min coherence` forcing elongation where the field reports none (e.g. plain velocity fields).",
  backend: "webgl2",
  inputs: [
    { name: "image", type: "image", required: true },
    { name: "field", label: "Field", type: "image", required: false },
  ],
  params: [
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 1,
      max: 32,
      softMax: 24,
      step: 0.5,
      default: 6,
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["anisotropic", "generalized"],
      default: "anisotropic",
    },
    {
      name: "sharpness",
      label: "Sharpness",
      type: "scalar",
      min: 1,
      max: 16,
      step: 0.5,
      default: 8,
    },
    {
      name: "hardness",
      label: "Hardness",
      type: "scalar",
      min: 0.1,
      max: 100,
      softMax: 20,
      step: 0.1,
      default: 8,
    },
    {
      name: "anisotropy",
      label: "Anisotropy",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.05,
      default: 1,
      visibleIf: (p) => (p.mode ?? "anisotropic") === "anisotropic",
    },
    {
      name: "min_coherence",
      label: "Min coherence",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      visibleIf: (p) => (p.mode ?? "anisotropic") === "anisotropic",
    },
    {
      // Internal-field fallback only — ignored while `field` is wired.
      name: "smooth",
      label: "Internal smooth",
      type: "scalar",
      min: 0,
      max: 32,
      softMax: 16,
      step: 0.5,
      default: 4,
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

    const mode = (params.mode as string) ?? "anisotropic";
    const wired = inputs.field;
    const wiredField = wired && wired.kind === "image" ? wired : null;
    // Generalized mode ignores the frame entirely — skip the internal
    // field passes and bind the source as a harmless dummy field.
    const internal =
      wiredField || mode === "generalized"
        ? null
        : computeOrientationField(ctx, src, {
            preBlur: 1,
            smooth: (params.smooth as number) ?? 4,
          });
    const fieldTex = (wiredField ?? internal ?? src).texture;

    const prog = ctx.getShader("kuwahara/main", KUWAHARA_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, fieldTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_field"), 1);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_invRes"),
        1 / ctx.width,
        1 / ctx.height
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_radius"),
        (params.radius as number) ?? 6
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_q"),
        (params.sharpness as number) ?? 8
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_hardness"),
        (params.hardness as number) ?? 8
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_anisotropy"),
        (params.anisotropy as number) ?? 1
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_minCoh"),
        (params.min_coherence as number) ?? 0
      );
      gl.uniform1i(
        gl.getUniformLocation(prog, "u_mode"),
        mode === "generalized" ? 1 : 0
      );
    });

    if (internal) ctx.releaseTexture(internal.texture);
    return { primary: output };
  },
};
