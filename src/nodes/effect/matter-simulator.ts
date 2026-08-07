import type {
  ColliderDescriptor,
  ForceDescriptor,
  ImageValue,
  NodeDefinition,
  InputSocketDef,
  ParticlesValue,
  PointsValue,
  RenderContext,
  SocketValue,
  SplineAnchor,
  SplineValue,
} from "@/engine/types";
import { ensureWebGPUDevice } from "@/engine/webgpu/device";
import { aspectCorrectY, aspectUncorrectY } from "@/engine/aspect";
import { ensurePointArray, makePoints } from "@/engine/points";
import { pushMediaSettle } from "@/engine/offline-settle";

// Matter Simulator — MLS-MPM deformable matter on WebGPU (spec
// 072626_matter-simulator.md, M3 of the fluid arc). Liquid, jelly, and
// snow are ONE solver with different numbers (Hu et al. 2018 MLS-MPM;
// material models per the classic taichi mpm99): every particle carries
// a deformation gradient F and affine velocity C; each substep scatters
// mass/momentum + stress to a background grid (P2G), integrates grid
// momentum (gravity, force descriptors, walls, colliders), and gathers
// back (G2P, APIC transfer). MPM needs NO neighbor search — that's why
// it's the browser-proven hybrid method (~100k particles on integrated
// GPUs) where SPH tops out at ~30k.
//
// WebGPU-only (backend "webgpu", the Particle Simulator's Phase-1
// bridge pattern): compute is synchronous but WebGPU readback is not,
// so the node runs ONE FRAME BEHIND — submit this frame's substeps,
// kick mapAsync on a render-layout copy, drain last frame's readback
// into a WebGL texture (ParticlesValue for Particles to Image) + a CPU
// PointsValue aux (the whole points ecosystem: Copy to Points on goo,
// Points to Spline metaball surfaces...). Offline export pushes the
// readback as a media settle so the two-pass export render captures the
// exact frame (the re-render doesn't re-step: time hasn't advanced, so
// the active gate is false).
//
// The WGSL P2G scatter uses the standard fixed-point trick: atomicAdd
// exists only for 32-bit integers, so momentum/mass accumulate as
// i32(round(v * 2^16)) and the grid pass divides them back out (the
// scale cancels in momentum/mass).
//
// Internal frame: GRID INDEX space, Y-DOWN (row 0 = top — no GL
// involved, storage buffers only), dx = 1, cells pixel-square
// (ny = nx/aspect). Descriptor seams (forces, analytic colliders,
// gravity) and GEOMETRY seams (the `seed` points input, the `points`
// aux, the obstacle spline) both convert index ↔ AUTHORED
// (engine/aspect.ts) — see SEAM_WGSL for why that, and not canvas UV,
// is the space they belong in. The `particles` primary is the one thing
// that stays canvas UV, because Particles to Image draws it directly.
// Colliders here are
// analytic circle/line only, resolved as free-slip on grid nodes;
// image-mask colliders are IGNORED (WebGPU can't sample WebGL textures
// without a cached CPU hop — deferred).

const MAX_FORCES = 6;
const MAX_COLLIDERS = 4;
const FIXED_SCALE = 65536; // 2^16 fixed-point for atomic accumulation

const MATERIALS = ["liquid", "jelly", "snow"] as const;

const FORCE_KIND: Record<ForceDescriptor["kind"], number> = {
  gravity: 0,
  drag: 1,
  point: 2,
  vortex: 3,
  wind: 4,
  turbulence: 5,
};

// Only analytic colliders participate. kind ints local to this node.
const COLLIDER_KIND: Record<string, number> = { circle: 0, line: 1 };

// ---- params buffer layout (explicit struct, offsets mirrored below) ----
//
//   offset  field
//        0  dt, time, gravity, stiffness        (4 × f32)
//       16  count, material, forceCount, colliderCount  (4 × u32)
//       32  nx, ny, hardening, damping          (4 × f32)
//       48  pMass, pVol, colliderPad, viscosity (4 × f32)
//       64  yieldLo, yieldHi, hasObstacle, pad  (4 × f32)
//       80  forceKinds: array<vec4<u32>, 2>     (32 B — 6 used)
//      112  forceA: array<vec4<f32>, 6>         (96 B)
//      208  forceB: array<vec4<f32>, 6>         (96 B)
//      304  colliderKinds: vec4<u32>            (16 B)
//      320  colliderA: array<vec4<f32>, 4>      (64 B)
//      384  colliderB: array<vec4<f32>, 4>      (64 B)
//      448  END
const PARAMS_BYTES = 448;

const PARAMS_STRUCT = /* wgsl */ `
struct Params {
  dt: f32,
  time: f32,
  gravity: f32,
  stiffness: f32,
  count: u32,
  material: u32,
  forceCount: u32,
  colliderCount: u32,
  nx: f32,
  ny: f32,
  hardening: f32,
  damping: f32,
  pMass: f32,
  pVol: f32,
  colliderPad: f32,
  viscosity: f32,
  yieldLo: f32,
  yieldHi: f32,
  hasObstacle: f32,
  pad1: f32,
  forceKinds: array<vec4<u32>, 2>,
  forceA: array<vec4<f32>, 6>,
  forceB: array<vec4<f32>, 6>,
  colliderKinds: vec4<u32>,
  colliderA: array<vec4<f32>, 4>,
  colliderB: array<vec4<f32>, 4>,
};
`;

// Particle storage: 16 floats. pos(2) vel(2) C(2×2) F(2×2) misc(Jp,-,-,-)
// Descriptor space seam. The solver's frame is GRID INDEX space, which
// is ISOTROPIC (cells are pixel-square, ny = nx/aspect); force,
// analytic-collider and gravity descriptors are AUTHORED coordinates
// (engine/aspect.ts — x spans the width, y width-isotropic and
// vertically centered). Index and authored differ by a single uniform
// scale (nx) plus a vertical offset, so lengths stay lengths and
// directions stay directions across the seam.
//
// This used to convert to CANVAS UV instead, which is anisotropic: it
// displaced every radial force vertically, squashed its falloff into an
// ellipse, and tilted analytic-collider normals (the old comment's
// claim that "y-down uv and index axes are parallel" only holds on a
// square canvas). Authored is also what the CPU sims use for the very
// same descriptors (engine/sim-kernel.ts), so one Point Force now feels
// identical wired into any simulator.
const SEAM_WGSL = /* wgsl */ `
fn idxToAuthored(p: vec2<f32>, nx: f32, ny: f32) -> vec2<f32> {
  return vec2<f32>(p.x / nx, (p.y - 0.5 * ny) / nx + 0.5);
}
fn authoredToIdx(a: vec2<f32>, nx: f32, ny: f32) -> vec2<f32> {
  return vec2<f32>(a.x * nx, (a.y - 0.5) * nx + 0.5 * ny);
}
`;

const PARTICLE_STRUCT = /* wgsl */ `
struct Particle {
  pos: vec2<f32>,
  vel: vec2<f32>,
  C: mat2x2<f32>,
  F: mat2x2<f32>,
  misc: vec4<f32>,
};
`;

const FLOATS_PER_PARTICLE = 16;

// Elastic moduli from the 0..1 stiffness dial (log-mapped) — computed
// CPU-side each frame and folded into `stiffness` (E). nu fixed at 0.2.
const POISSON = 0.2;

// ---- WGSL kernels -------------------------------------------------------

const CLEAR_WGSL = /* wgsl */ `
${PARAMS_STRUCT}
@group(0) @binding(0) var<storage, read_write> grid: array<atomic<i32>>;
@group(0) @binding(1) var<storage, read> params: Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let cells = u32(params.nx) * u32(params.ny);
  if (gid.x >= cells * 3u) { return; }
  atomicStore(&grid[gid.x], 0);
}
`;

