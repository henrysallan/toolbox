import type { NodeDefinition } from "@/engine/types";
import { OPACITY_PARAM } from "@/engine/conventions";

// Chromatic Aberration — split the R and B channels apart from G to fake lens
// dispersion / a glitchy RGB shift. Standalone and controllable (CA otherwise
// only exists buried inside Bloom / Grain / Lens Flare).
//
//   radial      — offset grows outward from `center`; `falloff` shapes how
//                 fast it ramps toward the edges (0 = uniform, >1 = edge-heavy).
//   directional — a constant offset along `angle` (uniform shift).
//
// Offsets are in normalized UV. Out-of-range samples read transparent (straight
// alpha); output alpha is the max of the three taps to avoid edge fringing on
// transparency. Universal mask + opacity are applied by the evaluator.
const CA_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_amount;
uniform int u_mode;     // 0 radial, 1 directional
uniform vec2 u_center;  // GL Y-up (flipped from the stored Y-down param)
uniform float u_angle;  // radians
uniform float u_falloff;
out vec4 outColor;

vec4 samp(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(u_src, uv);
}

void main() {
  vec2 dir;
  float k = 1.0;
  if (u_mode == 0) {
    vec2 d = v_uv - u_center;
    dir = d;
    k = pow(clamp(length(d) * 2.0, 0.0, 1.0), u_falloff);
  } else {
    dir = vec2(cos(u_angle), sin(u_angle));
  }
  vec2 off = dir * u_amount * k;
  vec4 r = samp(v_uv + off);
  vec4 g = samp(v_uv);
  vec4 b = samp(v_uv - off);
  float a = max(max(r.a, g.a), b.a);
  outColor = vec4(r.r, g.g, b.b, a);
}`;

export const chromaticAberrationNode: NodeDefinition = {
  type: "chromatic-aberration",
  name: "Chromatic Aberration",
  category: "image",
  subcategory: "modifier",
  description:
    "Split the red and blue channels away from green to fake lens dispersion or a glitchy RGB shift. Radial (grows from a center) or directional (uniform angled shift).",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "amount",
      label: "Amount",
      type: "scalar",
      min: 0,
      max: 0.1,
      softMax: 0.02,
      step: 0.0005,
      default: 0.004,
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["radial", "directional"],
      default: "radial",
    },
    {
      name: "center",
      label: "Center",
      type: "vec2",
      step: 0.001,
      default: [0.5, 0.5],
      visibleIf: (p) => p.mode !== "directional",
    },
    {
      name: "falloff",
      label: "Falloff",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.mode !== "directional",
    },
    {
      name: "angle",
      label: "Angle",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "directional",
    },
    OPACITY_PARAM,
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const src = inputs.image;
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    const amount = (params.amount as number) ?? 0.004;
    const mode = (params.mode as string) === "directional" ? 1 : 0;
    const center = (params.center as [number, number]) ?? [0.5, 0.5];
    const angleDeg = (params.angle as number) ?? 0;
    const falloff = (params.falloff as number) ?? 1;

    const prog = ctx.getShader("chromatic-aberration/main", CA_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform1f(gl.getUniformLocation(prog, "u_amount"), amount);
      gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), mode);
      // Stored center is normalized Y-DOWN; sampling space (v_uv) is Y-UP.
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_center"),
        center[0],
        1 - center[1]
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_angle"),
        (angleDeg * Math.PI) / 180
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_falloff"), Math.max(0, falloff));
    });

    return { primary: output };
  },
};
