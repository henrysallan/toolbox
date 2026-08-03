import type { NodeDefinition } from "@/engine/types";
import { OPACITY_PARAM } from "@/engine/conventions";
import { VELOCITY_DECODE_GLSL } from "@/engine/velocity-field";

// Advect Image — Advect Points' sibling for pixels (spec
// 072526_flow-fields.md): every output pixel back-traces through a
// velocity field, re-sampling the field at each step, so the image flows
// along the field's CURVES (steps=1 degenerates to a Displace-style
// single push). Stateless semi-Lagrangian: a pure function of its inputs
// — scrub-safe, cache-friendly, offline-exact, no Simulation Zone.
//
// Field modes mirror Advect Points exactly (vector / angle / gradient /
// contour) so one field image drives points and pixels identically.
// Velocity is Y-DOWN in isotropic canvas-width units (see
// engine/velocity-field.ts); the trace runs in Y-UP v_uv space, so each
// step is `uv -= vec2(v.x, -v.y * aspect) * k`.
//
// Two passes: pass 1 integrates the back-trace and writes the final
// source-sample coordinate per pixel; pass 2 samples the source there
// with the edge rule. That makes the trace result a first-class `uv` aux
// output (wire it into any uv consumer to reuse the warp) for the price
// of one extra texture. The aux is built UNCONDITIONALLY — this node is
// cacheable, and a cache hit reuses the previous NodeOutput verbatim, so
// consumption-gating would serve a stale empty forever once wired (the
// loop-weave rule; Adaptive Pixelate's points aux has the same note).

const TRACE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_field;
uniform sampler2D u_speed;
uniform int u_hasSpeed;
uniform int u_fieldMode;  // 0 vector, 1 angle, 2 gradient, 3 contour
uniform int u_steps;
uniform float u_k;        // signed per-step distance (canvas-width units)
uniform float u_aspect;   // width / height
uniform float u_midlevel;
uniform float u_angleTurns;
uniform float u_angleOffset;
out vec4 outColor;
${VELOCITY_DECODE_GLSL}

const float TWO_PI = 6.28318530718;
const float GRAD_EPS = 0.004; // FD half-step, canvas-width fraction

