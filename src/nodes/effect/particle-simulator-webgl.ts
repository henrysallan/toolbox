import type {
  ColliderDescriptor,
  EmitterDescriptor,
  ForceDescriptor,
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  NodeOutput,
  ParticlesValue,
  Point,
  PointsValue,
  RenderContext,
  SocketValue,
} from "@/engine/types";
import { aspectUncorrectY } from "@/engine/aspect";
import { pointsFromArray } from "@/engine/points";

// =====================================================================
// Particle Simulator — fragment-shader GPGPU on RGBA16F textures
// =====================================================================
//
// Each particle is one pixel in a square texture. Two textures hold
// state:
//   positionTex.RGBA = (pos.x, pos.y, age, lifetime)   — age 0 = dead
//   velocityTex.RGBA = (vel.x, vel.y, _, _)
//
// Per frame, one fragment-shader pass reads the prev pair and writes
// the next pair via WebGL2 multi-render-target (gl.drawBuffers). Both
// step (apply forces, integrate, age) and spawn (revive dead pixels
// from emitters) happen in the same shader so we don't need a second
// pass.
//
// Forces and emitters are CPU descriptors carried on `force` /
// `emitter` sockets. The shader has a fixed cap (MAX_FORCES,
// MAX_EMITTERS) and a switch over their `kind` ints — keeps shader
// compiles deterministic without runtime stitching.
//
// State is stored on ctx.state[`particle-simulator:${nodeId}`] so it
// survives across frames. The eval cache doesn't touch it (textures
// are owned by this state, not allocated through ctx.allocImage).
//
// WebGPU upgrade path: replace the fragment-shader pass with a real
// compute kernel via ctx.getWebGPUDevice(); read final positions back
// to a WebGL texture via ctx.uploadFloat32ToImage so downstream WebGL
// nodes (renderer, etc.) consume the result with no API change. The
// texture layout, force/emitter/collider descriptor contracts, and
// the ParticlesValue output shape stay identical — only the kernel
// body changes.

const MAX_FORCES = 8;
const MAX_EMITTERS = 4;
const MAX_COLLIDERS = 6;
// Cap CPU readback for the optional points output. Higher values make
// the per-frame stall painful (sync gl.readPixels), so the user opts
// in via `outputPoints` and trades latency for compatibility with
// existing point-consumers like Copy-to-Points.
const POINTS_READBACK_CAP = 8192;

const FORCE_KIND: Record<ForceDescriptor["kind"], number> = {
  gravity: 0,
  drag: 1,
  point: 2,
  vortex: 3,
  wind: 4,
  turbulence: 5,
};

const EMITTER_KIND: Record<EmitterDescriptor["kind"], number> = {
  point: 0,
  image_mask: 1,
};

const COLLIDER_KIND: Record<ColliderDescriptor["kind"], number> = {
  circle: 0,
  line: 1,
  image_mask: 2,
};

const BOUNDS_MODE: Record<string, number> = {
  off: 0,
  bounce: 1,
  wrap: 2,
  clamp: 3,
  kill: 4,
};

// Texture units. 0/1 read state; 2..(2+MAX_EMITTERS-1) are emitter
// masks; (EMITTER+MAX_EMITTERS)..+MAX_COLLIDERS are collider masks.
const POS_UNIT = 0;
const VEL_UNIT = 1;
const EMITTER_MASK_BASE_UNIT = 2;
const COLLIDER_MASK_BASE_UNIT = EMITTER_MASK_BASE_UNIT + MAX_EMITTERS;

