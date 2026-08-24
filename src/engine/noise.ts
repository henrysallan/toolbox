// CPU implementations of the noise algorithms in nodes/source/perlin-noise.ts.
// They exist so the Noise node can produce a `value` aux output (a scalar
// noise sample at a single vec2 position) without round-tripping through a
// 1×1 framebuffer readback. The image branch still runs on the GPU.
//
// snoise / cnoise / vnoise are line-by-line ports of the GLSL functions in
// the shader file, so that what the image displays at a given UV equals
// what `value` returns when sampled at that same UV.
//
// The other algorithms in the GLSL (opensimplex / opensimplex2 / os2s /
// super-simplex / perlin-deriv / flow / curl) are not ported here; the
// value path falls back to simplex when one of those is selected. The
// noise node documents this on its description so users aren't surprised.

function mod289(x: number): number {
  return x - Math.floor(x * (1 / 289)) * 289;
}

function permute(x: number): number {
  return mod289((x * 34 + 1) * x);
}

// Ashima snoise — 2D simplex noise, returns ~[-1, 1].
export function snoise(vx: number, vy: number): number {
  const C0 = 0.211324865405187;
  const C1 = 0.366025403784439;
  const C2 = -0.577350269189626;
  const C3 = 0.024390243902439;

  const dotVc = (vx + vy) * C1;
  let ix = Math.floor(vx + dotVc);
  let iy = Math.floor(vy + dotVc);
  const dotI = (ix + iy) * C0;
  const x0x = vx - ix + dotI;
  const x0y = vy - iy + dotI;
  const i1x = x0x > x0y ? 1 : 0;
  const i1y = x0x > x0y ? 0 : 1;
  const x12_0x = x0x + C0 - i1x;
  const x12_0y = x0y + C0 - i1y;
  const x12_1x = x0x + C2;
  const x12_1y = x0y + C2;
  ix = mod289(ix);
  iy = mod289(iy);
  const py0 = permute(iy);
  const py1 = permute(iy + i1y);
  const py2 = permute(iy + 1);
  const p0 = permute(py0 + ix);
  const p1 = permute(py1 + ix + i1x);
  const p2 = permute(py2 + ix + 1);

  let m0 = Math.max(0, 0.5 - (x0x * x0x + x0y * x0y));
  let m1 = Math.max(0, 0.5 - (x12_0x * x12_0x + x12_0y * x12_0y));
  let m2 = Math.max(0, 0.5 - (x12_1x * x12_1x + x12_1y * x12_1y));
  m0 *= m0;
  m0 *= m0;
  m1 *= m1;
  m1 *= m1;
  m2 *= m2;
  m2 *= m2;

  const xv0 = 2 * (p0 * C3 - Math.floor(p0 * C3)) - 1;
  const xv1 = 2 * (p1 * C3 - Math.floor(p1 * C3)) - 1;
  const xv2 = 2 * (p2 * C3 - Math.floor(p2 * C3)) - 1;
  const h0 = Math.abs(xv0) - 0.5;
  const h1 = Math.abs(xv1) - 0.5;
  const h2 = Math.abs(xv2) - 0.5;
  const a00 = xv0 - Math.floor(xv0 + 0.5);
  const a01 = xv1 - Math.floor(xv1 + 0.5);
  const a02 = xv2 - Math.floor(xv2 + 0.5);

  m0 *= 1.79284291400159 - 0.85373472095314 * (a00 * a00 + h0 * h0);
  m1 *= 1.79284291400159 - 0.85373472095314 * (a01 * a01 + h1 * h1);
  m2 *= 1.79284291400159 - 0.85373472095314 * (a02 * a02 + h2 * h2);

  const g0 = a00 * x0x + h0 * x0y;
  const g1 = a01 * x12_0x + h1 * x12_0y;
  const g2 = a02 * x12_1x + h2 * x12_1y;
  return 130.0 * (m0 * g0 + m1 * g1 + m2 * g2);
}

