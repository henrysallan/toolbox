// =====================================================================
// Integrate kernel — Phase 1 WGSL
// =====================================================================
//
// Per-frame compute kernel for the WebGPU particle simulator. Reads
// the current ping-pong state, applies forces, integrates one Euler
// step, resolves screen bounds, ages each slot, and writes the next
// state. Layout mirrors the WebGL fragment kernel in
// particle-simulator-webgl.ts to keep the visual semantics identical:
//
//   pos[i] = vec4<f32>(x, y, age, lifetime)   // age 0 = dead slot
//   vel[i] = vec4<f32>(vx, vy, _, _)
//
// Phase 1 force coverage: gravity (kind 0), drag (kind 1). Other
// kinds (point/vortex/wind/turbulence) are stubbed — wiring them
// produces no force contribution, but the structural key still
// captures them so Phase 2 can fill them in without breaking caches.
//
// Emitters and colliders are not implemented in this phase. Reset
// hardcodes a uniform-random initial population so there's something
// to integrate (see the WebGPU migration spec, Phase 1).

import type { PipelineKey } from "../pipelines";

// Tracks the per-bind-group layout that the JS-side packer must
// honor. Storage buffer layout — looser rules than uniform, so
// `array<u32, 8>` packs at natural stride (4 bytes) instead of
// 16-byte-strided. Field offsets are referenced by the packer.
//
//   offset  field
//   ------  -----
//        0  dt: f32
//        4  time: f32
//        8  seed: f32
//       12  boundsRest: f32
//       16  count: u32
//       20  forceCount: u32
//       24  boundsMode: u32
//       28  resetFlag: u32
//       32  forceKinds: array<u32, 8>     // 32 bytes
//       64  forceA: array<vec4<f32>, 8>   // 128 bytes
//      192  forceB: array<vec4<f32>, 8>   // 128 bytes
//      320  END
export const PARAMS_BYTES = 320;
export const PARAMS_FORCE_KINDS_OFFSET = 32;
export const PARAMS_FORCE_A_OFFSET = 64;
export const PARAMS_FORCE_B_OFFSET = 192;

// Force-kind ints. Mirrors the WebGL kernel exactly so descriptor
// packing logic is shared between backends.
export const FORCE_KIND_GRAVITY = 0;
export const FORCE_KIND_DRAG = 1;
export const FORCE_KIND_POINT = 2;
export const FORCE_KIND_VORTEX = 3;
export const FORCE_KIND_WIND = 4;
export const FORCE_KIND_TURBULENCE = 5;

// Bounds-mode ints.
export const BOUNDS_OFF = 0;
export const BOUNDS_BOUNCE = 1;
export const BOUNDS_WRAP = 2;
export const BOUNDS_CLAMP = 3;
export const BOUNDS_KILL = 4;

// The kernel is structurally identical across all Phase 1 wirings —
// branches over force/bounds kinds are runtime switches. We still
// route through `buildIntegrateWgsl(key)` because Phase 2+ will start
// specializing the source per structural key (e.g. dropping unused
// branches, inlining curl-noise only when turbulence is present).
// Until then, key is unused.
export function buildIntegrateWgsl(key: PipelineKey): string {
  void key;
  return WGSL;
}

