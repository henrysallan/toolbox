import type { ImageValue, NodeDefinition } from "@/engine/types";
import { OPACITY_PARAM } from "@/engine/conventions";
import {
  computeOrientationField,
  ORIENTATION_DECODE_GLSL,
} from "@/engine/orientation-field";

// Coherence Shock — smooth along the flow, sharpen across it via
// directional dilation/erosion (spec
// painterlyspec/082426_flow-guided-filters.md §2; Weickert 2003,
// Kyprianidis & Kang 2011). The strongest single painterly operator in
// the lineage: it manufactures the crisp, fluid brush edges Kuwahara's
// pooling can't.
//
// Per iteration, two passes:
//   smooth — 1D Gaussian along the local tangent (flow smoothing).
//   shock  — the sign of the second luminance derivative ACROSS the
//            flow (gradient axis) picks dilation (ridge) or erosion
//            (valley); the pixel takes the extreme-luminance sample
//            found within `radius` px along that axis, blended by
//            `amount`. The derivative is computed inline from the
//            smoothed texture — no separate sign pass needed.
//
// Iterative ≠ stateful (the spec's temporal note): all iterations run
// inside one compute, a pure function of (source, field, params) —
// nothing drifts between frames, caching is normal. The field is
// sampled from the SAME input every iteration (stability under
// animation; the reference's per-iteration re-estimation is the
// deferred `refine` toggle, spec M4).
//
// Luminance is coverage-weighted (lum × alpha) so transparent surround
// never wins a dilation; the amount-blend mixes premultiplied then
// un-premultiplies (the fringe rule).

const MAX_TAPS = 16;

// Exported for scripts/emit-shaders.mts (check:shaders compile coverage).
export const SHOCK_SMOOTH_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_field;
uniform vec2 u_invRes;
uniform float u_sigma; // px along the tangent
out vec4 outColor;
${ORIENTATION_DECODE_GLSL}

vec4 pm(vec4 c) { return vec4(c.rgb * c.a, c.a); }

void main() {
  vec2 t = decodeTangent(texture(u_field, v_uv));
  if (dot(t, t) < 0.5) t = vec2(1.0, 0.0);
  vec2 dir = vec2(t.x, -t.y);

  int radius = int(min(ceil(u_sigma * 3.0), float(${MAX_TAPS})));
  if (radius <= 0) { outColor = texture(u_src, v_uv); return; }
  float twoS2 = 2.0 * u_sigma * u_sigma;
  vec4 acc = pm(texture(u_src, v_uv));
  float wsum = 1.0;
  for (int i = 1; i <= ${MAX_TAPS}; i++) {
    if (i > radius) break;
    float w = exp(-float(i * i) / twoS2);
    vec2 off = dir * float(i) * u_invRes;
    acc += w * (pm(texture(u_src, v_uv + off)) +
                pm(texture(u_src, v_uv - off)));
    wsum += 2.0 * w;
  }
  vec4 c = acc / wsum;
  outColor = vec4(c.a > 1e-5 ? c.rgb / c.a : vec3(0.0), c.a);
}`;

// Exported for scripts/emit-shaders.mts (check:shaders compile coverage).
export const SHOCK_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;   // the along-flow-smoothed image
uniform sampler2D u_field;
uniform vec2 u_invRes;
uniform float u_radius;    // px reach of the directional min/max
uniform float u_amount;
out vec4 outColor;
${ORIENTATION_DECODE_GLSL}

float clum(vec2 uv) {
  vec4 c = texture(u_src, uv);
  return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) * c.a;
}

void main() {
  vec2 t = decodeTangent(texture(u_field, v_uv));
  if (dot(t, t) < 0.5) t = vec2(1.0, 0.0);
  vec2 g = vec2(t.y, t.x); // gradient axis: perp of Y-UP'd tangent

  // Second derivative across the flow decides dilate vs erode.
  vec2 d = g * 1.5 * u_invRes;
  float lap = clum(v_uv + d) - 2.0 * clum(v_uv) + clum(v_uv - d);

  vec4 center = texture(u_src, v_uv);
  int radius = int(min(ceil(u_radius), float(${MAX_TAPS})));
  float bestL = clum(v_uv);
  vec4 best = center;
  for (int i = 1; i <= ${MAX_TAPS}; i++) {
    if (i > radius) break;
    vec2 off = g * float(i) * u_invRes;
    for (int s = 0; s < 2; s++) {
      vec2 uv = s == 0 ? v_uv + off : v_uv - off;
      float l = clum(uv);
      bool better = lap < 0.0 ? l > bestL : l < bestL;
      if (better) { bestL = l; best = texture(u_src, uv); }
    }
  }

  vec4 a = vec4(center.rgb * center.a, center.a);
  vec4 b = vec4(best.rgb * best.a, best.a);
  vec4 c = mix(a, b, u_amount);
  outColor = vec4(c.a > 1e-5 ? c.rgb / c.a : vec3(0.0), c.a);
}`;