const STEP_FS = `#version 300 es
precision highp float;

in vec2 v_uv;

uniform sampler2D u_pos;
uniform sampler2D u_vel;
uniform vec2 u_texSize;
uniform float u_dt;
uniform float u_time;
uniform float u_seed;
uniform int u_resetFlag;

uniform int u_forceCount;
uniform int u_forceKinds[${MAX_FORCES}];
uniform vec4 u_forceA[${MAX_FORCES}];
uniform vec4 u_forceB[${MAX_FORCES}];

uniform int u_emitterCount;
uniform int u_emitterKinds[${MAX_EMITTERS}];
uniform vec4 u_emitterA[${MAX_EMITTERS}];
uniform vec4 u_emitterB[${MAX_EMITTERS}];
uniform float u_emitterTickets[${MAX_EMITTERS}];
uniform int u_emitterHasMask[${MAX_EMITTERS}];
uniform sampler2D u_emitterMask0;
uniform sampler2D u_emitterMask1;
uniform sampler2D u_emitterMask2;
uniform sampler2D u_emitterMask3;

uniform int u_colliderCount;
uniform int u_colliderKinds[${MAX_COLLIDERS}];
uniform vec4 u_colliderA[${MAX_COLLIDERS}];
uniform vec4 u_colliderB[${MAX_COLLIDERS}];
uniform sampler2D u_colliderMask0;
uniform sampler2D u_colliderMask1;
uniform sampler2D u_colliderMask2;
uniform sampler2D u_colliderMask3;
uniform sampler2D u_colliderMask4;
uniform sampler2D u_colliderMask5;

// Screen bounds: 0=off, 1=bounce, 2=wrap, 3=clamp, 4=kill
uniform int u_boundsMode;
uniform float u_boundsRestitution;

// Canvas aspect (W / H) for the descriptor seam below.
uniform float u_aspect;

layout(location = 0) out vec4 outPos;
layout(location = 1) out vec4 outVel;

// ---- hash helpers --------------------------------------------------
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// ---- 2D simplex noise + curl ---------------------------------------
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
// 2D curl-noise: take orthogonal gradient of a noise potential.
vec2 curl2(vec2 p, float t) {
  float eps = 0.01;
  float n1 = snoise2(p + vec2(0.0, eps) + vec2(t, -t));
  float n2 = snoise2(p - vec2(0.0, eps) + vec2(t, -t));
  float n3 = snoise2(p + vec2(eps, 0.0) + vec2(t, -t));
  float n4 = snoise2(p - vec2(eps, 0.0) + vec2(t, -t));
  return vec2((n1 - n2) / (2.0 * eps), -(n3 - n4) / (2.0 * eps));
}

// ---- descriptor space seam -----------------------------------------
// The solver itself runs in y-down CANVAS UV: that is what the bounds
// box (the unit square IS the canvas), the emitter/collider mask
// samplers, and Particles to Image all speak, so none of that moves.
//
// Force, analytic-collider and emitter descriptors are AUTHORED
// coordinates instead (engine/aspect.ts): x still spans the width, but
// y is width-isotropic and vertically centered. That is the space where
// a radius descriptor describes an actual circle rather than an ellipse,
// it's where the CPU sims evaluate the very same descriptors
// (engine/sim-kernel.ts, via Rope / Rigid Body) — so one Point Force
// feels identical wired into any simulator. Evaluating them in canvas
// UV, as this shader used to, put every radial force off-center
// vertically and squashed its falloff into an ellipse on 16:9.
//
// Positions map affinely; velocities and offsets are pure vectors, so
// they only scale. Authored velocity is W px/sec on BOTH axes, which is
// what makes gravity match across sims. Square canvas = identity.
vec2 toAuthored(vec2 p) { return vec2(p.x, 0.5 + (p.y - 0.5) / u_aspect); }
vec2 toCanvas(vec2 p) { return vec2(p.x, 0.5 + (p.y - 0.5) * u_aspect); }
vec2 toAuthoredVec(vec2 v) { return vec2(v.x, v.y / u_aspect); }
vec2 toCanvasVec(vec2 v) { return vec2(v.x, v.y * u_aspect); }

// ---- emitter mask sampling ----------------------------------------
vec4 sampleEmitterMask(int slot, vec2 uv) {
  // GLSL won't let us index a sampler array, so unroll manually.
  if (slot == 0) return texture(u_emitterMask0, uv);
  if (slot == 1) return texture(u_emitterMask1, uv);
  if (slot == 2) return texture(u_emitterMask2, uv);
  return texture(u_emitterMask3, uv);
}

vec4 sampleColliderMask(int slot, vec2 uv) {
  if (slot == 0) return texture(u_colliderMask0, uv);
  if (slot == 1) return texture(u_colliderMask1, uv);
  if (slot == 2) return texture(u_colliderMask2, uv);
  if (slot == 3) return texture(u_colliderMask3, uv);
  if (slot == 4) return texture(u_colliderMask4, uv);
  return texture(u_colliderMask5, uv);
}

// ---- collision response -------------------------------------------
// Apply each collider in order. Returns false if the particle should
// die (kill-on-contact case). Velocity reflects against the surface
// normal scaled by restitution. Position is nudged out of penetration
// so the next frame's check doesn't immediately re-trigger.
bool resolveColliders(inout vec2 pos, inout vec2 vel) {
  for (int i = 0; i < ${MAX_COLLIDERS}; i++) {
    if (i >= u_colliderCount) break;
    int ck = u_colliderKinds[i];
    vec4 ca = u_colliderA[i];
    vec4 cb = u_colliderB[i];
    if (ck == 0) {
      // circle: ca.xy=center, ca.z=radius, ca.w=inside(0/1); cb.x=resti
      // Resolved in AUTHORED space — a radius only bounds a circle
      // there. Written back only on contact, so non-touching particles
      // never eat the round-trip's float drift.
      vec2 p = toAuthored(pos);
      vec2 v = toAuthoredVec(vel);
      vec2 d = p - ca.xy;
      float r = length(d);
      bool inside = ca.w > 0.5;
      bool penetrating = inside ? r > ca.z : r < ca.z;
      if (penetrating && r > 1e-5) {
        vec2 n = (d / r) * (inside ? -1.0 : 1.0);
        // Push out along the normal back to the surface.
        p = inside
          ? ca.xy + n * (-ca.z)
          : ca.xy + (d / r) * ca.z;
        float vn = dot(v, n);
        if (vn < 0.0) {
          v -= (1.0 + cb.x) * vn * n;
        }
        pos = toCanvas(p);
        vel = toCanvasVec(v);
      }
    } else if (ck == 1) {
      // line half-plane: ca.xy=normal, ca.z=offset; cb.x=resti
      // Block points with n·p < d. Authored space again: the descriptor
      // carries a UNIT normal, and only there does it stay unit-length
      // (and the plane stay at the authored angle).
      vec2 p = toAuthored(pos);
      vec2 v = toAuthoredVec(vel);
      float dist = dot(ca.xy, p) - ca.z;
      if (dist < 0.0) {
        vec2 n = ca.xy;
        p -= dist * n;
        float vn = dot(v, n);
        if (vn < 0.0) v -= (1.0 + cb.x) * vn * n;
        pos = toCanvas(p);
        vel = toCanvasVec(v);
      }
    } else if (ck == 2) {
      // image mask: ca.x=threshold; cb.x=resti; cb.y=killFlag (0/1)
      // pos is Y-DOWN canvas-UV; texture coords are Y-UP. Flip V on
      // every mask sample so the collider geometry aligns visually
      // with the source mask.
      vec2 sampleUv = clamp(vec2(pos.x, 1.0 - pos.y), vec2(0.0), vec2(1.0));
      float a = sampleColliderMask(i, sampleUv).a;
      if (a >= ca.x) {
        if (cb.y > 0.5) return false;
        // Estimate gradient via central differences on the mask alpha.
        float eps = 0.004;
        float aL = sampleColliderMask(i, sampleUv + vec2(-eps, 0.0)).a;
        float aR = sampleColliderMask(i, sampleUv + vec2( eps, 0.0)).a;
        float aD = sampleColliderMask(i, sampleUv + vec2(0.0, -eps)).a;
        float aU = sampleColliderMask(i, sampleUv + vec2(0.0,  eps)).a;
        // Gradient is in texture-UV (Y-up); flip Y to convert back to
        // pos-space (Y-down) so the normal points the right way.
        vec2 grad = vec2(aR - aL, -(aU - aD));
        float gradLen = length(grad);
        vec2 n = gradLen > 1e-5 ? -grad / gradLen : -normalize(vel + 1e-5);
        // Step out of the opaque region by a small amount along normal.
        pos += n * eps * 2.0;
        float vn = dot(vel, n);
        if (vn < 0.0) vel -= (1.0 + cb.x) * vn * n;
      }
    }
  }
  return true;
}

// Returns false if the particle should die (kill bounds).
bool resolveBounds(inout vec2 pos, inout vec2 vel) {
  if (u_boundsMode == 0) return true;
  // 1 = bounce, 2 = wrap, 3 = clamp, 4 = kill
  if (u_boundsMode == 2) {
    pos = fract(pos);
    return true;
  }
  if (u_boundsMode == 4) {
    if (pos.x < 0.0 || pos.x > 1.0 || pos.y < 0.0 || pos.y > 1.0) {
      return false;
    }
    return true;
  }
  // bounce/clamp share clamping; bounce additionally reflects.
  bool reflect = u_boundsMode == 1;
  if (pos.x < 0.0) {
    pos.x = 0.0;
    if (reflect && vel.x < 0.0) vel.x = -vel.x * u_boundsRestitution;
  } else if (pos.x > 1.0) {
    pos.x = 1.0;
    if (reflect && vel.x > 0.0) vel.x = -vel.x * u_boundsRestitution;
  }
  if (pos.y < 0.0) {
    pos.y = 0.0;
    if (reflect && vel.y < 0.0) vel.y = -vel.y * u_boundsRestitution;
  } else if (pos.y > 1.0) {
    pos.y = 1.0;
    if (reflect && vel.y > 0.0) vel.y = -vel.y * u_boundsRestitution;
  }
  return true;
}

// ---- force application --------------------------------------------
void applyForce(int kind, vec4 a, vec4 b, vec2 pos, inout vec2 vel, float dt) {
  if (kind == 0) {
    // gravity: a.xy = (gx, gy)
    vel += a.xy * dt;
  } else if (kind == 1) {
    // drag: a.x = coeff
    vel *= max(0.0, 1.0 - a.x * dt);
  } else if (kind == 2) {
    // point: a.xy=center, a.z=strength, a.w=falloff; b.x=sign, b.y=radius
    vec2 d = pos - a.xy;
    float r = length(d);
    if (r < b.y && r > 1e-5) {
      float t = clamp(1.0 - r / b.y, 0.0, 1.0);
      float f = a.z * pow(t, a.w);
      vel += (d / r) * f * b.x * dt;
    }
  } else if (kind == 3) {
    // vortex: a.xy=center, a.z=strength, a.w=falloff; b.y=radius
    vec2 d = pos - a.xy;
    float r = length(d);
    if (r < b.y && r > 1e-5) {
      vec2 tang = vec2(-d.y, d.x) / r;
      float t = clamp(1.0 - r / b.y, 0.0, 1.0);
      float f = a.z * pow(t, a.w);
      vel += tang * f * dt;
    }
  } else if (kind == 4) {
    // wind: a.xy=direction (raw), a.z=strength
    vec2 d = a.xy;
    float l = length(d);
    if (l > 1e-5) vel += (d / l) * a.z * dt;
  } else if (kind == 5) {
    // turbulence: a.x=scale, a.y=strength, a.z=speed
    vec2 c = curl2(pos * a.x, u_time * a.z);
    vel += c * a.y * dt;
  }
}

void main() {
  vec2 uv = v_uv;
  ivec2 idx = ivec2(gl_FragCoord.xy);
  float pid = float(idx.x) + float(idx.y) * u_texSize.x;

  // Hard reset on the first frame after time wraps to 0 — clears all
  // particles so a /play-from-start replay produces deterministic
  // motion instead of evolving from whatever was on screen last loop.
  if (u_resetFlag == 1) {
    outPos = vec4(0.0);
    outVel = vec4(0.0);
    return;
  }

  vec4 pState = texture(u_pos, uv);
  vec4 vState = texture(u_vel, uv);
  vec2 pos = pState.xy;
  float age = pState.z;
  float lifetime = pState.w;
  vec2 vel = vState.xy;

  bool alive = age > 0.0 && age < lifetime && lifetime > 0.0;

  if (!alive) {
    // Spawn attempt: roll one ticket per emitter; first hit wins.
    bool spawned = false;
    for (int i = 0; i < ${MAX_EMITTERS}; i++) {
      if (i >= u_emitterCount) break;
      if (spawned) break;
      float ticket = u_emitterTickets[i];
      float r = hash11(pid + u_time * 1000.0 + float(i) * 137.137 + u_seed);
      if (r >= ticket) continue;

      int ek = u_emitterKinds[i];
      vec4 ea = u_emitterA[i];
      vec4 eb = u_emitterB[i];
      vec2 spawnPos = vec2(0.0);
      vec2 spawnVel = vec2(0.0);
      float spawnLife = max(eb.w, 0.05);

      if (ek == 0) {
        // point: ea.xy=center, ea.z=spread; eb.xy=v, eb.z=vJitter, eb.w=lifetime
        // Center, spread and launch velocity are AUTHORED, so the
        // spread box stays square and the emitter sits where the
        // descriptor says; convert into the solver's canvas UV once.
        vec2 j = (hash22(vec2(pid, u_time * 31.0 + float(i))) - 0.5) * 2.0 * ea.z;
        spawnPos = toCanvas(ea.xy + j);
        vec2 vj = (hash22(vec2(pid * 7.0 + 13.0, u_time * 23.0 + float(i))) - 0.5)
                  * 2.0 * eb.z;
        spawnVel = toCanvasVec(eb.xy + vj);
      } else if (ek == 1) {
        // image_mask: ea.x=threshold; eb.xy=v, eb.z=vJitter, eb.w=lifetime
        float threshold = ea.x;
        // Rejection sample: try a few candidate UVs; accept the first
        // one above threshold. uvk is in pos-space (Y-DOWN); flip V on
        // the texture sample so a bright spot at the visual top of the
        // mask spawns particles at the visual top.
        bool found = false;
        for (int k = 0; k < 4; k++) {
          vec2 uvk = hash22(vec2(pid * 11.0 + float(k) * 17.0, u_time * 41.0 + float(i)));
          float a = sampleEmitterMask(i, vec2(uvk.x, 1.0 - uvk.y)).a;
          if (a >= threshold) {
            spawnPos = uvk;
            found = true;
            break;
          }
        }
        if (!found) continue;
        // spawnPos came from rejection-sampling the mask, which is
        // canvas-aligned — it's already in the solver's space. Only the
        // launch velocity is an authored descriptor.
        vec2 vj = (hash22(vec2(pid * 9.0 + 5.0, u_time * 19.0 + float(i))) - 0.5)
                  * 2.0 * eb.z;
        spawnVel = toCanvasVec(eb.xy + vj);
      }

      outPos = vec4(spawnPos, max(u_dt, 1e-4), spawnLife);
      outVel = vec4(spawnVel, 0.0, 0.0);
      spawned = true;
    }
    if (!spawned) {
      outPos = vec4(0.0);
      outVel = vec4(0.0);
    }
    return;
  }

  // Alive: integrate forces (semi-implicit Euler), advance age.
  // The whole force block runs in AUTHORED space — position AND
  // velocity — so radial falloffs stay round and turbulence cells stay
  // square; only the resulting velocity converts back. Forces read pos
  // and write vel, so the round trip is exact.
  if (u_forceCount > 0) {
    vec2 fPos = toAuthored(pos);
    vec2 fVel = toAuthoredVec(vel);
    for (int i = 0; i < ${MAX_FORCES}; i++) {
      if (i >= u_forceCount) break;
      applyForce(u_forceKinds[i], u_forceA[i], u_forceB[i], fPos, fVel, u_dt);
    }
    vel = toCanvasVec(fVel);
  }
  pos += vel * u_dt;
  age += u_dt;

  // Resolve user colliders, then screen bounds. Either may kill the
  // particle (kill-on-contact mask collider, or "kill" bounds mode).
  bool stillAlive = resolveColliders(pos, vel);
  if (stillAlive) stillAlive = resolveBounds(pos, vel);

  if (!stillAlive || age >= lifetime) {
    outPos = vec4(0.0);
    outVel = vec4(0.0);
  } else {
    outPos = vec4(pos, age, lifetime);
    outVel = vec4(vel, 0.0, 0.0);
  }
}`;

