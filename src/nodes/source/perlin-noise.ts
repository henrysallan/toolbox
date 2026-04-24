import type { NodeDefinition, UvValue } from "@/engine/types";
import {
  disposePlaceholderTex,
  getPlaceholderTex,
} from "@/engine/placeholder-tex";

// Unified multi-algorithm noise source. `type` selects a lattice/gradient
// scheme; fBm + shaping params wrap all of them so visual tuning carries
// between types. The "perlin-deriv" / "flow" / "curl" types expose extra
// contextual controls via visibleIf.
//
// Implementations ordered by fidelity to their canonical references:
//   perlin         — Ashima cnoise (improved Perlin, quintic fade)
//   simplex        — Ashima snoise
//   value          — cubic-interpolated hashed lattice
//   opensimplex    — KdotJPG-flavored, skewed triangular lattice
//   opensimplex2   — OS2 "fast" variant
//   opensimplex2s  — OS2 "smooth" variant (wider kernel, more samples)
//   super-simplex  — Super Simplex (6-point blended samples)
//   perlin-deriv   — Perlin returning (value, ∂/∂x, ∂/∂y); output visualizes value
//   flow           — Perlin with gradients rotated by u_flowTime per cell
//   curl           — 2D curl of stream-function Perlin (outputs vec2 as RG)
//
// NOTE: opensimplex / os2 / os2s / super-simplex in this pipeline are
// pragmatic GLSL adaptations — they produce visually distinct results
// but aren't byte-exact ports of KdotJPG's reference Java.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform int   u_type;
uniform float u_scale;
uniform int   u_octaves;
uniform float u_persistence;
uniform float u_lacunarity;
uniform vec2  u_offset;
uniform float u_seed;
uniform float u_contrast;
uniform vec3  u_colorA;
uniform vec3  u_colorB;
uniform float u_alpha;
uniform float u_flowTime;
uniform int u_hasUvIn;
uniform sampler2D u_uvIn;
uniform vec2 u_uvConst;
out vec4 outColor;