const P2G_WGSL = /* wgsl */ `
${PARAMS_STRUCT}
${PARTICLE_STRUCT}
@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> grid: array<atomic<i32>>;
@group(0) @binding(2) var<storage, read> params: Params;

fn det2(m: mat2x2<f32>) -> f32 {
  return m[0][0] * m[1][1] - m[1][0] * m[0][1];
}

// Closed-form 2×2 polar rotation of F (no SVD needed for corotated).
fn rotationOf(m: mat2x2<f32>) -> mat2x2<f32> {
  let c = m[0][0] + m[1][1];
  let s = m[0][1] - m[1][0];
  let l = max(sqrt(c * c + s * s), 1e-8);
  let co = c / l;
  let si = s / l;
  return mat2x2<f32>(vec2<f32>(co, si), vec2<f32>(-si, co));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let p = particles[i];

  let E = params.stiffness;
  let mu0 = E / (2.0 * (1.0 + ${POISSON}));
  let la0 = E * ${POISSON} / ((1.0 + ${POISSON}) * (1.0 - 2.0 * ${POISSON}));

  // Material response (mpm99): liquid μ=0; jelly h=0.3; snow hardens
  // exponentially with compaction (Jp < 1).
  var h = 1.0;
  if (params.material == 2u) {
    h = clamp(exp(params.hardening * (1.0 - p.misc.x)), 0.1, 10.0);
  } else if (params.material == 1u) {
    h = 0.3;
  }
  var mu = mu0 * h;
  if (params.material == 0u) { mu = 0.0; }
  let la = la0 * h;

  let J = det2(p.F);
  var stress = mat2x2<f32>(vec2<f32>(0.0), vec2<f32>(0.0));
  if (mu > 0.0) {
    let R = rotationOf(p.F);
    stress = (2.0 * mu) * ((p.F - R) * transpose(p.F));
  }
  let pr = la * J * (J - 1.0);
  stress[0][0] = stress[0][0] + pr;
  stress[1][1] = stress[1][1] + pr;

  // Viscous stress (liquid dial): σ += μv·(∇v + ∇vᵀ), with C as the
  // velocity-gradient estimate. Honey/goo without touching pressure.
  if (params.viscosity > 0.0) {
    stress = stress + params.viscosity * (p.C + transpose(p.C));
  }

  // MLS-MPM fused momentum: Q = −dt·vol·4·σ + mass·C  (dx = 1).
  // pMass/pVol are density-normalized at seed time so the grid sees
  // ρ ≈ 1 regardless of particles-per-cell — without this, dense
  // seeding makes the material effectively N× heavier than the
  // stress model and pressure can never balance gravity (particles
  // squash straight through each other).
  let Q = (-params.dt * params.pVol * 4.0) * stress + params.pMass * p.C;

  let base = floor(p.pos - vec2<f32>(0.5));
  let fx = p.pos - base;
  // Quadratic B-spline weights per axis.
  let w0 = 0.5 * (vec2<f32>(1.5) - fx) * (vec2<f32>(1.5) - fx);
  let w1 = vec2<f32>(0.75) - (fx - vec2<f32>(1.0)) * (fx - vec2<f32>(1.0));
  let w2 = 0.5 * (fx - vec2<f32>(0.5)) * (fx - vec2<f32>(0.5));
  var wx: array<vec2<f32>, 3>;
  wx[0] = w0; wx[1] = w1; wx[2] = w2;

  let nx = i32(params.nx);
  let ny = i32(params.ny);
  for (var gy: i32 = 0; gy < 3; gy = gy + 1) {
    for (var gx: i32 = 0; gx < 3; gx = gx + 1) {
      let cx = i32(base.x) + gx;
      let cy = i32(base.y) + gy;
      if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) { continue; }
      let dpos = (vec2<f32>(f32(gx), f32(gy)) - fx);
      let wt = wx[gx].x * wx[gy].y;
      let mom = wt * (params.pMass * p.vel + Q * dpos);
      let cell = (cy * nx + cx) * 3;
      atomicAdd(&grid[cell + 0], i32(round(mom.x * ${FIXED_SCALE}.0)));
      atomicAdd(&grid[cell + 1], i32(round(mom.y * ${FIXED_SCALE}.0)));
      atomicAdd(&grid[cell + 2], i32(round(wt * params.pMass * ${FIXED_SCALE}.0)));
    }
  }
}
`;

// Grid momentum → velocity, gravity + force descriptors + damping,
// walls (closed box, free-slip), analytic colliders (free-slip), CFL
// safety clamp. Descriptor seam: forces run in Y-DOWN AUTHORED space
// (SEAM_WGSL), the convention every simulator shares, so the same force
// nodes feel identical wherever they are wired.
const GRID_WGSL = /* wgsl */ `
${PARAMS_STRUCT}
${SEAM_WGSL}
@group(0) @binding(0) var<storage, read_write> grid: array<atomic<i32>>;
@group(0) @binding(1) var<storage, read_write> gridVel: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> params: Params;
// Signed distance field (index units, negative inside) baked CPU-side
// from the obstacle spline + image-mask colliders. Row 0 = top (y-down),
// matching index space — no flips anywhere.
@group(0) @binding(3) var<storage, read> obstacle: array<f32>;

fn mod289_3(x: vec3<f32>) -> vec3<f32> { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289_2(x: vec2<f32>) -> vec2<f32> { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute3(x: vec3<f32>) -> vec3<f32> { return mod289_3(((x * 34.0) + vec3<f32>(1.0)) * x); }
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
fn curl2(p: vec2<f32>, t: f32) -> vec2<f32> {
  let eps = 0.01;
  let n1 = snoise2(p + vec2<f32>(0.0, eps) + vec2<f32>(t, -t));
  let n2 = snoise2(p - vec2<f32>(0.0, eps) + vec2<f32>(t, -t));
  let n3 = snoise2(p + vec2<f32>(eps, 0.0) + vec2<f32>(t, -t));
  let n4 = snoise2(p - vec2<f32>(eps, 0.0) + vec2<f32>(t, -t));
  return vec2<f32>((n1 - n2) / (2.0 * eps), -(n3 - n4) / (2.0 * eps));
}

// Mirror of the particle-simulator force contract (AUTHORED space,
// y-down — see SEAM_WGSL).
fn applyForce(kind: u32, a: vec4<f32>, b: vec4<f32>, pos: vec2<f32>,
              vel: vec2<f32>, dt: f32, time: f32) -> vec2<f32> {
  var v = vel;
  if (kind == 0u) {
    v = v + a.xy * dt;
  } else if (kind == 1u) {
    v = v * max(0.0, 1.0 - a.x * dt);
  } else if (kind == 2u) {
    let d = pos - a.xy;
    let r = length(d);
    if (r < b.y && r > 1e-5) {
      let t = clamp(1.0 - r / b.y, 0.0, 1.0);
      v = v + (d / r) * a.z * pow(t, a.w) * b.x * dt;
    }
  } else if (kind == 3u) {
    let d = pos - a.xy;
    let r = length(d);
    if (r < b.y && r > 1e-5) {
      let tang = vec2<f32>(-d.y, d.x) / r;
      let t = clamp(1.0 - r / b.y, 0.0, 1.0);
      v = v + tang * a.z * pow(t, a.w) * dt;
    }
  } else if (kind == 4u) {
    let d = a.xy;
    let l = length(d);
    if (l > 1e-5) { v = v + (d / l) * a.z * dt; }
  } else if (kind == 5u) {
    v = v + curl2(pos * a.x, time * a.z) * a.y * dt;
  }
  return v;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let nx = u32(params.nx);
  let ny = u32(params.ny);
  if (gid.x >= nx * ny) { return; }
  let cell = gid.x * 3u;
  let m = f32(atomicLoad(&grid[cell + 2u]));
  if (m <= 0.0) {
    gridVel[gid.x] = vec4<f32>(0.0);
    return;
  }
  // Fixed-point scale cancels in momentum / mass.
  var v = vec2<f32>(f32(atomicLoad(&grid[cell + 0u])),
                    f32(atomicLoad(&grid[cell + 1u]))) / m;

  let cx = gid.x % nx;
  let cy = gid.x / nx;
  let dt = params.dt;

  // Gravity (AUTHORED units/s² → index/s² via nx — the uniform scale
  // BOTH axes use; y-down so +gravity falls). Scaling by ny instead is
  // what made the node's own gravity disagree with a wired Gravity
  // force node on non-square canvases.
  v.y = v.y + params.gravity * params.nx * dt;

  // Force descriptors in the AUTHORED seam.
  let posA = idxToAuthored(vec2<f32>(f32(cx) + 0.5, f32(cy) + 0.5),
                           params.nx, params.ny);
  if (params.forceCount > 0u) {
    var vA = v / params.nx;
    for (var j: u32 = 0u; j < 6u; j = j + 1u) {
      if (j >= params.forceCount) { break; }
      let kind = params.forceKinds[j >> 2u][j & 3u];
      vA = applyForce(kind, params.forceA[j], params.forceB[j],
                      posA, vA, dt, params.time);
    }
    v = vA * params.nx;
  }

  v = v * max(0.0, 1.0 - params.damping * dt);

  // Analytic colliders — free-slip: remove the velocity component
  // pointing into the solid.
  for (var j: u32 = 0u; j < 4u; j = j + 1u) {
    if (j >= params.colliderCount) { break; }
    let kind = params.colliderKinds[j];
    let ca = params.colliderA[j];
    var n = vec2<f32>(0.0);
    var inside = false;
    let pad = params.colliderPad;
    if (kind == 0u) {
      // circle: ca.xy=center ca.z=radius ca.w=inside(0/1) — AUTHORED
      // space (a radius only bounds a circle there), surface inflated
      // by colliderPad, which is authored too (the obstacle SDF already
      // scales it by nx).
      let d = posA - ca.xy;
      let r = length(d);
      if (ca.w > 0.5) {
        if (r > ca.z - pad) { inside = true; n = -d / max(r, 1e-5); }
      } else if (r < ca.z + pad) {
        inside = true;
        n = d / max(r, 1e-5);
      }
    } else if (kind == 1u) {
      // line: ca.xy=unit normal ca.z=d — solid where n·p < d (+pad).
      if (dot(ca.xy, posA) < ca.z + pad) { inside = true; n = normalize(ca.xy); }
    }
    if (inside) {
      // n points OUT of the solid (authored). Authored and index axes
      // differ by a UNIFORM scale, so the same normal applies to v in
      // index units — the property canvas UV does not have.
      let into = dot(v, n);
      if (into < 0.0) { v = v - n * into; }
    }
  }

  // Baked obstacle SDF (spline obstacle + image-mask colliders):
  // free-slip against the padded surface, full stop deep inside.
  if (params.hasObstacle > 0.5) {
    let sd = obstacle[gid.x];
    let padIdx = params.colliderPad * params.nx;
    if (sd < padIdx) {
      let xi = i32(cx);
      let yi = i32(cy);
      let nxi = i32(nx);
      let nyi = i32(ny);
      let sR = obstacle[u32(yi * nxi + min(xi + 1, nxi - 1))];
      let sL = obstacle[u32(yi * nxi + max(xi - 1, 0))];
      let sD2 = obstacle[u32(min(yi + 1, nyi - 1) * nxi + xi)];
      let sU2 = obstacle[u32(max(yi - 1, 0) * nxi + xi)];
      let g = vec2<f32>(sR - sL, sD2 - sU2);
      let gl = length(g);
      if (gl > 1e-4) {
        let n = g / gl;   // +∇sdf = outward
        let into = dot(v, n);
        if (into < 0.0) { v = v - n * into; }
      }
      if (sd < padIdx - 2.0) { v = vec2<f32>(0.0); }
    }
  }

  // Closed-box walls, free-slip.
  if (cx < 2u && v.x < 0.0) { v.x = 0.0; }
  if (cx > nx - 3u && v.x > 0.0) { v.x = 0.0; }
  if (cy < 2u && v.y < 0.0) { v.y = 0.0; }
  if (cy > ny - 3u && v.y > 0.0) { v.y = 0.0; }

  // CFL safety clamp — a grid node may not cross ~half a cell per
  // step. Prevents stiff-material explosions at art-tool settings.
  let vmax = 0.45 / dt;
  v = clamp(v, vec2<f32>(-vmax), vec2<f32>(vmax));

  gridVel[gid.x] = vec4<f32>(v, m, 0.0);
}
`;