interface SimState {
  texW: number;
  texH: number;
  count: number;
  posA: WebGLTexture;
  posB: WebGLTexture;
  velA: WebGLTexture;
  velB: WebGLTexture;
  fboA: WebGLFramebuffer;
  fboB: WebGLFramebuffer;
  // 0 = read from A, write to B; 1 = the reverse. Flips each frame.
  readIdx: 0 | 1;
  lastTime: number;
}

function stateKey(nodeId: string) {
  // MUST start with the registered node type ("particle-simulator") so the
  // evaluator's dispose sweep (which resolves the key's first `:` segment via
  // getNodeDef) actually fires dispose on node deletion / backend teardown. The
  // old "particle-sim:" prefix resolved to no def, so dispose was dead code and
  // every add/delete cycle leaked 4 textures + 2 FBOs. See 072226 audit #6.
  return `particle-simulator:${nodeId}`;
}

function disposeState(ctx: RenderContext, st: SimState) {
  const gl = ctx.gl;
  ctx.releaseTexture(st.posA);
  ctx.releaseTexture(st.posB);
  ctx.releaseTexture(st.velA);
  ctx.releaseTexture(st.velB);
  gl.deleteFramebuffer(st.fboA);
  gl.deleteFramebuffer(st.fboB);
}

function ensureState(
  ctx: RenderContext,
  nodeId: string,
  texW: number,
  texH: number
): SimState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as SimState | undefined;
  if (existing && existing.texW === texW && existing.texH === texH) {
    return existing;
  }
  if (existing) disposeState(ctx, existing);

  // ctx.allocImage gives RGBA16F (or RGBA8 fallback) — perfect for
  // packing (pos.x, pos.y, age, lifetime). Mark these as persistent
  // by NEVER releasing back to the pool until disposeState.
  const posA = ctx.allocImage({ width: texW, height: texH });
  const posB = ctx.allocImage({ width: texW, height: texH });
  const velA = ctx.allocImage({ width: texW, height: texH });
  const velB = ctx.allocImage({ width: texW, height: texH });
  ctx.clearTarget(posA, [0, 0, 0, 0]);
  ctx.clearTarget(posB, [0, 0, 0, 0]);
  ctx.clearTarget(velA, [0, 0, 0, 0]);
  ctx.clearTarget(velB, [0, 0, 0, 0]);

  const gl = ctx.gl;
  const fboA = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fboA);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    posA.texture,
    0
  );
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT1,
    gl.TEXTURE_2D,
    velA.texture,
    0
  );
  const fboB = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    posB.texture,
    0
  );
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT1,
    gl.TEXTURE_2D,
    velB.texture,
    0
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const st: SimState = {
    texW,
    texH,
    count: texW * texH,
    posA: posA.texture,
    posB: posB.texture,
    velA: velA.texture,
    velB: velB.texture,
    fboA,
    fboB,
    readIdx: 0,
    lastTime: ctx.time,
  };
  ctx.state[key] = st;
  return st;
}

