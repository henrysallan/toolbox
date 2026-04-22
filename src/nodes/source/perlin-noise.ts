import type { NodeDefinition } from "@/engine/types";

// 2D simplex noise (Ashima Arts / Stefan Gustavson, public domain).
// Wrapped in fBm with up to 8 octaves. Output is mapped between the two
// user-facing colors for immediate visual feedback.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform float u_scale;
uniform int   u_octaves;
uniform float u_persistence;
uniform float u_lacunarity;
uniform vec2  u_offset;
uniform float u_seed;
uniform float u_contrast;
uniform vec3  u_colorA;
uniform vec3  u_colorB;
out vec4 outColor;

vec3 mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289v2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289v3(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(
    0.211324865405187,
    0.366025403784439,
   -0.577350269189626,
    0.024390243902439
  );
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289v2(i);
  vec3 p = permute(
    permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0)
  );
  vec3 m = max(
    0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)),
    0.0
  );
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float fbm(vec2 p) {
  float total = 0.0;
  float amp = 1.0;
  float freq = 1.0;
  float maxAmp = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_octaves) break;
    total += snoise(p * freq) * amp;
    maxAmp += amp;
    amp *= u_persistence;
    freq *= u_lacunarity;
  }
  return total / max(maxAmp, 0.0001);
}

void main() {
  // Derive a deterministic 2D offset from the seed so different seed values
  // produce uncorrelated-looking fields.
  vec2 seedOffset = vec2(
    u_seed * 127.1,
    u_seed * 311.7
  );
  vec2 p = (v_uv - 0.5) * u_scale + u_offset + seedOffset;

  float n = fbm(p);                       // roughly [-1, 1]
  float t = n * 0.5 + 0.5;                // map to [0, 1]
  // Contrast curve around the midpoint.
  t = clamp(0.5 + (t - 0.5) * u_contrast, 0.0, 1.0);

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

export const perlinNoiseNode: NodeDefinition = {
  type: "perlin-noise",
  name: "Perlin Noise",
  category: "source",
  description:
    "Fractal simplex noise with adjustable scale, octaves, persistence and lacunarity.",
  backend: "webgl2",
  inputs: [],
  params: [
    {
      name: "scale",
      label: "Scale",
      type: "scalar",
      min: 0.1,
      max: 40,
      step: 0.1,
      default: 4,
    },
    {
      name: "octaves",
      label: "Octaves",
      type: "scalar",
      min: 1,
      max: 8,
      step: 1,
      default: 4,
    },
    {
      name: "persistence",
      label: "Persistence",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "lacunarity",
      label: "Lacunarity",
      type: "scalar",
      min: 1,
      max: 4,
      step: 0.01,
      default: 2,
    },
    {
      name: "offset_x",
      label: "Offset X",
      type: "scalar",
      min: -50,
      max: 50,
      step: 0.01,
      default: 0,
    },
    {
      name: "offset_y",
      label: "Offset Y",
      type: "scalar",
      min: -50,
      max: 50,
      step: 0.01,
      default: 0,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 1000,
      step: 1,
      default: 0,
    },
    {
      name: "contrast",
      label: "Contrast",
      type: "scalar",
      min: 0.1,
      max: 5,
      step: 0.01,
      default: 1,
    },
    {
      name: "color_a",
      label: "Color A (low)",
      type: "color",
      default: "#000000",
    },
    {
      name: "color_b",
      label: "Color B (high)",
      type: "color",
      default: "#ffffff",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ params, ctx }) {
    const output = ctx.allocImage();
    const scale = (params.scale as number) ?? 4;
    const octaves = Math.max(
      1,
      Math.min(8, Math.round((params.octaves as number) ?? 4))
    );
    const persistence = (params.persistence as number) ?? 0.5;
    const lacunarity = (params.lacunarity as number) ?? 2;
    const offX = (params.offset_x as number) ?? 0;
    const offY = (params.offset_y as number) ?? 0;
    const seed = (params.seed as number) ?? 0;
    const contrast = (params.contrast as number) ?? 1;
    const [ar, ag, ab] = hexToRgb((params.color_a as string) ?? "#000000");
    const [br, bg, bb] = hexToRgb((params.color_b as string) ?? "#ffffff");

    const prog = ctx.getShader("perlin-noise/fs", FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.uniform1f(gl.getUniformLocation(prog, "u_scale"), scale);
      gl.uniform1i(gl.getUniformLocation(prog, "u_octaves"), octaves);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_persistence"),
        persistence
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_lacunarity"), lacunarity);
      gl.uniform2f(gl.getUniformLocation(prog, "u_offset"), offX, offY);
      gl.uniform1f(gl.getUniformLocation(prog, "u_seed"), seed);
      gl.uniform1f(gl.getUniformLocation(prog, "u_contrast"), contrast);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorA"), ar, ag, ab);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorB"), br, bg, bb);
    });

    return { primary: output };
  },
};
