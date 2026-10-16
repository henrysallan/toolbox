// CPU implementations of the noise algorithms in nodes/source/perlin-noise.ts
// (NOISE_FS). The Noise node's `value` aux (one scalar at a vec2 position)
// evaluates here only where that is exact on any GPU (`noiseValueOnCpu`),
// and runs NOISE_FS itself, 1×1, everywhere else (perlin-noise.ts).
// Measured with scripts/noise-value-gl.cjs (Apple M5 Pro / Metal and
// SwiftShader, 2026-10-16).
//
// Everything below runs in EMULATED fp32: every operation is rounded with
// Math.fround in the shader's own order. The shader computes in fp32, and
// the hashes amplify rounding — value noise's hash12 ends in
// fract((x + y) · z) with the product ~1e4, so at |p| ≈ 100 (any seed ≥ 1:
// the seed offset is seed × (127.1, 311.7)) doubles miss the GPU's hash by
// up to 0.9 of the noise range. GLSL dot() is an fma chain on both GPUs
// measured (`dot2` / `dot3`); with that, perlin / simplex / value match
// SwiftShader's image to its half-float readback at every seed to 1000.
//
// Two things a CPU port cannot pin down:
//  - fract(sin(x) · 43758.5453). GPU sin() is implementation-defined —
//    Metal's is within 2 ulp of the correctly rounded value, SwiftShader's
//    thousands of ulp off — and × 43758 turns one ulp into a different hash
//    (why Voronoi moved to pcg3d). NOISE_FS sin-hashes the W slice offsets
//    (`hashOffset`, any w ≠ 0) and every lattice cell of opensimplex /
//    opensimplex2 / opensimplex2s / super-simplex / perlin-deriv / flow /
//    curl / phasor.
//  - Contraction. Metal fuses an explicit a·b + c (the seed offset
//    `u_offset + u_seed · 127.1` among them), SwiftShader does not, and at
//    |p| in the thousands one ulp of p is a visible step: Metal vs this
//    port reads 1.8e-3 at seed 7 and 0.1 at seed 1000. Hence the
//    magnitude guard in `noiseValueOnCpu`.
// `phasorNoise` and the sin-hashed `hashOffset` stay as the fallback for a
// context without float render targets (and the Skia gates' reference),
// right only where the GPU's sin rounds like Math.sin.

const f = Math.fround;

// GLSL fract on an fp32 x.
function fract32(x: number): number {
  return f(x - Math.floor(x));
}

// fma(a, b, c) in fp32: a · b is exact in a double, so one rounding of
// the sum (then fround) — double rounding only on exact ties.
function fma32(a: number, b: number, c: number): number {
  return f(a * b + c);
}

// GLSL dot(): Metal and SwiftShader (ANGLE) both lower it to an fma chain,
// dot(a, b) = fma(a.z, b.z, fma(a.y, b.y, a.x · b.x)) — bit-exact on 8000
// hash12 lattice points, where the separately rounded sum misses 24 %.
// Explicit a·b + c is left unfused: Metal fuses it, SwiftShader does not,
// and no hash amplifies it.
function dot2(ax: number, ay: number, bx: number, by: number): number {
  return fma32(ay, by, f(ax * bx));
}
function dot3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return fma32(az, bz, fma32(ay, by, f(ax * bx)));
}

// GLSL mix(x, y, a), as x + (y − x) · a.
function mix32(x: number, y: number, a: number): number {
  return f(x + f(f(y - x) * a));
}

const INV289 = f(1 / 289);

// mod289v2/v3/v4: x − floor(x · (1/289)) · 289.
function mod289(x: number): number {
  return f(x - f(Math.floor(f(x * INV289)) * 289));
}

// permute3/4: mod289(((x · 34) + 1) · x).
function permute(x: number): number {
  return mod289(f(f(f(x * 34) + 1) * x));
}