// ── shared helpers ──────────────────────────────────────────────────────
vec3 mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289v2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289v4(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute3(vec3 x) { return mod289v3(((x * 34.0) + 1.0) * x); }
vec4 permute4(vec4 x) { return mod289v4(((x * 34.0) + 1.0) * x); }

// Hash vec2 → pseudo-random unit gradient vector. Good enough for visual
// noise; used by perlinDeriv, flow, curl, and the OS family.
vec2 hashGrad(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return normalize(-1.0 + 2.0 * fract(sin(p) * 43758.5453123));
}

// ── simplex (Ashima snoise) ─────────────────────────────────────────────
float snoise(vec2 v) {
  const vec4 C = vec4(
    0.211324865405187, 0.366025403784439,
    -0.577350269189626, 0.024390243902439
  );
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289v2(i);
  vec3 p = permute3(
    permute3(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0)
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

// ── perlin (improved) ───────────────────────────────────────────────────
vec2 fade2(vec2 t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}
float cnoise(vec2 P) {
  vec4 Pi = floor(P.xyxy) + vec4(0.0, 0.0, 1.0, 1.0);
  vec4 Pf = fract(P.xyxy) - vec4(0.0, 0.0, 1.0, 1.0);
  Pi = mod(Pi, 289.0);
  vec4 ix = Pi.xzxz;
  vec4 iy = Pi.yyww;
  vec4 fx = Pf.xzxz;
  vec4 fy = Pf.yyww;
  vec4 ii = permute4(permute4(ix) + iy);
  vec4 gx = 2.0 * fract(ii * (1.0 / 41.0)) - 1.0;
  vec4 gy = abs(gx) - 0.5;
  vec4 tx = floor(gx + 0.5);
  gx = gx - tx;
  vec2 g00 = vec2(gx.x, gy.x);
  vec2 g10 = vec2(gx.y, gy.y);
  vec2 g01 = vec2(gx.z, gy.z);
  vec2 g11 = vec2(gx.w, gy.w);
  vec4 norm = 1.79284291400159 - 0.85373472095314 *
    vec4(dot(g00, g00), dot(g01, g01), dot(g10, g10), dot(g11, g11));
  g00 *= norm.x; g01 *= norm.y; g10 *= norm.z; g11 *= norm.w;
  float n00 = dot(g00, vec2(fx.x, fy.x));
  float n10 = dot(g10, vec2(fx.y, fy.y));
  float n01 = dot(g01, vec2(fx.z, fy.z));
  float n11 = dot(g11, vec2(fx.w, fy.w));
  vec2 f = fade2(Pf.xy);
  vec2 n_x = mix(vec2(n00, n01), vec2(n10, n11), f.x);
  return 2.3 * mix(n_x.x, n_x.y, f.y);
}

// ── value noise ─────────────────────────────────────────────────────────
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 P) {
  vec2 i = floor(P);
  vec2 f = fract(P);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

// ── OpenSimplex 2D (skewed triangular lattice, unit-vector gradients) ──
// Skew/unskew constants from the 2D simplex derivation.
const float OS_F = 0.366025403784439;
const float OS_G = 0.211324865405187;

float osNoise(vec2 p) {
  vec2 skewed = p + (p.x + p.y) * OS_F;
  vec2 i0 = floor(skewed);
  vec2 f0 = skewed - i0;
  vec2 o1 = (f0.x > f0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 i1 = i0 + o1;
  vec2 i2 = i0 + vec2(1.0);
  vec2 p0 = p - (i0 - (i0.x + i0.y) * OS_G);
  vec2 p1 = p - (i1 - (i1.x + i1.y) * OS_G);
  vec2 p2 = p - (i2 - (i2.x + i2.y) * OS_G);
  float t0 = 0.5 - dot(p0, p0);
  float t1 = 0.5 - dot(p1, p1);
  float t2 = 0.5 - dot(p2, p2);
  t0 = max(t0, 0.0); t1 = max(t1, 0.0); t2 = max(t2, 0.0);
  t0 *= t0; t0 *= t0;
  t1 *= t1; t1 *= t1;
  t2 *= t2; t2 *= t2;
  float n0 = t0 * dot(hashGrad(i0), p0);
  float n1 = t1 * dot(hashGrad(i1), p1);
  float n2 = t2 * dot(hashGrad(i2), p2);
  return 60.0 * (n0 + n1 + n2);
}

// ── OpenSimplex2 "fast" — similar lattice, 4-point kernel ─────────────
float os2Noise(vec2 p) {
  vec2 skewed = p + (p.x + p.y) * OS_F;
  vec2 i0 = floor(skewed);
  vec2 f0 = skewed - i0;
  bool aboveDiag = f0.x > f0.y;
  vec2 o1 = aboveDiag ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  // Fourth point on the opposite corner of the quadrilateral.
  vec2 o3 = aboveDiag ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
  vec2 i1 = i0 + o1;
  vec2 i2 = i0 + vec2(1.0);
  vec2 i3 = i0 + o3;
  vec2 p0 = p - (i0 - (i0.x + i0.y) * OS_G);
  vec2 p1 = p - (i1 - (i1.x + i1.y) * OS_G);
  vec2 p2 = p - (i2 - (i2.x + i2.y) * OS_G);
  vec2 p3 = p - (i3 - (i3.x + i3.y) * OS_G);
  float r = 0.6;
  float t0 = max(r - dot(p0, p0), 0.0);
  float t1 = max(r - dot(p1, p1), 0.0);
  float t2 = max(r - dot(p2, p2), 0.0);
  float t3 = max(r - dot(p3, p3), 0.0);
  t0 *= t0 * t0 * t0;
  t1 *= t1 * t1 * t1;
  t2 *= t2 * t2 * t2;
  t3 *= t3 * t3 * t3;
  float n0 = t0 * dot(hashGrad(i0), p0);
  float n1 = t1 * dot(hashGrad(i1), p1);
  float n2 = t2 * dot(hashGrad(i2), p2);
  float n3 = t3 * dot(hashGrad(i3), p3);
  return 32.0 * (n0 + n1 + n2 + n3);
}

// ── OpenSimplex2S "smooth" — 6-point, wider kernel ──────────────────────
float os2sNoise(vec2 p) {
  vec2 skewed = p + (p.x + p.y) * OS_F;
  vec2 i0 = floor(skewed);
  vec2 f0 = skewed - i0;
  vec2 p0 = p - (i0 - (i0.x + i0.y) * OS_G);

  // Six neighboring lattice points for a smoother blend.
  vec2 offsets[6];
  offsets[0] = vec2(0.0, 0.0);
  offsets[1] = vec2(1.0, 0.0);
  offsets[2] = vec2(0.0, 1.0);
  offsets[3] = vec2(1.0, 1.0);
  offsets[4] = vec2(-1.0, 1.0);
  offsets[5] = vec2(1.0, -1.0);

  float total = 0.0;
  float r = 2.0 / 3.0;
  for (int k = 0; k < 6; k++) {
    vec2 ik = i0 + offsets[k];
    vec2 pk = p - (ik - (ik.x + ik.y) * OS_G);
    float t = max(r - dot(pk, pk), 0.0);
    t *= t; t *= t;
    total += t * dot(hashGrad(ik), pk);
  }
  return 18.5 * total;
}

// ── Super Simplex — variant with wider-overlap kernel ──────────────────
float ssNoise(vec2 p) {
  vec2 skewed = p + (p.x + p.y) * OS_F;
  vec2 i0 = floor(skewed);
  vec2 f0 = skewed - i0;
  // Triangular lattice primary + two extended neighbors based on which
  // triangle we're in.
  bool aboveDiag = f0.x > f0.y;
  vec2 o1 = aboveDiag ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 o2 = aboveDiag ? vec2(1.0, -1.0) : vec2(-1.0, 1.0);

  vec2 offsets[5];
  offsets[0] = vec2(0.0);
  offsets[1] = o1;
  offsets[2] = vec2(1.0);
  offsets[3] = o2;
  offsets[4] = aboveDiag ? vec2(2.0, 0.0) : vec2(0.0, 2.0);

  float total = 0.0;
  float r = 0.75;
  for (int k = 0; k < 5; k++) {
    vec2 ik = i0 + offsets[k];
    vec2 pk = p - (ik - (ik.x + ik.y) * OS_G);
    float t = max(r - dot(pk, pk), 0.0);
    t *= t; t *= t;
    total += t * dot(hashGrad(ik), pk);
  }
  return 20.0 * total;
}

// ── Perlin with analytical derivatives (Iñigo Quilez formulation) ─────
// Returns vec3(value, ∂val/∂x, ∂val/∂y). Basis for flow + curl noise.
vec3 perlinDeriv(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u  = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

  vec2 ga = hashGrad(i + vec2(0.0, 0.0));
  vec2 gb = hashGrad(i + vec2(1.0, 0.0));
  vec2 gc = hashGrad(i + vec2(0.0, 1.0));
  vec2 gd = hashGrad(i + vec2(1.0, 1.0));

  float va = dot(ga, f - vec2(0.0, 0.0));
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));

  float value = va
    + u.x * (vb - va)
    + u.y * (vc - va)
    + u.x * u.y * (va - vb - vc + vd);

  vec2 deriv =
    ga
    + u.x * (gb - ga)
    + u.y * (gc - ga)
    + u.x * u.y * (ga - gb - gc + gd)
    + du * vec2(
        u.y * (va - vb - vc + vd) + (vb - va),
        u.x * (va - vb - vc + vd) + (vc - va)
      );

  return vec3(value, deriv);
}

// ── Flow noise — Perlin with per-cell gradient rotation by u_flowTime ─
float flowNoise(vec2 p, float t) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  // Per-cell angle offset from a second hash, so every lattice cell spins
  // at a subtly different rate — avoids the whole field spinning in lockstep.
  float ta = fract(sin(dot(i,                    vec2(127.1, 311.7))) * 43758.5) * 6.2831853;
  float tb = fract(sin(dot(i + vec2(1.0, 0.0),   vec2(127.1, 311.7))) * 43758.5) * 6.2831853;
  float tc = fract(sin(dot(i + vec2(0.0, 1.0),   vec2(127.1, 311.7))) * 43758.5) * 6.2831853;
  float td = fract(sin(dot(i + vec2(1.0, 1.0),   vec2(127.1, 311.7))) * 43758.5) * 6.2831853;

  vec2 ga = vec2(cos(ta + t), sin(ta + t));
  vec2 gb = vec2(cos(tb + t), sin(tb + t));
  vec2 gc = vec2(cos(tc + t), sin(tc + t));
  vec2 gd = vec2(cos(td + t), sin(td + t));

  float va = dot(ga, f - vec2(0.0, 0.0));
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));

  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y);
}

