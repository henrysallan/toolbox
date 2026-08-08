import { OPACITY_PARAM } from "@/engine/conventions";
import type {
  ImageValue,
  InputSocketDef,
  MaskValue,
  NodeDefinition,
  ParamDef,
  RenderContext,
} from "@/engine/types";

// Physarum — GPU slime-mold transport-network simulation.
//
// Millions of agents sense a decaying trail field at three points
// (ahead, ahead-left, ahead-right), turn toward the strongest, step
// forward and deposit; the field then diffuses and decays. The emergent
// structure is the self-optimising vein network.
//
// Lineage (see specdocs/archive/080226_physarum.md):
//   - Jeff Jones (2010), "Characteristics of pattern formation and
//     evolution in approximations of Physarum transport networks" —
//     the base 3-sensor algorithm.
//   - Sage Jenson (mxsage), "36 Points" (sagejenson.com/36points) — the
//     parameterisation this node exposes: the four classic parameters
//     are FUNCTIONS of the value the agent senses at its own position,
//         param = base + scale * pow(sensedValue, power)
//     which is what turns one algorithm into a family of regimes.
//   - Etienne Jacob (Bleuje), "interactive-physarum"
//     (github.com/Bleuje/interactive-physarum, CC BY-NC-SA 3.0) — the
//     implementation ported here: the sqrt(count) deposit curve, the
//     diffusion kernel with its delayed second channel, the 24-Point
//     matrix, the colour modes, and the two-Point spatial interpolation.
//     Attribution + non-commercial share-alike apply to that material.
//
// WebGL2 has no compute shaders and no atomics, so the reference's
// per-pixel atomicAdd counter becomes an additive gl.POINTS draw into a
// half-float texture. Everything else maps one-to-one onto fullscreen
// passes. Pipeline per step:
//
//   clear count → move (agents) → count (POINTS, additive)
//     → deposit (trail += f(count)) → diffuse×N (box blur + decay)
//
// then one render pass upsamples trail+count to the canvas.

// ---- reference constants -----------------------------------------------

// The reference sim is 1280x736 with 5767168 agents and multiplies the
// `scale` terms by 250 px. We normalise against those so a preset looks
// like itself at any canvas size / agent count.
const REF_SIM_HEIGHT = 736;
const REF_PIXEL_SCALE = 250;
const REF_DENSITY = (512 * 512 * 22) / (1280 * 736); // ≈ 6.12 agents/px
// Per-pixel agent count above which extra agents stop adding deposit —
// the reference's LIMIT, what keeps saturated veins from blowing out.
const DEPOSIT_LIMIT = 100;

// E[sqrt(X)] for X ~ Poisson(lambda), summed directly (stable: p0 = e^-λ
// then p_{k+1} = p_k·λ/(k+1)).
//
// Why this exists: the deposit is `sqrt(count)`-weighted, and the count on
// a pixel is Poisson-distributed with mean = agents-per-pixel. Scaling the
// COUNT by a density factor does not scale its sqrt-expectation by the
// same factor — Jensen's inequality bites, hard, at low densities (a 28%
// deposit shortfall at ~1 agent/px). That shortfall would be cosmetic in
// most sims; here it is not, because every parameter is
// `base + scale·pow(sensed, power)` with powers up to 33, so a 28% error
// in the equilibrium trail becomes a 7× error in sensor distance and the
// presets stop looking like themselves. Correcting for it analytically is
// exact and costs one ~50-term CPU loop per eval.
function expectedSqrtPoisson(lambda: number): number {
  if (!(lambda > 0)) return 0;
  // Large λ: the direct sum needs too many terms and the asymptotic
  // expansion is accurate to better than 1e-4 well before this point.
  if (lambda > 400) return Math.sqrt(lambda) * (1 - 0.125 / lambda);
  let p = Math.exp(-lambda);
  let sum = 0;
  const kMax = Math.ceil(lambda + 10 * Math.sqrt(lambda) + 30);
  for (let k = 0; k <= kMax; k++) {
    sum += p * Math.sqrt(k);
    p = (p * lambda) / (k + 1);
  }
  return sum;
}

// ---- the 24 Points -----------------------------------------------------

// Columns: SD0 SDE SDA | SA0 SAE SAA | RA0 RAE RAA | MD0 MDE MDA | SB1 SB2 | SF
// (base / power / scale for sensor distance, sensor angle, rotation
// angle, move distance; then the two sensing-position biases and the
// sensed-value gain.) Verbatim from points_basematrix.h — the "default
// exponent when amplitude is 0" placeholders are resolved inline.
type PointRow = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
  number, number, number,
  number, number, number,
];

const DE_SD = 2.0;
const DE_SA = 1.0;
const DE_RA = 1.0;
const DE_MD = 3.0;

const POINTS: Record<string, PointRow> = {
  "pure multiscale":            [0.000, 4.000, 0.300, 0.100, 51.32, 20.00, 0.410, 4.000, 0.000, 0.100, 6.000, 0.100, 0.000, 0.000, 22.0],
  "hex hole open":              [0.000, 28.04, 14.53, 0.090, DE_SA, 0.000, 0.010, 1.400, 1.120, 0.830, DE_MD, 0.000, 0.570, 0.030, 36.0],
  "vertebrata":                 [17.92, DE_SD, 0.000, 0.520, DE_SA, 0.000, 0.180, DE_RA, 0.000, 0.100, 6.050, 0.170, 0.000, 0.000, 18.0],
  "star network":               [3.000, 10.17, 0.400, 1.030, 2.300, 2.000, 1.420, 20.00, 0.750, 0.830, 1.560, 0.110, 1.070, 0.000, 13.0],
  "enmeshed singularities":     [0.000, 8.510, 0.190, 0.610, DE_SA, 0.000, 3.350, DE_RA, 0.000, 0.750, 12.62, 0.060, 0.000, 0.000, 34.0],
  "waves upturn":               [0.000, 0.820, 0.030, 0.180, DE_SA, 0.000, 0.260, DE_RA, 0.000, 0.000, 20.00, 0.650, 0.200, 0.900, 31.5],
  "more individuals":           [1.500, 1.940, 0.280, 1.730, 1.120, 0.710, 0.180, 2.220, 0.850, 0.500, 4.130, 0.110, 1.120, 0.000, 15.0],
  "sloppy bucky":               [2.870, 3.040, 0.280, 0.090, DE_SA, 0.000, 0.440, 0.850, 0.000, 0.000, 2.220, 0.140, 0.300, 0.850, 11.0],
  "massive structure":          [0.140, 1.120, 0.190, 0.270, 1.400, 0.000, 1.130, 2.000, 0.390, 0.750, 2.220, 0.190, 0.000, 7.140, 9.00],
  "speed modulation":           [0.001, 2.540, 0.080, 0.000, DE_SA, 0.000, 3.350, DE_RA, 0.000, 0.100, 12.62, 0.060, 0.000, 0.000, 30.5],
  "transmission tower":         [0.000, 28.04, 20.00, 0.180, 26.74, 20.00, 0.010, 1.400, 1.120, 0.830, DE_MD, 0.000, 2.540, 0.000, 39.0],
  "ink on white":               [0.000, 20.00, 3.000, 0.260, 2.150, 4.760, 0.410, 6.600, 12.62, 0.300, 6.600, 0.037, 0.400, 0.040, 28.0],
  "vanishing points":           [27.50, 2.000, 2.540, 0.880, 26.74, 0.000, 0.090, 2.000, 1.400, 0.100, 5.000, 7.410, 1.400, 14.25, 12.0],
  "scaling nodule emergence":   [0.000, 6.000, 100.0, 0.157, 1.000, 1.070, 0.000, 1.000, 5.000, 0.830, 5.000, 20.00, 0.400, 0.000, 8.00],
  "hyp offset":                 [0.000, 15.00, 8.600, 0.030, DE_SA, 0.000, 0.340, 2.000, 1.070, 0.220, 15.00, 0.100, 2.300, 0.820, 38.0],
  "strike":                     [0.000, 32.88, 402.0, 0.410, 3.000, 0.000, 0.100, DE_RA, 0.000, 0.300, 6.000, 0.000, 0.000, 0.000, 32.0],
  "clear spaghetti":            [0.000, 0.800, 0.020, 5.200, DE_SA, 0.000, 0.260, 0.100, 2.790, 0.830, 32.88, 37.74, 0.090, 0.330, 22.0],
  "point R":                    [3.000, 10.17, 0.400, 1.030, 0.308, 0.000, 0.148, 20.00, 0.750, 0.830, 1.560, 0.110, 1.070, 0.040, 9.00],
  "point S":                    [0.000, 5.000, 0.050, 0.900, 2.800, 0.000, 0.006, 0.840, 1.110, 0.750, 1.200, 0.000, 0.000, 0.000, 21.0],
  "point T":                    [27.50, 28.04, 0.000, 0.390, 1.400, 0.000, 0.090, 0.846, 1.400, 0.100, 2.031, 0.070, 1.400, 0.030, 15.3],
  "point U":                    [0.000, 8.500, 0.029, 0.270, 0.000, 0.000, 0.410, 0.000, 0.000, 0.750, 12.62, 0.060, 0.840, 0.000, 31.8],
  "point V":                    [0.000, 6.370, 5.425, 1.030, 0.000, 0.000, 0.180, 0.289, 0.443, 0.300, 2.200, 0.065, 1.070, 0.040, 19.0],
  "point W":                    [1.464, 20.00, 80.00, 0.260, 2.150, 4.760, 1.513, 2.000, 12.62, 0.385, 12.62, 0.037, 1.000, 0.000, 25.0],
  "point X":                    [0.000, 6.000, 100.0, 0.650, 0.175, 1.284, 0.000, 0.600, 5.000, 0.830, 5.395, 20.00, 0.400, 0.000, 8.60],
};
const PRESET_NAMES = [...Object.keys(POINTS), "custom"];
// mxsage's first Point, and the one that most reads as "physarum": a
// true multiscale network, thick trunks down to hair-fine capillaries.
const DEFAULT_PRESET = "pure multiscale";

