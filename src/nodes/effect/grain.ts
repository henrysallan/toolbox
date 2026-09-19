import type { ImageValue, NodeDefinition, RenderContext } from "@/engine/types";
import { PCG3D_GLSL } from "@/engine/voronoi-geometry";
import {
  GRAIN_AR_BLOCK,
  GRAIN_AR_SEAM,
  GRAIN_AR_TEMPLATE,
  GRAIN_BANDING_AXES,
  GRAIN_BLUR_MAX_TAPS,
  GRAIN_DISTRIBUTIONS,
  GRAIN_FILM_SLOTS,
  GRAIN_FIXED_FRAME,
  GRAIN_KERNELS,
  GRAIN_LOG_OFFSET,
  GRAIN_LOG_RANGE,
  GRAIN_LUT_SIZE,
  GRAIN_MAX_OCTAVES,
  GRAIN_MAX_SMOOTHNESS,
  GRAIN_MAX_SOFTNESS,
  GRAIN_MAX_TAPS,
  GRAIN_MODELS,
  GRAIN_MOTIONS,
  GRAIN_PRESETS,
  GRAIN_QUALITIES,
  GRAIN_RESPONSE_PRESETS,
  GRAIN_SIZE_UNITS,
  GRAIN_SPACES,
  buildGrainArTemplate,
  buildGrainResponseLut,
  defaultGrainResponseCurve,
  grainArCoefficients,
  grainBlotchWeights,
  grainBlurWeights,
  grainCellPx,
  grainDistributionIndex,
  grainDriftOffset,
  grainFilmParams,
  grainFrameNow,
  grainKernel,
  grainLoopPeriod,
  grainOctaveSeed,
  grainOctaveWeights,
  grainQualityDivisor,
  grainRate,
  grainResolveLook,
  grainResponseCurve,
  grainResponseKey,
  grainSensorWeights,
  grainSizeUnitIsMicrons,
  grainSpaceGain,
  grainSpaceIndex,
  grainTime,
  grainTimeKey,
  normalizeGrainKernelMode,
  normalizeGrainMotion,
  normalizeGrainPreset,
} from "@/engine/grain";

// Procedural grain. Spec: specdocs/091626_grain-node-v2.md.
//
// Models behind one `model` enum:
//
//   classic — the original node, kept verbatim for saved projects (they
//             migrate to it in lib/project.ts): float hash per floor-
//             quantised cell, a triangular "Gaussian", `seed` as a
//             continuous re-roll. One fragment pass.
//   fine    — v2 (M1). Integer pcg3d hash per grain cell, true Gaussian
//             (or triangular / uniform, all unit-variance so the amount
//             params mean "standard deviation"), FRAME-LOCKED to the
//             project clock, and animated through a variance-preserving
//             moving-average kernel over hashed frames (engine/grain.ts) so
//             `smoothness` gives a smooth, deterministic, scrubbable,
//             loopable evolution instead of a re-roll.
//   soft    — v2 (M2). The fine plate blurred by `softness` cells with
//             Σw² = 1 weights (unit variance survives the blur), plus
//             coarser octaves at 2× and 4× the cell size mixed in by
//             `irregularity` — the After Effects size / softness look,
//             with clumps.
//   film    — v2 (M4). Boolean disc grains after Newson et al.: a
//             Poisson field of soft discs with log-normal radii whose
//             density follows the local tone (λ = −ln(1−u)/πE[R²]), so
//             shadows hold sparse grains and highlights sparse holes.
//             Rendered at canvas / `quality` resolution; the temporal
//             kernel runs inside the pass (the union is non-linear), so
//             its cost scales with the tap count.
//   parametric — v2 (M5). The codec model: a CPU AR(1) template of
//             exponentially correlated Gaussian noise (`correlation`,
//             anisotropic by `aspect`) tiled over the plate in 32-texel
//             blocks at hashed offsets with AV1's variance-preserving seam
//             weights. The template is built from the kernel-blended
//             noise, so its CPU cost grows with the tap count.
//   sensor  — v2 (M6). The fine plate plus what a camera adds on top of
//             shot noise: a static per-pixel fixed pattern, row / column
//             banding, and a coarse chroma-only blotch plate; component
//             weights renormalised to Σw² = 1.
//   video   — v2 (M6). Analog snow: streaks `streak` px long and Size px
//             tall (the plate's cells), with per-line gain jitter and
//             rare dropout lines.
//   plate   — v2 (M5). A wired image or video IS the grain: its deviation
//             from `plate_center` × `plate_gain`, tiled at `plate_scale`
//             canvas px per texel with a random offset (and flips) per
//             grain frame. Unwired, it renders as `fine`.
//
// Application (M3), shared by the v2 models: a tonal `response` curve
// (input luminance → amplitude, baked to a LUT), the working `space`
// (display / linear / log, with the amount rescaled so it reads the same
// at mid grey), a colour model (`saturation` scales the chromatic grain's
// colour deviation, `tint` biases it, `per_channel` gives each colour its
// own cell size and intensity — Nuke's red-coarsest / blue-heaviest), an
// optional soft clip, grain scaled by the input's alpha, and a `preset`
// table (Physarum's pattern) that drives every look param at once.
//
// Execution (fine / soft): a noise plate at grain resolution (canvas /
// cell, aspect-stretched), optional separable blur at that resolution,
// then a composite that upsamples every plate with a variance-normalised
// cubic B-spline, shapes the sum and blends it over the input.
//
// Mix modes treat the grain as a layer centred at 0.5 + grain/2, so zero
// grain is identity in every mode. With no image wired the node emits the
// grain on neutral 50% grey; the `grain` aux output is that same picture
// even when an image is wired, and `view: grain` shows it on the primary.

// Shared by the classic and composite shaders (identical text to the
// original node's function — classic output must not change).
const BLEND_GLSL = `
vec3 blendMode(vec3 base, vec3 grain, int mode) {
  if (mode == 0) {
    // add
    return base + grain;
  } else if (mode == 1) {
    // screen: 1 - (1-a)*(1-b). Symmetric around mid-gray. Treat
    // grain as a 0..1 layer (centered at 0.5 + grain/2) so that 0
    // grain = no change.
    vec3 layer = clamp(0.5 + grain * 0.5, 0.0, 1.0);
    return 1.0 - (1.0 - base) * (1.0 - layer);
  } else if (mode == 2) {
    // overlay — most film-y on mid-tones. Layer is grain centered
    // at 0.5; overlay falls back to identity at 0 grain.
    vec3 layer = clamp(0.5 + grain * 0.5, 0.0, 1.0);
    vec3 lo = 2.0 * base * layer;
    vec3 hi = 1.0 - 2.0 * (1.0 - base) * (1.0 - layer);
    return mix(lo, hi, step(0.5, base));
  } else if (mode == 3) {
    // soft-light (Pegtop) — gentler than overlay.
    vec3 layer = clamp(0.5 + grain * 0.5, 0.0, 1.0);
    return (1.0 - 2.0 * layer) * base * base + 2.0 * layer * base;
  } else if (mode == 4) {
    // multiply
    vec3 layer = clamp(0.5 + grain * 0.5, 0.0, 1.0);
    return base * layer * 2.0; // *2 so 0.5 layer = identity
  } else if (mode == 5) {
    // linear-light = base + 2*layer - 1, with layer centered at 0.5.
    vec3 layer = clamp(0.5 + grain * 0.5, 0.0, 1.0);
    return base + 2.0 * layer - 1.0;
  }
  // 6: replace — base swapped for the grain texture (centered at 0.5).
  return clamp(0.5 + grain * 0.5, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------
// classic — the pre-v2 shader, unchanged
// ---------------------------------------------------------------------
export const GRAIN_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform int   u_hasSrc;
uniform vec2  u_res;
uniform float u_lum;     // luminance grain amount, [0..]
uniform float u_chr;     // chromatic grain amount, [0..]
uniform float u_scale;   // grain dot size in pixels (≥ 1 ⇒ finer)
uniform float u_seed;    // animate for moving grain
uniform float u_mix;     // 0..1 layer opacity over input
uniform int   u_mode;    // mix-mode index (see switch below)
out vec4 outColor;

// Hash → uniform [0,1). Same trick used elsewhere in the codebase
// (audio.ts, perlin-noise.ts) — produces visually grain-like noise
// without any texture sampling.
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

// Approx Gaussian via two uniforms summed (central-limit). Gives the
// noise a softer film-like shoulder than raw uniform speckle.
float gaussian(vec3 p) {
  float a = hash13(p);
  float b = hash13(p + vec3(17.0, 31.0, 13.0));
  return (a + b - 1.0); // ≈ in [-1, 1] with Gaussian-ish PDF
}
${BLEND_GLSL}

void main() {
  // Quantize UV into "grain cells" of u_scale pixels. A cell of 1
  // pixel = the finest possible grain (one independent sample per
  // pixel); larger u_scale pools many pixels onto a single sample,
  // producing chunky grain.
  vec2 px = v_uv * u_res;
  vec2 cell = floor(px / max(u_scale, 1.0));

  // Luminance grain — same value applied to R, G, B so the
  // brightness shifts but hue / saturation don't.
  float gl = gaussian(vec3(cell, u_seed));

  // Chromatic grain — independent per channel, offset hashes so the
  // three channels don't correlate.
  float gr = gaussian(vec3(cell, u_seed + 11.13));
  float gg = gaussian(vec3(cell, u_seed + 41.27));
  float gb = gaussian(vec3(cell, u_seed + 73.91));

  vec3 grain = vec3(gl) * u_lum + vec3(gr, gg, gb) * u_chr;

  if (u_hasSrc == 1) {
    vec4 src = texture(u_src, v_uv);
    vec3 mixed = blendMode(src.rgb, grain, u_mode);
    vec3 rgb = mix(src.rgb, mixed, clamp(u_mix, 0.0, 1.0));
    outColor = vec4(rgb, src.a);
  } else {
    // Stand-alone grain on neutral 50% gray. Downstream Merge
    // nodes can composite this however they like.
    outColor = vec4(clamp(0.5 + grain, 0.0, 1.0), 1.0);
  }
}`;