const G2P_WGSL = /* wgsl */ `
${PARAMS_STRUCT}
${SEAM_WGSL}
${PARTICLE_STRUCT}
@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<storage, read> gridVel: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> params: Params;
@group(0) @binding(3) var<storage, read_write> renderOut: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> obstacle: array<f32>;

fn det2(m: mat2x2<f32>) -> f32 {
  return m[0][0] * m[1][1] - m[1][0] * m[0][1];
}
fn rotationOf(m: mat2x2<f32>) -> mat2x2<f32> {
  let c = m[0][0] + m[1][1];
  let s = m[0][1] - m[1][0];
  let l = max(sqrt(c * c + s * s), 1e-8);
  return mat2x2<f32>(vec2<f32>(c / l, s / l), vec2<f32>(-s / l, c / l));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }
  var p = particles[i];

  let base = floor(p.pos - vec2<f32>(0.5));
  let fx = p.pos - base;
  let w0 = 0.5 * (vec2<f32>(1.5) - fx) * (vec2<f32>(1.5) - fx);
  let w1 = vec2<f32>(0.75) - (fx - vec2<f32>(1.0)) * (fx - vec2<f32>(1.0));
  let w2 = 0.5 * (fx - vec2<f32>(0.5)) * (fx - vec2<f32>(0.5));
  var wx: array<vec2<f32>, 3>;
  wx[0] = w0; wx[1] = w1; wx[2] = w2;

  let nx = i32(params.nx);
  let ny = i32(params.ny);
  var newV = vec2<f32>(0.0);
  var B = mat2x2<f32>(vec2<f32>(0.0), vec2<f32>(0.0));
  for (var gy: i32 = 0; gy < 3; gy = gy + 1) {
    for (var gx: i32 = 0; gx < 3; gx = gx + 1) {
      let cx = i32(base.x) + gx;
      let cy = i32(base.y) + gy;
      if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) { continue; }
      let dpos = vec2<f32>(f32(gx), f32(gy)) - fx;
      let wt = wx[gx].x * wx[gy].y;
      let gv = gridVel[cy * nx + cx].xy;
      newV = newV + wt * gv;
      // outer(gv, dpos): columns scaled by dpos components.
      B = B + mat2x2<f32>(gv * (wt * dpos.x), gv * (wt * dpos.y));
    }
  }

  let dt = params.dt;
  p.vel = newV;
  p.C = 4.0 * B;   // APIC, quadratic kernel, dx = 1
  p.pos = p.pos + newV * dt;

  // Particle-level collider projection, in the AUTHORED seam (matching
  // the grid pass — see SEAM_WGSL). Grid BCs alone let fast particles
  // tunnel between nodes and sprites visually sink into surfaces;
  // projecting positions out of the padded surface keeps boundaries
  // crisp. colliderPad inflates every surface so rendered particle
  // sprites rest ON the collider instead of inside it.
  if (params.colliderCount > 0u) {
    var pa = idxToAuthored(p.pos, params.nx, params.ny);
    var va = p.vel / params.nx;
    let pad = params.colliderPad;
    for (var j: u32 = 0u; j < 4u; j = j + 1u) {
      if (j >= params.colliderCount) { break; }
      let kind = params.colliderKinds[j];
      let ca = params.colliderA[j];
      if (kind == 0u) {
        let dvec = pa - ca.xy;
        let r = length(dvec);
        if (ca.w > 0.5) {
          // container: keep particles INSIDE radius − pad
          let lim = max(ca.z - pad, 1e-4);
          if (r > lim) {
            let nrm = dvec / max(r, 1e-5);
            pa = ca.xy + nrm * lim;
            let outw = dot(va, nrm);
            if (outw > 0.0) { va = va - nrm * outw; }
          }
        } else {
          let lim = ca.z + pad;
          if (r < lim) {
            let nrm = dvec / max(r, 1e-5);
            pa = ca.xy + nrm * lim;
            let inw = dot(va, nrm);
            if (inw < 0.0) { va = va - nrm * inw; }
          }
        }
      } else if (kind == 1u) {
        let nrm = normalize(ca.xy);
        let s = dot(nrm, pa) - (ca.z + pad);
        if (s < 0.0) {
          pa = pa - nrm * s;
          let inw = dot(va, nrm);
          if (inw < 0.0) { va = va - nrm * inw; }
        }
      }
    }
    p.pos = authoredToIdx(pa, params.nx, params.ny);
    p.vel = va * params.nx;
  }

  // Baked obstacle SDF projection (bilinear sample, index units).
  if (params.hasObstacle > 0.5) {
    let padIdx = params.colliderPad * params.nx;
    let q = clamp(p.pos, vec2<f32>(0.5), vec2<f32>(params.nx - 1.5, params.ny - 1.5))
      - vec2<f32>(0.5);
    let q0 = floor(q);
    let qf = q - q0;
    let xi = i32(q0.x);
    let yi = i32(q0.y);
    let nxi = i32(params.nx);
    let s00 = obstacle[u32(yi * nxi + xi)];
    let s10 = obstacle[u32(yi * nxi + xi + 1)];
    let s01 = obstacle[u32((yi + 1) * nxi + xi)];
    let s11 = obstacle[u32((yi + 1) * nxi + xi + 1)];
    let sd = mix(mix(s00, s10, qf.x), mix(s01, s11, qf.x), qf.y);
    if (sd < padIdx) {
      let gx2 = mix(s10 - s00, s11 - s01, qf.y);
      let gy2 = mix(s01 - s00, s11 - s10, qf.x);
      let gl = length(vec2<f32>(gx2, gy2));
      if (gl > 1e-4) {
        let n = vec2<f32>(gx2, gy2) / gl;
        p.pos = p.pos + n * (padIdx - sd);
        let into = dot(p.vel, n);
        if (into < 0.0) { p.vel = p.vel - n * into; }
      }
    }
  }

  p.pos = clamp(p.pos,
    vec2<f32>(1.0),
    vec2<f32>(params.nx - 2.0, params.ny - 2.0));

  // Deformation update.
  let I = mat2x2<f32>(vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0));
  var F = (I + dt * p.C) * p.F;

  if (params.material == 0u) {
    // Liquid: keep only volume — deviatoric part dies each step.
    let J = clamp(det2(F), 0.06, 20.0);
    let s = sqrt(J);
    F = mat2x2<f32>(vec2<f32>(s, 0.0), vec2<f32>(0.0, s));
  } else if (params.material == 2u) {
    // Snow plasticity: clamp singular values (via R,S symmetric
    // eigendecomposition: F = R·S = (R·V)·Σ·Vᵀ), track Jp hardening.
    let R = rotationOf(F);
    let S = transpose(R) * F;   // symmetric
    let mid = (S[0][0] + S[1][1]) * 0.5;
    let rad = sqrt(max((S[0][0] - S[1][1]) * (S[0][0] - S[1][1]) * 0.25
                       + S[1][0] * S[0][1], 0.0));
    var s0 = mid + rad;
    var s1 = mid - rad;
    // Eigenvector angle of S.
    let phi = 0.5 * atan2(S[1][0] + S[0][1], S[0][0] - S[1][1]);
    let cp = cos(phi);
    let sp = sin(phi);
    let V = mat2x2<f32>(vec2<f32>(cp, sp), vec2<f32>(-sp, cp));
    // Yield range from the Crumble dial — wider = more plastic.
    let c0 = clamp(s0, 1.0 - params.yieldLo, 1.0 + params.yieldHi);
    let c1 = clamp(s1, 1.0 - params.yieldLo, 1.0 + params.yieldHi);
    var Jp = p.misc.x * (s0 * s1) / max(c0 * c1, 1e-6);
    Jp = clamp(Jp, 0.6, 20.0);
    let Sig = mat2x2<f32>(vec2<f32>(c0, 0.0), vec2<f32>(0.0, c1));
    F = R * V * Sig * transpose(V);
    p.misc.x = Jp;
  }
  p.F = F;

  particles[i] = p;
  renderOut[i] = vec4<f32>(p.pos.x / params.nx, p.pos.y / params.ny, 1.0, 1.0e9);
}
`;