const SC0 = f(0.211324865405187);
const SC1 = f(0.366025403784439);
const SC2 = f(-0.577350269189626);
const SC3 = f(0.024390243902439);
const NORM_A = f(1.79284291400159);
const NORM_B = f(0.85373472095314);

// Ashima snoise — 2D simplex noise, returns ~[-1, 1].
export function snoise(vx: number, vy: number): number {
  vx = f(vx);
  vy = f(vy);
  // i = floor(v + dot(v, C.yy))
  const dv = dot2(vx, vy, SC1, SC1);
  let ix = Math.floor(f(vx + dv));
  let iy = Math.floor(f(vy + dv));
  // x0 = v - i + dot(i, C.xx)
  const di = dot2(ix, iy, SC0, SC0);
  const x0x = f(f(vx - ix) + di);
  const x0y = f(f(vy - iy) + di);
  const i1x = x0x > x0y ? 1 : 0;
  const i1y = x0x > x0y ? 0 : 1;
  // x12 = x0.xyxy + C.xxzz; x12.xy -= i1
  const x12_0x = f(f(x0x + SC0) - i1x);
  const x12_0y = f(f(x0y + SC0) - i1y);
  const x12_1x = f(x0x + SC2);
  const x12_1y = f(x0y + SC2);
  ix = mod289(ix);
  iy = mod289(iy);
  // p = permute(permute(i.y + vec3(0, i1.y, 1)) + i.x + vec3(0, i1.x, 1))
  const p0 = permute(f(permute(iy) + ix));
  const p1 = permute(f(f(permute(f(iy + i1y)) + ix) + i1x));
  const p2 = permute(f(f(permute(f(iy + 1)) + ix) + 1));

  let m0 = Math.max(f(0.5 - dot2(x0x, x0y, x0x, x0y)), 0);
  let m1 = Math.max(f(0.5 - dot2(x12_0x, x12_0y, x12_0x, x12_0y)), 0);
  let m2 = Math.max(f(0.5 - dot2(x12_1x, x12_1y, x12_1x, x12_1y)), 0);
  m0 = f(m0 * m0);
  m0 = f(m0 * m0);
  m1 = f(m1 * m1);
  m1 = f(m1 * m1);
  m2 = f(m2 * m2);
  m2 = f(m2 * m2);

  // x = 2 · fract(p · C.www) − 1; h = |x| − 0.5; a0 = x − floor(x + 0.5)
  const xv0 = f(f(2 * fract32(f(p0 * SC3))) - 1);
  const xv1 = f(f(2 * fract32(f(p1 * SC3))) - 1);
  const xv2 = f(f(2 * fract32(f(p2 * SC3))) - 1);
  const h0 = f(Math.abs(xv0) - 0.5);
  const h1 = f(Math.abs(xv1) - 0.5);
  const h2 = f(Math.abs(xv2) - 0.5);
  const a00 = f(xv0 - Math.floor(f(xv0 + 0.5)));
  const a01 = f(xv1 - Math.floor(f(xv1 + 0.5)));
  const a02 = f(xv2 - Math.floor(f(xv2 + 0.5)));

  m0 = f(m0 * f(NORM_A - f(NORM_B * f(f(a00 * a00) + f(h0 * h0)))));
  m1 = f(m1 * f(NORM_A - f(NORM_B * f(f(a01 * a01) + f(h1 * h1)))));
  m2 = f(m2 * f(NORM_A - f(NORM_B * f(f(a02 * a02) + f(h2 * h2)))));

  const g0 = f(f(a00 * x0x) + f(h0 * x0y));
  const g1 = f(f(a01 * x12_0x) + f(h1 * x12_0y));
  const g2 = f(f(a02 * x12_1x) + f(h2 * x12_1y));
  return f(130 * dot3(m0, m1, m2, g0, g1, g2));
}