const COLOR_MODES = [
  "mono",
  "purple ice",
  "arctic",
  "ember",
  "gold",
  "neon",
  "zorg",
  "inferno ice",
  "spectral",
  "forest",
  "cyan trail",
];
const VIEWS = ["color", "trail", "count"];

// ---- shared GLSL -------------------------------------------------------

// PCG hash — the reference's randomness utils, but seeded from the agent
// INDEX and a per-step counter rather than from the agent's position.
// Position-seeded hashes make two agents that happen to share a pixel
// take identical "random" decisions forever, which shows up as clonal
// streaks; index-seeded ones don't.
const HASH_GLSL = `
uint pcg(uint v) {
  v = v * 747796405u + 2891336453u;
  uint w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (w >> 22u) ^ w;
}
float rnd(inout uint s) {
  s = pcg(s);
  return float(s) * (1.0 / 4294967296.0);
}`;

// ---- agent seeding -----------------------------------------------------

// Uniform random position + heading. `phase` is the respawn progress:
// staggered per agent so respawns are spread evenly over the cycle
// instead of every agent teleporting on the same step.
const SEED_FS = `#version 300 es
precision highp float;
uniform vec2 u_simSize;
uniform int u_agentW;
uniform uint u_seed;
out vec4 outColor;
${HASH_GLSL}
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  uint idx = uint(tc.y) * uint(u_agentW) + uint(tc.x);
  uint s = pcg(idx ^ pcg(u_seed));
  float x = rnd(s) * u_simSize.x;
  float y = rnd(s) * u_simSize.y;
  float h = rnd(s) * 6.28318530718;
  float p = rnd(s);
  outColor = vec4(x, y, h, p);
}`;

// ---- move --------------------------------------------------------------

// One agent per fragment. Reads its own state + the trail, writes the
// next state. This is computeshader_move.glsl with the installation-only
// features (gamepad waves, spawn bursts, inertia) removed and the
// two-Point interpolation driven by a mask instead of a cursor Gaussian.
//
// Each Point is packed as 4 vec4s so the A/B interpolation is four
// mix()es instead of fifteen:
//   q0 = (SD_base, SD_power, SD_scale, SA_base)
//   q1 = (SA_power, SA_scale, RA_base, RA_power)
//   q2 = (RA_scale, MD_base, MD_power, MD_scale)
//   q3 = (sensorY, sensorX, senseScale, -)
const MOVE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_agents;
uniform sampler2D u_trail;
uniform sampler2D u_blend;
uniform int u_hasBlend;
uniform vec2 u_simSize;
uniform int u_agentW;
uniform uint u_step;
uniform vec4 u_a[4];
uniform vec4 u_b[4];
uniform float u_pixelScale;
uniform float u_respawn;
out vec4 outColor;
${HASH_GLSL}

