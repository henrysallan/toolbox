import type { NodeDefinition } from "@/engine/types";
import { OPACITY_PARAM } from "@/engine/conventions";
import {
  computeOrientationField,
  ORIENTATION_DECODE_GLSL,
} from "@/engine/orientation-field";

// Flow Blur — line integral convolution (spec
// 082426_flow-guided-filters.md §1): smear each pixel along the
// streamline of an orientation/velocity field. The Van Gogh operator,
// and — fed a noise image — THE standard field visualization.
//
// Kinship: Advect Image TRANSPORTS (back-traces to a single source
// sample); Flow Blur SMEARS (averages every sample along the ±walk — a
// 1D blur bent along the flow).
//
// Consumer contract (082426_orientation-field.md): `field` unwired ⇒
// compute an internal structure-tensor field from the source itself via
// the shared engine helper, so the node works standalone. Wired ⇒ any
// field image steers it (Image Flow Field, Perlin curl, Spline Flow
// Field, a fluid sim's velocity aux…).
//
// `tangent` mode walks the π-periodic tangent SIGN-COHERENTLY
// (coherentStep — without it every path kinks at the tx>0
// canonicalization seam); `velocity` mode walks the RG as a directed
// velocity, so smear length scales with field speed.
//
// Premultiply rule (the region-filter contract): samples average in
// premultiplied color and un-premultiply on write — straight-alpha
// averaging at soft edges is the darkened-fringe bug convolve/
// boundary.ts exists to prevent.
//
// Pure/stateless — normal fingerprint caching, scrub-safe, offline-exact.

// Exported for scripts/emit-shaders.mts (check:shaders compile coverage).
export const FLOW_BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_field;
uniform int u_samples;   // per side, <= 64
uniform float u_step;    // canvas-width units per sample
uniform float u_aspect;  // width / height
uniform int u_falloff;   // 0 gauss, 1 box
uniform int u_mode;      // 0 tangent, 1 velocity
out vec4 outColor;
${ORIENTATION_DECODE_GLSL}

vec4 pm(vec2 uv) {
  vec4 c = texture(u_src, uv);
  return vec4(c.rgb * c.a, c.a);
}

vec2 dirAt(vec2 uv) {
  vec4 f = texture(u_field, uv);
  return u_mode == 1 ? 2.0 * (f.rg - vec2(0.5)) : decodeTangent(f);
}

float weightAt(int i) {
  if (u_falloff == 1) return 1.0;
  float x = float(i) / float(u_samples);
  return exp(-4.5 * x * x); // ~3σ at the walk's end
}

void main() {
  vec4 acc = pm(v_uv);
  float wsum = 1.0;
  vec2 t0 = dirAt(v_uv);
  for (int side = 0; side < 2; side++) {
    vec2 uv = v_uv;
    vec2 prev = side == 0 ? t0 : -t0;
    for (int i = 1; i <= 64; i++) {
      if (i > u_samples) break;
      vec2 t = dirAt(uv);
      if (u_mode == 0) t = coherentStep(t, prev);
      else if (side == 1) t = -t;
      uv += vec2(t.x, -t.y * u_aspect) * u_step;
      prev = t;
      float w = weightAt(i);
      acc += w * pm(uv);
      wsum += w;
    }
  }
  vec4 c = acc / wsum;
  outColor = vec4(c.a > 1e-5 ? c.rgb / c.a : vec3(0.0), c.a);
}`;

export const flowBlurNode: NodeDefinition = {
  type: "flow-blur",
  name: "Flow Blur",
  category: "image",
  subcategory: "modifier",
  description:
    "Smear the image along a flow field's streamlines (line integral convolution) — the painterly Van Gogh blur, and the standard way to SEE a field (wire noise into the image input). With `field` unwired the node derives flow from the image itself (structure tensor at `Internal smooth`); wire an Image Flow Field, Perlin curl, Spline Flow Field, or a sim's velocity aux to steer it. `Length` is the total ± smear distance (canvas-width fraction), `Samples` the quality per side. `Tangent` mode follows edge orientation regardless of direction; `Velocity` mode follows a directed field, smearing further where it's faster.",
  backend: "webgl2",
  inputs: [
    { name: "image", type: "image", required: true },
    { name: "field", label: "Field", type: "image", required: false },
  ],
  params: [
    {
      name: "length",
      label: "Length",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.3,
      step: 0.001,
      default: 0.06,
    },
    {
      name: "samples",
      label: "Samples",
      type: "scalar",
      min: 1,
      max: 64,
      softMax: 48,
      step: 1,
      default: 16,
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["tangent", "velocity"],
      default: "tangent",
    },
    {
      name: "falloff",
      label: "Falloff",
      type: "enum",
      options: ["gauss", "box"],
      default: "gauss",
    },
    {
      // Internal-field fallback only — ignored while `field` is wired
      // (params can't see wires, so it stays visible; the description
      // and docs row say so).
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
    const wiredField =
      wired && wired.kind === "image" ? wired : null;
    // Consumer contract: unwired field ⇒ internal structure tensor from
    // the source (fixed 1px pre-blur; `smooth` param). We own that
    // texture and must release it after the draw.
    const internal = wiredField
      ? null
      : computeOrientationField(ctx, src, {
          preBlur: 1,
          smooth: (params.smooth as number) ?? 4,
        });
    const fieldTex = (wiredField ?? internal)!.texture;

    const samples = Math.max(
      1,
      Math.min(64, Math.round((params.samples as number) ?? 16))
    );
    const length = (params.length as number) ?? 0.06;

    const prog = ctx.getShader("flow-blur/main", FLOW_BLUR_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, fieldTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_field"), 1);
      gl.uniform1i(gl.getUniformLocation(prog, "u_samples"), samples);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_step"),
        length / samples
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_aspect"),
        ctx.width / ctx.height
      );
      gl.uniform1i(
        gl.getUniformLocation(prog, "u_falloff"),
        ((params.falloff as string) ?? "gauss") === "box" ? 1 : 0
      );
      gl.uniform1i(
        gl.getUniformLocation(prog, "u_mode"),
        ((params.mode as string) ?? "tangent") === "velocity" ? 1 : 0
      );
    });

    if (internal) ctx.releaseTexture(internal.texture);
    return { primary: output };
  },
};