// GLSL mod(x, 289.0) = x − 289 · floor(x / 289).
function mod289div(x: number): number {
  return f(x - f(289 * Math.floor(f(x / 289))));
}

// fade2: t³ (t (6t − 15) + 10).
function fade(t: number): number {
  return f(f(f(t * t) * t) * f(f(t * f(f(t * 6) - 15)) + 10));
}

const INV41 = f(1 / 41);

// Improved Perlin (Ashima cnoise), returns ~[-1, 1].
export function cnoise(Px: number, Py: number): number {
  Px = f(Px);
  Py = f(Py);
  // Pi = mod(floor(P.xyxy) + (0, 0, 1, 1), 289); Pf = fract(P.xyxy) − (0, 0, 1, 1)
  const fx0 = Math.floor(Px);
  const fy0 = Math.floor(Py);
  const i00 = mod289div(fx0);
  const i01 = mod289div(fy0);
  const i10 = mod289div(f(fx0 + 1));
  const i11 = mod289div(f(fy0 + 1));
  const Pf0x = fract32(Px);
  const Pf0y = fract32(Py);
  const Pf1x = f(Pf0x - 1);
  const Pf1y = f(Pf0y - 1);

  // ix = Pi.xzxz, iy = Pi.yyww; ii = permute(permute(ix) + iy)
  const ii0 = permute(f(permute(i00) + i01));
  const ii1 = permute(f(permute(i10) + i01));
  const ii2 = permute(f(permute(i00) + i11));
  const ii3 = permute(f(permute(i10) + i11));

  // gx = 2 · fract(ii / 41) − 1; gy = |gx| − 0.5; gx −= floor(gx + 0.5)
  const gxa = [ii0, ii1, ii2, ii3].map((v) => f(f(2 * fract32(f(v * INV41))) - 1));
  const gy = gxa.map((v) => f(Math.abs(v) - 0.5));
  const gx = gxa.map((v) => f(v - Math.floor(f(v + 0.5))));
  // g00 = (gx.x, gy.x), g10 = (gx.y, gy.y), g01 = (gx.z, gy.z), g11 = (gx.w, gy.w);
  // norm = (dot(g00), dot(g01), dot(g10), dot(g11)) — g01 is index 2, g10 index 1.
  const nrm = (k: number) => f(NORM_A - f(NORM_B * dot2(gx[k], gy[k], gx[k], gy[k])));
  const n00s = nrm(0);
  const n10s = nrm(1);
  const n01s = nrm(2);
  const n11s = nrm(3);
  const g00x = f(gx[0] * n00s);
  const g00y = f(gy[0] * n00s);
  const g10x = f(gx[1] * n10s);
  const g10y = f(gy[1] * n10s);
  const g01x = f(gx[2] * n01s);
  const g01y = f(gy[2] * n01s);
  const g11x = f(gx[3] * n11s);
  const g11y = f(gy[3] * n11s);

  // fx = Pf.xzxz, fy = Pf.yyww
  const n00 = dot2(g00x, g00y, Pf0x, Pf0y);
  const n10 = dot2(g10x, g10y, Pf1x, Pf0y);
  const n01 = dot2(g01x, g01y, Pf0x, Pf1y);
  const n11 = dot2(g11x, g11y, Pf1x, Pf1y);

  const ux = fade(Pf0x);
  const uy = fade(Pf0y);
  const nx0 = mix32(n00, n10, ux);
  const nx1 = mix32(n01, n11, ux);
  return f(2.3 * mix32(nx0, nx1, uy));
}

const H12_K = f(0.1031);
const H12_ADD = f(33.33);