export const shockFilterNode: NodeDefinition = {
  type: "shock-filter",
  name: "Coherence Shock",
  category: "image",
  subcategory: "modifier",
  description:
    "Painterly sharpening: smooths ALONG the image's flow while pushing pixels toward their local light/dark extreme ACROSS it, so soft gradients collapse into crisp, fluid brush edges — the operator behind most 'hand-painted' looks; stack after Kuwahara or Flow Bilateral. Steered by the `field` input (Image Flow Field or any velocity field) or an internal estimate when unwired. `Iterations` compounds the effect (deterministic — safe to scrub and export), `Radius` sets how far the sharpening reaches, `Smooth along` the per-iteration flow smoothing, `Amount` blends the shock against the smoothed base.",
  backend: "webgl2",
  inputs: [
    { name: "image", type: "image", required: true },
    { name: "field", label: "Field", type: "image", required: false },
  ],
  params: [
    {
      name: "iterations",
      label: "Iterations",
      type: "scalar",
      min: 1,
      max: 8,
      step: 1,
      default: 3,
    },
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 1,
      max: 16,
      softMax: 8,
      step: 0.5,
      default: 2,
    },
    {
      name: "smooth_along",
      label: "Smooth along",
      type: "scalar",
      min: 0,
      max: 10,
      softMax: 6,
      step: 0.1,
      default: 2,
    },
    {
      name: "amount",
      label: "Amount",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
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

    const wired = inputs.field;
    const wiredField = wired && wired.kind === "image" ? wired : null;
    const internal = wiredField
      ? null
      : computeOrientationField(ctx, src, {
          preBlur: 1,
          smooth: (params.smooth as number) ?? 4,
        });
    const fieldTex = (wiredField ?? internal)!.texture;

    const iterations = Math.max(
      1,
      Math.min(8, Math.round((params.iterations as number) ?? 3))
    );

    const smoothProg = ctx.getShader("shock-filter/smooth", SHOCK_SMOOTH_FS);
    const shockProg = ctx.getShader("shock-filter/shock", SHOCK_FS);
    const bindCommon = (gl: WebGL2RenderingContext, prog: WebGLProgram) => {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, fieldTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_field"), 1);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_invRes"),
        1 / ctx.width,
        1 / ctx.height
      );
    };

    const tmpA = ctx.allocImage();
    const tmpB = ctx.allocImage();
    let cur = src.texture;
    for (let it = 0; it < iterations; it++) {
      ctx.drawFullscreen(smoothProg, tmpA, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, cur);
        gl.uniform1i(gl.getUniformLocation(smoothProg, "u_src"), 0);
        bindCommon(gl, smoothProg);
        gl.uniform1f(
          gl.getUniformLocation(smoothProg, "u_sigma"),
          (params.smooth_along as number) ?? 2
        );
      });
      const last = it === iterations - 1;
      ctx.drawFullscreen(shockProg, last ? output : tmpB, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tmpA.texture);
        gl.uniform1i(gl.getUniformLocation(shockProg, "u_src"), 0);
        bindCommon(gl, shockProg);
        gl.uniform1f(
          gl.getUniformLocation(shockProg, "u_radius"),
          (params.radius as number) ?? 2
        );
        gl.uniform1f(
          gl.getUniformLocation(shockProg, "u_amount"),
          (params.amount as number) ?? 1
        );
      });
      cur = tmpB.texture;
    }
    ctx.releaseTexture(tmpA.texture);
    ctx.releaseTexture(tmpB.texture);

    if (internal) ctx.releaseTexture(internal.texture);
    return { primary: output };
  },
};
