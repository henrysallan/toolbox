import type {
  ColliderDescriptor,
  ForceDescriptor,
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  RenderContext,
  SocketValue,
} from "@/engine/types";
import { OPACITY_PARAM } from "@/engine/conventions";
import { VELOCITY_ENCODE_GLSL } from "@/engine/velocity-field";

// Fluid Simulator — 2D Eulerian ink/smoke (spec 072626_fluid-simulator.md,
// M2 of the fluid arc; M1 field toolkit: 072526_flow-fields.md). Stable
// fluids (Stam) upgraded with ADVECTION-REFLECTION (Zehnder et al. 2018:
// the end-of-step projection is replaced by an energy-preserving
// mid-step reflection — two cheap projections instead of one, roughly
// two orders of magnitude less energy loss, swirls live instead of
// smearing out) plus vorticity confinement as an explicit "swirl" dial.
//
// Input vocabulary is Watercolor Ink's (deposit mask = where dye lands,
// color image = its hue, alpha doubling as coverage when deposit is
// unwired) PLUS the particle-descriptor ecosystem: force1..N sockets
// take the same Gravity/Drag/Point/Vortex/Wind/Turbulence descriptor
// nodes as the Particle Simulator (the applyForce GLSL below mirrors
// particle-simulator-webgl.ts verbatim — keep them in sync), and
// collider1..N take Circle/Line/Image-Mask colliders as solid obstacles
// (velocity damped inside; the pressure solve then routes flow around).
// The optional `field` input accepts an M1 velocity field (Perlin curl /
// Spline Flow Field) as a body-force guide, and the `velocity` aux
// output emits the live sim field in the SAME encoding — Advect Points /
// Advect Image can ride the simulation.
//
// State lives in node-owned grid-res RGBA16F textures (ping-pong
// velocity + dye, pressure pair, divergence, curl scratch), session-only
// in ctx.state per the house sim contract: advance while the clock
// moves, reset on scene wrap, deterministic offline export via
// sequential frame stepping (fixed dt per substep). Advection samples
// with hardware bilinear (OES_texture_half_float_linear; falls back to
// NEAREST — blockier but functional). Stencil passes use clamped
// texelFetch, so filtering never contaminates the solve.
//
// Internal units: velocity is stored in GL TEXEL space (y-up, texels/s)
// — the textbook frame, isotropic because grid cells are pixel-square.
// Conversions happen only at the seams: particle-land forces work in
// Y-DOWN anisotropic canvas-UV (exact round-trip below), the field
// input/aux use the M1 isotropic canvas-width convention (÷ gridW,
// y negated).

const MAX_FORCES = 6;
const MAX_COLLIDERS = 4;

const FORCE_KIND: Record<ForceDescriptor["kind"], number> = {
  gravity: 0,
  drag: 1,
  point: 2,
  vortex: 3,
  wind: 4,
  turbulence: 5,
};

const COLLIDER_KIND: Record<ColliderDescriptor["kind"], number> = {
  circle: 0,
  line: 1,
  image_mask: 2,
};

// ---- shared GLSL --------------------------------------------------------

const COMMON = `
uniform ivec2 u_size;   // grid dimensions
ivec2 clampCoord(ivec2 c) { return clamp(c, ivec2(0), u_size - 1); }
`;

// hash + simplex + curl2 — copied from particle-simulator-webgl.ts so the
// Turbulence force descriptor produces the same motion on grids as on
// particles. Keep in sync.
const NOISE = `
vec3 mod289_3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289_2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute3(vec3 x) { return mod289_3(((x * 34.0) + 1.0) * x); }
float snoise2(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                      -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289_2(i);
  vec3 p = permute3(permute3(i.y + vec3(0.0, i1.y, 1.0))
                              + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
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
vec2 curl2(vec2 p, float t) {
  float eps = 0.01;
  float n1 = snoise2(p + vec2(0.0, eps) + vec2(t, -t));
  float n2 = snoise2(p - vec2(0.0, eps) + vec2(t, -t));
  float n3 = snoise2(p + vec2(eps, 0.0) + vec2(t, -t));
  float n4 = snoise2(p - vec2(eps, 0.0) + vec2(t, -t));
  return vec2((n1 - n2) / (2.0 * eps), -(n3 - n4) / (2.0 * eps));
}
`;

// Forces + buoyancy + external guide field + velocity dissipation, one
// pass. applyForce mirrors particle-simulator-webgl.ts (same kinds, same
// vec4 packing) and runs in that node's frame: Y-DOWN anisotropic
// canvas-UV — velocity converts texel-y-up → uv-y-down before, back
// after, so a Gravity/Vortex node "feels" identical on both simulators.
const FORCES_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_vel;
uniform sampler2D u_dye;
uniform sampler2D u_ext;
uniform int u_hasExt;
uniform float u_extStrength;
uniform float u_dt;
uniform float u_time;
uniform float u_buoyancy;
uniform float u_dissipation;
uniform int u_forceCount;
uniform int u_forceKinds[${MAX_FORCES}];
uniform vec4 u_forceA[${MAX_FORCES}];
uniform vec4 u_forceB[${MAX_FORCES}];
out vec4 outColor;
${COMMON}
${NOISE}