// hash12 (Dave_Hoskins): p3 = fract(p.xyx · 0.1031); p3 += dot(p3, p3.yzx + 33.33);
// fract((p3.x + p3.y) · p3.z). p3.z aliases p3.x (vec3(p.xyx)).
function hash12(px: number, py: number): number {
  let p3x = fract32(f(px * H12_K));
  let p3y = fract32(f(py * H12_K));
  let p3z = p3x;
  const d = dot3(p3x, p3y, p3z, f(p3y + H12_ADD), f(p3z + H12_ADD), f(p3x + H12_ADD));
  p3x = f(p3x + d);
  p3y = f(p3y + d);
  p3z = f(p3z + d);
  return fract32(f(f(p3x + p3y) * p3z));
}

// Cubic-interpolated value noise, returns ~[-1, 1].
export function vnoise(Px: number, Py: number): number {
  Px = f(Px);
  Py = f(Py);
  const ix = Math.floor(Px);
  const iy = Math.floor(Py);
  const fx = fract32(Px);
  const fy = fract32(Py);
  // u = f · f · (3 − 2f)
  const ux = f(f(fx * fx) * f(3 - f(2 * fx)));
  const uy = f(f(fy * fy) * f(3 - f(2 * fy)));
  const a = hash12(ix, iy);
  const b = hash12(f(ix + 1), iy);
  const c = hash12(ix, f(iy + 1));
  const d = hash12(f(ix + 1), f(iy + 1));
  return f(f(mix32(mix32(a, b, ux), mix32(c, d, ux), uy) * 2) - 1);
}

export type NoiseFn = (px: number, py: number) => number;

// fract(sin(x) · 43758.5453123) with sin rounded once: the GPU's own sin is
// implementation-defined (see the header) — this matches it only where it
// rounds like Math.sin.
const SIN_K = f(43758.5453123);
function sinHash(x: number): number {
  return fract32(f(f(Math.sin(x)) * SIN_K));
}

const PH_A = [f(127.1), f(311.7)];
const PH_B = [f(269.5), f(183.3)];
const PH_C = [f(419.2), f(371.9)];
const PH_D = [f(183.3), f(251.7)];
const PI32 = f(3.141592653589793);
const TAU32 = f(6.283185307179586);

// Tricard et al. phasor noise — the GLSL `phasorNoise` in fp32.
// `orientation` is radians; `frequency` is cycles per lattice cell;
// `isotropy` 0 = all kernels share orientation, 1 = ±π random offset.
// Sin-hashed: exact only where the GPU's sin rounds like Math.sin.
export function phasorNoise(
  px: number,
  py: number,
  frequency: number,
  orientation: number,
  isotropy: number
): number {
  px = f(px);
  py = f(py);
  frequency = f(frequency);
  orientation = f(orientation);
  isotropy = f(isotropy);
  const ipx = Math.floor(px);
  const ipy = Math.floor(py);
  const fpx = fract32(px);
  const fpy = fract32(py);
  const isoK = f(PI32 * isotropy);
  let accX = 0;
  let accY = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cellX = f(ipx + i);
      const cellY = f(ipy + j);
      const h0x = sinHash(dot2(cellX, cellY, PH_A[0], PH_A[1]));
      const h0y = sinHash(dot2(cellX, cellY, PH_B[0], PH_B[1]));
      const h1x = sinHash(dot2(cellX, cellY, PH_C[0], PH_C[1]));
      const h1y = sinHash(dot2(cellX, cellY, PH_D[0], PH_D[1]));
      // r = g + h0 − fp
      const rx = f(f(i + h0x) - fpx);
      const ry = f(f(j + h0y) - fpy);
      const d2 = dot2(rx, ry, rx, ry);
      if (!(d2 < 1)) continue;
      const pd2 = f(PI32 * d2);
      const w = f(f(0.5 + f(0.5 * f(Math.cos(pd2)))) * f(Math.exp(-pd2)));
      const ori = f(orientation + f(isoK * f(f(h1x * 2) - 1)));
      const dirX = f(Math.cos(ori));
      const dirY = f(Math.sin(ori));
      const ang = f(TAU32 * f(f(frequency * dot2(rx, ry, dirX, dirY)) + h1y));
      accX = f(accX + f(w * f(Math.cos(ang))));
      accY = f(accY + f(w * f(Math.sin(ang))));
    }
  }
  const mag = f(Math.sqrt(dot2(accX, accY, accX, accY)));
  if (mag < 1e-5) return 0;
  return f(accX / mag);
}

