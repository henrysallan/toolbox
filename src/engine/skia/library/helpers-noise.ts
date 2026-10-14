// SkSL helpers for the noise & fields family (specdocs/101326_skia-target.md
// §7 Wave 2, family 1): the ten NOISE_FS algorithms helpers.ts does not
// already hold, the looping-evolution phase, and the float cell hash the
// hashed generators use instead of the GL nodes' uint PCG hashes.
// Registered on import (src/nodes/skia/noise.ts, shape-cells.ts).
//
// Ports, statement for statement, from NOISE_FS (src/nodes/source/perlin-noise.ts):
//   tbx.noise.perlin2d       cnoise + fade2 (Ashima improved Perlin)
//   tbx.noise.value2d        vnoise (hash12 is helpers.ts tbx_hash12)
//   tbx.noise.opensimplex2d  osNoise
//   tbx.noise.os2f2d         os2Noise ("fast")
//   tbx.noise.os2s2d         os2sNoise ("smooth", 6-point)
//   tbx.noise.ss2d           ssNoise (Super Simplex, 5-point)
//   tbx.noise.deriv2d        perlinDeriv → (value, ∂x, ∂y)
//   tbx.noise.flow2d         flowNoise(p, t)
//   tbx.noise.phasor2d       phasorNoise, with the phasor uniforms as args
//   tbx.noise.loop           loopEvolutionPhase (src/engine/noise.ts)
// hashGrad / phasorHash22 are helpers.ts tbx_hash_grad2 / tbx_hash_sin22
// (same constants); phasorHash22b is private here. The OS family's skew
// constants (OS_F / OS_G) are inlined as literals, as in the GL source.
//
// The float cell hash (tbx.noise.cellhash): NOT a port. Shape Cells hashes
// each cell with a uint PCG round (`hash44` in SHAPE_CELLS_FS); Skia's
// strict ES2 has no uint, xor or shifts, so the Skia version uses Dave
// Hoskins' "Hash without Sine" 4→4 variant (MIT, the same family as
// tbx_hash12 / NOISE_FS hash12) on float4(cell.x, cell.y, seed, 0). Every
// per-cell choice (shape, copy count, base hue, phase) therefore differs
// from the GL node for the same seed — the layout is a different random
// draw of the same distribution, deterministic per seed. Precision holds
// for |inputs| ≲ 1e4 in fp32 (cells ≤ 64, seed ≤ 9999).
//
// Naming: every function starts `tbx_noise2_` (or `tbx_noise_slice…`
// from helpers.ts), none starts with a library entry name.

import { registerSkslHelper } from "./registry";
import "./helpers";

registerSkslHelper({
  id: "tbx.noise.perlin2d",
  uses: ["tbx.noise.permute"],
  source: `float2 tbx_noise2_fade(float2 t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}
float tbx_noise2_perlin(float2 P) {
  float4 Pi = floor(P.xyxy) + float4(0.0, 0.0, 1.0, 1.0);
  float4 Pf = fract(P.xyxy) - float4(0.0, 0.0, 1.0, 1.0);
  Pi = mod(Pi, 289.0);
  float4 ix = Pi.xzxz;
  float4 iy = Pi.yyww;
  float4 fx = Pf.xzxz;
  float4 fy = Pf.yyww;
  float4 ii = tbx_permute4(tbx_permute4(ix) + iy);
  float4 gx = 2.0 * fract(ii * (1.0 / 41.0)) - 1.0;
  float4 gy = abs(gx) - 0.5;
  float4 tx = floor(gx + 0.5);
  gx = gx - tx;
  float2 g00 = float2(gx.x, gy.x);
  float2 g10 = float2(gx.y, gy.y);
  float2 g01 = float2(gx.z, gy.z);
  float2 g11 = float2(gx.w, gy.w);
  float4 norm = 1.79284291400159 - 0.85373472095314 *
    float4(dot(g00, g00), dot(g01, g01), dot(g10, g10), dot(g11, g11));
  g00 *= norm.x; g01 *= norm.y; g10 *= norm.z; g11 *= norm.w;
  float n00 = dot(g00, float2(fx.x, fy.x));
  float n10 = dot(g10, float2(fx.y, fy.y));
  float n01 = dot(g01, float2(fx.z, fy.z));
  float n11 = dot(g11, float2(fx.w, fy.w));
  float2 f = tbx_noise2_fade(Pf.xy);
  float2 n_x = mix(float2(n00, n01), float2(n10, n11), f.x);
  return 2.3 * mix(n_x.x, n_x.y, f.y);
}`,
});

