// =====================================================================
// Stipple relaxation kernel — WGSL compute
// =====================================================================
//
// GPU port of the CPU relaxation loop in nodes/effect/stipple.ts
// (`relaxPositionsCPU`). Only the *relaxation* stage moves to the GPU —
// the seeded rejection sampler stays on the CPU so a given seed yields
// the exact same point set regardless of backend. This kernel takes
// that fixed point set and runs the same Jacobi nearest-neighbour push,
// so the result is visually identical to the CPU path (modulo float
// precision, which relaxation is robust to).
//
// One iteration is three dispatches sharing a single bind group layout:
//
//   clearCounts — zero the per-cell atomic counters
//   bin         — each point atomicAdd's into its cell, recording its
//                 index into a fixed-capacity bins[cell*CAP + slot] list
//                 (mirrors the CPU's per-iteration Map<cell, idx[]>)
//   relax       — each point scans its 3×3 cell neighbourhood, finds the
//                 single nearest other point, and writes a displaced
//                 position into the WRITE buffer (Jacobi: never reads a
//                 same-iteration update). Mirrors stipple.ts:417-457.
//
// Positions ping-pong between two buffers across iterations. `sampleDensity`
// replicates `sampleDensityCPU` exactly (nearest texel, same luma weights,
// invert, alpha multiply, pow(curve)) so the per-point `ease` term matches.
//
// CAP bounds how many points a single cell can hold. The CPU has no cap,
// but with density-weighted jittered points a cell rarely holds more than
// a handful (the bin grid matches the output cell grid). Overflow just
// skips a few candidates in pathologically dense cells — negligible
// visually. The runner logs if overflow is observed.

const STIPPLE_RELAX_WGSL = /* wgsl */ `
struct Params {
  imgW   : u32,
  imgH   : u32,
  cellsX : u32,
  cellsY : u32,
  n      : u32,
  cap    : u32,
  invert : u32,   // 1 = use luma directly, 0 = use 1 - luma
  _pad0  : u32,
  stepBase : f32,
  curve    : f32,
  _pad1    : f32,
  _pad2    : f32,
};

@group(0) @binding(0) var<uniform> P : Params;
// Interleaved x,y in UV space, one vec2 per point.
@group(0) @binding(1) var<storage, read>        posIn  : array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write>  posOut : array<vec2<f32>>;
// Source image, RGBA interleaved float, length imgW*imgH*4.
@group(0) @binding(3) var<storage, read>        src    : array<f32>;
@group(0) @binding(4) var<storage, read_write>  counts : array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write>  bins   : array<u32>;

fn cellOf(p : vec2<f32>) -> vec2<i32> {
  let cx = clamp(i32(floor(p.x * f32(P.cellsX))), 0, i32(P.cellsX) - 1);
  let cy = clamp(i32(floor(p.y * f32(P.cellsY))), 0, i32(P.cellsY) - 1);
  return vec2<i32>(cx, cy);
}

// Nearest-texel density lookup — byte-for-byte the same arithmetic as
// sampleDensityCPU in stipple.ts.
fn sampleDensity(u : f32, v : f32) -> f32 {
  let x = clamp(i32(floor(u * f32(P.imgW))), 0, i32(P.imgW) - 1);
  let y = clamp(i32(floor(v * f32(P.imgH))), 0, i32(P.imgH) - 1);
  let idx = (u32(y) * P.imgW + u32(x)) * 4u;
  let r = src[idx + 0u];
  let g = src[idx + 1u];
  let b = src[idx + 2u];
  let a = src[idx + 3u];
  let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  var d = select(1.0 - lum, lum, P.invert == 1u);
  d = d * a;
  return pow(clamp(d, 0.0, 1.0), P.curve);
}

@compute @workgroup_size(64)
fn clearCounts(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.cellsX * P.cellsY) { return; }
  atomicStore(&counts[i], 0u);
}

@compute @workgroup_size(64)
fn bin(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let c = cellOf(posIn[i]);
  let cell = u32(c.y) * P.cellsX + u32(c.x);
  let slot = atomicAdd(&counts[cell], 1u);
  if (slot < P.cap) {
    bins[cell * P.cap + slot] = i;
  }
}

@compute @workgroup_size(64)
fn relax(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let p = posIn[i];
  let c = cellOf(p);

  var nearestDist2 = 3.4e38;
  var nnDx = 0.0;
  var nnDy = 0.0;

  // 3×3 cell neighbourhood, same iteration order as the CPU loop
  // (oy outer, ox inner). Tie-breaks on strict less-than so the first
  // wins; bin insertion order differs from the CPU's point-index order
  // under atomics, so near-equidistant ties may break differently —
  // immaterial to the converged field.
  for (var oy = -1; oy <= 1; oy = oy + 1) {
    for (var ox = -1; ox <= 1; ox = ox + 1) {
      let ncx = c.x + ox;
      let ncy = c.y + oy;
      if (ncx < 0 || ncy < 0 || ncx >= i32(P.cellsX) || ncy >= i32(P.cellsY)) {
        continue;
      }
      let cell = u32(ncy) * P.cellsX + u32(ncx);
      let raw = atomicLoad(&counts[cell]);
      let cnt = min(raw, P.cap);
      for (var k = 0u; k < cnt; k = k + 1u) {
        let j = bins[cell * P.cap + k];
        if (j == i) { continue; }
        let q = posIn[j];
        let ddx = p.x - q.x;
        let ddy = p.y - q.y;
        let d2 = ddx * ddx + ddy * ddy;
        if (d2 < nearestDist2) {
          nearestDist2 = d2;
          nnDx = ddx;
          nnDy = ddy;
        }
      }
    }
  }

  var out = p;
  if (nearestDist2 < 3.4e38 && nearestDist2 > 0.0) {
    let mag = sqrt(nearestDist2);
    let localD = sampleDensity(p.x, p.y);
    let ease = 1.0 - localD * 0.85;
    let dx = (nnDx / mag) * P.stepBase * ease;
    let dy = (nnDy / mag) * P.stepBase * ease;
    out = vec2<f32>(
      clamp(p.x + dx, 0.0, 1.0),
      clamp(p.y + dy, 0.0, 1.0),
    );
  }
  posOut[i] = out;
}
`;

export default STIPPLE_RELAX_WGSL;