export type PhasorParams = {
  frequency: number;
  orientation: number;
  isotropy: number;
};

// fBm — the GLSL `fbmAt` in fp32.
function fbmAt(
  fn: NoiseFn,
  px: number,
  py: number,
  octaves: number,
  persistence: number,
  lacunarity: number
): number {
  let total = 0;
  let amp = 1;
  let freq = 1;
  let maxAmp = 0;
  for (let i = 0; i < 8; i++) {
    if (i >= octaves) break;
    total = f(total + f(fn(f(px * freq), f(py * freq)) * amp));
    maxAmp = f(maxAmp + amp);
    amp = f(amp * persistence);
    freq = f(freq * lacunarity);
  }
  return f(total / Math.max(maxAmp, f(0.0001)));
}

const HO_A = f(12.9898);
const HO_B = f(78.233);
const HO_K = f(43758.5453);

// The GLSL hashOffset for W-slice blending. Sin-hashed: on the GPU, slice
// offsets come out as the GPU's sin rounds (Metal moves wi = ±1, ±2, ±3 by
// ~2 lattice units from this) — the value aux evaluates w ≠ 0 there.
function hashOffset(wi: number): [number, number] {
  if (wi === 0) return [0, 0];
  const a = fract32(f(f(Math.sin(f(wi * HO_A))) * HO_K));
  const b = fract32(f(f(Math.sin(f(wi * HO_B))) * HO_K));
  return [f(a * 1000), f(b * 1000)];
}

// fBm with W-slice evolution — the GLSL `fbm()` wrapper in fp32.
export function fbmWithW(
  fn: NoiseFn,
  px: number,
  py: number,
  w: number,
  octaves: number,
  persistence: number,
  lacunarity: number
): number {
  px = f(px);
  py = f(py);
  w = f(w);
  persistence = f(persistence);
  lacunarity = f(lacunarity);
  const wi = Math.floor(w);
  let wf = f(w - wi);
  wf = f(f(wf * wf) * f(3 - f(2 * wf)));
  const [o0x, o0y] = hashOffset(wi);
  if (wf === 0) {
    return fbmAt(fn, f(px + o0x), f(py + o0y), octaves, persistence, lacunarity);
  }
  const [o1x, o1y] = hashOffset(f(wi + 1));
  const a = fbmAt(fn, f(px + o0x), f(py + o0y), octaves, persistence, lacunarity);
  const b = fbmAt(fn, f(px + o1x), f(py + o1y), octaves, persistence, lacunarity);
  return mix32(a, b, wf);
}

// NOISE_FS main()'s sample point for canvas uv (u, v), in fp32:
//   p = (uv − 0.5) · scale;  p.y /= aspect;  p += offset + seedOffset + animOffset
// with seedOffset = seed · (127.1, 311.7) and aspect = width / height.
export function noiseSamplePoint(
  u: number,
  v: number,
  o: {
    width: number;
    height: number;
    scale: number;
    offsetX: number;
    offsetY: number;
    seed: number;
    animOffsetX: number;
    animOffsetY: number;
  }
): [number, number] {
  const scale = f(o.scale);
  const seed = f(o.seed);
  const aspect = f(f(o.width) / f(o.height));
  const ox = f(f(f(o.offsetX) + f(seed * PH_A[0])) + f(o.animOffsetX));
  const oy = f(f(f(o.offsetY) + f(seed * PH_A[1])) + f(o.animOffsetY));
  const px = f(f(f(u) - 0.5) * scale);
  const py = f(f(f(f(v) - 0.5) * scale) / aspect);
  return [f(px + ox), f(py + oy)];
}

