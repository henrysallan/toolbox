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