registerSkslHelper({
  id: "tbx.noise.value2d",
  uses: ["tbx.hash"],
  source: `float tbx_noise2_value(float2 P) {
  float2 i = floor(P);
  float2 f = fract(P);
  float2 u = f * f * (3.0 - 2.0 * f);
  float a = tbx_hash12(i);
  float b = tbx_hash12(i + float2(1.0, 0.0));
  float c = tbx_hash12(i + float2(0.0, 1.0));
  float d = tbx_hash12(i + float2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}`,
});

registerSkslHelper({
  id: "tbx.noise.opensimplex2d",
  uses: ["tbx.hash.sin"],
  source: `float tbx_noise2_os(float2 p) {
  float2 skewed = p + (p.x + p.y) * 0.366025403784439;
  float2 i0 = floor(skewed);
  float2 f0 = skewed - i0;
  float2 o1 = (f0.x > f0.y) ? float2(1.0, 0.0) : float2(0.0, 1.0);
  float2 i1 = i0 + o1;
  float2 i2 = i0 + float2(1.0);
  float2 p0 = p - (i0 - (i0.x + i0.y) * 0.211324865405187);
  float2 p1 = p - (i1 - (i1.x + i1.y) * 0.211324865405187);
  float2 p2 = p - (i2 - (i2.x + i2.y) * 0.211324865405187);
  float t0 = 0.5 - dot(p0, p0);
  float t1 = 0.5 - dot(p1, p1);
  float t2 = 0.5 - dot(p2, p2);
  t0 = max(t0, 0.0); t1 = max(t1, 0.0); t2 = max(t2, 0.0);
  t0 *= t0; t0 *= t0;
  t1 *= t1; t1 *= t1;
  t2 *= t2; t2 *= t2;
  float n0 = t0 * dot(tbx_hash_grad2(i0), p0);
  float n1 = t1 * dot(tbx_hash_grad2(i1), p1);
  float n2 = t2 * dot(tbx_hash_grad2(i2), p2);
  return 60.0 * (n0 + n1 + n2);
}`,
});

registerSkslHelper({
  id: "tbx.noise.os2f2d",
  uses: ["tbx.hash.sin"],
  source: `float tbx_noise2_os2f(float2 p) {
  float2 skewed = p + (p.x + p.y) * 0.366025403784439;
  float2 i0 = floor(skewed);
  float2 f0 = skewed - i0;
  bool aboveDiag = f0.x > f0.y;
  float2 o1 = aboveDiag ? float2(1.0, 0.0) : float2(0.0, 1.0);
  float2 o3 = aboveDiag ? float2(0.0, 1.0) : float2(1.0, 0.0);
  float2 i1 = i0 + o1;
  float2 i2 = i0 + float2(1.0);
  float2 i3 = i0 + o3;
  float2 p0 = p - (i0 - (i0.x + i0.y) * 0.211324865405187);
  float2 p1 = p - (i1 - (i1.x + i1.y) * 0.211324865405187);
  float2 p2 = p - (i2 - (i2.x + i2.y) * 0.211324865405187);
  float2 p3 = p - (i3 - (i3.x + i3.y) * 0.211324865405187);
  float r = 0.6;
  float t0 = max(r - dot(p0, p0), 0.0);
  float t1 = max(r - dot(p1, p1), 0.0);
  float t2 = max(r - dot(p2, p2), 0.0);
  float t3 = max(r - dot(p3, p3), 0.0);
  t0 *= t0 * t0 * t0;
  t1 *= t1 * t1 * t1;
  t2 *= t2 * t2 * t2;
  t3 *= t3 * t3 * t3;
  float n0 = t0 * dot(tbx_hash_grad2(i0), p0);
  float n1 = t1 * dot(tbx_hash_grad2(i1), p1);
  float n2 = t2 * dot(tbx_hash_grad2(i2), p2);
  float n3 = t3 * dot(tbx_hash_grad2(i3), p3);
  return 32.0 * (n0 + n1 + n2 + n3);
}`,
});