void applyForce(int kind, vec4 a, vec4 b, vec2 pos, inout vec2 vel, float dt) {
  if (kind == 0) {
    vel += a.xy * dt;
  } else if (kind == 1) {
    vel *= max(0.0, 1.0 - a.x * dt);
  } else if (kind == 2) {
    vec2 d = pos - a.xy;
    float r = length(d);
    if (r < b.y && r > 1e-5) {
      float t = clamp(1.0 - r / b.y, 0.0, 1.0);
      float f = a.z * pow(t, a.w);
      vel += (d / r) * f * b.x * dt;
    }
  } else if (kind == 3) {
    vec2 d = pos - a.xy;
    float r = length(d);
    if (r < b.y && r > 1e-5) {
      vec2 tang = vec2(-d.y, d.x) / r;
      float t = clamp(1.0 - r / b.y, 0.0, 1.0);
      float f = a.z * pow(t, a.w);
      vel += tang * f * dt;
    }
  } else if (kind == 4) {
    vec2 d = a.xy;
    float l = length(d);
    if (l > 1e-5) vel += (d / l) * a.z * dt;
  } else if (kind == 5) {
    vec2 c = curl2(pos * a.x, u_time * a.z);
    vel += c * a.y * dt;
  }
}

void main() {
  vec2 size = vec2(u_size);
  vec2 v = texture(u_vel, v_uv).xy;      // texels/s, y-up

  // Particle-land frame: y-down anisotropic canvas-UV.
  vec2 pos = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 vel = vec2(v.x / size.x, -v.y / size.y);
  for (int i = 0; i < ${MAX_FORCES}; i++) {
    if (i >= u_forceCount) break;
    applyForce(u_forceKinds[i], u_forceA[i], u_forceB[i], pos, vel, u_dt);
  }
  v = vec2(vel.x * size.x, -vel.y * size.y);

  // Buoyancy: dye density lifts (up = +y in GL). Units: canvas-widths/s².
  float density = texture(u_dye, v_uv).a;
  v.y += u_buoyancy * min(density, 2.0) * u_dt * size.x;

  // External guide field (M1 encoding: signed-RG, y-down, isotropic
  // canvas-width units) applied as acceleration.
  if (u_hasExt == 1) {
    vec2 e = 2.0 * (texture(u_ext, v_uv).rg - 0.5);
    v += vec2(e.x, -e.y) * u_extStrength * u_dt * size.x;
  }

  v *= max(0.0, 1.0 - u_dissipation * u_dt);
  outColor = vec4(v, 0.0, 1.0);
}`;

// Semi-Lagrangian advection: back-trace through u_field, sample u_qty.
const ADVECT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_field;
uniform sampler2D u_qty;
uniform float u_dt;
uniform float u_keep;
out vec4 outColor;
${COMMON}

void main() {
  vec2 size = vec2(u_size);
  vec2 v = texture(u_field, v_uv).xy;             // texels/s
  vec2 src = (v_uv * size - v * u_dt) / size;     // back-trace, texel space
  outColor = texture(u_qty, src) * u_keep;
}`;

// Reflection: ṽ = 2·v½ − ṽ½ (u_a = projected v½, u_b = unprojected ṽ½).
const REFLECT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_a;
uniform sampler2D u_b;
out vec4 outColor;
void main() {
  outColor = vec4(2.0 * texture(u_a, v_uv).xy - texture(u_b, v_uv).xy, 0.0, 1.0);
}`;

const CURL_FS = `#version 300 es
precision highp float;
uniform sampler2D u_vel;
out vec4 outColor;
${COMMON}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float vr = texelFetch(u_vel, clampCoord(c + ivec2(1, 0)), 0).y;
  float vl = texelFetch(u_vel, clampCoord(c - ivec2(1, 0)), 0).y;
  float vt = texelFetch(u_vel, clampCoord(c + ivec2(0, 1)), 0).x;
  float vb = texelFetch(u_vel, clampCoord(c - ivec2(0, 1)), 0).x;
  outColor = vec4(0.5 * ((vr - vl) - (vt - vb)), 0.0, 0.0, 1.0);
}`;

// Vorticity confinement: push toward local vorticity maxima.
const CONFINE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_vel;
uniform sampler2D u_curl;
uniform float u_amount;
uniform float u_dt;
out vec4 outColor;
${COMMON}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float w = texelFetch(u_curl, c, 0).x;
  float wr = abs(texelFetch(u_curl, clampCoord(c + ivec2(1, 0)), 0).x);
  float wl = abs(texelFetch(u_curl, clampCoord(c - ivec2(1, 0)), 0).x);
  float wt = abs(texelFetch(u_curl, clampCoord(c + ivec2(0, 1)), 0).x);
  float wb = abs(texelFetch(u_curl, clampCoord(c - ivec2(0, 1)), 0).x);
  vec2 eta = 0.5 * vec2(wr - wl, wt - wb);
  vec2 n = eta / (length(eta) + 1e-5);
  vec2 f = u_amount * w * vec2(n.y, -n.x);
  vec2 v = texelFetch(u_vel, c, 0).xy + f * u_dt;
  outColor = vec4(v, 0.0, 1.0);
}`;