// ---- state --------------------------------------------------------------

interface MatterState {
  device: GPUDevice;
  particleBuf: GPUBuffer;
  gridAtomic: GPUBuffer;
  gridVel: GPUBuffer;
  renderOut: GPUBuffer;
  staging: GPUBuffer;
  paramsBuf: GPUBuffer;
  // Baked obstacle SDF (nx·ny f32, index units, negative inside) from
  // the obstacle spline input + image-mask collider masks. Rebaked when
  // any source's value identity changes (devguide-blessed signal).
  obstacleBuf: GPUBuffer;
  obstacleSplineRef: unknown;
  obstacleMaskRefs: unknown[];
  hasObstacle: boolean;
  clearPipe: GPUComputePipeline;
  p2gPipe: GPUComputePipeline;
  gridPipe: GPUComputePipeline;
  g2pPipe: GPUComputePipeline;
  // Bind groups are stable per state (they reference the state's own
  // buffers), so they're built once here instead of per substep.
  clearBind: GPUBindGroup;
  p2gBind: GPUBindGroup;
  gridBind: GPUBindGroup;
  g2pBind: GPUBindGroup;
  count: number;
  // Actually-seeded particles this run (≤ count when particle_radius
  // spacing fills the region before the budget runs out). Kernels and
  // the points aux iterate this; padded/dead slots stay age 0.
  liveCount: number;
  texW: number;
  texH: number;
  nx: number;
  ny: number;
  seedSig: string;
  // Density-normalized particle mass (= volume, ρ0 = 1), measured from
  // the actual seed packing so the grid density is ~1 mass/cell².
  pMass: number;
  lastTime: number;
  lastDriver: number;
  needsSeed: boolean;
  outputImage: ImageValue | null;
  zeroVelocityImage: ImageValue;
  pendingUpload: Float32Array | null;
  // Last drained readback, kept for the points aux — paused evals must
  // keep emitting the same points, not go empty once pendingUpload is
  // consumed (stable:false ⇒ compute runs every eval).
  lastPositions: Float32Array | null;
  readbackBusy: boolean;
}

function stateKey(nodeId: string): string {
  // First `:` segment must be the registered type or the evaluator's
  // dispose sweep skips this state (072226 audit #6).
  return `matter-simulator:${nodeId}`;
}

function pickSquare(count: number): { w: number; h: number } {
  const side = Math.max(1, Math.ceil(Math.sqrt(count)));
  return { w: side, h: side };
}

function makePipeline(
  device: GPUDevice,
  code: string,
  label: string
): GPUComputePipeline {
  const shaderModule = device.createShaderModule({
    label: `${label}:module`,
    code,
  });
  return device.createComputePipeline({
    label: `${label}:pipeline`,
    layout: "auto",
    compute: { module: shaderModule, entryPoint: "main" },
  });
}

function disposeState(ctx: RenderContext, st: MatterState): void {
  st.particleBuf.destroy();
  st.gridAtomic.destroy();
  st.gridVel.destroy();
  st.renderOut.destroy();
  st.staging.destroy();
  st.paramsBuf.destroy();
  st.obstacleBuf.destroy();
  if (st.outputImage) ctx.releaseTexture(st.outputImage.texture);
  ctx.releaseTexture(st.zeroVelocityImage.texture);
}