// ---------------------------------------------------------------------
// fine / soft — pass 1: the noise plate
// ---------------------------------------------------------------------
//
// One texel per grain cell. Output is unit-variance per channel:
//   r   = luma grain
//   gba = independent per-channel grain (only drawn when u_chroma == 1)
// The temporal kernel (weights pre-normalised on the CPU so Σw² = 1)
// sums `u_taps` hashed frames starting at `u_frame0`; `u_loop` > 0 wraps
// the frame index. The per-(cell, frame) draw is mirrored on the CPU by
// grainSampleCpu in engine/grain.ts — keep the two in lockstep (same keys,
// same hash chaining, same Box–Muller).
export const GRAIN_NOISE_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
uniform vec2  u_plateSize;   // plate texel dimensions
uniform uint  u_seed;
uniform int   u_taps;        // kernel taps in use (1..${GRAIN_MAX_TAPS})
uniform int   u_frame0;      // hashed frame of tap 0 (non-negative)
uniform int   u_loop;        // loop period in grain frames, 0 = none
uniform int   u_dist;        // 0 gaussian, 1 triangular, 2 uniform
uniform int   u_chroma;      // 1 = also draw the per-channel grain
uniform float u_w[${GRAIN_MAX_TAPS}];
// Sensor components (Σw² = 1 across the three; fine/soft pass 1, 0, 0).
uniform float u_wShot;       // the temporal draw
uniform float u_wFixed;      // static per-pixel pattern
uniform float u_wBand;       // one value per row / column
uniform int   u_bandAxis;    // 0 rows, 1 columns
// Video: per-line gain jitter and rare dropout lines.
uniform float u_rowJitter;
uniform float u_dropout;
uniform int   u_lumaOff;     // 1 = chroma-only plate (zero the luma channel)
out vec4 outColor;
${PCG3D_GLSL}
const uint SEED_MUL = 0x9E3779B9u;
const uvec3 CHAIN_A = uvec3(0x68E31DA4u, 0xB5297A4Du, 0x1B56C4E9u);
const uvec3 CHAIN_B = uvec3(0x1B56C4E9u, 0x68E31DA4u, 0xB5297A4Du);
const int FIXED_FRAME = ${GRAIN_FIXED_FRAME};

vec3 words01(uvec3 h) { return vec3(h) * (1.0 / 4294967296.0); }

// Two independent N(0,1) from two uniforms.
vec2 boxMuller(float u0, float u1) {
  float r = sqrt(-2.0 * log(max(u0, 1e-7)));
  float a = 6.283185307179586 * u1;
  return r * vec2(cos(a), sin(a));
}

// Unit-variance draws for one cell and hashed frame: (luma, r, g, b).
vec4 sample4(uvec2 cell, int frame) {
  uvec3 h0 = pcg3d(uvec3(cell, uint(frame) ^ (u_seed * SEED_MUL)));
  vec3 a = words01(h0);
  if (u_dist == 0) {
    vec2 g01 = boxMuller(a.x, a.y);
    if (u_chroma == 0) return vec4(g01.x, 0.0, 0.0, 0.0);
    vec3 b = words01(pcg3d(h0 ^ CHAIN_A));
    vec2 g23 = boxMuller(b.x, b.y);
    return vec4(g01, g23);
  }
  if (u_dist == 2) {
    // uniform on [-1, 1] has std 1/sqrt(3)
    const float k3 = 1.7320508075688772;
    if (u_chroma == 0) return vec4((a.x * 2.0 - 1.0) * k3, 0.0, 0.0, 0.0);
    vec3 b = words01(pcg3d(h0 ^ CHAIN_A));
    return (vec4(a.x, a.y, a.z, b.x) * 2.0 - 1.0) * k3;
  }
  // triangular: sum of two uniforms minus one has std 1/sqrt(6)
  const float k6 = 2.449489742783178;
  if (u_chroma == 0) return vec4((a.x + a.y - 1.0) * k6, 0.0, 0.0, 0.0);
  uvec3 h1 = pcg3d(h0 ^ CHAIN_A);
  vec3 b = words01(h1);
  vec3 c = words01(pcg3d(h1 ^ CHAIN_B));
  return (vec4(a.x + a.y, a.z + b.x, b.y + b.z, c.x + c.y) - 1.0) * k6;
}

// The temporal kernel over hashed frames for one key.
vec4 temporal(uvec2 key) {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < ${GRAIN_MAX_TAPS}; i++) {
    if (i >= u_taps) break;
    int f = u_frame0 + i;
    if (u_loop > 0) f = f % u_loop;
    acc += u_w[i] * sample4(key, f);
  }
  return acc;
}

void main() {
  uvec2 cell = uvec2(floor(v_uv * u_plateSize));
  vec4 g = u_wShot * temporal(cell);
  // Fixed pattern: the same draw every frame.
  if (u_wFixed > 0.0) g += u_wFixed * sample4(cell, FIXED_FRAME);
  // Banding: one value per row (or column), evolving with the kernel.
  if (u_wBand > 0.0) {
    uvec2 line = (u_bandAxis == 0)
      ? uvec2(0x5bd1e995u, cell.y)
      : uvec2(cell.x, 0x5bd1e995u);
    g += u_wBand * temporal(line);
  }
  // Video: per-line gain jitter and dropout lines, re-rolled per grain
  // frame (keyed on the kernel's first frame).
  if (u_rowJitter > 0.0 || u_dropout > 0.0) {
    vec3 rh = words01(pcg3d(uvec3(cell.y, 0x27d4eb2fu, uint(u_frame0) ^ (u_seed * SEED_MUL))));
    float gain = 1.0 + u_rowJitter * (rh.x * 2.0 - 1.0);
    if (rh.y < u_dropout) gain *= 4.0;
    g *= gain;
  }
  if (u_lumaOff == 1) g.r = 0.0;
  outColor = g;
}`;

// ---------------------------------------------------------------------
// plate — pass 1: a wired image or video as the grain
// ---------------------------------------------------------------------
//
// Canvas-sized output in the shared layout. Each tap samples the plate
// at `plate_scale` canvas px per texel, translated by a random fraction
// of the plate (and flipped) per hashed frame, wrapped with fract; the
// deviation from `plate_center` × `plate_gain` is the grain, its luma the
// luminance channel.
export const GRAIN_PLATE_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
uniform sampler2D u_plateSrc;
uniform vec2  u_plateTexSize;  // wired plate texels
uniform vec2  u_canvasSize;
uniform float u_scalePx;       // canvas px per plate texel
uniform float u_center;
uniform float u_gain;
uniform int   u_flips;
uniform uint  u_seed;
uniform int   u_taps;
uniform int   u_frame0;
uniform int   u_loop;
uniform float u_w[${GRAIN_MAX_TAPS}];
out vec4 outColor;
${PCG3D_GLSL}
const uint SEED_MUL = 0x9E3779B9u;

float luma709(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 words01(uvec3 h) { return vec3(h) * (1.0 / 4294967296.0); }

void main() {
  vec2 px = v_uv * u_canvasSize;
  vec2 base = px / (u_scalePx * u_plateTexSize);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < ${GRAIN_MAX_TAPS}; i++) {
    if (i >= u_taps) break;
    int f = u_frame0 + i;
    if (u_loop > 0) f = f % u_loop;
    vec3 h = words01(pcg3d(uvec3(uint(f), 0x51633e2du, u_seed * SEED_MUL)));
    vec2 tuv = base;
    if (u_flips == 1) {
      if (h.z < 0.5) tuv.x = -tuv.x;
      if (fract(h.z * 2.0) < 0.5) tuv.y = -tuv.y;
    }
    tuv = fract(tuv + h.xy);
    vec3 dev = (texture(u_plateSrc, tuv).rgb - u_center) * u_gain;
    acc += u_w[i] * vec4(luma709(dev), dev);
  }
  outColor = acc;
}`;

