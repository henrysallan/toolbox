import { OPACITY_PARAM } from "@/engine/conventions";
import { loopEvolutionPhase } from "@/engine/noise";
import type {
  GradientPoint,
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  UvValue,
} from "@/engine/types";

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
uniform float u_angle;       // radians, wave
uniform vec2  u_start;       // linear gradient start point (UV, Y-up)
uniform vec2  u_end;         // linear gradient end point (UV, Y-up)
uniform vec2  u_center;      // radial + polar
uniform float u_radius;      // radial
uniform float u_angleOffset; // polar (radians)
uniform float u_frequency;   // wave
uniform float u_phase;       // wave (radians)
uniform int u_waveRing;      // wave: 0 = linear (directional), 1 = ring (radial)
uniform float u_aspect;      // wave ring: canvas width/height, keeps rings round
uniform float u_softness;    // applies to all modes; shapes the t curve
uniform int u_hasAngleMod;   // 0 or 1
uniform sampler2D u_angleMod;
uniform float u_angleModAmount; // radians; multiplied by sampled red
uniform float u_alpha;
uniform int u_hasUvIn;       // 0 = default v_uv, 1 = UV texture, 2 = scalar broadcast
uniform sampler2D u_uvIn;
uniform vec2 u_uvConst;

// multipoint: N color points blended by inverse-distance weighting.
#define MAX_POINTS 16
uniform int u_ptCount;
uniform vec2 u_ptPos[MAX_POINTS];   // UV, Y-up
uniform vec3 u_ptCol[MAX_POINTS];
uniform float u_idwPower;           // falloff exponent

out vec4 outColor;

const float PI = 3.14159265358979;

void main() {
  vec2 uv;
  if (u_hasUvIn == 1) uv = texture(u_uvIn, v_uv).rg;
  else if (u_hasUvIn == 2) uv = u_uvConst;
  else uv = v_uv;

  // multipoint: inverse-distance-weighted (Shepard) blend of the point
  // colors. Higher u_idwPower = sharper falloff (points dominate locally);
  // computes the color directly, so it skips the A/B mix + softness curve.
  if (u_mode == 4) {
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < MAX_POINTS; i++) {
      if (i >= u_ptCount) break;
      float d = max(distance(uv, u_ptPos[i]), 1e-4);
      float w = 1.0 / pow(d, u_idwPower);
      acc += w * u_ptCol[i];
      wsum += w;
    }
    vec3 c = wsum > 0.0 ? acc / wsum : vec3(0.0);
    outColor = vec4(c, u_alpha);
    return;
  }

  float t = 0.0;

  // Per-pixel angle offset from the modulator (zero if none connected).
  float angleMod = 0.0;
  if (u_hasAngleMod == 1) {
    angleMod = texture(u_angleMod, uv).r * u_angleModAmount;
  }
  float angle = u_angle + angleMod;

  if (u_mode == 0) {
    // linear: project (uv - start) onto the start→end axis, normalized so
    // t = 0 at the start handle and t = 1 at the end handle. The modulator
    // (when connected) rotates that axis per pixel by angleMod.
    vec2 se = u_end - u_start;
    float ca = cos(angleMod);
    float sa = sin(angleMod);
    vec2 d = vec2(ca * se.x - sa * se.y, sa * se.x + ca * se.y);
    t = dot(uv - u_start, d) / max(dot(d, d), 1e-6);
  } else if (u_mode == 1) {
    // radial: distance from center, normalised by radius.
    t = length(uv - u_center) / max(u_radius, 0.0001);
  } else if (u_mode == 2) {
    // polar / angular: angle around center, wrapped into [0, 1].
    vec2 p = uv - u_center;
    float a = atan(p.y, p.x) + u_angleOffset;
    t = fract(a / (2.0 * PI) + 1.0);
  } else if (u_mode == 3) {
    // wave: sinusoidal ramp. The linear sub-mode ramps along the direction
    // vector (parallel bands). The ring sub-mode ramps along the distance
    // from u_center, aspect-corrected so the rings stay round on non-square
    // canvases (concentric rings instead of stripes).
    float x;
    if (u_waveRing == 1) {
      vec2 p = uv - u_center;
      p.y /= u_aspect;
      x = length(p);
    } else {
      vec2 d = vec2(cos(angle), sin(angle));
      x = dot(uv - 0.5, d);
    }
    t = 0.5 + 0.5 * sin(x * u_frequency * 2.0 * PI + u_phase);
  }

  t = clamp(t, 0.0, 1.0);
  // Softness: 1.0 is the raw linear mix; lower values push values toward the
  // endpoints (sharper transition at the midpoint).
  float s = max(u_softness, 0.0001);
  t = pow(t, 1.0 / s);
  t = 1.0 - pow(1.0 - t, 1.0 / s);
  t = clamp(t, 0.0, 1.0);

  outColor = vec4(mix(u_colorA, u_colorB, t), u_alpha);
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
    case "multipoint": return 4;
    default: return 0;
  }
}