function pickSquare(count: number): { w: number; h: number } {
  // Round count up to the next square texture edge so we always have
  // a tight square. count=1000 → 32×32=1024.
  const side = Math.max(1, Math.ceil(Math.sqrt(count)));
  return { w: side, h: side };
}

// ---- descriptor packing ------------------------------------------
// Each force / emitter packs into two vec4s. Slots not set are zeroed.
// Same layout the shader's switch(kind) reads back.

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

interface EmitterPacked {
  kind: number;
  a: number[];
  b: number[];
  ticket: number;
  mask: ImageValue | null;
}

interface ColliderPacked {
  kind: number;
  a: number[];
  b: number[];
  mask: ImageValue | null;
}

function packCollider(d: ColliderDescriptor): ColliderPacked {
  const kind = COLLIDER_KIND[d.kind];
  const a = [0, 0, 0, 0];
  const b = [0, 0, 0, 0];
  let mask: ImageValue | null = null;
  switch (d.kind) {
    case "circle":
      a[0] = d.cx; a[1] = d.cy; a[2] = d.radius; a[3] = d.inside ? 1 : 0;
      b[0] = d.restitution;
      break;
    case "line":
      a[0] = d.nx; a[1] = d.ny; a[2] = d.d;
      b[0] = d.restitution;
      break;
    case "image_mask":
      a[0] = d.threshold;
      b[0] = d.restitution; b[1] = d.kill ? 1 : 0;
      mask = d.mask;
      break;
  }
  return { kind, a, b, mask };
}