// ---------------------------------------------------------------------
// film — pass 1: Boolean disc grains at canvas / quality resolution
// ---------------------------------------------------------------------
//
// Same output layout as the noise plate (r = luma grain, gba = per-channel
// grain, unit-variance-ish), so the composite pass is shared. Per tap and
// per field: walk the 3×3 cells of side S around the pixel; each cell
// holds SLOTS candidate grains, present with probability μ(u_cell)/SLOTS
// where u_cell is the source luminance at the cell centre; a present
// grain's centre and radius come from one pcg3d draw (its existence
// uniform, conditioned on presence, is reused as the radius's normal via
// the logistic approximation). Coverages union as 1 − Π(1 − cᵢ); the
// deviation from the pixel's own u is divided by sqrt(u(1 − u)).
export const GRAIN_FILM_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
uniform sampler2D u_src;
uniform int   u_hasSrc;
uniform vec2  u_plateSize;
uniform float u_aspect;      // sqrt(aspect): x is divided, y multiplied
uniform float u_radius;      // mean grain radius, plate px
uniform float u_sigmaLn;     // log-normal radius spread
uniform float u_cellSide;    // search cell side, plate px
uniform float u_edge;        // soft edge half-width, plate px
uniform float u_lambdaScale; // μ(u) = -ln(1-u) * u_lambdaScale
uniform uint  u_seed;
uniform int   u_taps;
uniform int   u_frame0;
uniform int   u_loop;
uniform int   u_chroma;
uniform float u_w[${GRAIN_MAX_TAPS}];
out vec4 outColor;
${PCG3D_GLSL}
const uint SEED_MUL = 0x9E3779B9u;
const int SLOTS = ${GRAIN_FILM_SLOTS};
const uvec3 FIELD_SALT = uvec3(0x68E31DA4u, 0xB5297A4Du, 0x1B56C4E9u);

float luma709(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Source luminance at a plate-space point (uv shared with the canvas).
float lumaAt(vec2 q) {
  if (u_hasSrc == 0) return 0.5;
  vec2 uv = vec2(q.x * u_aspect, q.y / u_aspect) / u_plateSize;
  return clamp(luma709(texture(u_src, uv).rgb), 0.02, 0.98);
}

float coverage(vec2 q, int frame, uint salt) {
  vec2 cellF = floor(q / u_cellSide);
  float notCovered = 1.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cf = cellF + vec2(float(i), float(j));
      float mu = -log(1.0 - lumaAt((cf + 0.5) * u_cellSide)) * u_lambdaScale;
      float pSlot = clamp(mu / float(SLOTS), 0.0, 1.0);
      uvec2 cell = uvec2(ivec2(cf) + ivec2(4096));
      for (int k = 0; k < SLOTS; k++) {
        uvec3 h = pcg3d(uvec3(cell, ((uint(frame) * 16u + uint(k)) ^ salt) ^ (u_seed * SEED_MUL)));
        vec3 u3 = vec3(h) * (1.0 / 4294967296.0);
        if (u3.z >= pSlot) continue;
        // Conditioned on presence, u3.z / pSlot is uniform again: a
        // logistic map gives a unit-ish normal for the radius spread.
        float ur = clamp(u3.z / max(pSlot, 1e-6), 0.001, 0.999);
        float z = 0.5513 * log(ur / (1.0 - ur));
        float rad = u_radius * exp(u_sigmaLn * z);
        vec2 center = (cf + u3.xy) * u_cellSide;
        float d = length(q - center);
        float c = 1.0 - smoothstep(rad - u_edge, rad + u_edge, d);
        notCovered *= 1.0 - c;
      }
    }
  }
  return 1.0 - notCovered;
}

void main() {
  // Plate pixel, aspect-corrected so discs are circles in q.
  vec2 p = v_uv * u_plateSize;
  vec2 q = vec2(p.x / u_aspect, p.y * u_aspect);
  float u = lumaAt(q);
  float norm = inversesqrt(u * (1.0 - u));
  vec4 acc = vec4(0.0);
  for (int t = 0; t < ${GRAIN_MAX_TAPS}; t++) {
    if (t >= u_taps) break;
    int f = u_frame0 + t;
    if (u_loop > 0) f = f % u_loop;
    vec4 g = vec4((coverage(q, f, 0u) - u) * norm, 0.0, 0.0, 0.0);
    if (u_chroma == 1) {
      g.g = (coverage(q, f, FIELD_SALT.x) - u) * norm;
      g.b = (coverage(q, f, FIELD_SALT.y) - u) * norm;
      g.a = (coverage(q, f, FIELD_SALT.z) - u) * norm;
    }
    acc += u_w[t] * g;
  }
  outColor = acc;
}`;

// ---------------------------------------------------------------------
// parametric — pass 1: tile the uploaded AR template over the plate
// ---------------------------------------------------------------------
//
// Every 32-texel block reads a window of the template at a hashed
// origin; the two texels nearest each seam blend with the neighbouring
// block's window continued across it, weights 27/32 and 17/32 (AV1's —
// 27² + 17² ≈ 32², so the seam keeps unit variance). Vertical after
// horizontal, as the codec does.
export const GRAIN_TILE_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
uniform sampler2D u_template;   // T×T RGBA, unit variance per channel
uniform float u_templateSize;
uniform vec2  u_plateSize;
uniform uint  u_seed;
out vec4 outColor;
${PCG3D_GLSL}
const uint SEED_MUL = 0x9E3779B9u;
const float BLOCK = ${GRAIN_AR_BLOCK}.0;
const float SEAM = ${GRAIN_AR_SEAM}.0;
const float W_NEAR = 27.0 / 32.0;
const float W_FAR = 17.0 / 32.0;

// Hashed window origin for a block, leaving room for the block plus its
// seam overlap inside the template.
vec2 blockOrigin(ivec2 block) {
  uvec3 h = pcg3d(uvec3(uvec2(block + ivec2(4096)), 0x7f4a7c15u ^ (u_seed * SEED_MUL)));
  vec2 u = vec2(h.xy) * (1.0 / 4294967296.0);
  return floor(u * (u_templateSize - BLOCK - SEAM));
}

vec4 fetchT(vec2 origin, vec2 local) {
  return texelFetch(u_template, ivec2(origin + local), 0);
}

// This block's sample at local, blended across the left seam with the
// left block's window continued into it.
vec4 sampleX(ivec2 block, vec2 local) {
  vec4 cur = fetchT(blockOrigin(block), local);
  if (local.x < SEAM) {
    vec4 prev = fetchT(blockOrigin(block - ivec2(1, 0)), local + vec2(BLOCK, 0.0));
    float wPrev = local.x < 0.5 ? W_NEAR : W_FAR;
    float wCur = local.x < 0.5 ? W_FAR : W_NEAR;
    return wPrev * prev + wCur * cur;
  }
  return cur;
}

void main() {
  vec2 p = floor(v_uv * u_plateSize);
  ivec2 block = ivec2(floor(p / BLOCK));
  vec2 local = p - vec2(block) * BLOCK;
  vec4 v = sampleX(block, local);
  if (local.y < SEAM) {
    vec4 above = sampleX(block - ivec2(0, 1), local + vec2(0.0, BLOCK));
    float wAbove = local.y < 0.5 ? W_NEAR : W_FAR;
    float wCur = local.y < 0.5 ? W_FAR : W_NEAR;
    v = wAbove * above + wCur * v;
  }
  outColor = v;
}`;

// ---------------------------------------------------------------------
// soft — 1-D blur pass over a plate (run once per axis)
// ---------------------------------------------------------------------
//
// Weights arrive normalised to Σw² = 1 (engine/grain.ts grainBlurWeights):
// the plate is zero-mean noise, so preserving its variance is the only
// normalisation that matters. Taps land on exact texel centres (the
// target has the plate's size), so the linear filter reads texels.
export const GRAIN_BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2  u_step;   // one texel along the blur axis
uniform int   u_taps;   // odd, 1..${GRAIN_BLUR_MAX_TAPS}
uniform float u_w[${GRAIN_BLUR_MAX_TAPS}];
out vec4 outColor;

