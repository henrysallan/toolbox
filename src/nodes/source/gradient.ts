import type { ImageValue, NodeDefinition } from "@/engine/types";

// All four modes share the same fragment shader; `u_mode` selects the
// evaluator. `t` is the gradient parameter in [0, 1] used to mix the two
// endpoint colors.
//
// The angle (for linear and wave modes) can also be per-pixel modulated by a
// connected image. The modulator's red channel is sampled at the current UV
// and scaled by `u_angleModAmount` (in radians) before being added to the
// base angle. When no modulator is connected, `u_hasAngleMod` is 0 and the
// sampler is bound to a dummy 1x1 zero texture so WebGL stays happy.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform int u_mode;
uniform vec3 u_colorA;
uniform vec3 u_colorB;
uniform float u_angle;       // radians, linear + wave
uniform vec2  u_center;      // radial + polar
uniform float u_radius;      // radial
uniform float u_angleOffset; // polar (radians)
uniform float u_frequency;   // wave
uniform float u_phase;       // wave (radians)
uniform float u_softness;    // applies to all modes; shapes the t curve
uniform int u_hasAngleMod;   // 0 or 1
uniform sampler2D u_angleMod;
uniform float u_angleModAmount; // radians; multiplied by sampled red
out vec4 outColor;

const float PI = 3.14159265358979;

