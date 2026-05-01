import type { NodeDefinition } from "@/engine/types";

// Rectangular ↔ polar image transform. Two directions:
//
//   rect-to-polar : the source image is treated as if it lies in
//                   (angle, radius) space — the X axis maps to angle
//                   in [0, 2π) and the Y axis maps to radius in
//                   [0, 1]. The output is the resulting circular
//                   image (a tunnel / kaleidoscope-friendly view).
//
//   polar-to-rect : the inverse — the source is treated as a
//                   conventional XY image and the output unrolls it
//                   around the center, with each output column
//                   sampling the source along a ray from the center.
//
// `center_x` / `center_y` set the pivot in [0, 1]² (default 0.5, 0.5).
// `rotation` rotates the angle axis (radians). `scale_radius` lets
// the user squeeze or stretch the radial range — values < 1 sample
// closer to the center, > 1 push past the edge.

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_center;
uniform float u_rotation;
uniform float u_radiusScale;
uniform int u_mode;       // 0 = rect-to-polar, 1 = polar-to-rect
uniform int u_wrap;       // 0 = transparent, 1 = clamp, 2 = mirror
out vec4 outColor;

const float TAU = 6.28318530717958647692;

vec2 wrapUv(vec2 uv) {
  if (u_wrap == 1) return clamp(uv, 0.0, 1.0);
  if (u_wrap == 2) return abs(fract(uv * 0.5) * 2.0 - 1.0);
  return uv;
}

void main() {
  vec2 uv;
  if (u_mode == 0) {
    // rect-to-polar: each output pixel sits at (cx + r cos θ, cy + r sin θ)
    // and we read from (θ/2π, r) of the source. Aspect-corrected for the
    // canvas isn't necessary here because output and input share UV space.
    vec2 d = v_uv - u_center;
    float r = length(d) * u_radiusScale;
    float theta = atan(d.y, d.x) + u_rotation;
    // atan returns [-π, π]; wrap into [0, 1) for the angle axis.
    float a = mod(theta, TAU) / TAU;
    if (a < 0.0) a += 1.0;
    uv = vec2(a, r);
  } else {
    // polar-to-rect: the output's X is angle (0..1 ⇒ 0..2π) and Y is
    // radius (0..1 ⇒ 0..max). Sample the source at the corresponding
    // (cx + r cos θ, cy + r sin θ).
    float theta = v_uv.x * TAU + u_rotation;
    float r = v_uv.y * u_radiusScale;
    uv = u_center + vec2(cos(theta), sin(theta)) * r;
  }

  if (u_wrap == 0 && (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)) {
    outColor = vec4(0.0);
    return;
  }
  outColor = texture(u_src, wrapUv(uv));
}`;

const MODES = ["rect-to-polar", "polar-to-rect"] as const;
type Mode = (typeof MODES)[number];

const WRAP_OPTIONS = ["transparent", "clamp", "mirror"] as const;

function modeToInt(m: Mode): number {
  return m === "polar-to-rect" ? 1 : 0;
}

function wrapToInt(s: string): number {
  if (s === "clamp") return 1;
  if (s === "mirror") return 2;
  return 0;
}

export const polarCoordsNode: NodeDefinition = {
  type: "polar-coords",
  name: "Polar Coords",
  category: "image",
  subcategory: "modifier",
  description:
    "Map an image between rectangular and polar coordinates. Rect ⇒ Polar wraps the source around the center (kaleidoscope / tunnel looks); Polar ⇒ Rect unrolls a circular source into a strip. Center, rotation, and radial scale set the pivot and orientation.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: MODES as unknown as string[],
      default: "rect-to-polar",
    },
    {
      name: "center_x",
      label: "Center X",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "center_y",
      label: "Center Y",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "rotation",
      label: "Rotation (rad)",
      type: "scalar",
      min: -Math.PI,
      max: Math.PI,
      step: 0.001,
      default: 0,
    },
    {
      name: "scale_radius",
      label: "Radius scale",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 2,
      step: 0.001,
      default: 1,
    },
    {
      name: "wrap",
      label: "Edge",
      type: "enum",
      options: WRAP_OPTIONS as unknown as string[],
      default: "clamp",
    },
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
    const mode = ((params.mode as string) ?? "rect-to-polar") as Mode;
    const cx = (params.center_x as number) ?? 0.5;
    const cy = (params.center_y as number) ?? 0.5;
    const rot = (params.rotation as number) ?? 0;
    const radiusScale = (params.scale_radius as number) ?? 1;
    const wrap = wrapToInt((params.wrap as string) ?? "clamp");

    const prog = ctx.getShader("polar-coords/fs", FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform2f(gl.getUniformLocation(prog, "u_center"), cx, cy);
      gl.uniform1f(gl.getUniformLocation(prog, "u_rotation"), rot);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_radiusScale"),
        radiusScale
      );
      gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), modeToInt(mode));
      gl.uniform1i(gl.getUniformLocation(prog, "u_wrap"), wrap);
    });
    return { primary: output };
  },
};