void main() {
  int h = (u_taps - 1) / 2;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < ${GRAIN_BLUR_MAX_TAPS}; i++) {
    if (i >= u_taps) break;
    acc += u_w[i] * texture(u_src, v_uv + float(i - h) * u_step);
  }
  outColor = acc;
}`;

// ---------------------------------------------------------------------
// fine / soft — pass 2: composite
// ---------------------------------------------------------------------
//
// Reads up to three plates (the base cell and the 2× / 4× octaves) —
// directly when the base plate is canvas-sized, otherwise through a cubic
// B-spline built from four bilinear fetches (Sigg & Hadwiger) — sums them
// with the octave weights, shapes the result (colour model, tonal
// response, alpha) and blends it over the input in the working space.
// The B-spline's implied 16 weights sum to one but their squares do not,
// so interpolated noise would carry a faint lattice of contrast; dividing
// by sqrt(Σwₓ²·Σw_y²) removes it, the same variance rule everything else
// here follows.
export const GRAIN_COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform int   u_hasSrc;
uniform sampler2D u_plate0;
uniform sampler2D u_plate1;
uniform sampler2D u_plate2;
uniform sampler2D u_lut;      // tonal response: display luminance → amplitude
uniform vec2  u_plateSize0;
uniform vec2  u_plateSize1;
uniform vec2  u_plateSize2;
uniform int   u_direct;       // 1 = plate0 is canvas-sized: fetch the texel
uniform int   u_octaves;      // 1..${GRAIN_MAX_OCTAVES}
uniform float u_ow[${GRAIN_MAX_OCTAVES}];
uniform float u_lum;
uniform float u_chr;
uniform float u_sat;          // chromatic colour deviation scale, 0 = mono
uniform vec3  u_tint;         // tint colour, 0.5 = neutral
uniform float u_tintAmt;
uniform int   u_perChannel;
uniform vec3  u_chSize;       // per-channel cell multipliers (≥ 1) → uv zoom
uniform vec3  u_chInt;        // per-channel intensity multipliers
uniform int   u_space;        // 0 display, 1 linear, 2 log
uniform float u_gain;         // amount rescale for the space
uniform int   u_softClip;
uniform vec2  u_uvOffset;     // drift: where the grain layer has wandered to
uniform float u_mix;
uniform int   u_mode;
uniform int   u_view;         // 1 = the grain layer alone on 50% grey
out vec4 outColor;
${BLEND_GLSL}

// Log encoding — literals mirrored from engine/grain.ts.
const float LOG_OFF = ${GRAIN_LOG_OFFSET.toFixed(12)};
const float LOG2_OFF = ${Math.log2(GRAIN_LOG_OFFSET).toFixed(12)};
const float LOG_RANGE = ${GRAIN_LOG_RANGE.toFixed(12)};

vec3 srgb2lin(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}
vec3 lin2srgb(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
vec3 lin2log(vec3 x) {
  return (log2(max(x, vec3(0.0)) + LOG_OFF) - LOG2_OFF) / LOG_RANGE;
}
vec3 log2lin(vec3 l) {
  return exp2(l * LOG_RANGE + LOG2_OFF) - LOG_OFF;
}
vec3 toSpace(vec3 c) {
  if (u_space == 1) return srgb2lin(c);
  if (u_space == 2) return lin2log(srgb2lin(c));
  return c;
}
vec3 fromSpace(vec3 c) {
  if (u_space == 1) return lin2srgb(c);
  if (u_space == 2) return lin2srgb(log2lin(c));
  return c;
}
// tanh shoulders in the last 5% at both ends: C¹ where they take over,
// asymptotic to 0 / 1 instead of the flat wall a hard clip leaves.
vec3 softClip(vec3 c) {
  const float k = 0.05;
  vec3 hi = (1.0 - k) + k * tanh((c - (1.0 - k)) / k);
  vec3 lo = k - k * tanh((k - c) / k);
  vec3 r = mix(c, hi, step(vec3(1.0 - k), c));
  return mix(r, lo, step(c, vec3(k)));
}
float luma709(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec4 bspline(sampler2D tex, vec2 size, vec2 uv) {
  vec2 p = uv * size - 0.5;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = -1.0 + w1 / g0;
  vec2 h1 = 1.0 + w3 / g1;
  vec2 texel = 1.0 / size;
  vec2 c = (i + 0.5) * texel;
  vec4 s00 = texture(tex, c + vec2(h0.x, h0.y) * texel);
  vec4 s10 = texture(tex, c + vec2(h1.x, h0.y) * texel);
  vec4 s01 = texture(tex, c + vec2(h0.x, h1.y) * texel);
  vec4 s11 = texture(tex, c + vec2(h1.x, h1.y) * texel);
  vec4 v = g0.y * (g0.x * s00 + g1.x * s10) + g1.y * (g0.x * s01 + g1.x * s11);
  vec2 sw2 = w0 * w0 + w1 * w1 + w2 * w2 + w3 * w3;
  return v * inversesqrt(sw2.x * sw2.y);
}

// Octave sum through the B-spline (any uv, any plate size).
vec4 plateSum(vec2 uv) {
  vec4 g = u_ow[0] * bspline(u_plate0, u_plateSize0, uv);
  if (u_octaves > 1) g += u_ow[1] * bspline(u_plate1, u_plateSize1, uv);
  if (u_octaves > 2) g += u_ow[2] * bspline(u_plate2, u_plateSize2, uv);
  return g;
}

vec4 grainAt(vec2 uv) {
  if (u_direct == 1) {
    vec4 g = u_ow[0] * texelFetch(u_plate0, ivec2(uv * u_plateSize0), 0);
    if (u_octaves > 1) g += u_ow[1] * bspline(u_plate1, u_plateSize1, uv);
    if (u_octaves > 2) g += u_ow[2] * bspline(u_plate2, u_plateSize2, uv);
    return g;
  }
  return plateSum(uv);
}

void main() {
  vec4 src = u_hasSrc == 1 ? texture(u_src, v_uv) : vec4(0.5, 0.5, 0.5, 1.0);
  // Drift wraps the layer (the seam is invisible in noise).
  vec2 guv = fract(v_uv + u_uvOffset);
  vec4 g = grainAt(guv);
  vec3 chroma = g.gba;
  if (u_perChannel == 1) {
    // A colour channel with a size multiplier reads its own zoomed copy
    // of the plates: 1.3 on red means red grain cells 1.3× larger.
    if (u_chSize.r != 1.0) chroma.r = plateSum(guv / u_chSize.r).g;
    if (u_chSize.g != 1.0) chroma.g = plateSum(guv / u_chSize.g).b;
    if (u_chSize.b != 1.0) chroma.b = plateSum(guv / u_chSize.b).a;
  }
  // Saturation scales the chromatic grain's colour deviation about its
  // own mean: 0 folds it into luminance, 1 leaves the channels
  // independent, 2 exaggerates the colour.
  float m = (chroma.r + chroma.g + chroma.b) / 3.0;
  chroma = m + (chroma - m) * u_sat;
  vec3 grain = vec3(g.r) * u_lum + chroma * u_chr;
  if (u_perChannel == 1) grain *= u_chInt;
  // Tint: a luminance-correlated colour bias (bright specks lean toward
  // the tint colour, dark ones away).
  grain += g.r * u_lum * u_tintAmt * (u_tint - 0.5) * 2.0;
  // Tonal response on the input's display luminance, then the input's
  // straight alpha so a cut-out's fringe does not sprout grain.
  float Y = luma709(src.rgb);
  grain *= texture(u_lut, vec2((Y * 255.0 + 0.5) / 256.0, 0.5)).r;
  grain *= src.a;

  if (u_view == 1 || u_hasSrc == 0) {
    outColor = vec4(clamp(0.5 + grain, 0.0, 1.0), 1.0);
    return;
  }
  vec3 base = toSpace(src.rgb);
  vec3 mixed = blendMode(base, grain * u_gain, u_mode);
  vec3 rgb = fromSpace(mix(base, mixed, clamp(u_mix, 0.0, 1.0)));
  if (u_softClip == 1) rgb = softClip(rgb);
  outColor = vec4(rgb, src.a);
}`;

const MIX_MODES = [
  "add",
  "screen",
  "overlay",
  "soft-light",
  "multiply",
  "linear-light",
  "replace",
] as const;