void main() {
  vec2 uv = v_uv;
  float t = 0.0;

  // Per-pixel angle offset from the modulator (zero if none connected).
  float angleMod = 0.0;
  if (u_hasAngleMod == 1) {
    angleMod = texture(u_angleMod, uv).r * u_angleModAmount;
  }
  float angle = u_angle + angleMod;

  if (u_mode == 0) {
    // linear: project (uv - 0.5) onto the angle direction.
    vec2 d = vec2(cos(angle), sin(angle));
    t = dot(uv - 0.5, d) + 0.5;
  } else if (u_mode == 1) {
    // radial: distance from center, normalised by radius.
    t = length(uv - u_center) / max(u_radius, 0.0001);
  } else if (u_mode == 2) {
    // polar / angular: angle around center, wrapped into [0, 1].
    vec2 p = uv - u_center;
    float a = atan(p.y, p.x) + u_angleOffset;
    t = fract(a / (2.0 * PI) + 1.0);
  } else if (u_mode == 3) {
    // wave: sinusoidal ramp along the direction vector.
    vec2 d = vec2(cos(angle), sin(angle));
    float x = dot(uv - 0.5, d);
    t = 0.5 + 0.5 * sin(x * u_frequency * 2.0 * PI + u_phase);
  }

  t = clamp(t, 0.0, 1.0);
  // Softness: 1.0 is the raw linear mix; lower values push values toward the
  // endpoints (sharper transition at the midpoint).
  float s = max(u_softness, 0.0001);
  t = pow(t, 1.0 / s);
  t = 1.0 - pow(1.0 - t, 1.0 / s);
  t = clamp(t, 0.0, 1.0);

  outColor = vec4(mix(u_colorA, u_colorB, t), 1.0);
}`;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ];
}

function modeToInt(m: string): number {
  switch (m) {
    case "linear": return 0;
    case "radial": return 1;
    case "polar": return 2;
    case "wave": return 3;
    default: return 0;
  }
}

const MODES = ["linear", "radial", "polar", "wave"];

// Ensure a 1x1 zero texture is cached per node for use as a "no modulator"
// placeholder. WebGL requires every declared sampler to have a valid binding
// regardless of whether the shader branches past it.
function getZeroTex(
  gl: WebGL2RenderingContext,
  state: Record<string, unknown>,
  nodeId: string
): WebGLTexture {
  const key = `gradient:${nodeId}:zero`;
  const cached = state[key] as WebGLTexture | undefined;
  if (cached) return cached;
  const tex = gl.createTexture();
  if (!tex) throw new Error("gradient: failed to create placeholder texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0])
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  state[key] = tex;
  return tex;
}

export const gradientNode: NodeDefinition = {
  type: "gradient",
  name: "Gradient",
  category: "source",
  description: "Two-color gradient in linear, radial, polar or wave modes.",
  backend: "webgl2",
  inputs: [],
  // The angle modulator socket is only exposed in modes where `angle` is
  // actually used (linear, wave). In radial/polar the socket is hidden to
  // avoid confusing no-op connections.
  resolveInputs(params) {
    const mode = (params.mode as string) ?? "linear";
    if (mode === "linear" || mode === "wave") {
      return [
        {
          name: "angle_mod",
          label: "angle mod",
          type: "image",
          required: false,
        },
      ];
    }
    return [];
  },
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: MODES,
      default: "linear",
    },
    { name: "color_a", label: "Color A", type: "color", default: "#000000" },
    { name: "color_b", label: "Color B", type: "color", default: "#ffffff" },

    {
      name: "angle",
      label: "Angle (°)",
      type: "scalar",
      min: 0,
      max: 360,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "linear" || p.mode === "wave",
    },
    {
      name: "angle_mod_amount",
      label: "Angle mod (°)",
      type: "scalar",
      min: -360,
      max: 360,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "linear" || p.mode === "wave",
    },

    {
      name: "center_x",
      label: "Center X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => p.mode === "radial" || p.mode === "polar",
    },
    {
      name: "center_y",
      label: "Center Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => p.mode === "radial" || p.mode === "polar",
    },

    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 0.01,
      max: 2,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => p.mode === "radial",
    },

    {
      name: "angle_offset",
      label: "Angle offset (°)",
      type: "scalar",
      min: 0,
      max: 360,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "polar",
    },

    {
      name: "frequency",
      label: "Frequency",
      type: "scalar",
      min: 0,
      max: 20,
      step: 0.1,
      default: 4,
      visibleIf: (p) => p.mode === "wave",
    },
    {
      name: "phase",
      label: "Phase (°)",
      type: "scalar",
      min: 0,
      max: 360,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "wave",
    },

    {
      name: "softness",
      label: "Softness",
      type: "scalar",
      min: 0.1,
      max: 3,
      step: 0.01,
      default: 1,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  dispose(ctx, nodeId) {
    const key = `gradient:${nodeId}:zero`;
    const tex = ctx.state[key] as WebGLTexture | undefined;
    if (tex) ctx.gl.deleteTexture(tex);
    delete ctx.state[key];
  },

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const mode = modeToInt((params.mode as string) ?? "linear");
    const [ar, ag, ab] = hexToRgb((params.color_a as string) ?? "#000000");
    const [br, bg, bb] = hexToRgb((params.color_b as string) ?? "#ffffff");
    const angleDeg = (params.angle as number) ?? 0;
    const cx = (params.center_x as number) ?? 0.5;
    const cy = (params.center_y as number) ?? 0.5;
    const radius = (params.radius as number) ?? 0.5;
    const angleOffsetDeg = (params.angle_offset as number) ?? 0;
    const frequency = (params.frequency as number) ?? 4;
    const phaseDeg = (params.phase as number) ?? 0;
    const softness = (params.softness as number) ?? 1;
    const angleModAmountDeg = (params.angle_mod_amount as number) ?? 0;

    const angleMod = inputs.angle_mod;
    const modTex: WebGLTexture =
      angleMod && angleMod.kind === "image"
        ? (angleMod as ImageValue).texture
        : getZeroTex(ctx.gl, ctx.state, nodeId);
    const hasMod = angleMod && angleMod.kind === "image" ? 1 : 0;

    const prog = ctx.getShader("gradient/fs", FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), mode);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorA"), ar, ag, ab);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorB"), br, bg, bb);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_angle"),
        (angleDeg * Math.PI) / 180
      );
      gl.uniform2f(gl.getUniformLocation(prog, "u_center"), cx, cy);
      gl.uniform1f(gl.getUniformLocation(prog, "u_radius"), radius);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_angleOffset"),
        (angleOffsetDeg * Math.PI) / 180
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_frequency"), frequency);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_phase"),
        (phaseDeg * Math.PI) / 180
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_softness"), softness);

      gl.uniform1i(gl.getUniformLocation(prog, "u_hasAngleMod"), hasMod);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_angleModAmount"),
        (angleModAmountDeg * Math.PI) / 180
      );
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, modTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_angleMod"), 0);
    });

    return { primary: output };
  },
};