const WGSL = /* wgsl */ `
struct Params {
  dt: f32,
  time: f32,
  seed: f32,
  boundsRest: f32,
  count: u32,
  forceCount: u32,
  boundsMode: u32,
  resetFlag: u32,
  forceKinds: array<u32, 8>,
  forceA: array<vec4<f32>, 8>,
  forceB: array<vec4<f32>, 8>,
};

@group(0) @binding(0) var<storage, read> posIn: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> velIn: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> posOut: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> velOut: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> params: Params;

// hash helpers — direct ports of the WebGL kernel's hash11/hash22 so
// reset-time random seeds give identical visual variance across
// backends.
fn hash11(p_in: f32) -> f32 {
  var p = fract(p_in * 0.1031);
  p = p * (p + 33.33);
  p = p * (p + p);
  return fract(p);
}
fn hash22(p_in: vec2<f32>) -> vec2<f32> {
  var p3 = fract(vec3<f32>(p_in.x, p_in.y, p_in.x) * vec3<f32>(0.1031, 0.1030, 0.0973));
  p3 = p3 + dot(p3, vec3<f32>(p3.y, p3.z, p3.x) + vec3<f32>(33.33));
  return fract((vec2<f32>(p3.x, p3.x) + vec2<f32>(p3.y, p3.z)) * vec2<f32>(p3.z, p3.y));
}

// 2D simplex noise — direct port of the GLSL snoise2 in
// particle-simulator-webgl.ts:157-179. WGSL doesn't allow swizzle
// assignment (e.g. \`x12.xy = ...\`) and requires explicit scalar→vector
// broadcasts in a few places, so the structure is the same but a
// couple of intermediate vars are spelled out.
fn mod289_3(x: vec3<f32>) -> vec3<f32> {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}
fn mod289_2(x: vec2<f32>) -> vec2<f32> {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}
fn permute3(x: vec3<f32>) -> vec3<f32> {
  return mod289_3(((x * 34.0) + vec3<f32>(1.0)) * x);
}
fn snoise2(v: vec2<f32>) -> f32 {
  let C = vec4<f32>(0.211324865405187, 0.366025403784439,
                    -0.577350269189626, 0.024390243902439);
  var i = floor(v + vec2<f32>(dot(v, C.yy)));
  let x0 = v - i + vec2<f32>(dot(i, C.xx));
  let i1 = select(vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), x0.x > x0.y);
  let x12_pre = vec4<f32>(x0.x, x0.y, x0.x, x0.y) + vec4<f32>(C.x, C.x, C.z, C.z);
  let x12 = vec4<f32>(x12_pre.x - i1.x, x12_pre.y - i1.y, x12_pre.z, x12_pre.w);
  i = mod289_2(i);
  let p = permute3(
    permute3(vec3<f32>(i.y) + vec3<f32>(0.0, i1.y, 1.0))
      + vec3<f32>(i.x) + vec3<f32>(0.0, i1.x, 1.0)
  );
  var m = max(
    vec3<f32>(0.5) - vec3<f32>(
      dot(x0, x0),
      dot(vec2<f32>(x12.x, x12.y), vec2<f32>(x12.x, x12.y)),
      dot(vec2<f32>(x12.z, x12.w), vec2<f32>(x12.z, x12.w))
    ),
    vec3<f32>(0.0)
  );
  m = m * m;
  m = m * m;
  let x = 2.0 * fract(p * vec3<f32>(C.w)) - vec3<f32>(1.0);
  let h = abs(x) - vec3<f32>(0.5);
  let ox = floor(x + vec3<f32>(0.5));
  let a0 = x - ox;
  m = m * (vec3<f32>(1.79284291400159) - 0.85373472095314 * (a0 * a0 + h * h));
  let g = vec3<f32>(
    a0.x * x0.x + h.x * x0.y,
    a0.y * x12.x + h.y * x12.y,
    a0.z * x12.z + h.z * x12.w,
  );
  return 130.0 * dot(m, g);
}

// 2D curl-noise — orthogonal gradient of a scrolling simplex
// potential. Mirrors curl2() in the GLSL kernel. Time-shifted along
// (t, -t) so the field flows diagonally even when the particle field
// is static.
fn curl2(p: vec2<f32>, t: f32) -> vec2<f32> {
  let eps = 0.01;
  let n1 = snoise2(p + vec2<f32>(0.0, eps) + vec2<f32>(t, -t));
  let n2 = snoise2(p - vec2<f32>(0.0, eps) + vec2<f32>(t, -t));
  let n3 = snoise2(p + vec2<f32>(eps, 0.0) + vec2<f32>(t, -t));
  let n4 = snoise2(p - vec2<f32>(eps, 0.0) + vec2<f32>(t, -t));
  return vec2<f32>((n1 - n2) / (2.0 * eps), -(n3 - n4) / (2.0 * eps));
}

fn applyForce(
  kind: u32,
  a: vec4<f32>,
  b: vec4<f32>,
  pos: vec2<f32>,
  vel: vec2<f32>,
  dt: f32,
  time: f32,
) -> vec2<f32> {
  var v = vel;
  if (kind == ${FORCE_KIND_GRAVITY}u) {
    v = v + a.xy * dt;
  } else if (kind == ${FORCE_KIND_DRAG}u) {
    v = v * max(0.0, 1.0 - a.x * dt);
  } else if (kind == ${FORCE_KIND_POINT}u) {
    // point: a.xy=center, a.z=strength, a.w=falloff; b.x=sign(±1),
    // b.y=radius. Pulls in (sign=+1) or pushes out (sign=-1) with a
    // falloff curve that hits zero at r >= radius.
    let d = pos - a.xy;
    let r = length(d);
    if (r < b.y && r > 1e-5) {
      let t = clamp(1.0 - r / b.y, 0.0, 1.0);
      let f = a.z * pow(t, a.w);
      v = v + (d / r) * f * b.x * dt;
    }
  } else if (kind == ${FORCE_KIND_VORTEX}u) {
    // vortex: a.xy=center, a.z=strength, a.w=falloff; b.y=radius.
    // Tangential swirl with the same radial falloff as point.
    let d = pos - a.xy;
    let r = length(d);
    if (r < b.y && r > 1e-5) {
      let tang = vec2<f32>(-d.y, d.x) / r;
      let t = clamp(1.0 - r / b.y, 0.0, 1.0);
      let f = a.z * pow(t, a.w);
      v = v + tang * f * dt;
    }
  } else if (kind == ${FORCE_KIND_WIND}u) {
    // wind: a.xy=direction (raw, normalized inside the kernel),
    // a.z=strength. Constant push along the direction.
    let d = a.xy;
    let l = length(d);
    if (l > 1e-5) {
      v = v + (d / l) * a.z * dt;
    }
  } else if (kind == ${FORCE_KIND_TURBULENCE}u) {
    // turbulence: a.x=scale, a.y=strength, a.z=speed. Curl-noise
    // sample using time*speed for the scroll phase.
    let c = curl2(pos * a.x, time * a.z);
    v = v + c * a.y * dt;
  }
  return v;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }

  // Hard reset (first frame / time-wrap). Seed every slot with a
  // random position in [0,1]^2, zero velocity, and a sentinel
  // lifetime so reaping never fires. Phase 3 replaces this with
  // emitter-driven spawning.
  if (params.resetFlag == 1u) {
    let pid = f32(i);
    let r = hash22(vec2<f32>(pid * 1.337, params.seed * 7.0 + 0.5));
    posOut[i] = vec4<f32>(r.x, r.y, 0.5, 1.0e9);
    velOut[i] = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return;
  }

  let pIn = posIn[i];
  let vIn = velIn[i];
  var pos = pIn.xy;
  var vel = vIn.xy;
  var age = pIn.z;
  let lifetime = pIn.w;

  let alive = age > 0.0 && age < lifetime && lifetime > 0.0;
  if (!alive) {
    posOut[i] = vec4<f32>(0.0);
    velOut[i] = vec4<f32>(0.0);
    return;
  }

  // Forces (semi-implicit Euler — same order as the WebGL kernel).
  let dt = params.dt;
  let fc = params.forceCount;
  // Loop bound is the constant 8u; the early-out on j >= fc lets the
  // shader compiler unroll and the runtime cost matches the dynamic
  // count.
  for (var j: u32 = 0u; j < 8u; j = j + 1u) {
    if (j >= fc) { break; }
    vel = applyForce(
      params.forceKinds[j],
      params.forceA[j],
      params.forceB[j],
      pos,
      vel,
      dt,
      params.time,
    );
  }

  pos = pos + vel * dt;
  age = age + dt;

  // Screen bounds. Same semantics as WebGL: pos space is canvas UV
  // [0,1] Y-down.
  var stillAlive = true;
  let mode = params.boundsMode;
  let rest = params.boundsRest;
  if (mode == ${BOUNDS_BOUNCE}u) {
    if (pos.x < 0.0) { pos.x = 0.0; if (vel.x < 0.0) { vel.x = -vel.x * rest; } }
    else if (pos.x > 1.0) { pos.x = 1.0; if (vel.x > 0.0) { vel.x = -vel.x * rest; } }
    if (pos.y < 0.0) { pos.y = 0.0; if (vel.y < 0.0) { vel.y = -vel.y * rest; } }
    else if (pos.y > 1.0) { pos.y = 1.0; if (vel.y > 0.0) { vel.y = -vel.y * rest; } }
  } else if (mode == ${BOUNDS_WRAP}u) {
    pos = fract(pos);
  } else if (mode == ${BOUNDS_CLAMP}u) {
    pos = clamp(pos, vec2<f32>(0.0), vec2<f32>(1.0));
  } else if (mode == ${BOUNDS_KILL}u) {
    if (pos.x < 0.0 || pos.x > 1.0 || pos.y < 0.0 || pos.y > 1.0) {
      stillAlive = false;
    }
  }

  if (!stillAlive || age >= lifetime) {
    posOut[i] = vec4<f32>(0.0);
    velOut[i] = vec4<f32>(0.0);
  } else {
    posOut[i] = vec4<f32>(pos, age, lifetime);
    velOut[i] = vec4<f32>(vel, 0.0, 0.0);
  }
}
`;