// ── dispatch for scalar-output types ───────────────────────────────────
float sampleNoise(vec2 p) {
  if (u_type == 0) return cnoise(p);
  if (u_type == 1) return snoise(p);
  if (u_type == 2) return vnoise(p);
  if (u_type == 3) return osNoise(p);
  if (u_type == 4) return os2Noise(p);
  if (u_type == 5) return os2sNoise(p);
  if (u_type == 6) return ssNoise(p);
  if (u_type == 7) return perlinDeriv(p).x;
  if (u_type == 8) return flowNoise(p, u_flowTime);
  return 0.0;
}

float fbm(vec2 p) {
  float total = 0.0;
  float amp = 1.0;
  float freq = 1.0;
  float maxAmp = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_octaves) break;
    total += sampleNoise(p * freq) * amp;
    maxAmp += amp;
    amp *= u_persistence;
    freq *= u_lacunarity;
  }
  return total / max(maxAmp, 0.0001);
}

// Curl uses perlinDeriv per-octave and takes the curl of the summed field.
// 2D curl of a stream function ψ: v = (∂ψ/∂y, -∂ψ/∂x).
vec2 curlFbm(vec2 p) {
  vec2 total = vec2(0.0);
  float amp = 1.0;
  float freq = 1.0;
  float maxAmp = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_octaves) break;
    vec3 d = perlinDeriv(p * freq);
    // Scale derivatives by freq because derivatives chain through frequency.
    total += vec2(d.z, -d.y) * amp;
    maxAmp += amp;
    amp *= u_persistence;
    freq *= u_lacunarity;
  }
  return total / max(maxAmp, 0.0001);
}