const MODES = ["linear", "radial", "polar", "wave", "multipoint"];

// Uniform-array capacity for multipoint mode. Bump in lockstep with the
// GLSL `MAX_POINTS` if more points are ever needed.
const MAX_POINTS = 16;

// Parse a point's color (a hex string in the stored param, or an RGBA float
// tuple when keyframe-resolved by the evaluator) into [r,g,b] in 0..1.
function pointColorToRgb(color: unknown): [number, number, number] {
  if (Array.isArray(color)) {
    return [
      (color[0] as number) ?? 0,
      (color[1] as number) ?? 0,
      (color[2] as number) ?? 0,
    ];
  }
  if (typeof color === "string") return hexToRgb(color);
  return [0, 0, 0];
}

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
  category: "image",
  subcategory: "generator",
  description: "Two-color gradient in linear, radial, polar or wave modes.",
  backend: "webgl2",
  inputs: [],
  // The angle modulator socket is only exposed in modes where `angle` is
  // actually used (linear, wave). In radial/polar the socket is hidden to
  // avoid confusing no-op connections.
  resolveInputs(params) {
    const mode = (params.mode as string) ?? "linear";
    const waveMode = (params.wave_mode as string) ?? "linear";
    const uv: InputSocketDef = {
      name: "uv_in",
      label: "UV",
      type: "uv",
      required: false,
    };
    // angle modulation applies to linear and the directional (linear) wave —
    // not the radial ring wave.
    if (mode === "linear" || (mode === "wave" && waveMode !== "ring")) {
      return [
        uv,
        {
          name: "angle_mod",
          label: "angle mod",
          type: "image",
          required: false,
        },
      ];
    }
    return [uv];
  },
  params: [
    OPACITY_PARAM,
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: MODES,
      default: "linear",
    },
    // Wave sub-mode: linear = directional parallel bands (the original wave);
    // ring = concentric radial rings emanating from center_x/center_y.
    {
      name: "wave_mode",
      label: "Sub-mode",
      type: "enum",
      options: ["linear", "ring"],
      default: "linear",
      visibleIf: (p) => p.mode === "wave",
    },
    { name: "color_a", label: "Color A", type: "color", default: "#000000" },
    { name: "color_b", label: "Color B", type: "color", default: "#ffffff" },

    // Linear gradient endpoints (UV, Y-up). Driven by the on-canvas handles
    // (two draggable points joined by a line) and keyframable here. A legacy
    // `angle`-only gradient is migrated into these on load (see project.ts).
    {
      name: "start_x",
      label: "Start X",
      type: "scalar",
      min: -0.5,
      max: 1.5,
      softMax: 1,
      step: 0.001,
      default: 0,
      visibleIf: (p) => p.mode === "linear",
    },
    {
      name: "start_y",
      label: "Start Y",
      type: "scalar",
      min: -0.5,
      max: 1.5,
      softMax: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.mode === "linear",
    },
    {
      name: "end_x",
      label: "End X",
      type: "scalar",
      min: -0.5,
      max: 1.5,
      softMax: 1,
      step: 0.001,
      default: 1,
      visibleIf: (p) => p.mode === "linear",
    },
    {
      name: "end_y",
      label: "End Y",
      type: "scalar",
      min: -0.5,
      max: 1.5,
      softMax: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.mode === "linear",
    },

    {
      name: "angle",
      label: "Angle (°)",
      type: "scalar",
      min: 0,
      max: 360,
      step: 1,
      default: 0,
      // Angle only drives the linear wave sub-mode; ring waves are radial.
      visibleIf: (p) =>
        p.mode === "wave" && (p.wave_mode ?? "linear") !== "ring",
    },
    {
      name: "angle_mod_amount",
      label: "Angle mod (°)",
      type: "scalar",
      min: -360,
      max: 360,
      step: 1,
      default: 0,
      visibleIf: (p) =>
        p.mode === "linear" ||
        (p.mode === "wave" && (p.wave_mode ?? "linear") !== "ring"),
    },

    {
      name: "center_x",
      label: "Center X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) =>
        p.mode === "radial" ||
        p.mode === "polar" ||
        (p.mode === "wave" && (p.wave_mode ?? "linear") === "ring"),
    },
    {
      name: "center_y",
      label: "Center Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) =>
        p.mode === "radial" ||
        p.mode === "polar" ||
        (p.mode === "wave" && (p.wave_mode ?? "linear") === "ring"),
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

    // Phase animation. When on, the wave's phase is driven internally from
    // scene time around a closed loop [start, end] (frames): over one window
    // the phase advances `rate` full cycles, then wraps — seamless when rate
    // is a whole number (same loopEvolutionPhase mechanism as looping noise).
    // The static Phase above becomes the starting offset. Works in both wave
    // sub-modes.
    {
      name: "phase_animate",
      label: "Animate phase",
      type: "boolean",
      default: false,
      visibleIf: (p) => p.mode === "wave",
    },
    {
      name: "phase_start",
      label: "Start (frame)",
      type: "scalar",
      min: 0,
      max: 100000,
      softMax: 300,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "wave" && p.phase_animate === true,
    },
    {
      name: "phase_end",
      label: "End (frame)",
      type: "scalar",
      min: 1,
      max: 100000,
      softMax: 300,
      step: 1,
      default: 120,
      visibleIf: (p) => p.mode === "wave" && p.phase_animate === true,
    },
    {
      name: "phase_rate",
      label: "Rate (cycles/loop)",
      type: "scalar",
      min: 0,
      max: 20,
      softMax: 8,
      step: 1,
      default: 1,
      visibleIf: (p) => p.mode === "wave" && p.phase_animate === true,
    },

    // Multipoint: N color points blended by inverse-distance weighting.
    // The array isn't keyframable, but each point's x/y/color animate via
    // virtual keys (see conventions.ts gpoint_*). Authored on-canvas (dots)
    // and in the panel; positions are UV, Y-up.
    {
      name: "points",
      label: "Points",
      type: "gradient_points",
      default: [
        { id: "gp-a", x: 0.25, y: 0.7, color: "#ef4444" },
        { id: "gp-b", x: 0.75, y: 0.7, color: "#22c55e" },
        { id: "gp-c", x: 0.5, y: 0.25, color: "#3b82f6" },
      ] as GradientPoint[],
      visibleIf: (p) => p.mode === "multipoint",
    },
    {
      name: "idw_power",
      label: "Falloff",
      type: "scalar",
      min: 0.5,
      max: 8,
      softMax: 6,
      step: 0.1,
      default: 2,
      visibleIf: (p) => p.mode === "multipoint",
    },

    {
      name: "softness",
      label: "Softness",
      type: "scalar",
      min: 0.1,
      max: 3,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.mode !== "multipoint",
    },
    {
      name: "alpha",
      label: "Alpha",
      type: "scalar",
      min: 0,
      max: 1,
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

  // Recompute every frame only while the wave phase is animating; otherwise
  // stay cached as a static generator.
  fingerprintExtras(params, ctx) {
    return params.mode === "wave" && params.phase_animate
      ? `phaseanim:${ctx.tick}`
      : "";
  },

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const mode = modeToInt((params.mode as string) ?? "linear");
    const [ar, ag, ab] = hexToRgb((params.color_a as string) ?? "#000000");
    const [br, bg, bb] = hexToRgb((params.color_b as string) ?? "#ffffff");
    const angleDeg = (params.angle as number) ?? 0;
    const startX = (params.start_x as number) ?? 0;
    const startY = (params.start_y as number) ?? 0.5;
    const endX = (params.end_x as number) ?? 1;
    const endY = (params.end_y as number) ?? 0.5;
    const cx = (params.center_x as number) ?? 0.5;
    const cy = (params.center_y as number) ?? 0.5;
    const radius = (params.radius as number) ?? 0.5;
    const angleOffsetDeg = (params.angle_offset as number) ?? 0;
    const frequency = (params.frequency as number) ?? 4;
    const phaseDeg = (params.phase as number) ?? 0;
    const softness = (params.softness as number) ?? 1;
    const alpha = (params.alpha as number) ?? 1;
    const angleModAmountDeg = (params.angle_mod_amount as number) ?? 0;
    const waveRing =
      ((params.wave_mode as string) ?? "linear") === "ring" ? 1 : 0;
    const aspect = ctx.height > 0 ? ctx.width / ctx.height : 1;

    // Phase in radians: the static param is the base offset; when phase
    // animation is on, add the loop's swept phase (rate full turns per
    // [start, end] window) so the wave scrolls and loops seamlessly.
    let phaseRad = (phaseDeg * Math.PI) / 180;
    if ((params.phase_animate as boolean) ?? false) {
      const pStart = (params.phase_start as number) ?? 0;
      const pEnd = (params.phase_end as number) ?? 120;
      const pRate = (params.phase_rate as number) ?? 1;
      const frameNow = ctx.tick / ctx.ticksPerFrame;
      phaseRad +=
        loopEvolutionPhase(frameNow, pStart, pEnd) * pRate * 2 * Math.PI;
    }

    // Multipoint: flatten the (keyframe-resolved) points into padded uniform
    // arrays. Colors arrive as hex (stored) or RGBA tuples (keyframed).
    const rawPoints = Array.isArray(params.points)
      ? (params.points as GradientPoint[])
      : [];
    const ptCount = Math.min(rawPoints.length, MAX_POINTS);
    const ptPos = new Float32Array(MAX_POINTS * 2);
    const ptCol = new Float32Array(MAX_POINTS * 3);
    for (let i = 0; i < ptCount; i++) {
      const p = rawPoints[i];
      ptPos[i * 2] = (p.x as number) ?? 0.5;
      ptPos[i * 2 + 1] = (p.y as number) ?? 0.5;
      const [r, g, b] = pointColorToRgb(p.color);
      ptCol[i * 3] = r;
      ptCol[i * 3 + 1] = g;
      ptCol[i * 3 + 2] = b;
    }
    const idwPower = (params.idw_power as number) ?? 2;

    const angleMod = inputs.angle_mod;
    const modTex: WebGLTexture =
      angleMod && angleMod.kind === "image"
        ? (angleMod as ImageValue).texture
        : getZeroTex(ctx.gl, ctx.state, nodeId);
    const hasMod = angleMod && angleMod.kind === "image" ? 1 : 0;

    const uvIn = inputs.uv_in;
    let uvInMode = 0;
    let uvInTex: WebGLTexture = getZeroTex(ctx.gl, ctx.state, nodeId);
    let uvConst: [number, number] = [0, 0];
    if (uvIn) {
      if (uvIn.kind === "uv") {
        uvInMode = 1;
        uvInTex = (uvIn as UvValue).texture;
      } else if (uvIn.kind === "scalar") {
        uvInMode = 2;
        uvConst = [uvIn.value, uvIn.value];
      }
    }

    const prog = ctx.getShader("gradient/fs", FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), mode);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorA"), ar, ag, ab);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorB"), br, bg, bb);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_angle"),
        (angleDeg * Math.PI) / 180
      );
      gl.uniform2f(gl.getUniformLocation(prog, "u_start"), startX, startY);
      gl.uniform2f(gl.getUniformLocation(prog, "u_end"), endX, endY);
      gl.uniform2f(gl.getUniformLocation(prog, "u_center"), cx, cy);
      gl.uniform1f(gl.getUniformLocation(prog, "u_radius"), radius);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_angleOffset"),
        (angleOffsetDeg * Math.PI) / 180
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_frequency"), frequency);
      gl.uniform1f(gl.getUniformLocation(prog, "u_phase"), phaseRad);
      gl.uniform1i(gl.getUniformLocation(prog, "u_waveRing"), waveRing);
      gl.uniform1f(gl.getUniformLocation(prog, "u_aspect"), aspect);
      gl.uniform1f(gl.getUniformLocation(prog, "u_softness"), softness);
      gl.uniform1f(gl.getUniformLocation(prog, "u_alpha"), alpha);

      gl.uniform1i(gl.getUniformLocation(prog, "u_hasAngleMod"), hasMod);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_angleModAmount"),
        (angleModAmountDeg * Math.PI) / 180
      );
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, modTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_angleMod"), 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, uvInTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_uvIn"), 1);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasUvIn"), uvInMode);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_uvConst"),
        uvConst[0],
        uvConst[1]
      );

      gl.uniform1i(gl.getUniformLocation(prog, "u_ptCount"), ptCount);
      gl.uniform2fv(gl.getUniformLocation(prog, "u_ptPos"), ptPos);
      gl.uniform3fv(gl.getUniformLocation(prog, "u_ptCol"), ptCol);
      gl.uniform1f(gl.getUniformLocation(prog, "u_idwPower"), idwPower);
    });

    return { primary: output };
  },
};