// The algorithms with no sin hash, whose CPU port can be exact.
export const NOISE_CPU_EXACT_TYPES: readonly string[] = ["perlin", "simplex", "value"];

// Below this, |sample point| × the top octave's frequency keeps one ulp of
// p under 2⁻¹¹ lattice units at the finest octave, so a GPU that rounds the
// sample point differently (contraction) still lands within ~1e-3 of this
// port. Seed 0 and 1 (at 4 octaves) pass; seed 7 does not.
export const NOISE_CPU_MAX_EXTENT = 4096;

// Whether the Noise node's `value` aux at fp32 sample point (sx, sy)
// (`noiseSamplePoint`) evaluates on the CPU: a sin-free type, no W slice
// offsets (w = 0; the looping evolution forces it), and small coordinates.
// Everything else runs NOISE_FS on the GPU.
export function noiseValueOnCpu(
  type: string,
  w: number,
  sx: number,
  sy: number,
  octaves: number,
  lacunarity: number
): boolean {
  if (f(w) !== 0 || !NOISE_CPU_EXACT_TYPES.includes(type)) return false;
  let freq = 1;
  for (let i = 1; i < octaves; i++) freq = f(freq * f(lacunarity));
  return Math.max(Math.abs(sx), Math.abs(sy)) * freq < NOISE_CPU_MAX_EXTENT;
}

// ── Looping noise evolution ────────────────────────────────────────────
// Drive W-style evolution around a closed loop so an animation returns to
// its exact starting field at the end of the window — seamless, always
// forward (no ping-pong). See specdocs/archive/061626_looping-noise-evolution.md.
//
// frameNow is the continuous frame (ctx.tick / ctx.ticksPerFrame). The
// window [start, end] (in frames) is the period; phase wraps in [0, 1).
export function loopEvolutionPhase(
  frameNow: number,
  start: number,
  end: number
): number {
  const period = end - start;
  if (period <= 0) return 0;
  let phase = ((frameNow - start) / period) % 1;
  if (phase < 0) phase += 1;
  return phase;
}

// Offset added to the noise sample point: a circle of radius `rate` traced
// once per window. Because the W mechanism is "translate the sample point
// by an offset", walking that offset around a circle returns exactly to the
// start. Returns [0,0] when the window is degenerate or rate is 0.
export function loopEvolutionOffset(
  frameNow: number,
  start: number,
  end: number,
  rate: number
): [number, number] {
  if (rate === 0) return [0, 0];
  const period = end - start;
  if (period <= 0) return [0, 0];
  const theta = loopEvolutionPhase(frameNow, start, end) * Math.PI * 2;
  return [rate * Math.cos(theta), rate * Math.sin(theta)];
}