function ensureState(
  ctx: RenderContext,
  device: GPUDevice,
  nodeId: string,
  count: number,
  nx: number,
  ny: number
): MatterState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as MatterState | undefined;
  const { w, h } = pickSquare(count);
  if (
    existing &&
    existing.texW === w &&
    existing.texH === h &&
    existing.nx === nx &&
    existing.ny === ny &&
    existing.device === device
  ) {
    return existing;
  }
  if (existing) disposeState(ctx, existing);

  const capacity = w * h;
  const cells = nx * ny;
  const mk = (label: string, size: number, extraUsage = 0) =>
    device.createBuffer({
      label: `matter-sim:${label}`,
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extraUsage,
    });

  const particleBuf = mk("particles", capacity * FLOATS_PER_PARTICLE * 4);
  const gridAtomic = mk("grid-atomic", cells * 3 * 4);
  const gridVel = mk("grid-vel", cells * 16);
  const obstacleBuf = mk("obstacle-sdf", cells * 4);
  const renderOut = mk("render-out", capacity * 16, GPUBufferUsage.COPY_SRC);
  const staging = device.createBuffer({
    label: "matter-sim:staging",
    size: capacity * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const paramsBuf = mk("params", PARAMS_BYTES);

  // Dead-slot init for the padded tail of renderOut (age 0 = dead).
  device.queue.writeBuffer(renderOut, 0, new Float32Array(capacity * 4));

  const zeroVelocityImage = ctx.allocImage({ width: w, height: h });
  ctx.clearTarget(zeroVelocityImage, [0, 0, 0, 0]);

  const clearPipe = makePipeline(device, CLEAR_WGSL, "matter-sim:clear");
  const p2gPipe = makePipeline(device, P2G_WGSL, "matter-sim:p2g");
  const gridPipe = makePipeline(device, GRID_WGSL, "matter-sim:grid");
  const g2pPipe = makePipeline(device, G2P_WGSL, "matter-sim:g2p");
  const bind = (pipe: GPUComputePipeline, buffers: GPUBuffer[]) =>
    device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: buffers.map((buffer, i) => ({ binding: i, resource: { buffer } })),
    });

  const st: MatterState = {
    device,
    particleBuf,
    gridAtomic,
    gridVel,
    renderOut,
    staging,
    paramsBuf,
    obstacleBuf,
    obstacleSplineRef: null,
    obstacleMaskRefs: [],
    hasObstacle: false,
    clearPipe,
    p2gPipe,
    gridPipe,
    g2pPipe,
    clearBind: bind(clearPipe, [gridAtomic, paramsBuf]),
    p2gBind: bind(p2gPipe, [particleBuf, gridAtomic, paramsBuf]),
    gridBind: bind(gridPipe, [gridAtomic, gridVel, paramsBuf, obstacleBuf]),
    g2pBind: bind(g2pPipe, [particleBuf, gridVel, paramsBuf, renderOut, obstacleBuf]),
    count,
    liveCount: count,
    texW: w,
    texH: h,
    nx,
    ny,
    seedSig: "",
    pMass: 0.1,
    lastTime: ctx.time,
    lastDriver: 0,
    needsSeed: true,
    outputImage: null,
    zeroVelocityImage,
    pendingUpload: null,
    lastPositions: null,
    readbackBusy: false,
  };
  ctx.state[key] = st;
  return st;
}

// ---- seeding ------------------------------------------------------------

// Build the initial particle state CPU-side (reset only, never per
// frame): positions from the seed points input, from rejection-sampling
// the region mask, or a default centered block. Uploaded with F = I,
// Jp = 1, everything else zero.
function seedParticles(
  ctx: RenderContext,
  st: MatterState,
  seedPts: PointsValue | null,
  region: { texture: WebGLTexture; width: number; height: number } | null,
  jitterSeed: number,
  particleRadius: number
): void {
  const n = st.count;
  const data = new Float32Array(st.texW * st.texH * FLOATS_PER_PARTICLE);
  let rng = (jitterSeed * 9301 + 49297) % 233280;
  const rand = () => {
    rng = (rng * 9301 + 49297) % 233280;
    return rng / 233280;
  };

  // Candidate positions in y-down uv.
  const positions: [number, number][] = [];
  if (seedPts && seedPts.count > 0) {
    // Explicit seed points: honor them as given (cycled to the budget);
    // particle_radius doesn't apply — spacing came from the producer.
    // The socket carries AUTHORED coordinates, so y converts INTO canvas
    // UV here — the mirror of the points-aux conversion on the way out.
    // Skipping it squashed a seed shape vertically on non-square
    // canvases (and made a sim→seed round trip lossy).
    const pts = ensurePointArray(seedPts);
    const aspect = ctx.width / ctx.height;
    for (let i = 0; i < n; i++) {
      const p = pts[i % pts.length];
      positions.push([
        p.pos[0] + (rand() - 0.5) * 0.01,
        aspectCorrectY(p.pos[1], aspect) + (rand() - 0.5) * 0.01,
      ]);
    }
  } else {
    // Region-mask or default-block coverage test in y-down uv.
    let maskBuf: Uint8ClampedArray | null = null;
    let rw = 0;
    let rh = 0;
    if (region) {
      rw = Math.min(128, region.width);
      rh = Math.min(128, region.height);
      maskBuf = ctx.readImagePixels(
        {
          kind: "image",
          texture: region.texture,
          width: region.width,
          height: region.height,
        },
        rw,
        rh
      );
    }
    const inRegion = (x: number, y: number): boolean => {
      if (maskBuf) {
        const px = Math.max(0, Math.min(rw - 1, Math.floor(x * rw)));
        const py = Math.max(0, Math.min(rh - 1, Math.floor(y * rh)));
        return maskBuf[(py * rw + px) * 4] > 96;
      }
      // Default: a centered block that falls and splashes.
      return x >= 0.35 && x <= 0.65 && y >= 0.2 && y <= 0.5;
    };

    // particle_radius > 0 ⇒ jittered-grid packing at 2r spacing. That
    // spacing IS the rest separation: density normalization makes the
    // pressure model preserve seed density, so the material relaxes
    // back to ~2r apart instead of crowding. May seed fewer than the
    // budget (liveCount) — the region filled up.
    const spacingIdx =
      particleRadius > 0 ? Math.max(0.75, particleRadius * 2 * st.nx) : 0;
    if (spacingIdx > 0) {
      outer: for (let gy = 1.5; gy < st.ny - 1.5; gy += spacingIdx) {
        for (let gx = 1.5; gx < st.nx - 1.5; gx += spacingIdx) {
          const jx = gx + (rand() - 0.5) * 0.7 * spacingIdx;
          const jy = gy + (rand() - 0.5) * 0.7 * spacingIdx;
          const x = jx / st.nx;
          const y = jy / st.ny;
          if (!inRegion(x, y)) continue;
          positions.push([x, y]);
          if (positions.length >= n) break outer;
        }
      }
    } else {
      let attempts = 0;
      while (positions.length < n && attempts < n * 40) {
        attempts++;
        const x = rand();
        const y = rand();
        if (inRegion(x, y)) positions.push([x, y]);
      }
    }
  }
  if (positions.length === 0) positions.push([0.5, 0.35]);

  const live = Math.min(n, positions.length);
  const cellsTouched = new Set<number>();
  for (let i = 0; i < live; i++) {
    const [ux, uy] = positions[i];
    const o = i * FLOATS_PER_PARTICLE;
    // uv → grid index space, clamped inside the walls.
    const gx = Math.max(1, Math.min(st.nx - 2, ux * st.nx));
    const gy = Math.max(1, Math.min(st.ny - 2, uy * st.ny));
    data[o] = gx;
    data[o + 1] = gy;
    cellsTouched.add(Math.floor(gy) * st.nx + Math.floor(gx));
    // vel (2,3) and C (4..7) stay 0; F = identity.
    data[o + 8] = 1;
    data[o + 11] = 1;
    data[o + 12] = 1; // Jp
  }
  // Density normalization: with mass = 1/(particles per seeded cell)
  // the grid sees ρ ≈ 1, so the stress model's pressure can actually
  // balance gravity no matter how densely the material was seeded.
  const perCell = live / Math.max(1, cellsTouched.size);
  st.pMass = Math.max(1 / 64, Math.min(1, 1 / perCell));
  st.liveCount = live;
  // A reseed can shrink liveCount — clear renderOut so slots beyond the
  // new live range read as dead (age 0) instead of ghost particles.
  st.device.queue.writeBuffer(
    st.renderOut,
    0,
    new Float32Array(st.texW * st.texH * 4)
  );
  st.device.queue.writeBuffer(st.particleBuf, 0, data);
}

// ---- obstacle SDF bake --------------------------------------------------

// Two-pass 3×4-weight chamfer distance transform, in place. `d` holds 0
// at set cells and +INF elsewhere; afterwards each cell holds ≈distance
// (index units) to the nearest set cell.
function chamfer(d: Float32Array, nx: number, ny: number): void {
  const D = 1.4;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - nx] + 1);
        if (x > 0) v = Math.min(v, d[i - nx - 1] + D);
        if (x < nx - 1) v = Math.min(v, d[i - nx + 1] + D);
      }
      d[i] = v;
    }
  }
  for (let y = ny - 1; y >= 0; y--) {
    for (let x = nx - 1; x >= 0; x--) {
      const i = y * nx + x;
      let v = d[i];
      if (x < nx - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < ny - 1) {
        v = Math.min(v, d[i + nx] + 1);
        if (x < nx - 1) v = Math.min(v, d[i + nx + 1] + D);
        if (x > 0) v = Math.min(v, d[i + nx - 1] + D);
      }
      d[i] = v;
    }
  }
}

