import type { ImageValue, NodeDefinition } from "@/engine/types";
import { OPACITY_PARAM } from "@/engine/conventions";
import {
  computeOrientationField,
  ORIENTATION_DECODE_GLSL,
} from "@/engine/orientation-field";

// Flow Bilateral — orientation-aligned separable bilateral (spec
// painterlyspec/082426_flow-guided-filters.md §3; Kyprianidis & Döllner
// 2008): one 1D bilateral pass along the local gradient axis, one along
// the tangent axis, iterated. Far cheaper than a true 2D bilateral and
// better-looking on flowing regions — the standard abstraction base
// under soft quantization (the toon stack).
//
// Kang's FBL is NOT a separate node: it's this node with an ETF-method
// Image Flow Field wired into `field` (once the field node's `etf`
// method lands — spec M2).
//
// One shader serves both passes (u_axis picks tangent vs gradient); the
// walk is a straight line along the LOCAL orientation at the center
// pixel (the OABF formulation), not a curved streamline — Flow Blur
// owns the curved walk. Consumer contract: `field` unwired ⇒ internal
// structure tensor from the source. Premultiply rule: spatial+range
// weights accumulate premultiplied color; range distance is measured in
// premultiplied RGBA so a soft edge reads as its composited color, not
// its stored one.
//
// Pure/stateless — normal caching.

const MAX_TAPS = 32;

// Exported for scripts/emit-shaders.mts (check:shaders compile coverage).
export const FLOW_BILATERAL_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_field;
uniform vec2 u_invRes;
uniform int u_axis;      // 0 along tangent, 1 across (gradient axis)
uniform float u_sigmaS;  // spatial σ, px
uniform float u_sigmaR;  // range σ, premultiplied-RGBA distance
out vec4 outColor;
${ORIENTATION_DECODE_GLSL}

vec4 pm(vec4 c) { return vec4(c.rgb * c.a, c.a); }

void main() {
  vec2 t = decodeTangent(texture(u_field, v_uv));
  if (dot(t, t) < 0.5) t = u_axis == 0 ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 dir = vec2(t.x, -t.y); // Y-DOWN tangent → Y-UP v_uv pixel steps
  if (u_axis == 1) dir = vec2(-dir.y, dir.x);

  vec4 center = pm(texture(u_src, v_uv));
  int radius = int(min(ceil(u_sigmaS * 3.0), float(${MAX_TAPS})));
  float twoS2 = 2.0 * u_sigmaS * u_sigmaS;
  float twoR2 = 2.0 * u_sigmaR * u_sigmaR;

  vec4 acc = center;
  float wsum = 1.0;
  for (int i = 1; i <= ${MAX_TAPS}; i++) {
    if (i > radius) break;
    float ws = exp(-float(i * i) / twoS2);
    vec2 off = dir * float(i) * u_invRes;
    vec4 ca = pm(texture(u_src, v_uv + off));
    vec4 cb = pm(texture(u_src, v_uv - off));
    vec4 da = ca - center;
    vec4 db = cb - center;
    float wa = ws * exp(-dot(da, da) / twoR2);
    float wb = ws * exp(-dot(db, db) / twoR2);
    acc += ca * wa + cb * wb;
    wsum += wa + wb;
  }
  vec4 c = acc / wsum;
  outColor = vec4(c.a > 1e-5 ? c.rgb / c.a : vec3(0.0), c.a);
}`;

export const flowBilateralNode: NodeDefinition = {
  type: "flow-bilateral",
  name: "Flow Bilateral",
  category: "image",
  subcategory: "modifier",
  description:
    "Edge-preserving smoothing aligned to the image's flow: a 1D bilateral filter runs across the local edge direction, then along it, per iteration — flattening texture and noise while edges and flowing detail survive. Much cheaper than a full 2D bilateral and calmer on video. The abstraction base of the toon look (follow with Posterize and Line Art). Steered by the `field` input (Image Flow Field or any velocity field) or an internal estimate when unwired. `Spatial σ` is the smoothing reach in px, `Range σ` how different colors must be to count as an edge (lower preserves more), `Across scale` shrinks the across-edge reach to protect edges harder.",
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
      max: 4,
      step: 1,
      default: 2,
    },
    {
      name: "sigma_s",
      label: "Spatial σ",
      type: "scalar",
      min: 0.5,
      max: 10,
      softMax: 8,
      step: 0.1,
      default: 4,
    },
    {
      name: "sigma_r",
      label: "Range σ",
      type: "scalar",
      min: 0.01,
      max: 1,
      softMax: 0.5,
      step: 0.01,
      default: 0.1,
    },
    {
      name: "across_scale",
      label: "Across scale",
      type: "scalar",
      min: 0.1,
      max: 2,
      step: 0.05,
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
      Math.min(4, Math.round((params.iterations as number) ?? 2))
    );
    const sigmaS = (params.sigma_s as number) ?? 4;
    const sigmaR = (params.sigma_r as number) ?? 0.1;
    const acrossScale = (params.across_scale as number) ?? 1;

    const prog = ctx.getShader("flow-bilateral/main", FLOW_BILATERAL_FS);
    const pass = (
      from: WebGLTexture,
      to: ImageValue,
      axis: number,
      s: number
    ) => {
      ctx.drawFullscreen(prog, to, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, from);
        gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, fieldTex);
        gl.uniform1i(gl.getUniformLocation(prog, "u_field"), 1);
        gl.uniform2f(
          gl.getUniformLocation(prog, "u_invRes"),
          1 / ctx.width,
          1 / ctx.height
        );
        gl.uniform1i(gl.getUniformLocation(prog, "u_axis"), axis);
        gl.uniform1f(gl.getUniformLocation(prog, "u_sigmaS"), s);
        gl.uniform1f(gl.getUniformLocation(prog, "u_sigmaR"), sigmaR);
      });
    };

    // iterations × (across → along) pass pairs, ping-ponging two temps;
    // the final along-pass lands in `output`.
    const tmpA = ctx.allocImage();
    const tmpB = ctx.allocImage();
    let cur = src.texture;
    for (let it = 0; it < iterations; it++) {
      pass(cur, tmpA, 1, sigmaS * acrossScale);
      const last = it === iterations - 1;
      pass(tmpA.texture, last ? output : tmpB, 0, sigmaS);
      cur = tmpB.texture;
    }
    ctx.releaseTexture(tmpA.texture);
    ctx.releaseTexture(tmpB.texture);

    if (internal) ctx.releaseTexture(internal.texture);
    return { primary: output };
  },
};