function mixModeIndex(name: string): number {
  const idx = (MIX_MODES as readonly string[]).indexOf(name);
  return idx < 0 ? 2 : idx; // default overlay
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function hexToRgb01(hex: unknown, fallback: [number, number, number]): [number, number, number] {
  if (typeof hex !== "string") return fallback;
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  if (s.length !== 6) return fallback;
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return fallback;
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

// Panel visibility. A preset other than `custom` drives every look param
// from its table, so those rows hide until the user picks custom.
type P = Record<string, unknown>;
const isCustom = (p: P) => normalizeGrainPreset(p.preset) === "custom";
const isV2 = (p: P) => grainResolveLook(p).model !== "classic";
const customV2 = (p: P) => isCustom(p) && isV2(p);
const customSoft = (p: P) => isCustom(p) && grainResolveLook(p).model === "soft";
const customFilm = (p: P) => isCustom(p) && grainResolveLook(p).model === "film";
const customShaped = (p: P) => customSoft(p) || customFilm(p);
const customParametric = (p: P) =>
  isCustom(p) && grainResolveLook(p).model === "parametric";
const customSensor = (p: P) => isCustom(p) && grainResolveLook(p).model === "sensor";
const customVideo = (p: P) => isCustom(p) && grainResolveLook(p).model === "video";
const customPlate = (p: P) => isCustom(p) && grainResolveLook(p).model === "plate";
const customMicrons = (p: P) =>
  customV2(p) && grainSizeUnitIsMicrons(grainResolveLook(p).size_unit);
const customChannels = (p: P) => customV2(p) && p.per_channel === true;

interface Plate {
  img: ImageValue;
  w: number;
  h: number;
}

// Per-node persistent state: the baked response LUT (RGBA8 256×1) and the
// key it was baked from. Owned here, torn down in dispose.
interface GrainState {
  lut: WebGLTexture | null;
  lutKey: string;
}

function stateKey(nodeId: string): string {
  return `grain:${nodeId}`;
}

function ensureLut(
  ctx: RenderContext,
  nodeId: string,
  key: string,
  bake: () => Uint8Array
): WebGLTexture {
  const gl = ctx.gl;
  let state = ctx.state[stateKey(nodeId)] as GrainState | undefined;
  if (!state) {
    state = { lut: null, lutKey: "" };
    ctx.state[stateKey(nodeId)] = state;
  }
  if (!state.lut) {
    const tex = gl.createTexture();
    if (!tex) throw new Error("grain: failed to create LUT texture");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      GRAIN_LUT_SIZE,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    state.lut = tex;
    state.lutKey = "";
  }
  if (state.lutKey !== key) {
    const mono = bake();
    const rgba = new Uint8Array(GRAIN_LUT_SIZE * 4);
    for (let i = 0; i < GRAIN_LUT_SIZE; i++) {
      rgba[i * 4] = mono[i];
      rgba[i * 4 + 1] = mono[i];
      rgba[i * 4 + 2] = mono[i];
      rgba[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, state.lut);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      GRAIN_LUT_SIZE,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgba
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
    state.lutKey = key;
  }
  return state.lut;
}

export const grainNode: NodeDefinition = {
  type: "grain",
  name: "Grain",
  category: "image",
  subcategory: "modifier",
  description:
    "Procedural grain in six models — fine hash grain, soft blurred grain with coarser octaves, Boolean film discs, digital sensor noise, analog video snow, or a wired image / video plate — with a tonal response curve, display / linear / log working space, a per-channel colour model and film-stock presets, frame-locked to the project clock with a variance-preserving temporal kernel for smooth or looping evolution, composited over an optional image through a choice of mix modes or emitted alone on 50% gray.",
  searchAliases: ["film grain", "noise"],
  facts: {
    space: { "param:scale": "pixels" },
    reads: ["time"],
    gotchas: [
      "Size is grain cell size in render px; size_unit=1080p px scales by canvas height/1080, um units take size_um through the film gauge width; aspect stretches cells (video: streak x Size).",
      "model=classic is the pre-v2 shader for saved projects (float hash, seed re-rolls continuously); a preset other than custom drives every look param from its table - pick custom to edit them.",
      "luminance/chromatic = display std at mid-grey in every space; response scales grain by input luminance; saturation 0 = mono chromatic grain; no image = grain alone on 50% gray (also the grain aux).",
      "soft blurs the plate (softness cells, sum w^2 = 1) and mixes 2x/4x octaves by irregularity; film draws Boolean disc grains at canvas/quality res whose count follows -ln(1-Y)*density.",
      "sensor = fine + fixed pattern, banding, chroma blotch; video = streak x Size cells with line jitter/dropout; plate tiles the wired image; parametric tiles a CPU AR(1) template (cost ~ taps).",
      "motion=animated steps grain time from the project clock at rate fps: rate 0 = new grain once per project frame in preview and export alike; rate 12 at 24 fps holds each grain frame two frames.",
      "smoothness = sigma (grain frames) of a Gaussian moving average over hashed frames, renormalised by 1/sqrt(sum w^2) so contrast never breathes (kernel=bspline: 4 taps); drift wanders the layer, px/s.",
      "evolution is a continuous grain-time offset in every mode (a wired ramp morphs smoothly when smoothness > 0); looping repeats every loop_frames project frames, which must divide the project loop.",
    ],
  },
  backend: "webgl2",
  inputs: [
    { name: "image", label: "Image", type: "image", required: false },
    // model=plate: this image (or video frame) is the grain itself.
    { name: "plate", label: "Plate", type: "image", required: false },
  ],
  params: [
    {
      name: "preset",
      label: "Preset",
      type: "enum",
      options: GRAIN_PRESETS as unknown as string[],
      default: "custom",
    },
    {
      name: "model",
      label: "Model",
      type: "enum",
      options: GRAIN_MODELS as unknown as string[],
      default: "fine",
      visibleIf: isCustom,
    },
    {
      name: "scale",
      label: "Size",
      type: "scalar",
      min: 1,
      max: 32,
      softMax: 8,
      step: 0.1,
      default: 1,
      visibleIf: (p) => isCustom(p) && !customMicrons(p),
    },
    {
      name: "size_um",
      label: "Size (µm)",
      type: "scalar",
      min: 1,
      max: 200,
      softMax: 60,
      step: 0.5,
      default: 20,
      visibleIf: customMicrons,
    },
    {
      name: "size_unit",
      label: "Size Unit",
      type: "enum",
      options: GRAIN_SIZE_UNITS as unknown as string[],
      default: "px",
      visibleIf: customV2,
    },
    {
      name: "aspect",
      label: "Aspect",
      type: "scalar",
      min: 0.25,
      max: 4,
      step: 0.01,
      default: 1,
      visibleIf: customV2,
    },
    {
      name: "distribution",
      label: "Distribution",
      type: "enum",
      options: GRAIN_DISTRIBUTIONS as unknown as string[],
      default: "gaussian",
      visibleIf: customV2,
    },
    {
      name: "softness",
      label: "Softness",
      type: "scalar",
      min: 0,
      max: GRAIN_MAX_SOFTNESS,
      softMax: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: customShaped,
    },
    {
      name: "irregularity",
      label: "Irregularity",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.3,
      visibleIf: customShaped,
    },
    {
      name: "density",
      label: "Density",
      type: "scalar",
      min: 0.25,
      max: 4,
      step: 0.01,
      default: 1,
      visibleIf: customFilm,
    },
    {
      name: "quality",
      label: "Quality",
      type: "enum",
      options: GRAIN_QUALITIES as unknown as string[],
      default: "full",
      visibleIf: customFilm,
    },
    // --- parametric --------------------------------------------------------
    {
      name: "correlation",
      label: "Correlation",
      type: "scalar",
      min: 0,
      max: 0.95,
      step: 0.01,
      default: 0.6,
      visibleIf: customParametric,
    },
    // --- sensor ------------------------------------------------------------
    {
      name: "shot",
      label: "Shot Noise",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
      visibleIf: customSensor,
    },
    {
      name: "fixed_pattern",
      label: "Fixed Pattern",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.15,
      visibleIf: customSensor,
    },
    {
      name: "banding",
      label: "Banding",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.1,
      visibleIf: customSensor,
    },
    {
      name: "banding_axis",
      label: "Banding Axis",
      type: "enum",
      options: GRAIN_BANDING_AXES as unknown as string[],
      default: "rows",
      visibleIf: customSensor,
    },
    {
      name: "blotch",
      label: "Chroma Blotch",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.3,
      visibleIf: customSensor,
    },
    {
      name: "blotch_size",
      label: "Blotch Size (×)",
      type: "scalar",
      min: 2,
      max: 32,
      step: 1,
      default: 8,
      visibleIf: customSensor,
    },
    // --- video -------------------------------------------------------------
    {
      name: "streak",
      label: "Streak (px)",
      type: "scalar",
      min: 1,
      max: 64,
      softMax: 32,
      step: 0.5,
      default: 12,
      visibleIf: customVideo,
    },
    {
      name: "line_jitter",
      label: "Line Jitter",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.3,
      visibleIf: customVideo,
    },
    {
      name: "dropout",
      label: "Dropout",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.005,
      default: 0.05,
      visibleIf: customVideo,
    },
    // --- plate -------------------------------------------------------------
    {
      name: "plate_scale",
      label: "Plate Scale (px/texel)",
      type: "scalar",
      min: 0.25,
      max: 8,
      step: 0.05,
      default: 1,
      visibleIf: customPlate,
    },
    {
      name: "plate_center",
      label: "Plate Center",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: customPlate,
    },
    {
      name: "plate_gain",
      label: "Plate Gain",
      type: "scalar",
      min: 0.1,
      max: 20,
      softMax: 8,
      step: 0.1,
      default: 4,
      visibleIf: customPlate,
    },
    {
      name: "plate_flips",
      label: "Random Flips",
      type: "boolean",
      default: true,
      visibleIf: customPlate,
    },
    // --- Amount ------------------------------------------------------------
    {
      name: "luminance",
      label: "Luminance",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.06,
    },
    {
      name: "chromatic",
      label: "Chromatic",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0,
    },
    {
      name: "saturation",
      label: "Grain Saturation",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 1,
      visibleIf: customV2,
    },
    {
      name: "tint",
      label: "Tint",
      type: "color",
      default: "#808080",
      visibleIf: isV2,
    },
    {
      name: "tint_amount",
      label: "Tint Amount",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      visibleIf: isV2,
    },
    {
      name: "response_preset",
      label: "Response",
      type: "enum",
      options: GRAIN_RESPONSE_PRESETS as unknown as string[],
      default: "flat",
      visibleIf: customV2,
    },
    {
      name: "response",
      label: "Response Curve",
      type: "float_curve",
      default: defaultGrainResponseCurve(),
      visibleIf: (p) => customV2(p) && p.response_preset === "custom",
    },
    {
      name: "space",
      label: "Space",
      type: "enum",
      options: GRAIN_SPACES as unknown as string[],
      default: "display",
      visibleIf: customV2,
    },
    {
      name: "soft_clip",
      label: "Soft Clip",
      type: "boolean",
      default: false,
      visibleIf: isV2,
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
    // --- Per-channel colour model (custom look) ---------------------------
    {
      name: "per_channel",
      label: "Per-channel",
      type: "boolean",
      default: false,
      group: "channels",
      groupHeader: true,
      visibleIf: customV2,
    },
    {
      name: "size_r",
      label: "Size R (×)",
      type: "scalar",
      min: 1,
      max: 3,
      step: 0.01,
      default: 1,
      group: "channels",
      visibleIf: customChannels,
    },
    {
      name: "size_g",
      label: "Size G (×)",
      type: "scalar",
      min: 1,
      max: 3,
      step: 0.01,
      default: 1,
      group: "channels",
      visibleIf: customChannels,
    },
    {
      name: "size_b",
      label: "Size B (×)",
      type: "scalar",
      min: 1,
      max: 3,
      step: 0.01,
      default: 1,
      group: "channels",
      visibleIf: customChannels,
    },
    {
      name: "intensity_r",
      label: "Intensity R",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 1,
      group: "channels",
      visibleIf: customChannels,
    },
    {
      name: "intensity_g",
      label: "Intensity G",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 1,
      group: "channels",
      visibleIf: customChannels,
    },
    {
      name: "intensity_b",
      label: "Intensity B",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 1,
      group: "channels",
      visibleIf: customChannels,
    },
    // --- Motion (v2 models) ----------------------------------------------
    {
      name: "motion",
      label: "Motion",
      type: "enum",
      options: GRAIN_MOTIONS as unknown as string[],
      default: "animated",
      group: "motion",
      groupHeader: true,
      visibleIf: isV2,
    },
    {
      name: "rate",
      label: "Rate (fps, 0 = project)",
      type: "scalar",
      min: 0,
      max: 240,
      softMax: 60,
      step: 0.5,
      default: 0,
      group: "motion",
      visibleIf: (p) => isV2(p) && normalizeGrainMotion(p.motion) !== "static",
    },
    {
      name: "smoothness",
      label: "Smoothness (frames)",
      type: "scalar",
      min: 0,
      max: GRAIN_MAX_SMOOTHNESS,
      softMax: 2,
      step: 0.01,
      default: 0,
      group: "motion",
      visibleIf: isV2,
    },
    {
      name: "kernel",
      label: "Kernel",
      type: "enum",
      options: GRAIN_KERNELS as unknown as string[],
      default: "gaussian",
      group: "motion",
      visibleIf: (p) => isV2(p) && num(p.smoothness, 0) > 0,
    },
    {
      name: "drift",
      label: "Drift (px/s)",
      type: "scalar",
      min: 0,
      max: 64,
      softMax: 16,
      step: 0.1,
      default: 0,
      group: "motion",
      visibleIf: (p) => isV2(p) && normalizeGrainMotion(p.motion) !== "static",
    },
    {
      name: "loop_frames",
      label: "Loop (frames)",
      type: "scalar",
      min: 1,
      max: 100000,
      softMax: 300,
      step: 1,
      default: 120,
      group: "motion",
      visibleIf: (p) => isV2(p) && normalizeGrainMotion(p.motion) === "looping",
    },
    {
      name: "evolution",
      label: "Evolution",
      type: "scalar",
      min: -100000,
      max: 100000,
      softMax: 100,
      step: 0.01,
      default: 0,
      group: "motion",
      visibleIf: isV2,
    },
    // --- Mix ---------------------------------------------------------------
    {
      name: "mix_mode",
      label: "Mix Mode",
      type: "enum",
      options: MIX_MODES as unknown as string[],
      default: "overlay",
    },
    {
      name: "mix",
      label: "Mix Amount",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    {
      name: "view",
      label: "View",
      type: "enum",
      options: ["result", "grain"],
      default: "result",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [
    {
      name: "grain",
      type: "image",
      label: "Grain",
      description:
        "The grain layer alone on neutral 50% gray (opaque) — the same picture the node renders with no image wired — for compositing in Merge or driving Displace.",
    },
  ],
  // The aux is skipped when nothing reads it (one full-canvas pass), so the
  // consumed set must be part of the fingerprint. See TESTING.md §5.
  gatesOutputs: true,

  // Recompute at grain rate while animated — one key per grain frame when
  // the kernel is hard (so a 60 Hz preview of a 24 fps project recomputes
  // 24×/s, not 60×/s), quantised continuous time when it is smooth. Static
  // grain and the classic model stay fully cached on params alone.
  fingerprintExtras(params, ctx) {
    if (grainResolveLook(params).model === "classic") return "";
    const motion = normalizeGrainMotion(params.motion);
    if (motion === "static") return "";
    const fps = ctx.fps > 0 ? ctx.fps : 60;
    const rate = grainRate(params.rate, fps);
    const t = grainTime(
      motion,
      grainFrameNow(ctx),
      fps,
      rate,
      num(params.evolution, 0)
    );
    // Drift moves continuously, so it needs the continuous key too.
    const continuous = num(params.smoothness, 0) > 0 || num(params.drift, 0) > 0;
    return `g:${grainTimeKey(t, continuous ? 1 : 0)}`;
  },

  compute({ inputs, params, ctx, nodeId, consumedOutputs }) {
    const src = inputs.image;
    const srcImg = src && src.kind === "image" ? src : null;
    const look = grainResolveLook(params);
    const lum = num(params.luminance, 0.06);
    const chr = num(params.chromatic, 0);
    const seed = num(params.seed, 0);
    const mixAmt = num(params.mix, 1);
    const mode = mixModeIndex((params.mix_mode as string) ?? "overlay");
    const grainView = params.view === "grain";
    // Undefined ⇒ non-evaluator caller (bench); build it, as Bloom does.
    const wantGrain = !consumedOutputs || consumedOutputs.has("aux:grain");
    const W = ctx.width;
    const H = ctx.height;

    const output = ctx.allocImage();
    const grainOut: ImageValue | null = wantGrain ? ctx.allocImage() : null;
    const result = () => ({
      primary: output,
      ...(grainOut ? { aux: { grain: grainOut } } : {}),
    });

    if (look.model === "classic") {
      const scale = Math.max(1, look.scale);
      const prog = ctx.getShader("grain/main", GRAIN_FS);
      // `showSrc` false renders the standalone grain — exactly the old
      // no-input picture — which doubles as the grain view / aux.
      const draw = (target: ImageValue, showSrc: boolean) =>
        ctx.drawFullscreen(prog, target, (gl) => {
          const useSrc = showSrc && srcImg ? 1 : 0;
          gl.activeTexture(gl.TEXTURE0);
          // When no image is wired, bind a dummy texture so the sampler
          // is still defined. We never actually read it (u_hasSrc gates).
          gl.bindTexture(gl.TEXTURE_2D, useSrc ? srcImg!.texture : null);
          gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
          gl.uniform1i(gl.getUniformLocation(prog, "u_hasSrc"), useSrc);
          gl.uniform2f(gl.getUniformLocation(prog, "u_res"), W, H);
          gl.uniform1f(gl.getUniformLocation(prog, "u_lum"), lum);
          gl.uniform1f(gl.getUniformLocation(prog, "u_chr"), chr);
          gl.uniform1f(gl.getUniformLocation(prog, "u_scale"), scale);
          gl.uniform1f(gl.getUniformLocation(prog, "u_seed"), seed);
          gl.uniform1f(gl.getUniformLocation(prog, "u_mix"), mixAmt);
          gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), mode);
        });
      draw(output, !grainView);
      if (grainOut) draw(grainOut, false);
      return result();
    }

    // ---- fine / soft ----------------------------------------------------
    const soft = look.model === "soft";
    const motion = normalizeGrainMotion(params.motion);
    const fps = ctx.fps > 0 ? ctx.fps : 60;
    const rate = grainRate(params.rate, fps);
    const t = grainTime(
      motion,
      grainFrameNow(ctx),
      fps,
      rate,
      num(params.evolution, 0)
    );
    const sigma = Math.min(
      GRAIN_MAX_SMOOTHNESS,
      Math.max(0, num(params.smoothness, 0))
    );
    const loop =
      motion === "looping" ? grainLoopPeriod(params.loop_frames, rate, fps) : 0;
    const kernel = grainKernel(t, sigma, loop, normalizeGrainKernelMode(params.kernel));
    const weights = new Float32Array(GRAIN_MAX_TAPS);
    weights.set(kernel.weights);
    // Drift: a slow wander of the whole layer, in canvas pixels.
    const [driftX, driftY] =
      motion === "static"
        ? [0, 0]
        : grainDriftOffset(grainFrameNow(ctx) / fps, num(params.drift, 0), Math.round(seed));

    const sensor = look.model === "sensor";
    const video = look.model === "video";
    const cell = grainCellPx(look.scale, look.size_um, look.size_unit, look.aspect, W, H);
    // Video: streaks `streak` px long and Size px tall.
    const cellW = video ? Math.max(1, look.streak) : cell.cellW;
    const cellH = video ? Math.max(1, cell.basePx) : cell.cellH;
    const blur = soft ? grainBlurWeights(look.softness) : { taps: 1, weights: [1] };
    // Extra plates: soft's 2× / 4× octaves, sensor's chroma blotch.
    let octW: number[] = [1];
    let octFactor: number[] = [1];
    let octLumaOff: boolean[] = [false];
    if (soft) {
      octW = grainOctaveWeights(look.irregularity);
      octFactor = octW.map((_, o) => 1 << o);
      octLumaOff = octW.map(() => false);
    } else if (sensor) {
      octW = grainBlotchWeights(look.blotch);
      octFactor = octW.map((_, o) => (o === 0 ? 1 : Math.max(2, look.blotch_size)));
      octLumaOff = octW.map((_, o) => o > 0);
    }
    const [wShot, wFixed, wBand] = sensor
      ? grainSensorWeights(look.shot, look.fixed_pattern, look.banding)
      : [1, 0, 0];
    const rowJitter = video ? Math.min(1, Math.max(0, look.line_jitter)) : 0;
    const dropout = video ? Math.min(1, Math.max(0, look.dropout)) : 0;
    // Base plate canvas-sized ⇒ read direct (still true after a blur).
    const direct = cellW <= 1.0001 && cellH <= 1.0001;
    // Per-channel zoom needs every channel drawn, so force the chroma
    // channels on whenever the per-channel model is active.
    const perChannel = look.per_channel;
    const chSize: [number, number, number] = [
      Math.max(1, look.size_r),
      Math.max(1, look.size_g),
      Math.max(1, look.size_b),
    ];
    const chInt: [number, number, number] = [
      Math.max(0, look.intensity_r),
      Math.max(0, look.intensity_g),
      Math.max(0, look.intensity_b),
    ];
    const drawChroma = chr > 0 || (perChannel && chSize.some((s) => s !== 1));

    const noiseProg = ctx.getShader("grain/noise", GRAIN_NOISE_FS);
    const drawNoise = (
      target: ImageValue,
      pw: number,
      ph: number,
      seedU: number,
      lumaOff: boolean
    ) =>
      ctx.drawFullscreen(noiseProg, target, (gl) => {
        gl.uniform2f(gl.getUniformLocation(noiseProg, "u_plateSize"), pw, ph);
        gl.uniform1ui(gl.getUniformLocation(noiseProg, "u_seed"), seedU >>> 0);
        gl.uniform1i(gl.getUniformLocation(noiseProg, "u_taps"), kernel.taps);
        gl.uniform1i(gl.getUniformLocation(noiseProg, "u_frame0"), kernel.frame0 | 0);
        gl.uniform1i(gl.getUniformLocation(noiseProg, "u_loop"), kernel.loop | 0);
        gl.uniform1i(
          gl.getUniformLocation(noiseProg, "u_dist"),
          grainDistributionIndex(look.distribution)
        );
        gl.uniform1i(gl.getUniformLocation(noiseProg, "u_chroma"), drawChroma ? 1 : 0);
        gl.uniform1fv(gl.getUniformLocation(noiseProg, "u_w"), weights);
        gl.uniform1f(gl.getUniformLocation(noiseProg, "u_wShot"), wShot);
        gl.uniform1f(gl.getUniformLocation(noiseProg, "u_wFixed"), wFixed);
        gl.uniform1f(gl.getUniformLocation(noiseProg, "u_wBand"), wBand);
        gl.uniform1i(
          gl.getUniformLocation(noiseProg, "u_bandAxis"),
          look.banding_axis === "columns" ? 1 : 0
        );
        gl.uniform1f(gl.getUniformLocation(noiseProg, "u_rowJitter"), rowJitter);
        gl.uniform1f(gl.getUniformLocation(noiseProg, "u_dropout"), dropout);
        gl.uniform1i(gl.getUniformLocation(noiseProg, "u_lumaOff"), lumaOff ? 1 : 0);
      });

    const plateIn = inputs.plate;
    const plateImg = plateIn && plateIn.kind === "image" ? plateIn : null;
    const plates: Plate[] = [];
    let plateDirect = direct;
    if (look.model === "plate" && plateImg) {
      // The wired image is the grain. Unwired, the fine path below runs.
      const img = ctx.allocImage({ width: W, height: H });
      const plateProg = ctx.getShader("grain/plate", GRAIN_PLATE_FS);
      ctx.drawFullscreen(plateProg, img, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, plateImg.texture);
        gl.uniform1i(gl.getUniformLocation(plateProg, "u_plateSrc"), 0);
        gl.uniform2f(
          gl.getUniformLocation(plateProg, "u_plateTexSize"),
          plateImg.width,
          plateImg.height
        );
        gl.uniform2f(gl.getUniformLocation(plateProg, "u_canvasSize"), W, H);
        gl.uniform1f(gl.getUniformLocation(plateProg, "u_scalePx"), Math.max(0.05, look.plate_scale));
        gl.uniform1f(gl.getUniformLocation(plateProg, "u_center"), look.plate_center);
        gl.uniform1f(gl.getUniformLocation(plateProg, "u_gain"), Math.max(0, look.plate_gain));
        gl.uniform1i(gl.getUniformLocation(plateProg, "u_flips"), look.plate_flips ? 1 : 0);
        gl.uniform1ui(gl.getUniformLocation(plateProg, "u_seed"), grainOctaveSeed(seed, 0) >>> 0);
        gl.uniform1i(gl.getUniformLocation(plateProg, "u_taps"), kernel.taps);
        gl.uniform1i(gl.getUniformLocation(plateProg, "u_frame0"), kernel.frame0 | 0);
        gl.uniform1i(gl.getUniformLocation(plateProg, "u_loop"), kernel.loop | 0);
        gl.uniform1fv(gl.getUniformLocation(plateProg, "u_w"), weights);
      });
      plates.push({ img, w: W, h: H });
      plateDirect = true;
    } else if (look.model === "parametric") {
      // CPU AR(1) template from the kernel-blended noise, uploaded and
      // tiled by the GPU at the base cell size (aspect lives in the
      // filter's anisotropy, not in the cells).
      const { rhoX, rhoY } = grainArCoefficients(look.correlation, look.aspect);
      const data = buildGrainArTemplate(
        kernel,
        grainOctaveSeed(seed, 0),
        look.distribution,
        rhoX,
        rhoY
      );
      const tmpl = ctx.uploadFloat32ToImage(data, GRAIN_AR_TEMPLATE, GRAIN_AR_TEMPLATE);
      const one = cell.basePx <= 1.0001;
      const pw = one ? W : Math.max(1, Math.ceil(W / cell.basePx));
      const ph = one ? H : Math.max(1, Math.ceil(H / cell.basePx));
      const img = ctx.allocImage({ width: pw, height: ph });
      const tileProg = ctx.getShader("grain/tile", GRAIN_TILE_FS);
      ctx.drawFullscreen(tileProg, img, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tmpl.texture);
        gl.uniform1i(gl.getUniformLocation(tileProg, "u_template"), 0);
        gl.uniform1f(gl.getUniformLocation(tileProg, "u_templateSize"), GRAIN_AR_TEMPLATE);
        gl.uniform2f(gl.getUniformLocation(tileProg, "u_plateSize"), pw, ph);
        gl.uniform1ui(gl.getUniformLocation(tileProg, "u_seed"), grainOctaveSeed(seed, 1) >>> 0);
      });
      ctx.releaseTexture(tmpl.texture);
      plates.push({ img, w: pw, h: ph });
      plateDirect = one;
    } else if (look.model === "film") {
      // One plate at canvas / quality resolution, the whole temporal
      // kernel evaluated inside the pass.
      const div = grainQualityDivisor(look.quality);
      const pw = Math.max(1, Math.ceil(W / div));
      const ph = Math.max(1, Math.ceil(H / div));
      const fp = grainFilmParams(cell.basePx, look.irregularity, look.softness, look.density, div);
      const aspectRoot = Math.sqrt(Math.max(0.25, Math.min(4, look.aspect)));
      const img = ctx.allocImage({ width: pw, height: ph });
      const filmProg = ctx.getShader("grain/film", GRAIN_FILM_FS);
      ctx.drawFullscreen(filmProg, img, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcImg ? srcImg.texture : null);
        gl.uniform1i(gl.getUniformLocation(filmProg, "u_src"), 0);
        gl.uniform1i(gl.getUniformLocation(filmProg, "u_hasSrc"), srcImg ? 1 : 0);
        gl.uniform2f(gl.getUniformLocation(filmProg, "u_plateSize"), pw, ph);
        gl.uniform1f(gl.getUniformLocation(filmProg, "u_aspect"), aspectRoot);
        gl.uniform1f(gl.getUniformLocation(filmProg, "u_radius"), fp.radius);
        gl.uniform1f(gl.getUniformLocation(filmProg, "u_sigmaLn"), fp.sigmaLn);
        gl.uniform1f(gl.getUniformLocation(filmProg, "u_cellSide"), fp.cellSide);
        gl.uniform1f(gl.getUniformLocation(filmProg, "u_edge"), fp.edge);
        gl.uniform1f(gl.getUniformLocation(filmProg, "u_lambdaScale"), fp.lambdaScale);
        gl.uniform1ui(gl.getUniformLocation(filmProg, "u_seed"), grainOctaveSeed(seed, 0) >>> 0);
        gl.uniform1i(gl.getUniformLocation(filmProg, "u_taps"), kernel.taps);
        gl.uniform1i(gl.getUniformLocation(filmProg, "u_frame0"), kernel.frame0 | 0);
        gl.uniform1i(gl.getUniformLocation(filmProg, "u_loop"), kernel.loop | 0);
        gl.uniform1i(gl.getUniformLocation(filmProg, "u_chroma"), drawChroma ? 1 : 0);
        gl.uniform1fv(gl.getUniformLocation(filmProg, "u_w"), weights);
      });
      plates.push({ img, w: pw, h: ph });
      plateDirect = div === 1;
    } else {
      for (let o = 0; o < octW.length; o++) {
        const f = octFactor[o];
        const pw = direct && o === 0 ? W : Math.max(1, Math.ceil(W / (cellW * f)));
        const ph = direct && o === 0 ? H : Math.max(1, Math.ceil(H / (cellH * f)));
        let img = ctx.allocImage({ width: pw, height: ph });
        drawNoise(img, pw, ph, grainOctaveSeed(seed, o), octLumaOff[o]);
        if (blur.taps > 1) img = blurPlate(ctx, img, pw, ph, blur.taps, blur.weights);
        plates.push({ img, w: pw, h: ph });
      }
    }

    // Tonal response LUT — baked once per curve, kept on the node.
    const lutKey = grainResponseKey(look.response_preset, params.response);
    const lut = ensureLut(ctx, nodeId, lutKey, () =>
      buildGrainResponseLut(grainResponseCurve(look.response_preset, params.response))
    );

    const tint = hexToRgb01(params.tint, [0.5, 0.5, 0.5]);
    const tintAmt = Math.max(0, Math.min(1, num(params.tint_amount, 0)));
    const octaveWeights = new Float32Array(GRAIN_MAX_OCTAVES);
    octaveWeights.set(octW);
    const compProg = ctx.getShader("grain/composite", GRAIN_COMPOSITE_FS);
    const composite = (target: ImageValue, view: number) =>
      ctx.drawFullscreen(compProg, target, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcImg ? srcImg.texture : null);
        gl.uniform1i(gl.getUniformLocation(compProg, "u_src"), 0);
        gl.uniform1i(gl.getUniformLocation(compProg, "u_hasSrc"), srcImg ? 1 : 0);
        for (let o = 0; o < GRAIN_MAX_OCTAVES; o++) {
          // Unused octave samplers get the base plate so every sampler
          // unit holds a complete texture.
          const p = plates[Math.min(o, plates.length - 1)];
          gl.activeTexture(gl.TEXTURE1 + o);
          gl.bindTexture(gl.TEXTURE_2D, p.img.texture);
          gl.uniform1i(gl.getUniformLocation(compProg, `u_plate${o}`), 1 + o);
          gl.uniform2f(gl.getUniformLocation(compProg, `u_plateSize${o}`), p.w, p.h);
        }
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, lut);
        gl.uniform1i(gl.getUniformLocation(compProg, "u_lut"), 4);
        gl.uniform1i(gl.getUniformLocation(compProg, "u_direct"), plateDirect ? 1 : 0);
        gl.uniform1i(gl.getUniformLocation(compProg, "u_octaves"), plates.length);
        gl.uniform1fv(gl.getUniformLocation(compProg, "u_ow"), octaveWeights);
        gl.uniform1f(gl.getUniformLocation(compProg, "u_lum"), lum);
        gl.uniform1f(gl.getUniformLocation(compProg, "u_chr"), chr);
        gl.uniform1f(gl.getUniformLocation(compProg, "u_sat"), Math.max(0, look.saturation));
        gl.uniform3f(gl.getUniformLocation(compProg, "u_tint"), tint[0], tint[1], tint[2]);
        gl.uniform1f(gl.getUniformLocation(compProg, "u_tintAmt"), tintAmt);
        gl.uniform1i(gl.getUniformLocation(compProg, "u_perChannel"), perChannel ? 1 : 0);
        gl.uniform3f(gl.getUniformLocation(compProg, "u_chSize"), chSize[0], chSize[1], chSize[2]);
        gl.uniform3f(gl.getUniformLocation(compProg, "u_chInt"), chInt[0], chInt[1], chInt[2]);
        gl.uniform1i(gl.getUniformLocation(compProg, "u_space"), grainSpaceIndex(look.space));
        gl.uniform1f(gl.getUniformLocation(compProg, "u_gain"), grainSpaceGain(look.space));
        gl.uniform1i(gl.getUniformLocation(compProg, "u_softClip"), params.soft_clip === true ? 1 : 0);
        gl.uniform2f(gl.getUniformLocation(compProg, "u_uvOffset"), driftX / W, driftY / H);
        gl.uniform1f(gl.getUniformLocation(compProg, "u_mix"), mixAmt);
        gl.uniform1i(gl.getUniformLocation(compProg, "u_mode"), mode);
        gl.uniform1i(gl.getUniformLocation(compProg, "u_view"), view);
      });
    composite(output, grainView ? 1 : 0);
    if (grainOut) composite(grainOut, 1);

    for (const p of plates) ctx.releaseTexture(p.img.texture);
    return result();
  },

  dispose(ctx, nodeId) {
    const state = ctx.state[stateKey(nodeId)] as GrainState | undefined;
    if (state?.lut) ctx.gl.deleteTexture(state.lut);
    delete ctx.state[stateKey(nodeId)];
  },
};

// Separable Gaussian over a plate at its own resolution. Two passes through
// a scratch texture; releases the source and returns a fresh plate.
function blurPlate(
  ctx: RenderContext,
  src: ImageValue,
  pw: number,
  ph: number,
  taps: number,
  weights: number[]
): ImageValue {
  const prog = ctx.getShader("grain/blur", GRAIN_BLUR_FS);
  const w = new Float32Array(GRAIN_BLUR_MAX_TAPS);
  w.set(weights);
  const pass = (from: ImageValue, to: ImageValue, sx: number, sy: number) =>
    ctx.drawFullscreen(prog, to, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, from.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform2f(gl.getUniformLocation(prog, "u_step"), sx, sy);
      gl.uniform1i(gl.getUniformLocation(prog, "u_taps"), taps);
      gl.uniform1fv(gl.getUniformLocation(prog, "u_w"), w);
    });
  const tmp = ctx.allocImage({ width: pw, height: ph });
  pass(src, tmp, 1 / pw, 0);
  const out = ctx.allocImage({ width: pw, height: ph });
  pass(tmp, out, 0, 1 / ph);
  ctx.releaseTexture(src.texture);
  ctx.releaseTexture(tmp.texture);
  return out;
}