// Shared 2D canvas for spline occupancy rasterization (grid-res, tiny).
let bakeCanvas: HTMLCanvasElement | null = null;

// Bake obstacle occupancy (spline fill ∪ image-mask collider alphas)
// into a signed distance field in index units, negative inside. Follows
// the spline→mask coercion's fill rules: subpaths closed for fill,
// even-odd. Row 0 = top (y-down index space) — ImageData row order and
// readImagePixels both match, no flips.
function bakeObstacleSdf(
  ctx: RenderContext,
  spline: SplineValue | null,
  masks: { img: ImageValue; threshold: number }[],
  nx: number,
  ny: number
): Float32Array<ArrayBuffer> {
  const cells = nx * ny;
  const occ = new Uint8Array(cells);

  if (spline && spline.subpaths.length > 0) {
    if (!bakeCanvas) bakeCanvas = document.createElement("canvas");
    const cv = bakeCanvas;
    if (cv.width !== nx) cv.width = nx;
    if (cv.height !== ny) cv.height = ny;
    const c2d = cv.getContext("2d", { willReadFrequently: true });
    if (c2d) {
      c2d.clearRect(0, 0, nx, ny);
      const path = new Path2D();
      // The spline is AUTHORED (engine/aspect.ts), and index space is
      // isotropic, so BOTH axes scale by nx — y additionally re-centers
      // (authored y = 0.5 is the canvas middle, index y = ny/2).
      // Scaling y by ny instead treated authored coordinates as canvas
      // UV and stretched every obstacle vertically at 16:9.
      const oy = 0.5 * (ny - nx);
      const px = (a: SplineAnchor, h?: [number, number]): [number, number] => [
        (a.pos[0] + (h?.[0] ?? 0)) * nx,
        (a.pos[1] + (h?.[1] ?? 0)) * nx + oy,
      ];
      for (const sub of spline.subpaths) {
        const anchors = sub.anchors;
        if (anchors.length < 2) continue;
        const [mx, my] = px(anchors[0]);
        path.moveTo(mx, my);
        const segs = sub.closed ? anchors.length : anchors.length - 1;
        for (let k = 0; k < segs; k++) {
          const a = anchors[k];
          const b = anchors[(k + 1) % anchors.length];
          const [c1x, c1y] = px(a, a.outHandle);
          const [c2x, c2y] = px(b, b.inHandle);
          const [bx, by] = px(b);
          path.bezierCurveTo(c1x, c1y, c2x, c2y, bx, by);
        }
        path.closePath();
      }
      c2d.fillStyle = "#fff";
      c2d.fill(path, "evenodd");
      const img = c2d.getImageData(0, 0, nx, ny).data;
      for (let i = 0; i < cells; i++) {
        if (img[i * 4 + 3] > 127) occ[i] = 1;
      }
    }
  }

  for (const { img, threshold } of masks) {
    const buf = ctx.readImagePixels(img, nx, ny);
    if (!buf) continue;
    const t = Math.max(1, Math.round(threshold * 255));
    for (let i = 0; i < cells; i++) {
      if (buf[i * 4 + 3] >= t) occ[i] = 1;
    }
  }

  // sdf = dist-to-occupied − dist-to-empty (one of the two is 0).
  const INF = 1e9;
  const dOcc = new Float32Array(cells);
  const dEmp = new Float32Array(cells);
  for (let i = 0; i < cells; i++) {
    dOcc[i] = occ[i] ? 0 : INF;
    dEmp[i] = occ[i] ? INF : 0;
  }
  chamfer(dOcc, nx, ny);
  chamfer(dEmp, nx, ny);
  const sdf = new Float32Array(cells);
  for (let i = 0; i < cells; i++) sdf[i] = dOcc[i] - dEmp[i];
  return sdf;
}

// ---- descriptor gathering ----------------------------------------------

function gatherForces(
  inputs: Record<string, SocketValue | undefined>
): ForceDescriptor[] {
  const out: ForceDescriptor[] = [];
  for (let i = 0; i < MAX_FORCES; i++) {
    const v = inputs[`force${i + 1}`];
    if (v && v.kind === "force") out.push(v.descriptor);
  }
  return out;
}

function gatherColliders(
  inputs: Record<string, SocketValue | undefined>
): ColliderDescriptor[] {
  const out: ColliderDescriptor[] = [];
  for (let i = 0; i < MAX_COLLIDERS; i++) {
    const v = inputs[`collider${i + 1}`];
    // Analytic kinds only — image_mask colliders route through the
    // baked obstacle SDF instead (gatherMaskColliders).
    if (v && v.kind === "collider" && v.descriptor.kind !== "image_mask") {
      out.push(v.descriptor);
    }
  }
  return out;
}

// Image-mask colliders can't be sampled by WebGPU directly (WebGL
// texture) — they join the obstacle spline in the CPU-baked SDF.
function gatherMaskColliders(
  inputs: Record<string, SocketValue | undefined>
): { img: ImageValue; threshold: number }[] {
  const out: { img: ImageValue; threshold: number }[] = [];
  for (let i = 0; i < MAX_COLLIDERS; i++) {
    const v = inputs[`collider${i + 1}`];
    if (v && v.kind === "collider" && v.descriptor.kind === "image_mask") {
      out.push({ img: v.descriptor.mask, threshold: v.descriptor.threshold });
    }
  }
  return out;
}

function packForceVec4(
  d: ForceDescriptor
): { kind: number; a: number[]; b: number[] } {
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
  return { kind: FORCE_KIND[d.kind], a, b };
}

function writeParams(
  st: MatterState,
  args: {
    dt: number;
    time: number;
    gravity: number;
    E: number;
    material: number;
    hardening: number;
    damping: number;
    colliderPad: number;
    viscosity: number;
    yieldLo: number;
    yieldHi: number;
    hasObstacle: boolean;
    forces: ForceDescriptor[];
    colliders: ColliderDescriptor[];
  }
): void {
  const data = new ArrayBuffer(PARAMS_BYTES);
  const f32 = new Float32Array(data);
  const u32 = new Uint32Array(data);
  f32[0] = args.dt;
  f32[1] = args.time;
  f32[2] = args.gravity;
  f32[3] = args.E;
  u32[4] = st.liveCount;
  u32[5] = args.material;
  u32[6] = Math.min(args.forces.length, MAX_FORCES);
  u32[7] = Math.min(args.colliders.length, MAX_COLLIDERS);
  f32[8] = st.nx;
  f32[9] = st.ny;
  f32[10] = args.hardening;
  f32[11] = args.damping;
  f32[12] = st.pMass;
  f32[13] = st.pMass; // pVol = pMass at ρ0 = 1
  f32[14] = args.colliderPad;
  f32[15] = args.viscosity;
  f32[16] = args.yieldLo;
  f32[17] = args.yieldHi;
  f32[18] = args.hasObstacle ? 1 : 0;
  // forceKinds at byte 80, forceA at 112, forceB at 208.
  args.forces.slice(0, MAX_FORCES).forEach((d, i) => {
    const p = packForceVec4(d);
    u32[20 + i] = p.kind;
    for (let k = 0; k < 4; k++) {
      f32[28 + i * 4 + k] = p.a[k];
      f32[52 + i * 4 + k] = p.b[k];
    }
  });
  // colliderKinds at byte 304 (u32 idx 76), colliderA at 320 (f32 idx
  // 80), colliderB at 384 (reserved).
  args.colliders.slice(0, MAX_COLLIDERS).forEach((d, i) => {
    if (d.kind === "circle") {
      u32[76 + i] = COLLIDER_KIND.circle;
      f32[80 + i * 4] = d.cx;
      f32[80 + i * 4 + 1] = d.cy;
      f32[80 + i * 4 + 2] = d.radius;
      f32[80 + i * 4 + 3] = d.inside ? 1 : 0;
    } else if (d.kind === "line") {
      u32[76 + i] = COLLIDER_KIND.line;
      f32[80 + i * 4] = d.nx;
      f32[80 + i * 4 + 1] = d.ny;
      f32[80 + i * 4 + 2] = d.d;
    }
  });
  st.device.queue.writeBuffer(st.paramsBuf, 0, data);
}

