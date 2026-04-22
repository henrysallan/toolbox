import type { NodeDefinition } from "@/engine/types";

export interface ColorRampStop {
  id: string;
  position: number; // 0..1
  color: string;    // hex, e.g. "#ff00aa"
}

export const COLOR_RAMP_MAX_STOPS = 16;

export function newStopId(): string {
  return `stop-${Math.random().toString(36).slice(2, 8)}`;
}

// Stops are uploaded into fixed-size uniform arrays. The shader walks the
// sorted stops to find the bracket around the input factor and interpolates
// between them according to the interpolation mode.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform int u_stopCount;
uniform float u_positions[${COLOR_RAMP_MAX_STOPS}];
uniform vec4  u_colors[${COLOR_RAMP_MAX_STOPS}];
uniform int u_interp; // 0: linear, 1: ease, 2: constant
out vec4 outColor;

vec4 sampleRamp(float t) {
  if (u_stopCount == 0) return vec4(t, t, t, 1.0);
  if (u_stopCount == 1) return u_colors[0];
  if (t <= u_positions[0]) return u_colors[0];
  if (t >= u_positions[u_stopCount - 1]) return u_colors[u_stopCount - 1];

  for (int i = 0; i < ${COLOR_RAMP_MAX_STOPS - 1}; i++) {
    if (i + 1 >= u_stopCount) break;
    float a = u_positions[i];
    float b = u_positions[i + 1];
    if (t >= a && t <= b) {
      float f = (t - a) / max(b - a, 0.0001);
      if (u_interp == 2) return u_colors[i];            // constant (left)
      if (u_interp == 1) f = smoothstep(0.0, 1.0, f);   // ease
      return mix(u_colors[i], u_colors[i + 1], f);
    }
  }
  return u_colors[u_stopCount - 1];
}

void main() {
  vec4 c = texture(u_src, v_uv);
  float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  outColor = sampleRamp(clamp(lum, 0.0, 1.0));
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

function interpToInt(m: string): number {
  switch (m) {
    case "linear": return 0;
    case "ease": return 1;
    case "constant": return 2;
    default: return 0;
  }
}

export const colorRampNode: NodeDefinition = {
  type: "color-ramp",
  name: "Color Ramp",
  category: "effect",
  description:
    "Remaps the input's luminance through a gradient of user-defined color stops.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "stops",
      label: "Ramp",
      type: "color_ramp",
      default: [
        { id: "stop-a", position: 0, color: "#000000" },
        { id: "stop-b", position: 1, color: "#ffffff" },
      ] as ColorRampStop[],
    },
    {
      name: "interpolation",
      label: "Interpolation",
      type: "enum",
      options: ["linear", "ease", "constant"],
      default: "linear",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const src = inputs["image"];
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output };
    }

    const rawStops = Array.isArray(params.stops)
      ? (params.stops as ColorRampStop[])
      : [];
    const sorted = [...rawStops]
      .filter((s) => typeof s.position === "number")
      .sort((a, b) => a.position - b.position)
      .slice(0, COLOR_RAMP_MAX_STOPS);

    const positions = new Float32Array(COLOR_RAMP_MAX_STOPS);
    const colors = new Float32Array(COLOR_RAMP_MAX_STOPS * 4);
    for (let i = 0; i < sorted.length; i++) {
      positions[i] = Math.max(0, Math.min(1, sorted[i].position));
      const [r, g, b] = hexToRgb(sorted[i].color ?? "#000000");
      colors[i * 4 + 0] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = 1;
    }

    const interp = interpToInt((params.interpolation as string) ?? "linear");

    const prog = ctx.getShader("color-ramp/fs", FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform1i(
        gl.getUniformLocation(prog, "u_stopCount"),
        sorted.length
      );
      gl.uniform1fv(
        gl.getUniformLocation(prog, "u_positions[0]"),
        positions
      );
      gl.uniform4fv(gl.getUniformLocation(prog, "u_colors[0]"), colors);
      gl.uniform1i(gl.getUniformLocation(prog, "u_interp"), interp);
    });

    return { primary: output };
  },
};