// The CPU noise function for a type. Only perlin / simplex / value are
// exact (NOISE_CPU_EXACT_TYPES); phasor is the sin-hashed fallback port;
// the OS family / perlin-deriv / flow / curl have no CPU port and read as
// simplex here — the Noise node evaluates them on the GPU instead.
export function noiseFnFor(type: string, phasor?: PhasorParams): NoiseFn {
  switch (type) {
    case "perlin":
      return cnoise;
    case "value":
      return vnoise;
    case "simplex":
      return snoise;
    case "phasor": {
      const frequency = phasor?.frequency ?? 2;
      const orientation = phasor?.orientation ?? 0;
      const isotropy = phasor?.isotropy ?? 0.2;
      return (x, y) => phasorNoise(x, y, frequency, orientation, isotropy);
    }
    default:
      return snoise;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 3D noise — the `noise_field` value's CPU evaluators (081026 spec M6.5)
// ═══════════════════════════════════════════════════════════════════════
//
// True 3D lattice/gradient noise for world-space consumers (Instance
// Transform's noise weight; Displace later). These are NOT bit-mirrors of
// the 2D GLSL — nothing overlays a shader render (the voronoi pcg3d rule
// doesn't apply), they just need to be deterministic, seeded, and in the
// same visual family. All return roughly [-1, 1].

// Deterministic integer-lattice hash → [0, 1). Same sin-fract recipe as
// the 2D hashes above.
function hash13(ix: number, iy: number, iz: number): number {
  const n = Math.sin(ix * 12.9898 + iy * 78.233 + iz * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

const GRAD3: [number, number, number][] = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

function grad3Dot(
  ix: number,
  iy: number,
  iz: number,
  dx: number,
  dy: number,
  dz: number
): number {
  const g = GRAD3[(hash13(ix, iy, iz) * 12) | 0];
  return g[0] * dx + g[1] * dy + g[2] * dz;
}

// Classic (improved) Perlin, quintic fade — 3D analog of cnoise.
export function cnoise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const n000 = grad3Dot(ix, iy, iz, fx, fy, fz);
  const n100 = grad3Dot(ix + 1, iy, iz, fx - 1, fy, fz);
  const n010 = grad3Dot(ix, iy + 1, iz, fx, fy - 1, fz);
  const n110 = grad3Dot(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz);
  const n001 = grad3Dot(ix, iy, iz + 1, fx, fy, fz - 1);
  const n101 = grad3Dot(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1);
  const n011 = grad3Dot(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1);
  const n111 = grad3Dot(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1);
  const nx00 = lerp(n000, n100, u);
  const nx10 = lerp(n010, n110, u);
  const nx01 = lerp(n001, n101, u);
  const nx11 = lerp(n011, n111, u);
  const nxy0 = lerp(nx00, nx10, v);
  const nxy1 = lerp(nx01, nx11, v);
  // Gradient dot ranges cover ~[-√2·0.75, +√2·0.75]; the classic ~0.9
  // scale lands output in [-1, 1] territory.
  return lerp(nxy0, nxy1, w) * 0.9;
}

// 3D simplex (Gustavson-style skew/unskew) — 3D analog of snoise.
const F3 = 1 / 3;
const G3 = 1 / 6;
export function snoise3(x: number, y: number, z: number): number {
  const s = (x + y + z) * F3;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const k = Math.floor(z + s);
  const t = (i + j + k) * G3;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const z0 = z - (k - t);
  // Rank the components to pick the simplex traversal order.
  let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }
  const x1 = x0 - i1 + G3;
  const y1 = y0 - j1 + G3;
  const z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2 * G3;
  const y2 = y0 - j2 + 2 * G3;
  const z2 = z0 - k2 + 2 * G3;
  const x3 = x0 - 1 + 3 * G3;
  const y3 = y0 - 1 + 3 * G3;
  const z3 = z0 - 1 + 3 * G3;
  let n = 0;
  let tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (tt > 0) {
    tt *= tt;
    n += tt * tt * grad3Dot(i, j, k, x0, y0, z0);
  }
  tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
  if (tt > 0) {
    tt *= tt;
    n += tt * tt * grad3Dot(i + i1, j + j1, k + k1, x1, y1, z1);
  }
  tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
  if (tt > 0) {
    tt *= tt;
    n += tt * tt * grad3Dot(i + i2, j + j2, k + k2, x2, y2, z2);
  }
  tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
  if (tt > 0) {
    tt *= tt;
    n += tt * tt * grad3Dot(i + 1, j + 1, k + 1, x3, y3, z3);
  }
  return 32 * n;
}

// Hashed-lattice value noise, trilinear with quintic fade — 3D vnoise.
export function vnoise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const n000 = hash13(ix, iy, iz);
  const n100 = hash13(ix + 1, iy, iz);
  const n010 = hash13(ix, iy + 1, iz);
  const n110 = hash13(ix + 1, iy + 1, iz);
  const n001 = hash13(ix, iy, iz + 1);
  const n101 = hash13(ix + 1, iy, iz + 1);
  const n011 = hash13(ix, iy + 1, iz + 1);
  const n111 = hash13(ix + 1, iy + 1, iz + 1);
  const nx00 = lerp(n000, n100, u);
  const nx10 = lerp(n010, n110, u);
  const nx01 = lerp(n001, n101, u);
  const nx11 = lerp(n011, n111, u);
  return lerp(lerp(nx00, nx10, v), lerp(nx01, nx11, v), w) * 2 - 1;
}

export type NoiseFn3 = (x: number, y: number, z: number) => number;

export function noiseFn3For(type: string): NoiseFn3 {
  switch (type) {
    case "perlin":
    case "perlin-deriv":
      return cnoise3;
    case "value":
      return vnoise3;
    // simplex + the OS family + flow/curl/phasor all read as simplex in 3D.
    default:
      return snoise3;
  }
}

function fbm3At(
  fn: NoiseFn3,
  x: number,
  y: number,
  z: number,
  octaves: number,
  persistence: number,
  lacunarity: number
): number {
  let total = 0;
  let amp = 1;
  let freq = 1;
  let maxAmp = 0;
  for (let i = 0; i < octaves; i++) {
    total += fn(x * freq, y * freq, z * freq) * amp;
    maxAmp += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return total / Math.max(maxAmp, 1e-4);
}

// W-slice evolution for the 3D field — the same slice-blend mechanism the
// 2D pipeline uses (w stays a SEPARATE evolution axis; z is spatial now).
function hashOffset3(wi: number): [number, number, number] {
  if (wi === 0) return [0, 0, 0];
  const a = Math.sin(wi * 12.9898) * 43758.5453;
  const b = Math.sin(wi * 78.233) * 43758.5453;
  const c = Math.sin(wi * 37.719) * 43758.5453;
  return [
    (a - Math.floor(a)) * 1000,
    (b - Math.floor(b)) * 1000,
    (c - Math.floor(c)) * 1000,
  ];
}

export function fbm3WithW(
  fn: NoiseFn3,
  x: number,
  y: number,
  z: number,
  w: number,
  octaves: number,
  persistence: number,
  lacunarity: number
): number {
  const wi = Math.floor(w);
  let wf = w - wi;
  wf = wf * wf * (3 - 2 * wf);
  const [o0x, o0y, o0z] = hashOffset3(wi);
  if (wf === 0) {
    return fbm3At(fn, x + o0x, y + o0y, z + o0z, octaves, persistence, lacunarity);
  }
  const [o1x, o1y, o1z] = hashOffset3(wi + 1);
  const a = fbm3At(fn, x + o0x, y + o0y, z + o0z, octaves, persistence, lacunarity);
  const b = fbm3At(fn, x + o1x, y + o1y, z + o1z, octaves, persistence, lacunarity);
  return a + (b - a) * wf;
}

// Evaluate a NoiseFieldValue at a WORLD-space point → [0, 1]. One world
// unit spans `scale` noise units (isotropic — no canvas aspect here).
// Seed offsets mirror the 2D pipeline's constants (+ a third axis);
// contrast shapes around the midpoint like the image path.
export function sampleNoiseField(
  field: {
    noiseType: string;
    scale: number;
    octaves: number;
    persistence: number;
    lacunarity: number;
    offset: [number, number];
    seed: number;
    w: number;
    contrast: number;
  },
  x: number,
  y: number,
  z: number
): number {
  const fn = noiseFn3For(field.noiseType);
  const sx = x * field.scale + field.offset[0] + field.seed * 127.1;
  const sy = y * field.scale + field.offset[1] + field.seed * 311.7;
  const sz = z * field.scale + field.seed * 74.7;
  const n = fbm3WithW(
    fn,
    sx,
    sy,
    sz,
    field.w,
    field.octaves,
    field.persistence,
    field.lacunarity
  );
  const v = 0.5 + n * 0.5 * field.contrast;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