// The world is a torus: the trail textures are REPEAT-wrapped, so a raw
// pos/size UV wraps for free.
float sampleTrail(vec2 pos) {
  return texture(u_trail, pos / u_simSize).x;
}
float senseAt(float angle, vec2 pos, float heading, float dist) {
  return sampleTrail(pos + dist * vec2(cos(heading + angle), sin(heading + angle)));
}

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 st = texelFetch(u_agents, tc, 0);
  vec2 pos = st.xy;
  float heading = st.z;
  float phase = st.w;

  uint idx = uint(tc.y) * uint(u_agentW) + uint(tc.x);
  uint rs = pcg(idx ^ pcg(u_step));

  // Point A ↔ Point B, per agent, at the agent's own position.
  float lerper = 0.0;
  if (u_hasBlend == 1) {
    lerper = clamp(texture(u_blend, pos / u_simSize).r, 0.0, 1.0);
  }
  vec4 q0 = mix(u_a[0], u_b[0], lerper);
  vec4 q1 = mix(u_a[1], u_b[1], lerper);
  vec4 q2 = mix(u_a[2], u_b[2], lerper);
  vec4 q3 = mix(u_a[3], u_b[3], lerper);

  vec2 dir = vec2(cos(heading), sin(heading));

  // mxsage: sense ONE value at (or near) the agent, then let it set every
  // other parameter. u_a[3].xy are the two sensing-position biases —
  // sensorX along the heading, sensorY in world Y.
  float sensed = sampleTrail(pos + q3.y * dir + vec2(0.0, q3.x)) * q3.z;
  sensed = clamp(sensed, 1e-9, 1.0);

  // param = base + scale * pow(sensed, power). The distance-domain
  // scales additionally carry the reference's 250px pixel factor.
  float sensorDistance = q0.x + q0.z * pow(sensed, q0.y) * u_pixelScale;
  float sensorAngle    = q0.w + q1.y * pow(sensed, q1.x);
  float rotationAngle  = q1.z + q2.x * pow(sensed, q1.w);
  float moveDistance   = q2.y + q2.w * pow(sensed, q2.z) * u_pixelScale;

  float left   = senseAt(-sensorAngle, pos, heading, sensorDistance);
  float middle = senseAt(0.0, pos, heading, sensorDistance);
  float right  = senseAt(sensorAngle, pos, heading, sensorDistance);

  float newHeading = heading;
  if (middle > left && middle > right) {
    // straight on
  } else if (middle < left && middle < right) {
    newHeading = (rnd(rs) < 0.5) ? heading - rotationAngle : heading + rotationAngle;
  } else if (right < left) {
    newHeading = heading - rotationAngle;
  } else if (left < right) {
    newHeading = heading + rotationAngle;
  }

  vec2 next = pos + moveDistance * vec2(cos(newHeading), sin(newHeading));

  // Periodic respawn (mxsage): each agent teleports to a fresh random
  // spot once every 1/u_respawn steps. Without it the population locks
  // into whatever network it found first and the image goes static.
  phase += u_respawn;
  if (phase >= 1.0) {
    phase = fract(phase);
    next = vec2(rnd(rs) * u_simSize.x, rnd(rs) * u_simSize.y);
    newHeading = rnd(rs) * 6.28318530718;
  }

  next = mod(next + u_simSize, u_simSize);
  outColor = vec4(next, mod(newHeading, 6.28318530718), phase);
}`;

// ---- deposit-count (point draw) ----------------------------------------

// One point per agent, additively blended. This stands in for the
// reference's atomicAdd on a per-pixel counter — the sum of 1.0s landing
// on a texel IS the count. Half-float holds integers exactly well past
// the DEPOSIT_LIMIT of 100.
const COUNT_VS = `#version 300 es
precision highp float;
uniform sampler2D u_agents;
uniform int u_agentW;
uniform vec2 u_simSize;
void main() {
  int idx = gl_VertexID;
  int x = idx % u_agentW;
  int y = idx / u_agentW;
  vec2 pos = texelFetch(u_agents, ivec2(x, y), 0).xy;
  // Sim-pixel space → clip. No Y flip: the trail, the count texture and
  // the render pass all live in the same framebuffer-Y-up space, so the
  // engine's v_uv convention (v=0 at bottom) holds end to end.
  gl_Position = vec4((pos / u_simSize) * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;

const COUNT_FS = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(1.0, 0.0, 0.0, 0.0); }`;

// ---- deposit -----------------------------------------------------------

// The reference's own contribution: deposit grows as sqrt of the number
// of agents on the pixel, capped. Linear accumulation makes dense veins
// run away; sqrt keeps thin filaments legible next to saturated trunks.
const DEPOSIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_trail;
uniform sampler2D u_count;
uniform sampler2D u_inject;
uniform int u_hasInject;
uniform float u_deposit;
uniform float u_density;
uniform float u_inject_amount;
uniform float u_limit;
out vec4 outColor;
void main() {
  vec2 prev = texture(u_trail, v_uv).xy;
  float count = texelFetch(u_count, ivec2(gl_FragCoord.xy), 0).x * u_density;
  float added = sqrt(min(count, u_limit)) * u_deposit;
  if (u_hasInject == 1) {
    added += texture(u_inject, v_uv).r * u_inject_amount;
  }
  outColor = vec4(prev.x + added, prev.y, 0.0, 1.0);
}`;

// ---- diffuse -----------------------------------------------------------

// Separable box blur, then decay. The G channel is the reference's
// DELAYED trail — a low-pass of the trail over time (0.8 new + 0.2 old).
// The difference between the two channels is "where the network changed
// recently", which is what several colour modes key off.
//
// The radius is SCALED WITH RESOLUTION, which the reference's fixed 3x3
// kernel is not. That matters here: structure scale is set by the ratio
// of agent stride to diffusion length, so a fixed 1-texel kernel makes
// `resolution` a regime knob (halving it turns a vein network into a
// labyrinth) and a 4K export stops resembling its 1080p preview. Scaling
// the kernel with the same factor the distances use keeps the picture
// frame-relative. Separable so the cost is 2(2R+1) taps, not (2R+1)².
const DIFFUSE_MAX_RADIUS = 8;
const DIFFUSE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_trail;
uniform vec2 u_step;
uniform float u_decay;
uniform int u_applyDecay;
uniform int u_radius;
out vec4 outColor;
void main() {
  vec2 sum = vec2(0.0);
  float n = 0.0;
  for (int i = -${DIFFUSE_MAX_RADIUS}; i <= ${DIFFUSE_MAX_RADIUS}; i++) {
    if (i < -u_radius || i > u_radius) continue;
    sum += texture(u_trail, v_uv + u_step * float(i)).xy;
    n += 1.0;
  }
  vec2 c = sum / max(n, 1.0);
  if (u_applyDecay == 1) {
    float decayed = c.x * u_decay;
    outColor = vec4(decayed, 0.8 * decayed + 0.2 * c.y, 0.0, 1.0);
  } else {
    outColor = vec4(c, 0.0, 1.0);
  }
}`;

// ---- render ------------------------------------------------------------

// Colour modes ported from computeshader_deposit.glsl. Every palette is
// a piecewise-linear ramp over 5, 6 or 7 stops.
const RENDER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_trail;
uniform sampler2D u_count;
uniform float u_density;
uniform int u_mode;
uniform int u_view;
uniform int u_transparent;
out vec4 outColor;

vec3 grad5(float f, vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec3 c4) {
  f = clamp(f, 0.0, 1.0) * 4.0;
  int i = int(floor(f));
  float t = f - float(i);
  vec3 a = i == 0 ? c0 : (i == 1 ? c1 : (i == 2 ? c2 : (i == 3 ? c3 : c4)));
  vec3 b = i == 0 ? c1 : (i == 1 ? c2 : (i == 2 ? c3 : c4));
  return mix(a, b, t);
}
vec3 grad6(float f, vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec3 c4, vec3 c5) {
  f = clamp(f, 0.0, 1.0) * 5.0;
  int i = int(floor(f));
  float t = f - float(i);
  vec3 a = i == 0 ? c0 : (i == 1 ? c1 : (i == 2 ? c2 : (i == 3 ? c3 : (i == 4 ? c4 : c5))));
  vec3 b = i == 0 ? c1 : (i == 1 ? c2 : (i == 2 ? c3 : (i == 3 ? c4 : c5)));
  return mix(a, b, t);
}
vec3 grad7(float f, vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec3 c4, vec3 c5, vec3 c6) {
  f = clamp(f, 0.0, 1.0) * 6.0;
  int i = int(floor(f));
  float t = f - float(i);
  vec3 a = i == 0 ? c0 : (i == 1 ? c1 : (i == 2 ? c2 : (i == 3 ? c3 : (i == 4 ? c4 : (i == 5 ? c5 : c6)))));
  vec3 b = i == 0 ? c1 : (i == 1 ? c2 : (i == 2 ? c3 : (i == 3 ? c4 : (i == 4 ? c5 : c6))));
  return mix(a, b, t);
}

vec3 gZorg(float f) {
  return grad5(f, vec3(0.0), vec3(0.0), vec3(0.07, 0.18, 0.38), vec3(1.0, 0.0, 0.56), vec3(0.58, 1.0, 0.2));
}
vec3 gOrangeBlue(float f) {
  return grad7(f, vec3(0.0), vec3(0.0), vec3(0.1, 0.2, 0.4), vec3(0.0, 0.5, 0.6), vec3(0.8, 0.4, 0.2), vec3(0.9, 0.6, 0.3), vec3(1.0, 0.9, 0.0));
}
vec3 gGreen(float f) {
  return grad7(f, vec3(0.0), vec3(0.0), vec3(0.0, 0.3, 0.2), vec3(0.1, 0.7, 0.7), vec3(0.8, 0.5, 0.3), vec3(0.9, 0.7, 0.5), vec3(1.0));
}
vec3 gPurpleFire(float f) {
  return grad7(f, vec3(0.0), vec3(0.0), vec3(0.1, 0.3, 0.6), vec3(0.3, 0.2, 0.5), vec3(0.7, 0.2, 0.3), vec3(0.9, 0.5, 0.2), vec3(1.0, 0.9, 0.1));
}
vec3 gArctic(float f) {
  return grad7(f, vec3(0.0), vec3(0.0), vec3(0.0, 0.1, 0.3), vec3(0.0, 0.3, 0.5), vec3(0.1, 0.6, 0.8), vec3(0.4, 0.8, 1.0), vec3(0.85, 0.96, 1.0));
}
vec3 gNeon(float f) {
  return grad6(f, vec3(0.0), vec3(0.2, 0.0, 0.3), vec3(0.6, 0.0, 0.6), vec3(0.8, 0.1, 0.2), vec3(1.0, 0.5, 0.1), vec3(1.0));
}

void main() {
  vec2 trail = texture(u_trail, v_uv).xy;
  float count = texture(u_count, v_uv).x * u_density;

  // The reference's count→intensity curve. Deliberately steep: it holds
  // the empty field at true black while letting veins reach full white
  // over a narrow band of densities.
  float cv = pow(tanh(7.5 * pow(max(0.0, (count - 1.0) / 1000.0), 0.3)), 8.5) * 1.1;
  cv = clamp(cv, 0.0, 1.0);
  float tv = pow(tanh(9.0 * pow(max(0.0, (250.0 * trail.y - 1.0) / 1100.0), 0.3)), 8.5) * 1.05;
  tv = clamp(tv, 0.0, 1.0);

  if (u_view == 1) {
    float g = clamp(trail.x, 0.0, 1.0);
    outColor = vec4(vec3(g), 1.0);
    return;
  }
  if (u_view == 2) {
    outColor = vec4(vec3(cv), 1.0);
    return;
  }

  // Radial offset — several modes shift hue with distance from centre.
  vec2 p = (v_uv - 0.5) * 1.2;
  float offset = length(p);
  float temporalDiff = trail.x - trail.y;
  float blend = tanh(500.0 * temporalDiff + 2.0 * offset);
  vec3 col2 = vec3(cv);
  vec3 col = col2;

  if (u_mode == 0) {
    col = col2;
  } else if (u_mode == 1) {
    col = mix(gPurpleFire(tanh(cv * 1.3)), gArctic(tanh(cv * 1.3)), blend);
    col = clamp(1.25 * col, 0.0, 1.0);
  } else if (u_mode == 2) {
    col = mix(gArctic(fract(tanh(cv * 0.6 + offset) + 0.15)), col2, blend);
  } else if (u_mode == 3) {
    col = mix(gPurpleFire(tanh(cv * 1.3)), col2, blend);
  } else if (u_mode == 4) {
    col = mix(gOrangeBlue(tanh(cv * 1.3 + offset)), col2, blend);
  } else if (u_mode == 5) {
    col = mix(gNeon(tanh(cv * 1.3)), col2, blend);
  } else if (u_mode == 6) {
    col = mix(gZorg(fract(tanh(cv * 0.6 + offset) + 0.15)), gArctic(tanh(cv * 1.3)), blend);
    col = clamp(1.5 * pow(col, vec3(1.1)), 0.0, 1.0);
  } else if (u_mode == 7) {
    col = mix(gNeon(tanh(cv * 1.3)), gArctic(tanh(cv * 1.3)), blend);
    col = clamp(1.1 * col, 0.0, 1.0);
  } else if (u_mode == 8) {
    vec3 c1 = gOrangeBlue(tanh(cv * 1.3 + offset));
    vec3 cg = gGreen(tanh(cv * 2.3 + offset));
    vec3 c2b = mix(vec3(clamp(1.3 * cv, 0.0, 1.0)), cg, 0.5);
    vec3 c3 = mix(c2b, c1, 1.0 - 0.6 * tanh(sin(-1500.0 * abs(temporalDiff)) + 2.0 * offset));
    vec3 c6 = 1.25 * mix(c1, col2, blend);
    c6 = pow(c6, vec3(2.0));
    col = max(c6, c3);
  } else if (u_mode == 9) {
    col = mix(gGreen(tanh(cv * 1.3)), col2, blend);
  } else {
    col = vec3(cv, tv, tv);
  }

  col = clamp(col, 0.0, 1.0);
  float a = 1.0;
  if (u_transparent == 1) {
    // Straight alpha: coverage from luminance, colour left alone so the
    // network composites over whatever is beneath it.
    a = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
  }
  outColor = vec4(col, a);
}`;

// Single-channel taps for the aux mask outputs.
const AUX_TRAIL_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_trail;
out vec4 outColor;
void main() { outColor = vec4(clamp(texture(u_trail, v_uv).x, 0.0, 1.0), 0.0, 0.0, 1.0); }`;

const AUX_COUNT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_count;
uniform float u_density;
out vec4 outColor;
void main() {
  float count = texture(u_count, v_uv).x * u_density;
  float cv = pow(tanh(7.5 * pow(max(0.0, (count - 1.0) / 1000.0), 0.3)), 8.5) * 1.1;
  outColor = vec4(clamp(cv, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

// ---- GL helpers --------------------------------------------------------

type TexFormat = "rgba32f" | "rgba16f";

function makeTex(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  format: TexFormat,
  filter: number,
  wrap: number
): ImageValue {
  const tex = gl.createTexture();
  if (!tex) throw new Error("physarum: createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (format === "rgba32f") {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { kind: "image", texture: tex, width: w, height: h };
}

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
  what: string
): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error(`physarum: createShader failed (${what})`);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`physarum: ${what} compile failed: ${log}`);
  }
  return s;
}

// The count pass is the only one with a custom VERTEX shader, so it
// can't go through ctx.getShader (which links against the engine's
// shared fullscreen VS). Built once per node and torn down in dispose.
function buildCountProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, COUNT_VS, "count VS");
  const fs = compile(gl, gl.FRAGMENT_SHADER, COUNT_FS, "count FS");
  const p = gl.createProgram();
  if (!p) throw new Error("physarum: createProgram failed");
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`physarum: count link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

// ---- persistent state --------------------------------------------------

interface PhysarumState {
  agents: [ImageValue, ImageValue];
  agentIdx: 0 | 1;
  agentW: number;
  agentCount: number;
  trail: [ImageValue, ImageValue];
  trailIdx: 0 | 1;
  count: ImageValue;
  simW: number;
  simH: number;
  fbo: WebGLFramebuffer;
  vao: WebGLVertexArrayObject;
  countProgram: WebGLProgram;
  seeded: boolean;
  trailReady: boolean;
  lastTime: number;
  lastDriver: number;
  stepCount: number;
}

// MUST be prefixed with the registered node type — the evaluator's
// dispose sweep resolves the key's first `:` segment through getNodeDef.
function stateKey(nodeId: string): string {
  return `physarum:${nodeId}`;
}

function freeAgents(ctx: RenderContext, st: PhysarumState) {
  ctx.releaseTexture(st.agents[0].texture);
  ctx.releaseTexture(st.agents[1].texture);
}
function freeField(ctx: RenderContext, st: PhysarumState) {
  ctx.releaseTexture(st.trail[0].texture);
  ctx.releaseTexture(st.trail[1].texture);
  ctx.releaseTexture(st.count.texture);
}
function disposeState(ctx: RenderContext, st: PhysarumState) {
  const gl = ctx.gl;
  freeAgents(ctx, st);
  freeField(ctx, st);
  gl.deleteFramebuffer(st.fbo);
  gl.deleteVertexArray(st.vao);
  gl.deleteProgram(st.countProgram);
}

function ensureState(
  ctx: RenderContext,
  nodeId: string,
  agentW: number,
  simW: number,
  simH: number
): PhysarumState {
  const key = stateKey(nodeId);
  const gl = ctx.gl;
  const existing = ctx.state[key] as PhysarumState | undefined;

  if (existing) {
    // Field and agents resize INDEPENDENTLY: bumping the agent count
    // mid-run reseeds the population but keeps the network it grew.
    if (existing.simW !== simW || existing.simH !== simH) {
      freeField(ctx, existing);
      existing.trail = [
        makeTex(gl, simW, simH, "rgba16f", gl.LINEAR, gl.REPEAT),
        makeTex(gl, simW, simH, "rgba16f", gl.LINEAR, gl.REPEAT),
      ];
      existing.count = makeTex(gl, simW, simH, "rgba16f", gl.LINEAR, gl.CLAMP_TO_EDGE);
      existing.trailIdx = 0;
      existing.simW = simW;
      existing.simH = simH;
      existing.trailReady = false;
      existing.seeded = false; // agent positions are in sim pixels
    }
    if (existing.agentW !== agentW) {
      freeAgents(ctx, existing);
      existing.agents = [
        makeTex(gl, agentW, agentW, "rgba32f", gl.NEAREST, gl.CLAMP_TO_EDGE),
        makeTex(gl, agentW, agentW, "rgba32f", gl.NEAREST, gl.CLAMP_TO_EDGE),
      ];
      existing.agentIdx = 0;
      existing.agentW = agentW;
      existing.agentCount = agentW * agentW;
      existing.seeded = false;
    }
    return existing;
  }

  const st: PhysarumState = {
    agents: [
      makeTex(gl, agentW, agentW, "rgba32f", gl.NEAREST, gl.CLAMP_TO_EDGE),
      makeTex(gl, agentW, agentW, "rgba32f", gl.NEAREST, gl.CLAMP_TO_EDGE),
    ],
    agentIdx: 0,
    agentW,
    agentCount: agentW * agentW,
    trail: [
      makeTex(gl, simW, simH, "rgba16f", gl.LINEAR, gl.REPEAT),
      makeTex(gl, simW, simH, "rgba16f", gl.LINEAR, gl.REPEAT),
    ],
    trailIdx: 0,
    count: makeTex(gl, simW, simH, "rgba16f", gl.LINEAR, gl.CLAMP_TO_EDGE),
    simW,
    simH,
    fbo: gl.createFramebuffer()!,
    vao: gl.createVertexArray()!,
    countProgram: buildCountProgram(gl),
    seeded: false,
    trailReady: false,
    lastTime: ctx.time,
    lastDriver: -Infinity,
    stepCount: 0,
  };
  ctx.state[key] = st;
  return st;
}

// ---- param resolution --------------------------------------------------

// Resolve one Point to the 4 packed vec4s the move shader wants,
// applying the always-visible multipliers and the resolution
// normalisation. `suffix` selects the A ("") or B ("_b") param block.
function resolvePoint(
  params: Record<string, unknown>,
  suffix: string,
  distScale: number,
  turnMult: number,
  angleMult: number,
  senseMult: number
): Float32Array {
  const presetName = (params[`preset${suffix}`] as string) ?? DEFAULT_PRESET;
  const num = (n: string, d: number) => {
    const v = params[`${n}${suffix}`];
    return typeof v === "number" && Number.isFinite(v) ? v : d;
  };
  let r: PointRow;
  if (presetName === "custom") {
    // Fallbacks mirror the DEFAULT_PRESET row, so flipping a fresh node
    // to `custom` starts where the preset left off instead of jumping.
    r = [
      num("sd_base", 0), num("sd_power", 4), num("sd_scale", 0.3),
      num("sa_base", 0.1), num("sa_power", 51.32), num("sa_scale", 20),
      num("ra_base", 0.41), num("ra_power", 4), num("ra_scale", 0),
      num("md_base", 0.1), num("md_power", 6), num("md_scale", 0.1),
      num("sensor_y", 0), num("sensor_x", 0), num("sense_scale", 22),
    ];
  } else {
    r = POINTS[presetName] ?? POINTS[DEFAULT_PRESET];
  }
  const out = new Float32Array(16);
  // Distance-domain resolution scaling is applied ONCE. The `base`
  // columns and the two sensor offsets are raw pixels, so they get
  // distScale here; the `scale` columns are multiplied by u_pixelScale in
  // the shader, which already carries distScale — scaling them here too
  // would square it.
  // q0 = SD base/power/scale, SA base
  out[0] = r[0] * distScale;
  out[1] = r[1];
  out[2] = r[2];
  out[3] = r[3] * angleMult;
  // q1 = SA power/scale, RA base/power
  out[4] = r[4];
  out[5] = r[5] * angleMult;
  out[6] = r[6] * turnMult;
  out[7] = r[7];
  // q2 = RA scale, MD base/power/scale
  out[8] = r[8] * turnMult;
  out[9] = r[9] * distScale;
  out[10] = r[10];
  out[11] = r[11];
  // q3 = sensorY, sensorX, senseScale
  out[12] = r[12] * distScale;
  out[13] = r[13] * distScale;
  out[14] = r[14] * senseMult;
  out[15] = 0;
  return out;
}

// ---- params ------------------------------------------------------------

// The 15 raw numbers of one Point, generated for A ("") and B ("_b").
// Laid out to match the reference's own UI order.
function pointParams(suffix: string, group: string, gate: (p: Record<string, unknown>) => boolean): ParamDef[] {
  // Defaults are DEFAULT_PRESET's row (kept in sync with resolvePoint's
  // custom fallbacks). softMax covers the whole 24-Point matrix's range
  // for that column; `max` leaves an escape hatch far above it.
  const rows: Array<[string, string, number, number, number, number]> = [
    // name, label, min, softMax, step, default
    ["sd_base", "Sensor distance base", 0, 30, 0.01, 0],
    ["sd_power", "Sensor distance power", 0, 35, 0.01, 4],
    ["sd_scale", "Sensor distance scale", 0, 20, 0.001, 0.3],
    ["sa_base", "Sensor angle base", 0, 6, 0.001, 0.1],
    ["sa_power", "Sensor angle power", 0, 52, 0.01, 51.32],
    ["sa_scale", "Sensor angle scale", 0, 20, 0.01, 20],
    ["ra_base", "Rotation angle base", 0, 6, 0.001, 0.41],
    ["ra_power", "Rotation angle power", 0, 20, 0.01, 4],
    ["ra_scale", "Rotation angle scale", 0, 13, 0.01, 0],
    ["md_base", "Move distance base", 0, 4, 0.001, 0.1],
    ["md_power", "Move distance power", 0, 33, 0.01, 6],
    ["md_scale", "Move distance scale", 0, 20, 0.001, 0.1],
    ["sensor_y", "Sensor Y offset", -8, 8, 0.01, 0],
    ["sensor_x", "Sensor X offset", -16, 16, 0.01, 0],
    ["sense_scale", "Sense scale", 0, 60, 0.1, 22],
  ];
  return rows.map(([name, label, min, softMax, step, def]) => ({
    name: `${name}${suffix}`,
    label,
    type: "scalar" as const,
    min,
    max: min < 0 ? -min * 40 : softMax * 40,
    softMax,
    step,
    default: def,
    group,
    visibleIf: gate,
  }));
}

const isCustomA = (p: Record<string, unknown>) => p.preset === "custom";
const isCustomB = (p: Record<string, unknown>) =>
  !!p.two_points && p.preset_b === "custom";

// ---- node definition ---------------------------------------------------

let warnedNoFloat = false;

export const physarumNode: NodeDefinition = {
  type: "physarum",
  name: "Physarum",
  category: "image",
  subcategory: "generator",
  description:
    "GPU slime-mold (Physarum) transport network. Millions of agents sense a decaying trail field ahead-left / ahead / ahead-right, turn toward the strongest, step and deposit; the field diffuses and decays, and self-optimising vein networks emerge. Uses Sage Jenson's 36 Points parameterisation — every classic parameter is `base + scale * sensed^power`, so one algorithm covers 24 wildly different regimes. Pick a `preset`, then ride the four multipliers on top of it: `sense scale` is the most expressive (it slides the whole system between regimes), `turn` and `sensor angle` reshape the branching, and `scale` sets structure size — raise `blur passes` with it, since structure size is really the ratio of agent stride to diffusion width and `scale` alone just makes agents outrun the field. `custom` opens all 15 raw numbers. `agents` is a quality knob, not a look knob (the deposit is density-normalised), and `resolution` is fidelity above ~740px of sim height and a zoom below it. Wire a mask into `inject` to draw structure the agents colonise. Turn on `two points` and wire a mask into `blend` to run two different presets in different parts of the frame with a continuous frontier — a Circle driven by the Cursor node reproduces the original's interactive pen. Plays while the timeline runs; restarting the timeline reseeds. Algorithm: Jones 2010 / mxsage 36 Points; implementation ported from Etienne Jacob's interactive-physarum (CC BY-NC-SA 3.0).",
  backend: "webgl2",
  // Self-iterating: the image depends on accumulated steps, not just the
  // current params.
  stable: false,
  simulation: true,
  inputs: [
    { name: "blend", type: "mask", required: false },
    { name: "inject", type: "mask", required: false },
  ],
  resolveInputs(params): InputSocketDef[] {
    const base: InputSocketDef[] = [
      { name: "blend", type: "mask", required: false },
      { name: "inject", type: "mask", required: false },
    ];
    if (params.drive_by_scene_time) {
      base.push({ name: "time", type: "scalar", required: false });
    }
    return base;
  },
  params: [
    // --- Point A -------------------------------------------------------
    {
      name: "preset",
      label: "Preset",
      type: "enum",
      options: PRESET_NAMES,
      default: DEFAULT_PRESET,
      group: "point_a",
      groupHeader: true,
    },
    ...pointParams("", "point_a", isCustomA),

    // --- Point B -------------------------------------------------------
    {
      name: "two_points",
      label: "Two points",
      type: "boolean",
      default: false,
      group: "point_b",
      groupHeader: true,
    },
    {
      name: "preset_b",
      label: "Preset B",
      type: "enum",
      options: PRESET_NAMES,
      default: "vertebrata",
      group: "point_b",
      visibleIf: (p) => !!p.two_points,
    },
    ...pointParams("_b", "point_b", isCustomB),

    // --- multipliers (ride on top of ANY preset) -----------------------
    {
      name: "scale",
      label: "Scale",
      type: "scalar",
      min: 0.05,
      max: 20,
      softMax: 4,
      step: 0.01,
      default: 1,
    },
    {
      name: "turn_mult",
      label: "Turn",
      type: "scalar",
      min: 0,
      max: 20,
      softMax: 4,
      step: 0.01,
      default: 1,
    },
    {
      name: "angle_mult",
      label: "Sensor angle",
      type: "scalar",
      min: 0,
      max: 20,
      softMax: 4,
      step: 0.01,
      default: 1,
    },
    {
      name: "sense_mult",
      label: "Sense scale",
      type: "scalar",
      min: 0,
      max: 20,
      softMax: 4,
      step: 0.01,
      default: 1,
    },

    // --- field ---------------------------------------------------------
    {
      name: "deposit",
      label: "Deposit amount",
      type: "scalar",
      min: 0,
      max: 0.5,
      softMax: 0.02,
      step: 0.0001,
      default: 0.003,
    },
    {
      name: "decay",
      label: "Decay rate",
      type: "scalar",
      min: 0.1,
      max: 1,
      step: 0.001,
      default: 0.75,
    },
    {
      name: "blur_passes",
      label: "Blur passes",
      type: "scalar",
      min: 0,
      max: 6,
      step: 1,
      default: 1,
    },
    {
      name: "respawn_rate",
      label: "Respawn rate",
      type: "scalar",
      min: 0,
      max: 0.2,
      softMax: 0.02,
      step: 0.0001,
      default: 0.001,
    },
    {
      name: "inject_amount",
      label: "Inject amount",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.1,
      step: 0.0005,
      default: 0.01,
    },

    // --- system --------------------------------------------------------
    {
      name: "agents",
      label: "Agents",
      type: "scalar",
      min: 1024,
      max: 4194304,
      softMax: 1048576,
      step: 1024,
      default: 500000,
    },
    {
      name: "resolution",
      label: "Resolution",
      type: "scalar",
      min: 0.1,
      max: 1,
      step: 0.05,
      default: 0.5,
    },
    {
      name: "steps_per_frame",
      label: "Steps / frame",
      type: "scalar",
      min: 1,
      max: 16,
      softMax: 4,
      step: 1,
      default: 1,
    },
    {
      name: "normalize_density",
      label: "Normalize density",
      type: "boolean",
      default: true,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 100000,
      step: 1,
      default: 0,
    },

    // --- look ----------------------------------------------------------
    {
      name: "view",
      label: "View",
      type: "enum",
      options: VIEWS,
      default: "color",
    },
    {
      name: "color_mode",
      label: "Color mode",
      type: "enum",
      options: COLOR_MODES,
      default: "purple ice",
      visibleIf: (p) => (p.view ?? "color") === "color",
    },
    {
      name: "transparent_bg",
      label: "Transparent background",
      type: "boolean",
      default: false,
    },
    {
      name: "drive_by_scene_time",
      label: "Drive by time input",
      type: "boolean",
      default: false,
    },
    OPACITY_PARAM,
  ],
  primaryOutput: "image",
  auxOutputs: [
    { name: "trail", type: "mask" },
    { name: "count", type: "mask" },
  ],
  headerControl: { paramName: "view" },

  fingerprintExtras(_params, ctx) {
    return `t:${ctx.time.toFixed(4)}`;
  },

  compute({ inputs, params, ctx, nodeId, consumedOutputs }) {
    // RGBA32F agent state and half-float render targets both need this.
    // Without it there is no simulation to run — fail visibly (black),
    // not silently.
    if (!ctx.gl.getExtension("EXT_color_buffer_float")) {
      if (!warnedNoFloat) {
        console.warn(
          "physarum: EXT_color_buffer_float unavailable — simulation disabled."
        );
        warnedNoFloat = true;
      }
      const out = ctx.allocImage();
      ctx.clearTarget(out, [0, 0, 0, 1]);
      return { primary: out };
    }

    const gl = ctx.gl;
    const rez = Math.max(0.1, Math.min(1, (params.resolution as number) ?? 0.5));
    const simW = Math.max(8, Math.round(ctx.width * rez));
    const simH = Math.max(8, Math.round(ctx.height * rez));
    const requested = Math.max(
      1024,
      Math.min(4194304, Math.floor((params.agents as number) ?? 500000))
    );
    // The whole agent texture is live, so the effective population rounds
    // up to the next perfect square — no dead texels depositing at (0,0).
    const agentW = Math.ceil(Math.sqrt(requested));

    const st = ensureState(ctx, nodeId, agentW, simW, simH);

    // --- reset ---------------------------------------------------------
    const wasNonZero = st.lastTime > 0.05;
    const isNearZero = ctx.time < 0.05;
    const resetField = !st.trailReady || (wasNonZero && isNearZero);
    const reseedAgents = !st.seeded || resetField;

    if (resetField) {
      ctx.clearTarget(st.trail[0], [0, 0, 0, 1]);
      ctx.clearTarget(st.trail[1], [0, 0, 0, 1]);
      ctx.clearTarget(st.count, [0, 0, 0, 0]);
      st.trailIdx = 0;
      st.trailReady = true;
      st.stepCount = 0;
      st.lastDriver =
        inputs.time?.kind === "scalar" ? inputs.time.value : 0;
    }
    if (reseedAgents) {
      const seedProg = ctx.getShader("physarum/seed", SEED_FS);
      const seedVal = Math.floor((params.seed as number) ?? 0) >>> 0;
      for (const target of st.agents) {
        ctx.drawFullscreen(seedProg, target, (g) => {
          g.uniform2f(g.getUniformLocation(seedProg, "u_simSize"), simW, simH);
          g.uniform1i(g.getUniformLocation(seedProg, "u_agentW"), agentW);
          g.uniform1ui(g.getUniformLocation(seedProg, "u_seed"), seedVal + 1);
        });
      }
      st.agentIdx = 0;
      st.seeded = true;
    }

    // --- advance gate ---------------------------------------------------
    let active: boolean;
    if (params.drive_by_scene_time) {
      const driver = inputs.time?.kind === "scalar" ? inputs.time.value : 0;
      active = driver > st.lastDriver + 1e-6;
      st.lastDriver = driver;
    } else {
      // Offline export renders each frame exactly once with ctx.playing
      // false — advance on the time delta instead so exports match
      // playback step for step.
      active = ctx.playing || (ctx.offline && ctx.time > st.lastTime + 1e-6);
    }
    st.lastTime = ctx.time;

    // --- resolved params ------------------------------------------------
    // Distance scaling, clamped at the reference scale from below.
    //
    // Structure size is set by the ratio of agent stride to diffusion
    // length, and diffusion cannot be narrower than one texel. Scaling
    // distances DOWN at low resolution therefore pushes them under the
    // diffusion floor and the network collapses into a labyrinth. So:
    // above the reference sim height, distances and the blur radius scale
    // together and the picture stays frame-relative (a 4K export looks
    // like its 1080p preview); at or below it, the sim runs at reference
    // pixel scale and lower resolutions simply read as zoomed in.
    const userScale = Math.max(0.01, (params.scale as number) ?? 1);
    const distScale = Math.max(1, simH / REF_SIM_HEIGHT) * userScale;
    const turnMult = Math.max(0, (params.turn_mult as number) ?? 1);
    const angleMult = Math.max(0, (params.angle_mult as number) ?? 1);
    const senseMult = Math.max(0, (params.sense_mult as number) ?? 1);
    const pointA = resolvePoint(params, "", distScale, turnMult, angleMult, senseMult);
    const twoPoints = !!params.two_points;
    const pointB = twoPoints
      ? resolvePoint(params, "_b", distScale, turnMult, angleMult, senseMult)
      : pointA;

    // Density normalisation, in two parts.
    //
    // `densityScale` rescales the per-pixel count into the reference's
    // range, so the DEPOSIT_LIMIT cap and the colour curve keep meaning
    // the same thing at any agent count. `depositCorrection` then fixes
    // the sqrt-of-a-Poisson bias that scaling alone leaves behind, so the
    // equilibrium trail level — and therefore every `pow(sensed, power)`
    // downstream — matches the reference exactly. Without the second
    // term, agent count silently changes the regime instead of just the
    // fidelity.
    const density = st.agentCount / (simW * simH);
    const normalize = params.normalize_density !== false;
    const densityScale = normalize
      ? Math.max(0.02, Math.min(50, REF_DENSITY / Math.max(density, 1e-6)))
      : 1;
    const delivered = Math.sqrt(densityScale) * expectedSqrtPoisson(density);
    const depositCorrection =
      normalize && delivered > 1e-6
        ? Math.max(0.05, Math.min(20, expectedSqrtPoisson(REF_DENSITY) / delivered))
        : 1;

    const blend = inputs.blend?.kind === "mask" ? inputs.blend : null;
    const inject = inputs.inject?.kind === "mask" ? inputs.inject : null;
    const depositAmount = Math.max(0, (params.deposit as number) ?? 0.003);
    const injectAmount = Math.max(0, (params.inject_amount as number) ?? 0.01);
    const decay = Math.max(0, Math.min(1, (params.decay as number) ?? 0.75));
    const blurPasses = Math.max(
      0,
      Math.min(6, Math.round((params.blur_passes as number) ?? 1))
    );
    const respawn = Math.max(0, (params.respawn_rate as number) ?? 0.001);
    // Diffusion radius tracks the distance scaling so structure stays
    // frame-relative across resolutions (see DIFFUSE_FS). Below the
    // reference's own sim height it clamps at 1 texel — you cannot
    // diffuse less than a texel — so very low resolutions do coarsen.
    const blurRadius = Math.max(
      1,
      Math.min(DIFFUSE_MAX_RADIUS, Math.round(distScale))
    );
    // Paused, the sim holds still. But a just-reset field is empty, so a
    // node dropped on a paused timeline (or a scrub back to 0) would show
    // pure black and read as broken — take one step so there is always
    // something on screen.
    const steps = active
      ? Math.max(1, Math.min(16, Math.round((params.steps_per_frame as number) ?? 1)))
      : resetField
        ? 1
        : 0;

    const moveProg = ctx.getShader("physarum/move", MOVE_FS);
    const depositProg = ctx.getShader("physarum/deposit", DEPOSIT_FS);
    const diffuseProg = ctx.getShader("physarum/diffuse", DIFFUSE_FS);

    for (let s = 0; s < steps; s++) {
      st.stepCount = (st.stepCount + 1) >>> 0;

      // 1. clear the per-pixel counter.
      ctx.clearTarget(st.count, [0, 0, 0, 0]);

      // 2. move: agents[i] + trail → agents[i^1].
      const readAgents = st.agents[st.agentIdx];
      const writeAgents = st.agents[st.agentIdx ^ 1];
      const readTrail = st.trail[st.trailIdx];
      ctx.drawFullscreen(moveProg, writeAgents, (g) => {
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, readAgents.texture);
        g.uniform1i(g.getUniformLocation(moveProg, "u_agents"), 0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, readTrail.texture);
        g.uniform1i(g.getUniformLocation(moveProg, "u_trail"), 1);
        g.activeTexture(g.TEXTURE2);
        g.bindTexture(g.TEXTURE_2D, (blend ?? readTrail).texture);
        g.uniform1i(g.getUniformLocation(moveProg, "u_blend"), 2);
        g.uniform1i(g.getUniformLocation(moveProg, "u_hasBlend"), blend ? 1 : 0);
        g.uniform2f(g.getUniformLocation(moveProg, "u_simSize"), simW, simH);
        g.uniform1i(g.getUniformLocation(moveProg, "u_agentW"), agentW);
        g.uniform1ui(g.getUniformLocation(moveProg, "u_step"), st.stepCount);
        g.uniform4fv(g.getUniformLocation(moveProg, "u_a"), pointA);
        g.uniform4fv(g.getUniformLocation(moveProg, "u_b"), pointB);
        g.uniform1f(
          g.getUniformLocation(moveProg, "u_pixelScale"),
          REF_PIXEL_SCALE * distScale
        );
        g.uniform1f(g.getUniformLocation(moveProg, "u_respawn"), respawn);
      });
      st.agentIdx = (st.agentIdx ^ 1) as 0 | 1;

      // 3. count: one additive point per agent. This is the atomicAdd.
      gl.bindFramebuffer(gl.FRAMEBUFFER, st.fbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        st.count.texture,
        0
      );
      gl.viewport(0, 0, simW, simH);
      gl.useProgram(st.countProgram);
      gl.bindVertexArray(st.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, writeAgents.texture);
      gl.uniform1i(gl.getUniformLocation(st.countProgram, "u_agents"), 0);
      gl.uniform1i(gl.getUniformLocation(st.countProgram, "u_agentW"), agentW);
      gl.uniform2f(
        gl.getUniformLocation(st.countProgram, "u_simSize"),
        simW,
        simH
      );
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, st.agentCount);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // 4. deposit: trail[t] + f(count) → trail[t^1].
      const depSrc = st.trail[st.trailIdx];
      const depDst = st.trail[st.trailIdx ^ 1];
      ctx.drawFullscreen(depositProg, depDst, (g) => {
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, depSrc.texture);
        g.uniform1i(g.getUniformLocation(depositProg, "u_trail"), 0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, st.count.texture);
        g.uniform1i(g.getUniformLocation(depositProg, "u_count"), 1);
        g.activeTexture(g.TEXTURE2);
        g.bindTexture(g.TEXTURE_2D, (inject ?? st.count).texture);
        g.uniform1i(g.getUniformLocation(depositProg, "u_inject"), 2);
        g.uniform1i(g.getUniformLocation(depositProg, "u_hasInject"), inject ? 1 : 0);
        g.uniform1f(
          g.getUniformLocation(depositProg, "u_deposit"),
          depositAmount * depositCorrection
        );
        g.uniform1f(g.getUniformLocation(depositProg, "u_density"), densityScale);
        g.uniform1f(
          g.getUniformLocation(depositProg, "u_inject_amount"),
          injectAmount
        );
        g.uniform1f(g.getUniformLocation(depositProg, "u_limit"), DEPOSIT_LIMIT);
      });
      st.trailIdx = (st.trailIdx ^ 1) as 0 | 1;

      // 5. diffuse + decay, separable. Decay lands on the very first
      //    sub-pass only, so raising blur passes widens diffusion without
      //    also compounding the decay.
      const passes = Math.max(1, blurPasses);
      let first = true;
      for (let i = 0; i < passes; i++) {
        for (const axis of [0, 1]) {
          const src = st.trail[st.trailIdx];
          const dst = st.trail[st.trailIdx ^ 1];
          const applyDecay = first;
          first = false;
          ctx.drawFullscreen(diffuseProg, dst, (g) => {
            g.activeTexture(g.TEXTURE0);
            g.bindTexture(g.TEXTURE_2D, src.texture);
            g.uniform1i(g.getUniformLocation(diffuseProg, "u_trail"), 0);
            g.uniform2f(
              g.getUniformLocation(diffuseProg, "u_step"),
              axis === 0 ? 1 / simW : 0,
              axis === 0 ? 0 : 1 / simH
            );
            g.uniform1f(g.getUniformLocation(diffuseProg, "u_decay"), decay);
            g.uniform1i(
              g.getUniformLocation(diffuseProg, "u_applyDecay"),
              applyDecay ? 1 : 0
            );
            g.uniform1i(
              g.getUniformLocation(diffuseProg, "u_radius"),
              blurPasses > 0 ? blurRadius : 0
            );
          });
          st.trailIdx = (st.trailIdx ^ 1) as 0 | 1;
          // With blur off there is nothing to separate — one decay-only
          // pass is the whole job.
          if (blurPasses === 0) break;
        }
        if (blurPasses === 0) break;
      }
    }

    // --- render ---------------------------------------------------------
    const trail = st.trail[st.trailIdx];
    const out = ctx.allocImage();
    const renderProg = ctx.getShader("physarum/render", RENDER_FS);
    const viewIdx = Math.max(0, VIEWS.indexOf((params.view as string) ?? "color"));
    const modeIdx = Math.max(
      0,
      COLOR_MODES.indexOf((params.color_mode as string) ?? "purple ice")
    );
    // `opacity` is NOT applied here — declaring OPACITY_PARAM makes the
    // evaluator's universal post-pass fade image outputs for free.
    ctx.drawFullscreen(renderProg, out, (g) => {
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, trail.texture);
      g.uniform1i(g.getUniformLocation(renderProg, "u_trail"), 0);
      g.activeTexture(g.TEXTURE1);
      g.bindTexture(g.TEXTURE_2D, st.count.texture);
      g.uniform1i(g.getUniformLocation(renderProg, "u_count"), 1);
      g.uniform1f(g.getUniformLocation(renderProg, "u_density"), densityScale);
      g.uniform1i(g.getUniformLocation(renderProg, "u_mode"), modeIdx);
      g.uniform1i(g.getUniformLocation(renderProg, "u_view"), viewIdx);
      g.uniform1i(
        g.getUniformLocation(renderProg, "u_transparent"),
        params.transparent_bg ? 1 : 0
      );
    });

    // Aux masks cost a pass each — only build what something reads.
    const aux: Record<string, MaskValue> = {};
    if (consumedOutputs?.has("aux:trail")) {
      const m = ctx.allocMask();
      const p = ctx.getShader("physarum/aux-trail", AUX_TRAIL_FS);
      ctx.drawFullscreen(p, m, (g) => {
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, trail.texture);
        g.uniform1i(g.getUniformLocation(p, "u_trail"), 0);
      });
      aux.trail = m;
    }
    if (consumedOutputs?.has("aux:count")) {
      const m = ctx.allocMask();
      const p = ctx.getShader("physarum/aux-count", AUX_COUNT_FS);
      ctx.drawFullscreen(p, m, (g) => {
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, st.count.texture);
        g.uniform1i(g.getUniformLocation(p, "u_count"), 0);
        g.uniform1f(g.getUniformLocation(p, "u_density"), densityScale);
      });
      aux.count = m;
    }

    return { primary: out, aux };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const st = ctx.state[key] as PhysarumState | undefined;
    if (st) disposeState(ctx, st);
    delete ctx.state[key];
  },
};