// ---- node definition ----------------------------------------------------

export const matterSimulatorNode: NodeDefinition = {
  type: "matter-simulator",
  name: "Matter Simulator",
  category: "effect",
  description:
    "MLS-MPM deformable matter on WebGPU — liquid, jelly, and snow are one solver with per-material dials (liquid: stiffness + viscosity; jelly: stiffness; snow: stiffness + crumble + hardening). Wire points into `seed` (or a mask into `region`) to place the material; `particle_radius` packs the seeding at a rest spacing so the material keeps that separation. Obstacles three ways: any spline into `obstacle`, Image Mask Colliders, or Circle/Line colliders — all free-slip, inflated by `collider_radius` so sprites rest ON surfaces. Takes the same force nodes as the Particle Simulator. Output is a `particles` socket for Particles to Image plus a `points` aux for the whole points ecosystem — Copy to Points on goo, Points to Spline surfaces. Runs one frame behind (WebGPU readback); needs a WebGPU-capable browser. Restarting the timeline reseeds.",
  backend: "webgpu",
  stable: false,
  simulation: true,
  inputs: [
    { name: "seed", type: "points", required: false },
    { name: "region", type: "mask", required: false },
    { name: "obstacle", type: "spline", required: false },
  ],
  resolveInputs(params): InputSocketDef[] {
    const base: InputSocketDef[] = [
      { name: "seed", type: "points", required: false },
      { name: "region", type: "mask", required: false },
      { name: "obstacle", type: "spline", required: false },
    ];
    const fc = Math.max(
      0,
      Math.min(MAX_FORCES, Math.floor((params.forceCount as number) ?? 2))
    );
    for (let i = 0; i < fc; i++) {
      base.push({ name: `force${i + 1}`, type: "force", required: false });
    }
    const cc = Math.max(
      0,
      Math.min(MAX_COLLIDERS, Math.floor((params.colliderCount as number) ?? 1))
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
      name: "count",
      label: "Particles",
      type: "scalar",
      min: 256,
      max: 131072,
      softMax: 32768,
      step: 256,
      default: 8192,
    },
    {
      name: "material",
      label: "Material",
      type: "enum",
      options: MATERIALS as unknown as string[],
      control: "segmented",
      default: "liquid",
    },
    // Per-material dials (visibleIf material) — separate params so each
    // mode remembers its own tuning and gets its own calibrated default.
    {
      name: "liquid_stiffness",
      label: "Stiffness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => (p.material ?? "liquid") === "liquid",
    },
    {
      name: "liquid_viscosity",
      label: "Viscosity",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.08,
      visibleIf: (p) => (p.material ?? "liquid") === "liquid",
    },
    {
      name: "jelly_stiffness",
      label: "Stiffness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.55,
      visibleIf: (p) => p.material === "jelly",
    },
    {
      name: "snow_stiffness",
      label: "Stiffness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.45,
      visibleIf: (p) => p.material === "snow",
    },
    {
      name: "snow_yield",
      label: "Crumble",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => p.material === "snow",
    },
    {
      name: "hardening",
      label: "Hardening",
      type: "scalar",
      min: 0,
      max: 20,
      step: 0.1,
      default: 10,
      visibleIf: (p) => p.material === "snow",
    },
    {
      name: "gravity",
      label: "Gravity",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.01,
      default: 0.6,
    },
    {
      name: "damping",
      label: "Damping",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 0,
    },
    {
      // Rest half-spacing between particles (canvas-width fraction),
      // applied at SEED time as jittered-grid packing at 2r — pressure
      // then maintains that density, so this reads as particle size.
      // 0 = legacy random packing at full budget. Ignored when explicit
      // seed points are wired (their spacing wins).
      name: "particle_radius",
      label: "Particle radius",
      type: "scalar",
      min: 0,
      max: 0.02,
      step: 0.0005,
      default: 0,
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
      name: "grid_res",
      label: "Grid resolution",
      type: "scalar",
      min: 32,
      max: 256,
      step: 8,
      default: 96,
    },
    {
      name: "substeps_per_frame",
      label: "Substeps / frame",
      type: "scalar",
      min: 2,
      max: 24,
      step: 1,
      default: 10,
    },
    {
      name: "forceCount",
      label: "Force slots",
      type: "scalar",
      min: 0,
      max: MAX_FORCES,
      step: 1,
      default: 2,
    },
    {
      name: "colliderCount",
      label: "Collider slots",
      type: "scalar",
      min: 0,
      max: MAX_COLLIDERS,
      step: 1,
      default: 1,
    },
    {
      // Inflates every collider surface (canvas-width fraction) so
      // rendered sprites rest ON the surface instead of sinking their
      // centers into it. Roughly match the Particles to Image size.
      name: "collider_radius",
      label: "Collider radius",
      type: "scalar",
      min: 0,
      max: 0.05,
      step: 0.001,
      default: 0.004,
      visibleIf: (p) => ((p.colliderCount as number) ?? 1) > 0,
    },
    {
      name: "seed_jitter",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 10000,
      step: 1,
      default: 1,
    },
    {
      name: "drive_by_scene_time",
      label: "Drive by time input",
      type: "boolean",
      default: false,
    },
  ],
  primaryOutput: "particles",
  auxOutputs: [{ name: "points", type: "points" }],

  fingerprintExtras(_params, ctx) {
    return `t:${ctx.time.toFixed(4)}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const statusKey = `${stateKey(nodeId)}:status`;
    const cachedStatus = ctx.state[statusKey] as
      | { ok: true; device: GPUDevice }
      | { ok: false; reason: string }
      | undefined;

    if (!cachedStatus) {
      void ensureWebGPUDevice(ctx).then((status) => {
        if (status.ok) {
          ctx.state[statusKey] = { ok: true, device: status.device };
        } else {
          ctx.state[statusKey] = { ok: false, reason: status.message };
        }
      });
      return;
    }
    if (!cachedStatus.ok) {
      throw new Error(cachedStatus.reason);
    }
    const device = cachedStatus.device;

    const count = Math.max(
      256,
      Math.min(131072, Math.floor((params.count as number) ?? 8192))
    );
    const gridRes = Math.max(
      32,
      Math.min(256, Math.round((params.grid_res as number) ?? 96))
    );
    const aspect = ctx.width / ctx.height;
    const nx = gridRes;
    const ny = Math.max(16, Math.min(512, Math.round(gridRes / aspect)));

    const st = ensureState(ctx, device, nodeId, count, nx, ny);

    // Reseed on: fresh state, scene-time wrap, or a seed-affecting
    // param/input change (material folded in — F/Jp semantics differ).
    const seedPts =
      inputs.seed && inputs.seed.kind === "points" ? inputs.seed : null;
    const region =
      inputs.region && inputs.region.kind === "mask" ? inputs.region : null;
    const material = Math.max(
      0,
      MATERIALS.indexOf(
        ((params.material as string) ?? "liquid") as (typeof MATERIALS)[number]
      )
    );
    const seedSig = [
      params.seed_jitter ?? 1,
      material,
      params.particle_radius ?? 0,
      seedPts ? `p${seedPts.count}` : region ? "r" : "d",
    ].join(":");
    const wasNonZero = st.lastTime > 0.05;
    const isNearZero = ctx.time < 0.05;
    if (st.needsSeed || (wasNonZero && isNearZero) || st.seedSig !== seedSig) {
      seedParticles(
        ctx,
        st,
        seedPts,
        region,
        Math.floor((params.seed_jitter as number) ?? 1) + 1,
        (params.particle_radius as number) ?? 0
      );
      st.needsSeed = false;
      st.seedSig = seedSig;
      st.lastDriver = inputs.time?.kind === "scalar" ? inputs.time.value : 0;
    }

    // Step gating — the house sim contract.
    let active: boolean;
    if (params.drive_by_scene_time) {
      const driver = inputs.time?.kind === "scalar" ? inputs.time.value : 0;
      active = driver > st.lastDriver + 1e-6;
      st.lastDriver = driver;
    } else {
      active = ctx.playing || (ctx.offline && ctx.time > st.lastTime + 1e-6);
    }
    st.lastTime = ctx.time;

    // Rebake the obstacle SDF when the obstacle spline or any
    // image-mask collider changes (value-object identity = "upstream
    // recomputed"). Runs even while paused so wiring shows on play.
    const obstacleSpline =
      inputs.obstacle && inputs.obstacle.kind === "spline"
        ? inputs.obstacle
        : null;
    const maskColliders = gatherMaskColliders(inputs);
    const maskRefsChanged =
      maskColliders.length !== st.obstacleMaskRefs.length ||
      maskColliders.some((m, i) => m.img !== st.obstacleMaskRefs[i]);
    if (obstacleSpline !== st.obstacleSplineRef || maskRefsChanged) {
      st.obstacleSplineRef = obstacleSpline;
      st.obstacleMaskRefs = maskColliders.map((m) => m.img);
      st.hasObstacle = !!obstacleSpline || maskColliders.length > 0;
      if (st.hasObstacle) {
        device.queue.writeBuffer(
          st.obstacleBuf,
          0,
          bakeObstacleSdf(ctx, obstacleSpline, maskColliders, nx, ny)
        );
      }
    }

    // Drain last frame's readback into the WebGL bridge texture and
    // keep the CPU array for the points aux.
    if (st.pendingUpload) {
      if (st.outputImage) ctx.releaseTexture(st.outputImage.texture);
      st.outputImage = ctx.uploadFloat32ToImage(
        st.pendingUpload,
        st.texW,
        st.texH
      );
      st.lastPositions = st.pendingUpload;
      st.pendingUpload = null;
    }

    if (active) {
      const substeps = Math.max(
        2,
        Math.min(24, Math.round((params.substeps_per_frame as number) ?? 10))
      );
      const speed = (params.speed as number) ?? 1;
      const dt = speed / Math.max(1, ctx.fps) / substeps;
      // Log dial: E ∈ [300, 300k]. Calibrated for hydrostatic balance
      // at density-normalized mass (ρ0 = 1): pressure must reach
      // ρ·g·h ≈ 32·pile-depth in index units, so useful λ lives in the
      // thousands-to-tens-of-thousands — the original 40·10^2.5s cap
      // sat two orders below that, which is why particles fell straight
      // through each other. CFL headroom holds: c = √(λ/ρ) ≤ ~290 idx/s
      // at the top of the dial vs the grid clamp of 0.45/dt = 270 (the
      // clamp engages only at max stiffness — raise substeps there).
      // Per-material dials; the retired shared `stiffness` param is the
      // fallback so day-one saved nodes keep their tuning.
      const dialKey =
        material === 0
          ? "liquid_stiffness"
          : material === 1
            ? "jelly_stiffness"
            : "snow_stiffness";
      const dialDefault = material === 0 ? 0.5 : material === 1 ? 0.55 : 0.45;
      const stiffness01 = Math.max(
        0,
        Math.min(
          1,
          (params[dialKey] as number) ??
            (params.stiffness as number) ??
            dialDefault
        )
      );
      const E = 300 * Math.pow(10, stiffness01 * 3);
      // Viscosity dial (liquid only): quadratic map into viscous-stress
      // μv — 0..300 covers water → honey.
      const visc01 =
        material === 0 ? ((params.liquid_viscosity as number) ?? 0.08) : 0;
      const viscosity = visc01 * visc01 * 300;
      // Snow yield range from the Crumble dial (mpm99 defaults at 0.5).
      const yield01 = (params.snow_yield as number) ?? 0.5;
      const yieldLo = 0.005 + 0.05 * Math.max(0, Math.min(1, yield01));
      const yieldHi = 0.18 * yieldLo;
      const forces = gatherForces(inputs);
      const colliders = gatherColliders(inputs);

      const cells = nx * ny;
      for (let s = 0; s < substeps; s++) {
        // All substeps share one params buffer, so each write must be
        // queue-ordered before its own submit: writeBuffer → submit,
        // per substep (only `time` differs between them).
        writeParams(st, {
          dt,
          time: ctx.time + s * dt,
          gravity: (params.gravity as number) ?? 0.6,
          E,
          material,
          hardening: (params.hardening as number) ?? 10,
          damping: (params.damping as number) ?? 0,
          colliderPad: (params.collider_radius as number) ?? 0.004,
          viscosity,
          yieldLo,
          yieldHi,
          hasObstacle: st.hasObstacle,
          forces,
          colliders,
        });
        const sub = device.createCommandEncoder({ label: "matter-sim:substep" });
        const dispatch = (
          pipe: GPUComputePipeline,
          bindGroup: GPUBindGroup,
          groups: number
        ) => {
          const pass = sub.beginComputePass();
          pass.setPipeline(pipe);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(groups);
          pass.end();
        };
        dispatch(st.clearPipe, st.clearBind, Math.ceil((cells * 3) / 64));
        dispatch(st.p2gPipe, st.p2gBind, Math.ceil(st.liveCount / 64));
        dispatch(st.gridPipe, st.gridBind, Math.ceil(cells / 64));
        dispatch(st.g2pPipe, st.g2pBind, Math.ceil(st.liveCount / 64));
        device.queue.submit([sub.finish()]);
      }

      // Kick the readback for next frame's drain (or this frame's
      // settle pass during offline export).
      if (!st.readbackBusy) {
        const copy = device.createCommandEncoder({ label: "matter-sim:copy" });
        copy.copyBufferToBuffer(
          st.renderOut,
          0,
          st.staging,
          0,
          st.texW * st.texH * 16
        );
        device.queue.submit([copy.finish()]);
        st.readbackBusy = true;
        const staging = st.staging;
        const mapped = staging
          .mapAsync(GPUMapMode.READ)
          .then(() => {
            if (ctx.state[stateKey(nodeId)] !== st) {
              try {
                staging.unmap();
              } catch {
                // already gone
              }
              return;
            }
            const copyArr = new Float32Array(st.texW * st.texH * 4);
            copyArr.set(
              new Float32Array(staging.getMappedRange(0, st.texW * st.texH * 16))
            );
            staging.unmap();
            st.pendingUpload = copyArr;
            st.readbackBusy = false;
          })
          .catch((err) => {
            console.warn("matter-simulator: mapAsync rejected:", err);
            st.readbackBusy = false;
          });
        // Offline: the export driver's settle→re-render pass drains this
        // (time won't advance on the re-render, so no double-step).
        if (ctx.offline) pushMediaSettle(ctx, mapped);
      }
    }

    // ---- outputs (one frame behind) ----
    if (!st.outputImage) return;
    const particles: ParticlesValue = {
      kind: "particles",
      positionTex: st.outputImage.texture,
      velocityTex: st.zeroVelocityImage.texture,
      width: st.texW,
      height: st.texH,
      count: st.count,
    };
    // Points aux from the drained CPU array. The solver (and the
    // `particles` primary) runs in y-down CANVAS UV, but geometry
    // sockets carry AUTHORED coordinates (engine/aspect.ts — y is
    // width-isotropic and vertically centered), so y converts on the
    // way out. Without it every points consumer that aspect-corrects on
    // render — Copy to Points' instanced VS, Points to Spline →
    // rasterizer, Point Labels, the viewport overlay — double-corrects
    // and pushes copies away from center vertically on non-square
    // canvases. Square canvas = identity. The padded tail beyond count
    // never enters.
    let points: PointsValue;
    const src = st.lastPositions;
    if (src) {
      const live = Math.min(st.liveCount, st.count);
      const aspect = ctx.width / ctx.height;
      points = makePoints(live);
      for (let i = 0; i < live; i++) {
        points.positions[i * 2] = src[i * 4];
        points.positions[i * 2 + 1] = aspectUncorrectY(src[i * 4 + 1], aspect);
      }
    } else {
      points = makePoints(0);
    }
    return { primary: particles, aux: { points } };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const st = ctx.state[key] as MatterState | undefined;
    if (st) {
      disposeState(ctx, st);
      delete ctx.state[key];
    }
    delete ctx.state[`${key}:status`];
  },
};