// Permute used by cnoise — 2D Perlin (Ashima cnoise). The shader uses
// mod(Pi, 289.0); JS modulo on negatives gives wrong sign, so wrap
// explicitly.
function mod289Pos(x: number): number {
  const r = x % 289;
  return r < 0 ? r + 289 : r;
}
function permute289(x: number): number {
  return mod289Pos((x * 34 + 1) * x);
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// Improved Perlin (cnoise), returns ~[-1, 1].
export function cnoise(Px: number, Py: number): number {
  const Pi0x = Math.floor(Px);
  const Pi0y = Math.floor(Py);
  const Pi1x = Pi0x + 1;
  const Pi1y = Pi0y + 1;
  const Pf0x = Px - Pi0x;
  const Pf0y = Py - Pi0y;
  const Pf1x = Pf0x - 1;
  const Pf1y = Pf0y - 1;
  const i00 = mod289Pos(Pi0x);
  const i01 = mod289Pos(Pi0y);
  const i10 = mod289Pos(Pi1x);
  const i11 = mod289Pos(Pi1y);

  // ix = (Pi.x, Pi.z, Pi.x, Pi.z) = (i00, i10, i00, i10)
  // iy = (Pi.y, Pi.y, Pi.w, Pi.w) = (i01, i01, i11, i11)
  const ii0 = permute289(permute289(i00) + i01);
  const ii1 = permute289(permute289(i10) + i01);
  const ii2 = permute289(permute289(i00) + i11);
  const ii3 = permute289(permute289(i10) + i11);

  const inv41 = 1 / 41;
  const gx0a = 2 * (ii0 * inv41 - Math.floor(ii0 * inv41)) - 1;
  const gx1a = 2 * (ii1 * inv41 - Math.floor(ii1 * inv41)) - 1;
  const gx2a = 2 * (ii2 * inv41 - Math.floor(ii2 * inv41)) - 1;
  const gx3a = 2 * (ii3 * inv41 - Math.floor(ii3 * inv41)) - 1;
  const gy0 = Math.abs(gx0a) - 0.5;
  const gy1 = Math.abs(gx1a) - 0.5;
  const gy2 = Math.abs(gx2a) - 0.5;
  const gy3 = Math.abs(gx3a) - 0.5;
  // gx -= floor(gx + 0.5)
  const gx0 = gx0a - Math.floor(gx0a + 0.5);
  const gx1 = gx1a - Math.floor(gx1a + 0.5);
  const gx2 = gx2a - Math.floor(gx2a + 0.5);
  const gx3 = gx3a - Math.floor(gx3a + 0.5);
  const n0 = 1.79284291400159 - 0.85373472095314 * (gx0 * gx0 + gy0 * gy0);
  const n1 = 1.79284291400159 - 0.85373472095314 * (gx1 * gx1 + gy1 * gy1);
  const n2 = 1.79284291400159 - 0.85373472095314 * (gx2 * gx2 + gy2 * gy2);
  const n3 = 1.79284291400159 - 0.85373472095314 * (gx3 * gx3 + gy3 * gy3);

  const g00x = gx0 * n0;
  const g00y = gy0 * n0;
  const g10x = gx1 * n1;
  const g10y = gy1 * n1;
  const g01x = gx2 * n2;
  const g01y = gy2 * n2;
  const g11x = gx3 * n3;
  const g11y = gy3 * n3;

  const n00 = g00x * Pf0x + g00y * Pf0y;
  const n10 = g10x * Pf1x + g10y * Pf0y;
  const n01 = g01x * Pf0x + g01y * Pf1y;
  const n11 = g11x * Pf1x + g11y * Pf1y;

  const fx = fade(Pf0x);
  const fy = fade(Pf0y);
  const nx0 = n00 + (n10 - n00) * fx;
  const nx1 = n01 + (n11 - n01) * fx;
  return 2.3 * (nx0 + (nx1 - nx0) * fy);
}

// Hash for value-noise (Dave_Hoskins-style). Match the GLSL hash12 line by line;
// note that p3.z aliases p3.x because the shader does `vec3(p.xyx)`.
function hash12(px: number, py: number): number {
  const sx = px * 0.1031;
  const sy = py * 0.1031;
  let p3x = sx - Math.floor(sx);
  let p3y = sy - Math.floor(sy);
  let p3z = sx - Math.floor(sx);
  const d =
    p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33);
  p3x += d;
  p3y += d;
  p3z += d;
  const v = (p3x + p3y) * p3z;
  return v - Math.floor(v);
}

// Cubic-interpolated value noise, returns ~[-1, 1].
export function vnoise(Px: number, Py: number): number {
  const ix = Math.floor(Px);
  const iy = Math.floor(Py);
  const fx = Px - ix;
  const fy = Py - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash12(ix, iy);
  const b = hash12(ix + 1, iy);
  const c = hash12(ix, iy + 1);
  const d = hash12(ix + 1, iy + 1);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return (ab + (cd - ab) * uy) * 2 - 1;
}

export type NoiseFn = (px: number, py: number) => number;

// fBm wrapper — same semantics as the GLSL `fbmAt`.
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
  for (let i = 0; i < octaves; i++) {
    total += fn(px * freq, py * freq) * amp;
    maxAmp += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return total / Math.max(maxAmp, 1e-4);
}

// Match the GLSL hashOffset for W-slice blending.
function hashOffset(wi: number): [number, number] {
  if (wi === 0) return [0, 0];
  const a = Math.sin(wi * 12.9898) * 43758.5453;
  const b = Math.sin(wi * 78.233) * 43758.5453;
  const fa = a - Math.floor(a);
  const fb = b - Math.floor(b);
  return [fa * 1000, fb * 1000];
}

// fBm with W-slice evolution. Mirrors the GLSL `fbm()` wrapper.
export function fbmWithW(
  fn: NoiseFn,
  px: number,
  py: number,
  w: number,
  octaves: number,
  persistence: number,
  lacunarity: number
): number {
  const wi = Math.floor(w);
  let wf = w - wi;
  wf = wf * wf * (3 - 2 * wf);
  const [o0x, o0y] = hashOffset(wi);
  if (wf === 0) {
    return fbmAt(fn, px + o0x, py + o0y, octaves, persistence, lacunarity);
  }
  const [o1x, o1y] = hashOffset(wi + 1);
  const a = fbmAt(fn, px + o0x, py + o0y, octaves, persistence, lacunarity);
  const b = fbmAt(fn, px + o1x, py + o1y, octaves, persistence, lacunarity);
  return a + (b - a) * wf;
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

export function noiseFnFor(type: string): NoiseFn {
  switch (type) {
    case "perlin":
      return cnoise;
    case "value":
      return vnoise;
    case "simplex":
      return snoise;
    // OS family / perlin-deriv / flow / curl — fall back to simplex on the
    // value path (the GLSL implementations of those aren't ported to JS yet).
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
    // simplex + the OS family + flow/curl all read as simplex in 3D.
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