void main() {
  vec2 uv;
  if (u_hasUvIn == 1) uv = texture(u_uvIn, v_uv).rg;
  else if (u_hasUvIn == 2) uv = u_uvConst;
  else uv = v_uv;

  vec2 seedOffset = vec2(u_seed * 127.1, u_seed * 311.7);
  vec2 p = (uv - 0.5) * u_scale + u_offset + seedOffset;

  // Curl outputs a vec2; pack into R/G at 0.5-centered encoding so it
  // visualizes cleanly AND downstream Displace (with channel R/G) sees a
  // signed vector. B stays 0; alpha honors user setting.
  if (u_type == 9) {
    vec2 v = curlFbm(p);
    v = clamp(v * u_contrast, -1.0, 1.0);
    outColor = vec4(v * 0.5 + 0.5, 0.0, u_alpha);
    return;
  }

  float n = fbm(p);
  float t = n * 0.5 + 0.5;
  t = clamp(0.5 + (t - 0.5) * u_contrast, 0.0, 1.0);
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

const NOISE_TYPES = [
  "perlin",
  "simplex",
  "value",
  "opensimplex",
  "opensimplex2",
  "opensimplex2s",
  "super-simplex",
  "perlin-deriv",
  "flow",
  "curl",
] as const;

function noiseTypeToInt(t: string): number {
  switch (t) {
    case "perlin":
      return 0;
    case "simplex":
      return 1;
    case "value":
      return 2;
    case "opensimplex":
      return 3;
    case "opensimplex2":
      return 4;
    case "opensimplex2s":
      return 5;
    case "super-simplex":
      return 6;
    case "perlin-deriv":
      return 7;
    case "flow":
      return 8;
    case "curl":
      return 9;
    default:
      return 1;
  }
}

export const perlinNoiseNode: NodeDefinition = {
  type: "noise",
  name: "Noise",
  category: "image",
  subcategory: "generator",
  description:
    "Multi-algorithm fBm noise: Perlin / Simplex / Value / OpenSimplex family / Perlin Derivatives / Flow / Curl. Curl outputs a 2D vector encoded in R and G — feed into Displace for motion.",
  backend: "webgl2",
  inputs: [{ name: "uv_in", label: "UV", type: "uv", required: false }],
  params: [
    {
      name: "type",
      label: "Type",
      type: "enum",
      options: NOISE_TYPES as unknown as string[],
      default: "simplex",
    },
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
    // Flow noise — only meaningful when type=flow. Rotation accumulates
    // over time; expose + connect Scene Time to animate.
    {
      name: "flow_time",
      label: "Flow Time",
      type: "scalar",
      min: -100,
      max: 100,
      softMax: 20,
      step: 0.01,
      default: 0,
      visibleIf: (p) => p.type === "flow",
    },
    {
      name: "color_a",
      label: "Color A (low)",
      type: "color",
      default: "#000000",
      visibleIf: (p) => p.type !== "curl",
    },
    {
      name: "color_b",
      label: "Color B (high)",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => p.type !== "curl",
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

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const typeInt = noiseTypeToInt((params.type as string) ?? "simplex");
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
    const flowTime = (params.flow_time as number) ?? 0;
    const [ar, ag, ab] = hexToRgb((params.color_a as string) ?? "#000000");
    const [br, bg, bb] = hexToRgb((params.color_b as string) ?? "#ffffff");
    const alpha = (params.alpha as number) ?? 1;

    const uvIn = inputs.uv_in;
    const placeholderKey = `perlin-noise:${nodeId}:zero`;
    let uvInMode = 0;
    let uvInTex: WebGLTexture = getPlaceholderTex(
      ctx.gl,
      ctx.state,
      placeholderKey
    );
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

    const prog = ctx.getShader("noise/fs", FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.uniform1i(gl.getUniformLocation(prog, "u_type"), typeInt);
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
      gl.uniform1f(gl.getUniformLocation(prog, "u_flowTime"), flowTime);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorA"), ar, ag, ab);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorB"), br, bg, bb);
      gl.uniform1f(gl.getUniformLocation(prog, "u_alpha"), alpha);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, uvInTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_uvIn"), 0);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasUvIn"), uvInMode);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_uvConst"),
        uvConst[0],
        uvConst[1]
      );
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    disposePlaceholderTex(ctx.gl, ctx.state, `perlin-noise:${nodeId}:zero`);
  },
};