// Local arrays assigned by constant index and read by the loop index are
// strict-ES2 legal, so the six-offset loop stays as written.
registerSkslHelper({
  id: "tbx.noise.os2s2d",
  uses: ["tbx.hash.sin"],
  source: `float tbx_noise2_os2s(float2 p) {
  float2 skewed = p + (p.x + p.y) * 0.366025403784439;
  float2 i0 = floor(skewed);
  float2 offsets[6];
  offsets[0] = float2(0.0, 0.0);
  offsets[1] = float2(1.0, 0.0);
  offsets[2] = float2(0.0, 1.0);
  offsets[3] = float2(1.0, 1.0);
  offsets[4] = float2(-1.0, 1.0);
  offsets[5] = float2(1.0, -1.0);
  float total = 0.0;
  float r = 2.0 / 3.0;
  for (int k = 0; k < 6; k++) {
    float2 ik = i0 + offsets[k];
    float2 pk = p - (ik - (ik.x + ik.y) * 0.211324865405187);
    float t = max(r - dot(pk, pk), 0.0);
    t *= t; t *= t;
    total += t * dot(tbx_hash_grad2(ik), pk);
  }
  return 18.5 * total;
}`,
});

registerSkslHelper({
  id: "tbx.noise.ss2d",
  uses: ["tbx.hash.sin"],
  source: `float tbx_noise2_ss(float2 p) {
  float2 skewed = p + (p.x + p.y) * 0.366025403784439;
  float2 i0 = floor(skewed);
  float2 f0 = skewed - i0;
  bool aboveDiag = f0.x > f0.y;
  float2 o1 = aboveDiag ? float2(1.0, 0.0) : float2(0.0, 1.0);
  float2 o2 = aboveDiag ? float2(1.0, -1.0) : float2(-1.0, 1.0);
  float2 offsets[5];
  offsets[0] = float2(0.0);
  offsets[1] = o1;
  offsets[2] = float2(1.0);
  offsets[3] = o2;
  offsets[4] = aboveDiag ? float2(2.0, 0.0) : float2(0.0, 2.0);
  float total = 0.0;
  float r = 0.75;
  for (int k = 0; k < 5; k++) {
    float2 ik = i0 + offsets[k];
    float2 pk = p - (ik - (ik.x + ik.y) * 0.211324865405187);
    float t = max(r - dot(pk, pk), 0.0);
    t *= t; t *= t;
    total += t * dot(tbx_hash_grad2(ik), pk);
  }
  return 20.0 * total;
}`,
});

registerSkslHelper({
  id: "tbx.noise.deriv2d",
  uses: ["tbx.hash.sin"],
  source: `float3 tbx_noise2_deriv(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  float2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float2 ga = tbx_hash_grad2(i + float2(0.0, 0.0));
  float2 gb = tbx_hash_grad2(i + float2(1.0, 0.0));
  float2 gc = tbx_hash_grad2(i + float2(0.0, 1.0));
  float2 gd = tbx_hash_grad2(i + float2(1.0, 1.0));
  float va = dot(ga, f - float2(0.0, 0.0));
  float vb = dot(gb, f - float2(1.0, 0.0));
  float vc = dot(gc, f - float2(0.0, 1.0));
  float vd = dot(gd, f - float2(1.0, 1.0));
  float value = va
    + u.x * (vb - va)
    + u.y * (vc - va)
    + u.x * u.y * (va - vb - vc + vd);
  float2 deriv =
    ga
    + u.x * (gb - ga)
    + u.y * (gc - ga)
    + u.x * u.y * (ga - gb - gc + gd)
    + du * float2(
        u.y * (va - vb - vc + vd) + (vb - va),
        u.x * (va - vb - vc + vd) + (vc - va)
      );
  return float3(value, deriv);
}`,
});