const DIVERGENCE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_vel;
out vec4 outColor;
${COMMON}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float vr = texelFetch(u_vel, clampCoord(c + ivec2(1, 0)), 0).x;
  float vl = texelFetch(u_vel, clampCoord(c - ivec2(1, 0)), 0).x;
  float vt = texelFetch(u_vel, clampCoord(c + ivec2(0, 1)), 0).y;
  float vb = texelFetch(u_vel, clampCoord(c - ivec2(0, 1)), 0).y;
  outColor = vec4(0.5 * ((vr - vl) + (vt - vb)), 0.0, 0.0, 1.0);
}`;

// Jacobi pressure relaxation. Closed edges: clamped fetch ≈ Neumann.
// Open edges: out-of-bounds pressure is 0 (Dirichlet) so flow exits.
const JACOBI_FS = `#version 300 es
precision highp float;
uniform sampler2D u_pressure;
uniform sampler2D u_div;
uniform int u_open;
out vec4 outColor;
${COMMON}
float pAt(ivec2 c) {
  if (u_open == 1 &&
      (c.x < 0 || c.y < 0 || c.x >= u_size.x || c.y >= u_size.y)) return 0.0;
  return texelFetch(u_pressure, clampCoord(c), 0).x;
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float d = texelFetch(u_div, c, 0).x;
  float p = (pAt(c + ivec2(1, 0)) + pAt(c - ivec2(1, 0)) +
             pAt(c + ivec2(0, 1)) + pAt(c - ivec2(0, 1)) - d) * 0.25;
  outColor = vec4(p, 0.0, 0.0, 1.0);
}`;

const GRADIENT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_vel;
uniform sampler2D u_pressure;
out vec4 outColor;
${COMMON}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float pr = texelFetch(u_pressure, clampCoord(c + ivec2(1, 0)), 0).x;
  float pl = texelFetch(u_pressure, clampCoord(c - ivec2(1, 0)), 0).x;
  float pt = texelFetch(u_pressure, clampCoord(c + ivec2(0, 1)), 0).x;
  float pb = texelFetch(u_pressure, clampCoord(c - ivec2(0, 1)), 0).x;
  vec2 v = texelFetch(u_vel, c, 0).xy - 0.5 * vec2(pr - pl, pt - pb);
  outColor = vec4(v, 0.0, 1.0);
}`;

// Walls + colliders. Closed edges zero the wall-normal component
// (free-slip); colliders damp velocity inside their solid coverage with
// a ~1.5-texel feather — the projection then steers flow around them.
const BOUNDARY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_vel;
uniform int u_open;
uniform int u_colliderCount;
uniform int u_colliderKinds[${MAX_COLLIDERS}];
uniform vec4 u_colliderA[${MAX_COLLIDERS}];
uniform vec4 u_colliderB[${MAX_COLLIDERS}];
uniform sampler2D u_colliderMask0;
uniform sampler2D u_colliderMask1;
uniform sampler2D u_colliderMask2;
uniform sampler2D u_colliderMask3;
out vec4 outColor;
${COMMON}

vec4 sampleColliderMask(int slot, vec2 uv) {
  if (slot == 0) return texture(u_colliderMask0, uv);
  if (slot == 1) return texture(u_colliderMask1, uv);
  if (slot == 2) return texture(u_colliderMask2, uv);
  return texture(u_colliderMask3, uv);
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 v = texelFetch(u_vel, c, 0).xy;

  // Solid coverage from the collider descriptors. pos is Y-DOWN
  // canvas-UV (the particle convention); mask samples flip V.
  vec2 pos = vec2(v_uv.x, 1.0 - v_uv.y);
  float feather = 1.5 / float(u_size.x);
  float solid = 0.0;
  for (int i = 0; i < ${MAX_COLLIDERS}; i++) {
    if (i >= u_colliderCount) break;
    int ck = u_colliderKinds[i];
    vec4 ca = u_colliderA[i];
    float s = 0.0;
    if (ck == 0) {
      float r = distance(pos, ca.xy);
      s = ca.w > 0.5
        ? smoothstep(ca.z - feather, ca.z + feather, r)   // inside: solid outside the disc
        : 1.0 - smoothstep(ca.z - feather, ca.z + feather, r);
    } else if (ck == 1) {
      // half-plane: blocks n·p < d
      s = 1.0 - smoothstep(0.0, feather * 2.0, dot(ca.xy, pos) - ca.z);
    } else {
      float a = sampleColliderMask(i, vec2(pos.x, 1.0 - pos.y)).a;
      s = smoothstep(ca.x, min(ca.x + 0.15, 1.0), a);
    }
    solid = max(solid, s);
  }
  v *= 1.0 - solid;

  if (u_open == 0) {
    if (c.x <= 0 || c.x >= u_size.x - 1) v.x = 0.0;
    if (c.y <= 0 || c.y >= u_size.y - 1) v.y = 0.0;
  }
  outColor = vec4(v, 0.0, 1.0);
}`;

// Dye: advect + fade + inject, one pass. Dye is premultiplied-ish:
// rgb = color·density accumulation, a = density.
const DYE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_field;
uniform sampler2D u_qty;
uniform sampler2D u_deposit;
uniform sampler2D u_color;
uniform int u_hasDeposit;
uniform int u_hasColor;
uniform vec3 u_inkColor;
uniform float u_rate;
uniform float u_dt;
uniform float u_keep;
out vec4 outColor;
${COMMON}

void main() {
  vec2 size = vec2(u_size);
  vec2 v = texture(u_field, v_uv).xy;
  vec2 src = (v_uv * size - v * u_dt) / size;
  vec4 dye = texture(u_qty, src) * u_keep;

  float cov = 0.0;
  vec3 col = u_inkColor;
  if (u_hasColor == 1) {
    vec4 c = texture(u_color, v_uv);
    col = c.rgb;
    cov = u_hasDeposit == 1 ? texture(u_deposit, v_uv).r : c.a;
  } else if (u_hasDeposit == 1) {
    cov = texture(u_deposit, v_uv).r;
  }
  float inj = cov * u_rate * u_dt;
  dye += vec4(col * inj, inj);
  dye.a = min(dye.a, 8.0);
  outColor = dye;
}`;

