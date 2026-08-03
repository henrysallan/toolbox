import type { NodeDefinition } from "@/engine/types";
import {
  VELOCITY_DECODE_GLSL,
  VELOCITY_ENCODE_GLSL,
} from "@/engine/velocity-field";

// Flow Obstacle — make any velocity field respect a shape (spec
// 072526_flow-fields.md). Field image in, obstacle mask in (any spline /
// Circle / Rectangle wires straight into the mask socket via the
// spline→mask coercion), field image out. Composable: it doesn't care
// whether the field came from Perlin curl, Spline Flow Field, or a chain
// of both — which is why boundary handling lives here instead of growing
// an obstacle input on every field producer.
//
// `deflect` removes the velocity component aimed INTO the obstacle inside
// a soft shell around it (the game-standard slip redirect — flow slides
// along the wall) and damps what's left deep inside. It is not exactly
// divergence-free (Bridson's potential-modulation is, but only applies at
// generation time); visually it reads as flow parting around the shape.
// `block` simply damps velocity by coverage — flow stagnates at the
// shape instead of parting around it (dead-water look).
//
// The obstacle's soft shell comes from wide finite-difference taps at
// `radius` — a hard-edged mask works as-is; blur the mask upstream for an
// even softer approach. Taps step isotropic PIXEL distances (y tap scaled
// by aspect) and the gradient flips to Y-DOWN to match the velocity
// convention.

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_field;
uniform sampler2D u_obstacle;
uniform float u_radius;   // canvas-width fraction
uniform float u_strength; // 0..1
uniform float u_aspect;   // width / height
uniform int u_mode;       // 0 = deflect, 1 = block
out vec4 outColor;
${VELOCITY_DECODE_GLSL}
${VELOCITY_ENCODE_GLSL}

void main() {
  vec2 v = decodeVelocity(texture(u_field, v_uv));
  float dx = u_radius;
  float dy = u_radius * u_aspect;
  float mC = texture(u_obstacle, v_uv).r;
  float mR = texture(u_obstacle, v_uv + vec2(dx, 0.0)).r;
  float mL = texture(u_obstacle, v_uv - vec2(dx, 0.0)).r;
  float mU = texture(u_obstacle, v_uv + vec2(0.0, dy)).r;
  float mD = texture(u_obstacle, v_uv - vec2(0.0, dy)).r;
  // Softened coverage — the wide taps mint a shell around a hard mask.
  float m = (2.0 * mC + mR + mL + mU + mD) / 6.0;

  vec2 outV = v;
  if (u_mode == 0) {
    // Y-DOWN gradient pointing into the obstacle (mU/mD are y-up taps).
    vec2 g = vec2(mR - mL, -(mU - mD));
    float glen = length(g);
    if (glen > 1e-5) {
      vec2 n = g / glen;
      float into = max(dot(outV, n), 0.0);
      // Engage across the shell; fully redirect once half-covered.
      outV -= u_strength * clamp(m * 2.0, 0.0, 1.0) * into * n;
    }
    // Deep interior: nothing should keep sliding through the solid core.
    outV *= 1.0 - u_strength * smoothstep(0.5, 0.95, mC);
  } else {
    outV *= 1.0 - u_strength * clamp(m, 0.0, 1.0);
  }
  outColor = encodeVelocity(outV);
}`;

export const flowObstacleNode: NodeDefinition = {
  type: "flow-obstacle",
  name: "Flow Obstacle",
  category: "image",
  subcategory: "modifier",
  description:
    "Make a velocity field respect a shape: wire a field (Perlin Noise curl / Spline Flow Field) and an obstacle mask (any spline or shape coerces in), and flow deflects around the silhouette instead of passing through it. `deflect` redirects flow to slide along the boundary (and stalls it inside); `block` just damps flow by coverage for a dead-water stop. `radius` sets how far out the boundary's influence reaches — blur the mask upstream for an even softer approach. Chain several obstacles in series for multiple shapes.",
  backend: "webgl2",
  inputs: [
    { name: "field", type: "image", required: true },
    { name: "obstacle", type: "mask", required: true },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["deflect", "block"],
      control: "segmented",
      default: "deflect",
    },
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 0.002,
      max: 0.2,
      softMax: 0.1,
      step: 0.001,
      default: 0.03,
    },
    {
      name: "strength",
      label: "Strength",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const field = inputs.field;
    if (!field || field.kind !== "image") {
      ctx.clearTarget(output, [0.5, 0.5, 0, 1]);
      return { primary: output };
    }
    const obstacle = inputs.obstacle;
    const obstacleTex =
      obstacle && obstacle.kind === "mask" ? obstacle.texture : null;

    const prog = ctx.getShader("flow-obstacle/fs", FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, field.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_field"), 0);
      gl.activeTexture(gl.TEXTURE1);
      // No obstacle wired → run with the field itself and strength 0
      // (straight pass-through) so the graph stays visible while wiring.
      gl.bindTexture(gl.TEXTURE_2D, obstacleTex ?? field.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_obstacle"), 1);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_radius"),
        (params.radius as number) ?? 0.03
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_strength"),
        obstacleTex ? ((params.strength as number) ?? 1) : 0
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_aspect"),
        ctx.width / ctx.height
      );
      gl.uniform1i(
        gl.getUniformLocation(prog, "u_mode"),
        ((params.mode as string) ?? "deflect") === "block" ? 1 : 0
      );
    });

    return { primary: output };
  },
};