registerSkslHelper({
  id: "tbx.noise.flow2d",
  source: `float tbx_noise2_flow(float2 p, float t) {
  float2 i = floor(p);
  float2 f = fract(p);
  float2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float ta = fract(sin(dot(i, float2(127.1, 311.7))) * 43758.5) * 6.2831853;
  float tb = fract(sin(dot(i + float2(1.0, 0.0), float2(127.1, 311.7))) * 43758.5) * 6.2831853;
  float tc = fract(sin(dot(i + float2(0.0, 1.0), float2(127.1, 311.7))) * 43758.5) * 6.2831853;
  float td = fract(sin(dot(i + float2(1.0, 1.0), float2(127.1, 311.7))) * 43758.5) * 6.2831853;
  float2 ga = float2(cos(ta + t), sin(ta + t));
  float2 gb = float2(cos(tb + t), sin(tb + t));
  float2 gc = float2(cos(tc + t), sin(tc + t));
  float2 gd = float2(cos(td + t), sin(td + t));
  float va = dot(ga, f - float2(0.0, 0.0));
  float vb = dot(gb, f - float2(1.0, 0.0));
  float vc = dot(gc, f - float2(0.0, 1.0));
  float vd = dot(gd, f - float2(1.0, 1.0));
  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y);
}`,
});

// orient is radians (the node's degrees param arrives scaled by π/180).
registerSkslHelper({
  id: "tbx.noise.phasor2d",
  uses: ["tbx.hash.sin"],
  source: `float2 tbx_noise2_phasor_hash22b(float2 p) {
  float2 h = float2(dot(p, float2(419.2, 371.9)), dot(p, float2(183.3, 251.7)));
  return fract(sin(h) * 43758.5453123);
}
float tbx_noise2_phasor(float2 p, float freq, float orient, float isotropy) {
  float2 ip = floor(p);
  float2 fp = fract(p);
  float2 acc = float2(0.0);
  const float PI = 3.141592653589793;
  const float TAU = 6.283185307179586;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      float2 g = float2(float(i), float(j));
      float2 cell = ip + g;
      float2 h0 = tbx_hash_sin22(cell);
      float2 h1 = tbx_noise2_phasor_hash22b(cell);
      float2 r = g + h0 - fp;
      float d2 = dot(r, r);
      if (d2 < 1.0) {
        float w = (0.5 + 0.5 * cos(PI * d2)) * exp(-PI * d2);
        float ori = orient + PI * isotropy * (h1.x * 2.0 - 1.0);
        float2 dir = float2(cos(ori), sin(ori));
        float ang = TAU * (freq * dot(r, dir) + h1.y);
        acc += w * float2(cos(ang), sin(ang));
      }
    }
  }
  float mag = length(acc);
  if (mag < 1e-5) return 0.0;
  return acc.x / mag;
}`,
});

// engine/noise.ts loopEvolutionPhase: where `frame` sits in the closed loop
// [start, end] frames, wrapped to [0, 1); 0 for a degenerate window.
registerSkslHelper({
  id: "tbx.noise.loop",
  source: `float tbx_noise2_loop_phase(float frame, float start, float end) {
  float period = end - start;
  if (period <= 0.0) return 0.0;
  return fract((frame - start) / period);
}`,
});

// Hoskins "Hash without Sine" hash44 (MIT): float4 lattice point → four
// independent floats in [0, 1). See the header for why it replaces PCG.
registerSkslHelper({
  id: "tbx.noise.cellhash",
  source: `float4 tbx_noise2_cellhash(float4 p4) {
  p4 = fract(p4 * float4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}`,
});