function packEmitter(
  d: EmitterDescriptor,
  particleCount: number,
  dt: number
): EmitterPacked {
  const kind = EMITTER_KIND[d.kind];
  const a = [0, 0, 0, 0];
  const b = [0, 0, 0, 0];
  let mask: ImageValue | null = null;
  // Per-pixel spawn probability per frame: rate / count * dt. Capped
  // so a pathological rate doesn't try to set every pixel alive at once
  // (you'd want particles to live some frames, not be replaced instantly).
  const ticket = Math.min(0.5, (d.rate * dt) / Math.max(1, particleCount));
  switch (d.kind) {
    case "point":
      a[0] = d.px; a[1] = d.py; a[2] = d.spread;
      b[0] = d.vx; b[1] = d.vy; b[2] = d.vJitter; b[3] = d.lifetime;
      break;
    case "image_mask":
      a[0] = d.threshold;
      b[0] = d.vx; b[1] = d.vy; b[2] = d.vJitter; b[3] = d.lifetime;
      mask = d.mask;
      break;
  }
  return { kind, a, b, ticket, mask };
}

// ---- node definition ---------------------------------------------

const FORCE_INPUTS_MAX = MAX_FORCES;
const EMITTER_INPUTS_MAX = MAX_EMITTERS;
const COLLIDER_INPUTS_MAX = MAX_COLLIDERS;

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