// Canvas-res present: composite (straight alpha) or the velocity field
// in the M1 encoding (which is also exactly what the aux output emits).
const RENDER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_dye;
uniform sampler2D u_vel;
uniform int u_view;   // 0 composite, 1 velocity
uniform float u_gridW;
out vec4 outColor;
${VELOCITY_ENCODE_GLSL}

void main() {
  if (u_view == 1) {
    vec2 v = texture(u_vel, v_uv).xy;
    outColor = encodeVelocity(vec2(v.x, -v.y) / u_gridW);
    return;
  }
  vec4 dye = texture(u_dye, v_uv);
  float a = clamp(dye.a, 0.0, 1.0);
  outColor = vec4(dye.rgb / max(dye.a, 1e-4), a);
}`;

// ---- state --------------------------------------------------------------

interface SimTex {
  kind: "image";
  texture: WebGLTexture;
  width: number;
  height: number;
}

interface FluidState {
  vel: [SimTex, SimTex];
  dye: [SimTex, SimTex];
  pr: [SimTex, SimTex];
  div: SimTex;
  curl: SimTex;
  velIdx: number;
  dyeIdx: number;
  prIdx: number;
  width: number;
  height: number;
  lastTime: number;
  lastDriver: number;
  initialized: boolean;
}

function createSimTexture(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  linear: boolean
): SimTex {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  const filter = linear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { kind: "image", texture: tex, width: w, height: h };
}

function stateKey(nodeId: string): string {
  return `fluid-simulator:${nodeId}`;
}

function ensureState(
  ctx: RenderContext,
  nodeId: string,
  w: number,
  h: number,
  linear: boolean
): FluidState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as FluidState | undefined;
  if (existing && existing.width === w && existing.height === h) return existing;
  if (existing) releaseState(ctx, existing);
  const gl = ctx.gl;
  const mk = (lin: boolean) => createSimTexture(gl, w, h, lin);
  const state: FluidState = {
    vel: [mk(linear), mk(linear)],
    dye: [mk(linear), mk(linear)],
    pr: [mk(false), mk(false)],
    div: mk(false),
    curl: mk(false),
    velIdx: 0,
    dyeIdx: 0,
    prIdx: 0,
    width: w,
    height: h,
    lastTime: ctx.time,
    lastDriver: 0,
    initialized: false,
  };
  ctx.state[key] = state;
  return state;
}

function releaseState(ctx: RenderContext, s: FluidState): void {
  const gl = ctx.gl;
  for (const t of [...s.vel, ...s.dye, ...s.pr, s.div, s.curl]) {
    gl.deleteTexture(t.texture);
  }
}

// ---- descriptor packing (mirrors particle-simulator-webgl.ts) -----------

function packForce(d: ForceDescriptor): { kind: number; a: number[]; b: number[] } {
  const kind = FORCE_KIND[d.kind];
  const a = [0, 0, 0, 0];
  const b = [0, 0, 0, 0];
  switch (d.kind) {
    case "gravity":
      a[0] = d.gx; a[1] = d.gy;
      break;
    case "drag":
      a[0] = d.coeff;
      break;
    case "point":
      a[0] = d.px; a[1] = d.py; a[2] = d.strength; a[3] = d.falloff;
      b[0] = d.sign; b[1] = d.radius;
      break;
    case "vortex":
      a[0] = d.px; a[1] = d.py; a[2] = d.strength; a[3] = d.falloff;
      b[1] = d.radius;
      break;
    case "wind":
      a[0] = d.dx; a[1] = d.dy; a[2] = d.strength;
      break;
    case "turbulence":
      a[0] = d.scale; a[1] = d.strength; a[2] = d.speed;
      break;
  }
  return { kind, a, b };
}

interface ColliderPacked {
  kind: number;
  a: number[];
  mask: ImageValue | null;
}

function packCollider(d: ColliderDescriptor): ColliderPacked {
  const kind = COLLIDER_KIND[d.kind];
  const a = [0, 0, 0, 0];
  let mask: ImageValue | null = null;
  switch (d.kind) {
    case "circle":
      a[0] = d.cx; a[1] = d.cy; a[2] = d.radius; a[3] = d.inside ? 1 : 0;
      break;
    case "line":
      a[0] = d.nx; a[1] = d.ny; a[2] = d.d;
      break;
    case "image_mask":
      a[0] = d.threshold;
      mask = d.mask;
      break;
  }
  return { kind, a, mask };
}

function gatherDescriptors<T>(
  inputs: Record<string, SocketValue | undefined>,
  prefix: string,
  max: number,
  unpack: (v: SocketValue) => T | null
): T[] {
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    const v = inputs[`${prefix}${i + 1}`];
    if (!v) continue;
    const u = unpack(v);
    if (u) out.push(u);
  }
  return out;
}

function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})/i.exec(hex);
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const VIEW_OPTIONS = ["composite", "velocity"];

let warnedNoFloat = false;

// ---- node definition ----------------------------------------------------

export const fluidSimulatorNode: NodeDefinition = {
  type: "fluid-simulator",
  name: "Fluid Simulator",
  category: "image",
  subcategory: "generator",
  description:
    "2D Eulerian fluid (smoke / dye / ink in open water). Wire any mask/spline/shape into `deposit` to release dye; an image into `color` for its hues (alpha doubles as coverage when `deposit` is unwired). Takes the SAME force nodes as the Particle Simulator (Vortex/Wind/Gravity/Turbulence… — add slots in the panel) and Circle/Line/Image-Mask colliders as solid obstacles the flow routes around. The optional `field` input steers the fluid with an authored velocity field (Perlin curl / Spline Flow Field); the `velocity` aux emits the LIVE sim field in the same encoding, so Advect Points / Advect Image can ride the simulation. Advection-reflection keeps swirls energetic; `vorticity` adds small-scale swirl back. `buoyancy` makes dense dye rise (smoke). Runs while the timeline plays; restarting the timeline clears the tank.",
  backend: "webgl2",
  stable: false,
  simulation: true,
  headerControl: { paramName: "view" },
  inputs: [
    { name: "deposit", type: "mask", required: false },
    { name: "color", type: "image", required: false },
    { name: "field", label: "Field (guide)", type: "image", required: false },
  ],
  resolveInputs(params): InputSocketDef[] {
    const base: InputSocketDef[] = [
      { name: "deposit", type: "mask", required: false },
      { name: "color", type: "image", required: false },
      { name: "field", label: "Field (guide)", type: "image", required: false },
    ];
    const fc = Math.max(
      0,
      Math.min(MAX_FORCES, Math.floor((params.forceCount as number) ?? 1))
    );
    for (let i = 0; i < fc; i++) {
      base.push({ name: `force${i + 1}`, type: "force", required: false });
    }
    const cc = Math.max(
      0,
      Math.min(MAX_COLLIDERS, Math.floor((params.colliderCount as number) ?? 0))
    );
    for (let i = 0; i < cc; i++) {
      base.push({ name: `collider${i + 1}`, type: "collider", required: false });
    }
    if (params.drive_by_scene_time) {
      base.push({ name: "time", type: "scalar", required: false });
    }
    return base;
  },
  params: [
    {
      name: "inject_rate",
      label: "Dye rate",
      type: "scalar",
      min: 0,
      max: 20,
      step: 0.1,
      default: 6,
    },
    {
      name: "ink_color",
      label: "Dye color",
      type: "color",
      default: "#ffffff",
    },
    {
      name: "dissipation",
      label: "Dye fade / sec",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.005,
      default: 0.02,
    },
    {
      name: "velocity_dissipation",
      label: "Velocity fade / sec",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 0.05,
    },
    {
      name: "vorticity",
      label: "Vorticity (swirl)",
      type: "scalar",
      min: 0,
      max: 30,
      step: 0.1,
      default: 8,
    },
    {
      name: "buoyancy",
      label: "Buoyancy",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.01,
      default: 0,
    },
    {
      name: "field_strength",
      label: "Field strength",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 2,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "speed",
      label: "Speed",
      type: "scalar",
      min: 0.1,
      max: 4,
      step: 0.05,
      default: 1,
    },
    {
      name: "edges",
      label: "Edges",
      type: "enum",
      options: ["closed", "open"],
      control: "segmented",
      default: "closed",
    },
    {
      name: "pressure_iterations",
      label: "Pressure iterations",
      type: "scalar",
      min: 8,
      max: 60,
      step: 1,
      default: 24,
    },
    {
      name: "substeps_per_frame",
      label: "Substeps / frame",
      type: "scalar",
      min: 1,
      max: 8,
      step: 1,
      default: 2,
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
      name: "forceCount",
      label: "Force slots",
      type: "scalar",
      min: 0,
      max: MAX_FORCES,
      step: 1,
      default: 1,
    },
    {
      name: "colliderCount",
      label: "Collider slots",
      type: "scalar",
      min: 0,
      max: MAX_COLLIDERS,
      step: 1,
      default: 0,
    },
    {
      name: "view",
      label: "View",
      type: "enum",
      options: VIEW_OPTIONS,
      default: "composite",
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
  auxOutputs: [{ name: "velocity", type: "image" }],

  fingerprintExtras(_params, ctx) {
    return `t:${ctx.time.toFixed(4)}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const gl = ctx.gl;
    if (!gl.getExtension("EXT_color_buffer_float")) {
      if (!warnedNoFloat) {
        console.warn(
          "fluid-simulator: EXT_color_buffer_float unavailable — simulation disabled."
        );
        warnedNoFloat = true;
      }
      const blank = ctx.allocImage();
      ctx.clearTarget(blank, [0, 0, 0, 0]);
      const velBlank = ctx.allocImage();
      ctx.clearTarget(velBlank, [0.5, 0.5, 0, 1]);
      return { primary: blank, aux: { velocity: velBlank } };
    }
    const linear = !!gl.getExtension("OES_texture_half_float_linear");

    const rez = Math.max(0.1, Math.min(1, (params.resolution as number) ?? 0.5));
    const simW = Math.max(8, Math.round(ctx.width * rez));
    const simH = Math.max(8, Math.round(ctx.height * rez));
    const state = ensureState(ctx, nodeId, simW, simH, linear);

    // Reset on first eval / scene-time wrap (the house sim contract).
    const wasNonZero = state.lastTime > 0.05;
    const isNearZero = ctx.time < 0.05;
    if (!state.initialized || (wasNonZero && isNearZero)) {
      for (const t of [...state.vel, ...state.dye, ...state.pr]) {
        ctx.clearTarget(t, [0, 0, 0, 0]);
      }
      state.velIdx = 0;
      state.dyeIdx = 0;
      state.prIdx = 0;
      state.initialized = true;
      state.lastDriver = inputs.time?.kind === "scalar" ? inputs.time.value : 0;
    }

    // Step gating: play (or offline frame-stepping), or a wired
    // monotonic scalar when drive_by_scene_time is on.
    let active: boolean;
    if (params.drive_by_scene_time) {
      const driver = inputs.time?.kind === "scalar" ? inputs.time.value : 0;
      active = driver > state.lastDriver + 1e-6;
      state.lastDriver = driver;
    } else {
      active = ctx.playing || (ctx.offline && ctx.time > state.lastTime + 1e-6);
    }
    state.lastTime = ctx.time;

    // ---- gather inputs ----
    const deposit =
      inputs.deposit && inputs.deposit.kind === "mask" ? inputs.deposit : null;
    const colorImg =
      inputs.color && inputs.color.kind === "image" ? inputs.color : null;
    const extField =
      inputs.field && inputs.field.kind === "image" ? inputs.field : null;
    const forces = gatherDescriptors(inputs, "force", MAX_FORCES, (v) =>
      v.kind === "force" ? packForce(v.descriptor) : null
    );
    const colliders = gatherDescriptors(inputs, "collider", MAX_COLLIDERS, (v) =>
      v.kind === "collider" ? packCollider(v.descriptor) : null
    );

    const substeps = Math.max(
      1,
      Math.min(8, Math.round((params.substeps_per_frame as number) ?? 2))
    );
    const iterations = Math.max(
      8,
      Math.min(60, Math.round((params.pressure_iterations as number) ?? 24))
    );
    const speed = (params.speed as number) ?? 1;
    const dt = (speed / Math.max(1, ctx.fps)) / substeps;
    const open = ((params.edges as string) ?? "closed") === "open" ? 1 : 0;
    const inkColor = hexToRgb01((params.ink_color as string) ?? "#ffffff");

    // ---- shaders ----
    const forcesProg = ctx.getShader("fluid-sim/forces", FORCES_FS);
    const advectProg = ctx.getShader("fluid-sim/advect", ADVECT_FS);
    const reflectProg = ctx.getShader("fluid-sim/reflect", REFLECT_FS);
    const curlProg = ctx.getShader("fluid-sim/curl", CURL_FS);
    const confineProg = ctx.getShader("fluid-sim/confine", CONFINE_FS);
    const divProg = ctx.getShader("fluid-sim/div", DIVERGENCE_FS);
    const jacobiProg = ctx.getShader("fluid-sim/jacobi", JACOBI_FS);
    const gradProg = ctx.getShader("fluid-sim/grad", GRADIENT_FS);
    const boundaryProg = ctx.getShader("fluid-sim/boundary", BOUNDARY_FS);
    const dyeProg = ctx.getShader("fluid-sim/dye", DYE_FS);
    const renderProg = ctx.getShader("fluid-sim/render", RENDER_FS);

    const bindTex = (
      prog: WebGLProgram,
      unit: number,
      name: string,
      tex: WebGLTexture | null
    ) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(prog, name), unit);
    };
    const setSize = (prog: WebGLProgram) => {
      gl.uniform2i(gl.getUniformLocation(prog, "u_size"), simW, simH);
    };

    const readVel = () => state.vel[state.velIdx];
    const writeVel = () => state.vel[1 - state.velIdx];
    const swapVel = () => {
      state.velIdx = 1 - state.velIdx;
    };

    // One projection: divergence → Jacobi ×N (warm-started from the
    // previous solve) → subtract gradient into `target`.
    const project = (target: SimTex) => {
      ctx.drawFullscreen(divProg, state.div, () => {
        setSize(divProg);
        bindTex(divProg, 0, "u_vel", readVel().texture);
      });
      for (let i = 0; i < iterations; i++) {
        const src = state.pr[state.prIdx];
        const dst = state.pr[1 - state.prIdx];
        ctx.drawFullscreen(jacobiProg, dst, () => {
          setSize(jacobiProg);
          gl.uniform1i(gl.getUniformLocation(jacobiProg, "u_open"), open);
          bindTex(jacobiProg, 0, "u_pressure", src.texture);
          bindTex(jacobiProg, 1, "u_div", state.div.texture);
        });
        state.prIdx = 1 - state.prIdx;
      }
      ctx.drawFullscreen(gradProg, target, () => {
        setSize(gradProg);
        bindTex(gradProg, 0, "u_vel", readVel().texture);
        bindTex(gradProg, 1, "u_pressure", state.pr[state.prIdx].texture);
      });
    };

    if (active) {
      // The reflection intermediate v½ needs its own storage for the
      // whole second half-step; a pool lease keeps the state footprint
      // at eight textures.
      const half = ctx.allocImage({ width: simW, height: simH });

      for (let s = 0; s < substeps; s++) {
        const simTime = ctx.time + s * dt;

        // 1 — body forces / buoyancy / guide field / dissipation.
        ctx.drawFullscreen(forcesProg, writeVel(), () => {
          setSize(forcesProg);
          bindTex(forcesProg, 0, "u_vel", readVel().texture);
          bindTex(forcesProg, 1, "u_dye", state.dye[state.dyeIdx].texture);
          bindTex(forcesProg, 2, "u_ext", extField?.texture ?? null);
          gl.uniform1i(
            gl.getUniformLocation(forcesProg, "u_hasExt"),
            extField ? 1 : 0
          );
          gl.uniform1f(
            gl.getUniformLocation(forcesProg, "u_extStrength"),
            (params.field_strength as number) ?? 0.5
          );
          gl.uniform1f(gl.getUniformLocation(forcesProg, "u_dt"), dt);
          gl.uniform1f(gl.getUniformLocation(forcesProg, "u_time"), simTime);
          gl.uniform1f(
            gl.getUniformLocation(forcesProg, "u_buoyancy"),
            (params.buoyancy as number) ?? 0
          );
          gl.uniform1f(
            gl.getUniformLocation(forcesProg, "u_dissipation"),
            (params.velocity_dissipation as number) ?? 0.05
          );
          gl.uniform1i(
            gl.getUniformLocation(forcesProg, "u_forceCount"),
            forces.length
          );
          if (forces.length > 0) {
            const kinds = new Int32Array(MAX_FORCES);
            const A = new Float32Array(MAX_FORCES * 4);
            const B = new Float32Array(MAX_FORCES * 4);
            forces.forEach((f, i) => {
              kinds[i] = f.kind;
              A.set(f.a, i * 4);
              B.set(f.b, i * 4);
            });
            gl.uniform1iv(
              gl.getUniformLocation(forcesProg, "u_forceKinds[0]"),
              kinds
            );
            gl.uniform4fv(gl.getUniformLocation(forcesProg, "u_forceA[0]"), A);
            gl.uniform4fv(gl.getUniformLocation(forcesProg, "u_forceB[0]"), B);
          }
        });
        swapVel();

        // 2 — vorticity confinement.
        const vorticity = (params.vorticity as number) ?? 8;
        if (vorticity > 0) {
          ctx.drawFullscreen(curlProg, state.curl, () => {
            setSize(curlProg);
            bindTex(curlProg, 0, "u_vel", readVel().texture);
          });
          ctx.drawFullscreen(confineProg, writeVel(), () => {
            setSize(confineProg);
            bindTex(confineProg, 0, "u_vel", readVel().texture);
            bindTex(confineProg, 1, "u_curl", state.curl.texture);
            gl.uniform1f(
              gl.getUniformLocation(confineProg, "u_amount"),
              vorticity
            );
            gl.uniform1f(gl.getUniformLocation(confineProg, "u_dt"), dt);
          });
          swapVel();
        }

        // 3 — advection-reflection (Zehnder et al.):
        //   ṽ½ = A(v, v, dt/2); v½ = P(ṽ½); ṽ = 2v½ − ṽ½;
        //   ṽ1 = A(ṽ, v½, dt/2); v1 = P(ṽ1)
        const advect = (
          field: SimTex,
          qty: SimTex,
          target: SimTex,
          stepDt: number
        ) => {
          ctx.drawFullscreen(advectProg, target, () => {
            setSize(advectProg);
            bindTex(advectProg, 0, "u_field", field.texture);
            bindTex(advectProg, 1, "u_qty", qty.texture);
            gl.uniform1f(gl.getUniformLocation(advectProg, "u_dt"), stepDt);
            gl.uniform1f(gl.getUniformLocation(advectProg, "u_keep"), 1);
          });
        };

        advect(readVel(), readVel(), writeVel(), dt / 2);
        swapVel(); // vel[read] = ṽ½
        project(half); // half = v½ (ṽ½ untouched)
        ctx.drawFullscreen(reflectProg, writeVel(), () => {
          bindTex(reflectProg, 0, "u_a", half.texture);
          bindTex(reflectProg, 1, "u_b", readVel().texture);
        });
        swapVel(); // vel[read] = ṽ
        advect(half, readVel(), writeVel(), dt / 2);
        swapVel(); // vel[read] = ṽ1
        project(writeVel());
        swapVel(); // vel[read] = v1

        // 4 — walls + colliders.
        ctx.drawFullscreen(boundaryProg, writeVel(), () => {
          setSize(boundaryProg);
          bindTex(boundaryProg, 0, "u_vel", readVel().texture);
          gl.uniform1i(gl.getUniformLocation(boundaryProg, "u_open"), open);
          gl.uniform1i(
            gl.getUniformLocation(boundaryProg, "u_colliderCount"),
            colliders.length
          );
          if (colliders.length > 0) {
            const kinds = new Int32Array(MAX_COLLIDERS);
            const A = new Float32Array(MAX_COLLIDERS * 4);
            colliders.forEach((c, i) => {
              kinds[i] = c.kind;
              A.set(c.a, i * 4);
            });
            gl.uniform1iv(
              gl.getUniformLocation(boundaryProg, "u_colliderKinds[0]"),
              kinds
            );
            gl.uniform4fv(
              gl.getUniformLocation(boundaryProg, "u_colliderA[0]"),
              A
            );
          }
          colliders.forEach((c, i) => {
            bindTex(
              boundaryProg,
              1 + i,
              `u_colliderMask${i}`,
              c.mask?.texture ?? null
            );
          });
        });
        swapVel();

        // 5 — dye: advect + fade + inject.
        const keep = Math.max(
          0,
          1 - ((params.dissipation as number) ?? 0.02) * dt
        );
        ctx.drawFullscreen(dyeProg, state.dye[1 - state.dyeIdx], () => {
          setSize(dyeProg);
          bindTex(dyeProg, 0, "u_field", readVel().texture);
          bindTex(dyeProg, 1, "u_qty", state.dye[state.dyeIdx].texture);
          bindTex(dyeProg, 2, "u_deposit", deposit?.texture ?? null);
          bindTex(dyeProg, 3, "u_color", colorImg?.texture ?? null);
          gl.uniform1i(
            gl.getUniformLocation(dyeProg, "u_hasDeposit"),
            deposit ? 1 : 0
          );
          gl.uniform1i(
            gl.getUniformLocation(dyeProg, "u_hasColor"),
            colorImg ? 1 : 0
          );
          gl.uniform3f(
            gl.getUniformLocation(dyeProg, "u_inkColor"),
            inkColor[0],
            inkColor[1],
            inkColor[2]
          );
          gl.uniform1f(
            gl.getUniformLocation(dyeProg, "u_rate"),
            (params.inject_rate as number) ?? 6
          );
          gl.uniform1f(gl.getUniformLocation(dyeProg, "u_dt"), dt);
          gl.uniform1f(gl.getUniformLocation(dyeProg, "u_keep"), keep);
        });
        state.dyeIdx = 1 - state.dyeIdx;
      }

      ctx.releaseTexture(half.texture);
    }

    // ---- present (canvas res) ----
    const view = (params.view as string) ?? "composite";
    const output = ctx.allocImage();
    ctx.drawFullscreen(renderProg, output, () => {
      bindTex(renderProg, 0, "u_dye", state.dye[state.dyeIdx].texture);
      bindTex(renderProg, 1, "u_vel", readVel().texture);
      gl.uniform1i(
        gl.getUniformLocation(renderProg, "u_view"),
        view === "velocity" ? 1 : 0
      );
      gl.uniform1f(gl.getUniformLocation(renderProg, "u_gridW"), simW);
    });

    // Velocity aux — always built (cheap single pass; a paused cache hit
    // must return a valid aux, the loop-weave rule).
    const velOut = ctx.allocImage();
    ctx.drawFullscreen(renderProg, velOut, () => {
      bindTex(renderProg, 0, "u_dye", state.dye[state.dyeIdx].texture);
      bindTex(renderProg, 1, "u_vel", readVel().texture);
      gl.uniform1i(gl.getUniformLocation(renderProg, "u_view"), 1);
      gl.uniform1f(gl.getUniformLocation(renderProg, "u_gridW"), simW);
    });

    return { primary: output, aux: { velocity: velOut } };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const s = ctx.state[key] as FluidState | undefined;
    if (s) releaseState(ctx, s);
    delete ctx.state[key];
  },
};