float luma(vec2 uv) {
  vec3 c = texture(u_field, uv).rgb;
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// Velocity at a Y-UP uv, returned Y-DOWN (Advect Points' conventions).
vec2 fieldVel(vec2 uv) {
  if (u_fieldMode == 0) {
    return 2.0 * (texture(u_field, uv).rg - vec2(u_midlevel));
  }
  if (u_fieldMode == 1) {
    float th = (luma(uv) * u_angleTurns + u_angleOffset) * TWO_PI;
    return vec2(cos(th), sin(th));
  }
  float gx = luma(uv + vec2(GRAD_EPS, 0.0)) - luma(uv - vec2(GRAD_EPS, 0.0));
  float gyUp = luma(uv + vec2(0.0, GRAD_EPS * u_aspect)) -
               luma(uv - vec2(0.0, GRAD_EPS * u_aspect));
  vec2 g = vec2(gx, -gyUp); // y-down gradient (toward bright)
  float len = length(g);
  if (len < 1e-6) return vec2(0.0);
  g /= len;
  return u_fieldMode == 3 ? vec2(-g.y, g.x) : g;
}

void main() {
  vec2 uv = v_uv;
  for (int i = 0; i < 64; i++) {
    if (i >= u_steps) break;
    vec2 v = fieldVel(uv);
    if (u_hasSpeed == 1) {
      vec3 s = texture(u_speed, uv).rgb;
      v *= dot(s, vec3(0.2126, 0.7152, 0.0722));
    }
    uv -= vec2(v.x, -v.y * u_aspect) * u_k;
  }
  outColor = vec4(uv, 0.0, 1.0);
}`;

const SAMPLE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_uv;
uniform int u_edge; // 0 transparent, 1 clamp, 2 wrap, 3 mirror
out vec4 outColor;

void main() {
  vec2 uv = texture(u_uv, v_uv).rg;
  if (u_edge == 0 &&
      (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)) {
    outColor = vec4(0.0);
    return;
  }
  if (u_edge == 1) uv = clamp(uv, 0.0, 1.0);
  else if (u_edge == 2) uv = fract(uv);
  else if (u_edge == 3) uv = abs(fract(uv * 0.5) * 2.0 - 1.0);
  outColor = texture(u_src, uv);
}`;

const EDGE_OPTIONS = ["transparent", "clamp", "wrap", "mirror"] as const;

function fieldModeToInt(s: string): number {
  switch (s) {
    case "angle":
      return 1;
    case "gradient":
      return 2;
    case "contour":
      return 3;
    case "vector":
    default:
      return 0;
  }
}

export const advectImageNode: NodeDefinition = {
  type: "advect-image",
  name: "Advect Image",
  category: "image",
  subcategory: "modifier",
  description:
    "Flow an image along a velocity field: each pixel back-traces `steps` samples through the field (re-sampled every step, so content follows the field's curves — unlike Displace's single push). Deterministic and scrub-safe: `distance` is the total flow, keyframe it 0→N to animate content streaming along the field. Field modes match Advect Points (`vector` = signed-RG velocity from Perlin curl / Spline Flow Field, `angle` = luminance heading, `gradient` / `contour` = flow toward / around brightness). Optional speed image multiplies flow by its luminance. The `uv` aux carries the final warp for reuse in any uv consumer.",
  backend: "webgl2",
  inputs: [
    { name: "image", type: "image", required: true },
    { name: "field", label: "Field", type: "image", required: true },
    { name: "speed", label: "Speed field", type: "image", required: false },
  ],
  params: [
    {
      name: "field_mode",
      label: "Field",
      type: "enum",
      options: ["vector", "angle", "gradient", "contour"],
      default: "vector",
    },
    {
      name: "distance",
      label: "Distance",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.3,
      step: 0.001,
      default: 0.08,
    },
    {
      name: "steps",
      label: "Steps",
      type: "scalar",
      min: 1,
      max: 64,
      softMax: 32,
      step: 1,
      default: 12,
    },
    { name: "invert", label: "Invert flow", type: "boolean", default: false },
    {
      name: "angle_turns",
      label: "Angle range (turns)",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 2,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.field_mode === "angle",
    },
    {
      name: "angle_offset",
      label: "Angle offset (turns)",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.01,
      default: 0,
      visibleIf: (p) => p.field_mode === "angle",
    },
    {
      name: "midlevel",
      label: "Midlevel",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => (p.field_mode ?? "vector") === "vector",
    },
    {
      name: "edge",
      label: "Edge",
      type: "enum",
      options: EDGE_OPTIONS as unknown as string[],
      default: "clamp",
    },
    OPACITY_PARAM,
  ],
  primaryOutput: "image",
  auxOutputs: [{ name: "uv", type: "uv" }],

  compute({ inputs, params, ctx }) {
    const src = inputs.image;
    const field = inputs.field;
    const uvMap = ctx.allocUv();
    const output = ctx.allocImage();

    const fieldTex = field && field.kind === "image" ? field.texture : null;
    const speed = inputs.speed;
    const speedTex = speed && speed.kind === "image" ? speed.texture : null;
    const steps = Math.max(
      1,
      Math.min(64, Math.round((params.steps as number) ?? 12))
    );
    const distance = (params.distance as number) ?? 0.08;
    const k = ((params.invert as boolean) ? -1 : 1) * (distance / steps);

    // Pass 1 — integrate the back-trace into a uv map. Missing field ⇒
    // zero steps ⇒ identity map, which makes pass 2 a straight copy (the
    // Displace missing-input convention: degrade to pass-through).
    const trace = ctx.getShader("advect-image/trace", TRACE_FS);
    ctx.drawFullscreen(trace, uvMap, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fieldTex);
      gl.uniform1i(gl.getUniformLocation(trace, "u_field"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, speedTex);
      gl.uniform1i(gl.getUniformLocation(trace, "u_speed"), 1);
      gl.uniform1i(
        gl.getUniformLocation(trace, "u_hasSpeed"),
        speedTex ? 1 : 0
      );
      gl.uniform1i(
        gl.getUniformLocation(trace, "u_fieldMode"),
        fieldModeToInt((params.field_mode as string) ?? "vector")
      );
      gl.uniform1i(gl.getUniformLocation(trace, "u_steps"), fieldTex ? steps : 0);
      gl.uniform1f(gl.getUniformLocation(trace, "u_k"), k);
      gl.uniform1f(
        gl.getUniformLocation(trace, "u_aspect"),
        ctx.width / ctx.height
      );
      gl.uniform1f(
        gl.getUniformLocation(trace, "u_midlevel"),
        (params.midlevel as number) ?? 0.5
      );
      gl.uniform1f(
        gl.getUniformLocation(trace, "u_angleTurns"),
        (params.angle_turns as number) ?? 1
      );
      gl.uniform1f(
        gl.getUniformLocation(trace, "u_angleOffset"),
        (params.angle_offset as number) ?? 0
      );
    });

    // Pass 2 — sample the source through the map.
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output, aux: { uv: uvMap } };
    }
    const sample = ctx.getShader("advect-image/sample", SAMPLE_FS);
    ctx.drawFullscreen(sample, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(sample, "u_src"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, uvMap.texture);
      gl.uniform1i(gl.getUniformLocation(sample, "u_uv"), 1);
      const edge = ((params.edge as string) ?? "clamp") as string;
      gl.uniform1i(
        gl.getUniformLocation(sample, "u_edge"),
        Math.max(0, EDGE_OPTIONS.indexOf(edge as (typeof EDGE_OPTIONS)[number]))
      );
    });

    return { primary: output, aux: { uv: uvMap } };
  },
};