export const particleSimulatorWebGLNode: NodeDefinition = {
  type: "particle-simulator",
  name: "Particle Simulator",
  category: "effect",
  description:
    "GPU particle simulator. Wire forces and emitters; output is a particles socket consumed by Particles to Image. Counts up to ~65k particles run in real-time on most GPUs.",
  backend: "webgl2",
  // Output depends on persistent state (the texture pair) — must
  // re-evaluate every frame. The fingerprint extras include ctx.time
  // so the cache busts each tick.
  stable: false,
  simulation: true,
  inputs: [],
  resolveInputs(params): InputSocketDef[] {
    const fc = Math.max(
      0,
      Math.min(FORCE_INPUTS_MAX, Math.floor((params.forceCount as number) ?? 2))
    );
    const ec = Math.max(
      1,
      Math.min(
        EMITTER_INPUTS_MAX,
        Math.floor((params.emitterCount as number) ?? 1)
      )
    );
    const cc = Math.max(
      0,
      Math.min(
        COLLIDER_INPUTS_MAX,
        Math.floor((params.colliderCount as number) ?? 0)
      )
    );
    const out: InputSocketDef[] = [];
    for (let i = 0; i < ec; i++) {
      out.push({ name: `emitter${i + 1}`, type: "emitter", required: false });
    }
    for (let i = 0; i < fc; i++) {
      out.push({ name: `force${i + 1}`, type: "force", required: false });
    }
    for (let i = 0; i < cc; i++) {
      out.push({ name: `collider${i + 1}`, type: "collider", required: false });
    }
    return out;
  },
  resolveAuxOutputs(params) {
    // The points output is opt-in: it forces a sync gl.readPixels each
    // frame, which costs ~1ms per 4k particles. Hide the socket when
    // off so users don't accidentally wire to a no-op.
    if (params.outputPoints) {
      return [{ name: "points", type: "points" as const }];
    }
    return [];
  },
  params: [
    {
      name: "count",
      label: "Max particles",
      type: "scalar",
      min: 64,
      max: 262144,
      step: 64,
      softMax: 65536,
      default: 4096,
    },
    {
      name: "emitterCount",
      label: "Emitter slots",
      type: "scalar",
      min: 1,
      max: EMITTER_INPUTS_MAX,
      step: 1,
      default: 1,
    },
    {
      name: "forceCount",
      label: "Force slots",
      type: "scalar",
      min: 0,
      max: FORCE_INPUTS_MAX,
      step: 1,
      default: 2,
    },
    {
      name: "colliderCount",
      label: "Collider slots",
      type: "scalar",
      min: 0,
      max: COLLIDER_INPUTS_MAX,
      step: 1,
      default: 0,
    },
    {
      name: "boundsMode",
      label: "Screen bounds",
      type: "enum",
      options: ["off", "bounce", "wrap", "clamp", "kill"],
      default: "off",
    },
    {
      name: "boundsRestitution",
      label: "Bounds bounce",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.6,
      visibleIf: (p) => p.boundsMode === "bounce",
    },
    {
      name: "outputPoints",
      label: "Output points (CPU readback)",
      type: "boolean",
      default: false,
    },
    {
      name: "fixedDt",
      label: "Substep dt",
      type: "scalar",
      min: 0.001,
      max: 0.1,
      step: 0.001,
      default: 1 / 60,
    },
    {
      name: "backend",
      label: "Backend",
      type: "enum",
      // "webgl" — the original RGBA16F fragment-GPGPU path. Full
      // feature parity (all forces, emitters, colliders).
      // "webgpu" — the new compute kernel. Phase 1-2 coverage:
      // gravity / drag / point / vortex / wind / turbulence forces
      // and all bounds modes. Emitters and colliders are stubbed
      // (no spawning past the initial random population, no
      // collision). See specdocs/archive/webgpu-particles.md.
      options: ["webgl", "webgpu"],
      default: "webgl",
    },
  ],
  primaryOutput: "particles",
  auxOutputs: [],

  fingerprintExtras(_params, ctx) {
    // Force per-frame re-eval; without this the cache would lock the
    // sim to its first computed output and never advance.
    return `t:${ctx.time.toFixed(4)}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const count = Math.max(
      64,
      Math.min(262144, Math.floor((params.count as number) ?? 4096))
    );
    const { w: texW, h: texH } = pickSquare(count);
    const dt = Math.max(
      0.001,
      Math.min(0.1, (params.fixedDt as number) ?? 1 / 60)
    );

    const st = ensureState(ctx, nodeId, texW, texH);

    // Reset on time wrap (RAF loop / scrub-to-start). Same heuristic
    // the trails / sim-zone nodes use.
    const wasNonZero = st.lastTime > 0.05;
    const isNearZero = ctx.time < 0.05;
    const reset = wasNonZero && isNearZero;
    // House sim contract (rope/rigid precedent): advance only while playing or
    // when an offline export steps to a NEW time. Evals at an UNCHANGED
    // ctx.time — a paused playhead, split view's 2nd pass, and above all the
    // offline settle RE-RENDER — re-emit the current state without advancing,
    // so the sim doesn't double-step on export (motion matching preview) or
    // drift while paused. A time wrap still resets below even when not active.
    // See 072226 sim audit #2. `active` reads st.lastTime BEFORE it's updated.
    const active =
      ctx.playing || (ctx.offline && ctx.time > st.lastTime + 1e-6);
    const runStep = active || reset;
    st.lastTime = ctx.time;

    // Gather force / emitter descriptors from inputs.
    const forces = gatherDescriptors<ForceDescriptor>(
      inputs,
      "force",
      FORCE_INPUTS_MAX,
      (v) => (v.kind === "force" ? v.descriptor : null)
    );
    const emitters = gatherDescriptors<EmitterDescriptor>(
      inputs,
      "emitter",
      EMITTER_INPUTS_MAX,
      (v) => (v.kind === "emitter" ? v.descriptor : null)
    );
    const colliders = gatherDescriptors<ColliderDescriptor>(
      inputs,
      "collider",
      COLLIDER_INPUTS_MAX,
      (v) => (v.kind === "collider" ? v.descriptor : null)
    );

    const forcePacked = forces.slice(0, MAX_FORCES).map(packForce);
    const emitterPacked = emitters
      .slice(0, MAX_EMITTERS)
      .map((d) => packEmitter(d, st.count, dt));
    const colliderPacked = colliders.slice(0, MAX_COLLIDERS).map(packCollider);

    // Pad arrays out to the shader's fixed cap so uniformXv calls have
    // a stable length regardless of how many inputs are actually wired.
    const padForce = (n: number): number[] => {
      const out: number[] = new Array(n * 4).fill(0);
      for (let i = 0; i < forcePacked.length; i++) {
        out[i * 4 + 0] = forcePacked[i].a[0];
        out[i * 4 + 1] = forcePacked[i].a[1];
        out[i * 4 + 2] = forcePacked[i].a[2];
        out[i * 4 + 3] = forcePacked[i].a[3];
      }
      return out;
    };
    const forceA = new Float32Array(MAX_FORCES * 4);
    const forceB = new Float32Array(MAX_FORCES * 4);
    const forceKinds = new Int32Array(MAX_FORCES);
    for (let i = 0; i < MAX_FORCES; i++) {
      const p = forcePacked[i];
      if (!p) continue;
      forceKinds[i] = p.kind;
      forceA.set(p.a, i * 4);
      forceB.set(p.b, i * 4);
    }
    void padForce;

    const emitterA = new Float32Array(MAX_EMITTERS * 4);
    const emitterB = new Float32Array(MAX_EMITTERS * 4);
    const emitterKinds = new Int32Array(MAX_EMITTERS);
    const emitterTickets = new Float32Array(MAX_EMITTERS);
    const emitterHasMask = new Int32Array(MAX_EMITTERS);
    for (let i = 0; i < MAX_EMITTERS; i++) {
      const e = emitterPacked[i];
      if (!e) continue;
      emitterKinds[i] = e.kind;
      emitterA.set(e.a, i * 4);
      emitterB.set(e.b, i * 4);
      emitterTickets[i] = e.ticket;
      emitterHasMask[i] = e.mask ? 1 : 0;
    }

    const colliderA = new Float32Array(MAX_COLLIDERS * 4);
    const colliderB = new Float32Array(MAX_COLLIDERS * 4);
    const colliderKinds = new Int32Array(MAX_COLLIDERS);
    for (let i = 0; i < MAX_COLLIDERS; i++) {
      const c = colliderPacked[i];
      if (!c) continue;
      colliderKinds[i] = c.kind;
      colliderA.set(c.a, i * 4);
      colliderB.set(c.b, i * 4);
    }

    // ---- run the pass --------------------------------------------
    const gl = ctx.gl;
    const program = ctx.getShader("particle-sim/step", STEP_FS);
    gl.useProgram(program);

    const readIdx = st.readIdx;
    const readPos = readIdx === 0 ? st.posA : st.posB;
    const readVel = readIdx === 0 ? st.velA : st.velB;
    const writeFbo = readIdx === 0 ? st.fboB : st.fboA;
    const writePos = readIdx === 0 ? st.posB : st.posA;
    const writeVel = readIdx === 0 ? st.velB : st.velA;

    gl.bindFramebuffer(gl.FRAMEBUFFER, writeFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, texW, texH);

    // Bind read state.
    gl.activeTexture(gl.TEXTURE0 + POS_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, readPos);
    gl.uniform1i(gl.getUniformLocation(program, "u_pos"), POS_UNIT);
    gl.activeTexture(gl.TEXTURE0 + VEL_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, readVel);
    gl.uniform1i(gl.getUniformLocation(program, "u_vel"), VEL_UNIT);

    gl.uniform2f(gl.getUniformLocation(program, "u_texSize"), texW, texH);
    gl.uniform1f(gl.getUniformLocation(program, "u_dt"), dt);
    gl.uniform1f(gl.getUniformLocation(program, "u_time"), ctx.time);
    gl.uniform1f(gl.getUniformLocation(program, "u_seed"), ctx.frame * 0.013);
    gl.uniform1i(
      gl.getUniformLocation(program, "u_resetFlag"),
      reset ? 1 : 0
    );
    // Descriptor seam (see toAuthored/toCanvas in the shader).
    gl.uniform1f(
      gl.getUniformLocation(program, "u_aspect"),
      ctx.height > 0 ? ctx.width / ctx.height : 1
    );

    gl.uniform1i(
      gl.getUniformLocation(program, "u_forceCount"),
      Math.min(forces.length, MAX_FORCES)
    );
    gl.uniform1iv(gl.getUniformLocation(program, "u_forceKinds"), forceKinds);
    gl.uniform4fv(gl.getUniformLocation(program, "u_forceA"), forceA);
    gl.uniform4fv(gl.getUniformLocation(program, "u_forceB"), forceB);

    gl.uniform1i(
      gl.getUniformLocation(program, "u_emitterCount"),
      Math.min(emitters.length, MAX_EMITTERS)
    );
    gl.uniform1iv(
      gl.getUniformLocation(program, "u_emitterKinds"),
      emitterKinds
    );
    gl.uniform4fv(gl.getUniformLocation(program, "u_emitterA"), emitterA);
    gl.uniform4fv(gl.getUniformLocation(program, "u_emitterB"), emitterB);
    gl.uniform1fv(
      gl.getUniformLocation(program, "u_emitterTickets"),
      emitterTickets
    );
    gl.uniform1iv(
      gl.getUniformLocation(program, "u_emitterHasMask"),
      emitterHasMask
    );

    // Bind emitter mask textures into stable units so the shader's
    // unrolled sampler switch can read them. Slots without a mask
    // get the read-pos texture as harmless filler — sampler uniforms
    // need SOMETHING bound or WebGL warns.
    for (let i = 0; i < MAX_EMITTERS; i++) {
      const e = emitterPacked[i];
      const tex = e?.mask ? e.mask.texture : readPos;
      gl.activeTexture(gl.TEXTURE0 + EMITTER_MASK_BASE_UNIT + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(
        gl.getUniformLocation(program, `u_emitterMask${i}`),
        EMITTER_MASK_BASE_UNIT + i
      );
    }

    // Colliders: same pattern. Pack count, kinds, A, B uniforms.
    gl.uniform1i(
      gl.getUniformLocation(program, "u_colliderCount"),
      Math.min(colliders.length, MAX_COLLIDERS)
    );
    gl.uniform1iv(
      gl.getUniformLocation(program, "u_colliderKinds"),
      colliderKinds
    );
    gl.uniform4fv(gl.getUniformLocation(program, "u_colliderA"), colliderA);
    gl.uniform4fv(gl.getUniformLocation(program, "u_colliderB"), colliderB);
    for (let i = 0; i < MAX_COLLIDERS; i++) {
      const c = colliderPacked[i];
      const tex = c?.mask ? c.mask.texture : readPos;
      gl.activeTexture(gl.TEXTURE0 + COLLIDER_MASK_BASE_UNIT + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(
        gl.getUniformLocation(program, `u_colliderMask${i}`),
        COLLIDER_MASK_BASE_UNIT + i
      );
    }

    // Screen bounds toggle.
    const boundsName = (params.boundsMode as string) ?? "off";
    const boundsId = BOUNDS_MODE[boundsName] ?? 0;
    gl.uniform1i(gl.getUniformLocation(program, "u_boundsMode"), boundsId);
    gl.uniform1f(
      gl.getUniformLocation(program, "u_boundsRestitution"),
      Math.max(0, Math.min(1, (params.boundsRestitution as number) ?? 0.6))
    );

    // Draw fullscreen quad. The engine's VAO + sharedVs feeds (-1,-1)..
    // (1,1) clip-space — we use the same setup since drawFullscreen does.
    // Reuse it via ctx.drawFullscreen with a no-op target by NOT
    // re-binding the FBO. drawFullscreen rebinds, so call gl directly.
    // Instead: drive the same VAO. The engine always keeps the VAO bound
    // and the sharedVs is implicit from getShader's link. drawArrays(
    // TRIANGLES, 0, 3) — that's the fullscreen-triangle convention.
    if (runStep) gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // Restore the default single drawBuffer so subsequent passes don't
    // see ours (drawFullscreen et al assume COLOR_ATTACHMENT0 only).
    gl.drawBuffers([gl.BACK]);

    // Flip the read index only when we actually stepped; otherwise the write
    // textures are stale, so re-emit the current read state (no advance).
    if (runStep) st.readIdx = readIdx === 0 ? 1 : 0;
    const outPos = runStep ? writePos : readPos;
    const outVel = runStep ? writeVel : readVel;

    const out: ParticlesValue = {
      kind: "particles",
      positionTex: outPos,
      velocityTex: outVel,
      width: texW,
      height: texH,
      count: st.count,
    };

    const result: NodeOutput = { primary: out };
    if (params.outputPoints) {
      // CPU-bridge into a PointsValue. Cap the readback to keep the
      // sync stall bounded — a 65k-particle sim still works on the
      // GPU side, but the point output samples the first N particles.
      const cap = Math.min(POINTS_READBACK_CAP, st.count);
      // Read only the first `cap` rows by allocating an FBO over the
      // upper portion of the texture. Easier: read the whole thing
      // then slice. Memory cost matches the cap because we only keep
      // `cap` Point objects.
      const data = ctx.readImageToFloat32({
        kind: "image",
        texture: outPos,
        width: texW,
        height: texH,
      });
      // The position texture is y-down CANVAS UV (what Particles to
      // Image draws), but geometry sockets carry AUTHORED coordinates
      // (engine/aspect.ts), so y converts on the way out. Every points
      // consumer aspect-corrects at render time — Copy to Points' VS,
      // Points to Spline → rasterizer, Point Labels, the viewport
      // overlay — so handing them canvas UV double-corrects and spreads
      // the points vertically. Square canvas = identity.
      const aspect = ctx.height > 0 ? ctx.width / ctx.height : 1;
      const pts: Point[] = [];
      for (let i = 0; i < cap; i++) {
        const o = i * 4;
        const age = data[o + 2];
        const lifetime = data[o + 3];
        if (age <= 0 || lifetime <= 0 || age >= lifetime) continue;
        pts.push({ pos: [data[o], aspectUncorrectY(data[o + 1], aspect)] });
      }
      const points: PointsValue = pointsFromArray(pts);
      result.aux = { points };
    }

    return result;
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const st = ctx.state[key] as SimState | undefined;
    if (st) {
      disposeState(ctx, st);
      delete ctx.state[key];
    }
  },
};
