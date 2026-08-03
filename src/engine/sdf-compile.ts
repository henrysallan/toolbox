// SDF + Position AST → GLSL compiler.
//
// Two parallel pipelines:
//   - Position: each PositionNode emits a `vec2` GLSL expression that
//     transforms the per-pixel canvas UV. Domain operators (Translate,
//     Scale, Rotate, Repeat, Mirror, Polar, Twist) live here.
//   - SDF: each SdfNode emits a `float` GLSL expression for the signed
//     distance. Shape primitives carry their own PositionNode (default
//     canvasUv) and emit `shapeFn(positionExpr, ...)`. Combiners and
//     modifiers stay distance-only.
//
// The Rasterize-family nodes call `compileSdf(root, mode)` once to get
// the fragment shader source + the flat uniform-binding list. The
// shader source depends only on the *structure* of the tree (kinds,
// not parameter values), so the engine's existing shader cache reuses
// the compiled program across param changes — only the uniform values
// get rebound each frame.

import type { PositionNode, ScalarFieldNode, SdfNode } from "./types";

export type SdfUniformType = "float" | "vec2" | "vec3" | "sampler2D";
export interface SdfUniform {
  name: string;
  type: SdfUniformType;
  value:
    | number
    | [number, number]
    | [number, number, number]
    | WebGLTexture;
}

interface EmitState {
  uniforms: SdfUniform[];
  helpers: Set<HelperKey>;
  // Emitted-expression memos, keyed on AST node OBJECT identity. Two
  // things need them:
  //
  //  - The Surf emitter delegates every leaf's distance to `emitSdf`, so
  //    a mode that emits both (bevel: struct at the centre, float at the
  //    four neighbour taps) reuses one set of leaf uniforms instead of
  //    allocating a second copy of every shape parameter.
  //  - A subtree wired into two places — a position chain branched
  //    across several shapes, which the SDF nodes' docs actively
  //    encourage — emits once rather than once per consumer.
  //
  // Memoizing the STRING is what makes this safe: the expression is
  // re-inlined at each use site, so operators that read the ambient
  // `p` (displace, and the bevel body's neighbour taps, which reassign
  // `p` between evaluations) still see the right coordinate.
  sdfMemo: Map<SdfNode, string>;
  posMemo: Map<PositionNode, string>;
  // Uniform memo for nodes the expression memos can't cover. Leaves are
  // deduped by `sdfMemo` (one emitted string, one set of uniforms), but
  // combiners and modifiers emit DIFFERENT expressions in the two
  // pipelines — `smin(a,b,k)` vs `sSmoothUnion(a,b,k)` — so a bevel
  // (which needs both walks) would otherwise mint `k` twice. That is
  // merely wasteful for floats and genuinely costly for Displace, whose
  // sampler would burn a second texture unit on the same texture.
  // Keyed on (node, slot).
  uniformMemo: Map<SdfNode, Map<string, string>>;
}

type HelperKey =
  // Position helpers
  | "scalePos"
  | "rotatePos"
  | "repeatPos"
  | "repeatBoundedPos"
  | "cellIdPos"
  | "polarPos"
  | "twistPos"
  // SDF distance helpers
  | "smin"
  | "smax"
  | "rectSdf"
  | "segSdf"
  | "polySdf"
  | "triSdf"
  | "starSdf"
  | "splineSdf"
  // Scalar field helpers
  | "snoise"
  | "snoiseFbm";

const HELPERS: Record<HelperKey, string> = {
  // ── Position helpers ────────────────────────────────────────────
  // Scale around a pivot. Inverse: divide by scale (because we're
  // transforming the *sample* position, not the shape).
  scalePos: `vec2 posScale(vec2 p, vec2 s, vec2 c) {
  return c + (p - c) / max(s, vec2(1e-4));
}`,
  // Rotate the sample position by -angle (inverse of rotating the shape).
  rotatePos: `vec2 posRotate(vec2 p, float ang, vec2 c) {
  vec2 q = p - c;
  float ca = cos(-ang);
  float sa = sin(-ang);
  return c + vec2(ca * q.x - sa * q.y, sa * q.x + ca * q.y);
}`,
  // Infinite tile-fold with optional per-cell jitter on rotation,
  // position, and scale. Each cell hashes its integer ID four ways
  // and uses those hashes to perturb the local coordinate inside the
  // tile. When all jitter values are 0 the helper degenerates to a
  // plain tile fold (the conditional is uniform across pixels — GPU
  // handles it efficiently).
  repeatPos: `vec2 posRepeat(vec2 p, vec2 spacing, vec2 center, float rotJ, vec2 posJ, float sclJ, float seed) {
  vec2 q = p - center;
  vec2 s = max(spacing, vec2(1e-4));
  vec2 id = round(q / s);
  vec2 ql = q - s * id;
  if (rotJ != 0.0 || posJ.x != 0.0 || posJ.y != 0.0 || sclJ != 0.0) {
    float h1 = fract(sin(dot(id, vec2(127.1, 311.7)) + seed) * 43758.5453);
    float h2 = fract(sin(dot(id, vec2(269.5, 183.3)) + seed * 7.0) * 43758.5453);
    float h3 = fract(sin(dot(id, vec2(113.5, 271.9)) + seed * 13.0) * 43758.5453);
    float h4 = fract(sin(dot(id, vec2(213.7, 71.5)) + seed * 19.0) * 43758.5453);
    float scl = 1.0 + (h4 - 0.5) * 2.0 * sclJ;
    ql /= max(scl, 0.01);
    float ang = (h1 - 0.5) * 2.0 * rotJ;
    float ca = cos(-ang);
    float sa = sin(-ang);
    ql = vec2(ca * ql.x - sa * ql.y, sa * ql.x + ca * ql.y);
    ql -= vec2((h2 - 0.5) * 2.0 * posJ.x, (h3 - 0.5) * 2.0 * posJ.y);
  }
  return center + ql;
}`,
  // Bounded tile-fold: clamps cell index so tiling only happens inside
  // (-limit, +limit) cells. Same per-cell jitter as the infinite variant.
  repeatBoundedPos: `vec2 posRepeatBounded(vec2 p, vec2 spacing, vec2 center, vec2 limits, float rotJ, vec2 posJ, float sclJ, float seed) {
  vec2 q = p - center;
  vec2 s = max(spacing, vec2(1e-4));
  vec2 id = round(q / s);
  id = clamp(id, -limits, limits);
  vec2 ql = q - s * id;
  if (rotJ != 0.0 || posJ.x != 0.0 || posJ.y != 0.0 || sclJ != 0.0) {
    float h1 = fract(sin(dot(id, vec2(127.1, 311.7)) + seed) * 43758.5453);
    float h2 = fract(sin(dot(id, vec2(269.5, 183.3)) + seed * 7.0) * 43758.5453);
    float h3 = fract(sin(dot(id, vec2(113.5, 271.9)) + seed * 13.0) * 43758.5453);
    float h4 = fract(sin(dot(id, vec2(213.7, 71.5)) + seed * 19.0) * 43758.5453);
    float scl = 1.0 + (h4 - 0.5) * 2.0 * sclJ;
    ql /= max(scl, 0.01);
    float ang = (h1 - 0.5) * 2.0 * rotJ;
    float ca = cos(-ang);
    float sa = sin(-ang);
    ql = vec2(ca * ql.x - sa * ql.y, sa * ql.x + ca * ql.y);
    ql -= vec2((h2 - 0.5) * 2.0 * posJ.x, (h3 - 0.5) * 2.0 * posJ.y);
  }
  return center + ql;
}`,
  // Per-pixel cell ID for a Repeat-style fold. Returns the integer
  // cell index as a vec2 — constant within a tile, varies between
  // tiles. Wire as the input position to a scalar field for per-tile
  // modulation.
  cellIdPos: `vec2 posCellId(vec2 p, vec2 spacing, vec2 center) {
  vec2 q = p - center;
  vec2 s = max(spacing, vec2(1e-4));
  return round(q / s);
}`,
  // N-fold rotational symmetry around \`center\`.
  polarPos: `vec2 posPolar(vec2 p, vec2 center, float segments, float rot) {
  vec2 q = p - center;
  float r = length(q);
  float a = atan(q.y, q.x) - rot;
  float sector = 6.28318530717958 / max(segments, 1.0);
  a = mod(a + sector * 0.5, sector) - sector * 0.5;
  return center + r * vec2(cos(a + rot), sin(a + rot));
}`,
  // Spiral around \`center\` by \`strength\` radians per unit distance.
  twistPos: `vec2 posTwist(vec2 p, vec2 center, float strength) {
  vec2 q = p - center;
  float r = length(q);
  float a = atan(q.y, q.x) + r * strength;
  return center + r * vec2(cos(a), sin(a));
}`,

  // ── SDF distance helpers ────────────────────────────────────────
  smin: `float smin(float a, float b, float k) {
  if (k <= 0.0) return min(a, b);
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}`,
  smax: `float smax(float a, float b, float k) {
  if (k <= 0.0) return max(a, b);
  float h = clamp(0.5 - 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) + k * h * (1.0 - h);
}`,
  rectSdf: `float rectSdf(vec2 p, vec2 c, vec2 s, float r) {
  vec2 q = abs(p - c) - s + vec2(r);
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}`,
  segSdf: `float segSdf(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h) - r;
}`,
  polySdf: `float polySdf(vec2 p, float r, float n) {
  float an = 3.14159265358979 / n;
  float h = mod(atan(p.x, p.y), 2.0 * an) - an;
  return length(p) * cos(h) - r * cos(an);
}`,
  triSdf: `float triSdf(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / max(dot(e0, e0), 1e-6), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / max(dot(e1, e1), 1e-6), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / max(dot(e2, e2), 1e-6), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(
    vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
    vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
    vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}`,
  starSdf: `float starSdf(vec2 p, float r, float n, float m) {
  float an = 3.14159265358979 / n;
  float en = 3.14159265358979 / max(m, 2.0);
  vec2 acs = vec2(cos(an), sin(an));
  vec2 ecs = vec2(cos(en), sin(en));
  float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
  vec2 q = length(p) * vec2(cos(bn), abs(sin(bn)));
  q -= r * acs;
  q += ecs * clamp(-dot(q, ecs), 0.0, r * acs.y / max(ecs.y, 1e-6));
  return length(q) * sign(q.x);
}`,
  // Distance to a polyline / closed polygon, packed into a 1×N
  // RGBA32F texture. Each texel = vec4(ax, ay, bx, by). For closed
  // splines, sign comes from a horizontal-ray winding count; for
  // open splines, the distance is unsigned (the result acts like a
  // stroke). Loop is bounded at 1024 segments — anything more
  // gracefully truncates.
  splineSdf: `float splineSdf(vec2 p, sampler2D segs, float segCount, float closed) {
  float d = 1e10;
  int wind = 0;
  for (int i = 0; i < 1024; i++) {
    if (float(i) >= segCount) break;
    vec4 s = texelFetch(segs, ivec2(i, 0), 0);
    vec2 a = s.xy;
    vec2 b = s.zw;
    vec2 ba = b - a;
    vec2 pa = p - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    d = min(d, length(pa - ba * h));
    bool crosses = (a.y > p.y) != (b.y > p.y);
    if (crosses) {
      float xCross = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y);
      if (p.x < xCross) wind++;
    }
  }
  bool inside = closed > 0.5 && (wind - (wind / 2) * 2) == 1;
  return inside ? -d : d;
}`,

  // ── Scalar field (noise) helpers ────────────────────────────────
  // Ashima snoise — 2D simplex noise. Returns ~[-1, 1]. Matches the
  // GLSL in src/nodes/source/perlin-noise.ts so a position-fed SDF
  // Noise sampled at canvas UV gives the same result as the Noise
  // image source at that pixel.
  snoise: `vec3 sdf_mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 sdf_mod289v2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 sdf_permute3(vec3 x) { return sdf_mod289v3(((x * 34.0) + 1.0) * x); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                      -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = sdf_mod289v2(i);
  vec3 p = sdf_permute3(
    sdf_permute3(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0)
  );
  vec3 m = max(
    0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)),
    0.0
  );
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
}`,
  // fBm wrapper around snoise. octaves capped at 8 to match the Noise
  // image source. Returns the normalized average so the output stays
  // in roughly [-1, 1] regardless of octave count.
  //
  // `w` is the 4D-evolution parameter, matched to the image-side
  // `hashOffset(w)` slice-blend so changing W in the Noise param
  // panel morphs the field through the same animation curve. The
  // wi == 0 branch is kept identical to the no-W path so projects
  // saved before W existed render unchanged.
  snoiseFbm: `vec2 snoiseHashOff(float wi) {
  if (wi == 0.0) return vec2(0.0);
  return vec2(
    fract(sin(wi * 12.9898) * 43758.5453),
    fract(sin(wi * 78.2330) * 43758.5453)
  ) * 1000.0;
}
float snoiseFbmAt(vec2 sp, int oct, float pers, float lac) {
  float total = 0.0;
  float amp = 1.0;
  float freq = 1.0;
  float maxAmp = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    total += snoise(sp * freq) * amp;
    maxAmp += amp;
    amp *= pers;
    freq *= lac;
  }
  return total / max(maxAmp, 1e-4);
}
float snoiseFbm(vec2 p, float scl, vec2 off, float seed,
                int oct, float pers, float lac, float w) {
  vec2 sp = (p - 0.5) * scl + off + vec2(seed * 127.1, seed * 311.7);
  float wi = floor(w);
  float wf = w - wi;
  wf = wf * wf * (3.0 - 2.0 * wf);
  vec2 o0 = snoiseHashOff(wi);
  if (wf == 0.0) return snoiseFbmAt(sp + o0, oct, pers, lac);
  vec2 o1 = snoiseHashOff(wi + 1.0);
  return mix(
    snoiseFbmAt(sp + o0, oct, pers, lac),
    snoiseFbmAt(sp + o1, oct, pers, lac),
    wf
  );
}`,
};

// ── The Surf pipeline ─────────────────────────────────────────────
//
// The float emitter collapses the tree to one distance, which throws
// away "which shape am I near" before anything is rendered — so no
// terminal can colour two shapes differently. The Surf emitter carries
// colour alongside distance instead:
//
//   d     signed distance, bit-identical to the float emitter's
//   c     winner-takes-all colour
//   acc   Σ colourᵢ·wᵢ  — the colour-bleed accumulator
//   accW  Σ wᵢ
//
// The load-bearing line is `r.c = mix(b.c, a.c, h)` in sSmoothUnion:
// `h` is the smin's OWN blend factor, so colour blends across exactly
// the bridge the distance blends over, driven by the same Smoothness
// knob. No new node, no new wire.
//
// `acc`/`accW` are a parallel channel only leaves write to, summed by
// the combiners. Two consequences worth knowing:
//   - A subtracted operand is a CUTTER: removed from the geometry and
//     from the wash (it would be surprising for a shape to tint the
//     hole it carved).
//   - Modifiers don't repaint. A leaf's weight comes from its own
//     distance, so a Displace/Onion above it reshapes the silhouette
//     without dragging the wash along. That is the intended reading of
//     "colour bleed PER SDF".
const SURF_DECLS = `uniform float u_bleedInv;
// 1 = interiors saturate at weight 1 (a firm colour core); 0 = weight
// keeps growing inward so the nearest shape dominates hard. Declared
// here, not with the shade uniforms, because sLeaf is shared by every
// Surf mode — rasterize/bevel simply leave it at its default, which is
// moot there since their bleedInv is 0 (every weight is exp(0) = 1).
uniform int u_bleedInside;

struct Surf { float d; vec3 c; vec3 acc; float accW; };

Surf sLeaf(float d, vec3 col, float matW, float bleedInv) {
  float dd = (u_bleedInside == 1) ? max(d, 0.0) : d;
  // Clamp the exponent: with saturate-interiors off, dd goes negative
  // and a small radius would overflow exp() to inf, poisoning accW.
  float w = matW * exp(clamp(-dd * bleedInv, -60.0, 60.0));
  return Surf(d, col, col * w, w);
}

Surf sUnion(Surf a, Surf b) {
  bool aw = a.d <= b.d;
  return Surf(aw ? a.d : b.d, aw ? a.c : b.c, a.acc + b.acc, a.accW + b.accW);
}

Surf sIntersect(Surf a, Surf b) {
  bool aw = a.d >= b.d;
  return Surf(aw ? a.d : b.d, aw ? a.c : b.c, a.acc + b.acc, a.accW + b.accW);
}

Surf sSubtract(Surf a, Surf b) {
  return Surf(max(a.d, -b.d), a.c, a.acc, a.accW);
}

Surf sSmoothUnion(Surf a, Surf b, float k) {
  float h = (k <= 0.0) ? step(a.d, b.d)
                       : clamp(0.5 + 0.5 * (b.d - a.d) / k, 0.0, 1.0);
  float d = (k <= 0.0) ? min(a.d, b.d) : mix(b.d, a.d, h) - k * h * (1.0 - h);
  return Surf(d, mix(b.c, a.c, h), a.acc + b.acc, a.accW + b.accW);
}

Surf sSmoothIntersect(Surf a, Surf b, float k) {
  float h = (k <= 0.0) ? step(b.d, a.d)
                       : clamp(0.5 - 0.5 * (b.d - a.d) / k, 0.0, 1.0);
  float d = (k <= 0.0) ? max(a.d, b.d) : mix(b.d, a.d, h) + k * h * (1.0 - h);
  return Surf(d, mix(b.c, a.c, h), a.acc + b.acc, a.accW + b.accW);
}

Surf sSmoothSubtract(Surf a, Surf b, float k) {
  float nb = -b.d;
  float h = (k <= 0.0) ? step(nb, a.d)
                       : clamp(0.5 - 0.5 * (nb - a.d) / k, 0.0, 1.0);
  float d = (k <= 0.0) ? max(a.d, nb) : mix(nb, a.d, h) + k * h * (1.0 - h);
  return Surf(d, a.c, a.acc, a.accW);
}

Surf sMorph(Surf a, Surf b, float t) {
  return Surf(mix(a.d, b.d, t), mix(a.c, b.c, t),
              mix(a.acc, b.acc, t), mix(a.accW, b.accW, t));
}

Surf sOffset(Surf s, float r) { s.d -= r; return s; }
Surf sOnion(Surf s, float t) { s.d = abs(s.d) - t; return s; }
Surf sDisplace(Surf s, float amt) { s.d += amt; return s; }`;

function newEmitState(): EmitState {
  return {
    uniforms: [],
    helpers: new Set(),
    sdfMemo: new Map(),
    posMemo: new Map(),
    uniformMemo: new Map(),
  };
}

// `alloc` with a stable (node, slot) identity, so a second walk over the
// same tree reuses the uniform the first walk minted. See EmitState.
function allocFor(
  state: EmitState,
  owner: SdfNode,
  slot: string,
  type: SdfUniformType,
  value:
    | number
    | [number, number]
    | [number, number, number]
    | WebGLTexture
): string {
  let slots = state.uniformMemo.get(owner);
  if (!slots) {
    slots = new Map();
    state.uniformMemo.set(owner, slots);
  }
  const hit = slots.get(slot);
  if (hit !== undefined) return hit;
  const name = alloc(state, type, value);
  slots.set(slot, name);
  return name;
}

function alloc(
  state: EmitState,
  type: SdfUniformType,
  value:
    | number
    | [number, number]
    | [number, number, number]
    | WebGLTexture
): string {
  const idx = state.uniforms.length;
  const name = `u_p${idx}`;
  state.uniforms.push({ name, type, value });
  return name;
}

// Position pipeline emitter. Returns a GLSL `vec2` expression that
// computes the per-pixel sample position. Default `canvasUv` returns
// the bare `p` (the canvas-UV variable in scope at the call site).
//
// Memoized on node identity: one position chain branched across several
// shapes (the pattern the SDF primitives' docs recommend) emits its
// uniforms once instead of once per consumer.
function emitPosition(node: PositionNode, state: EmitState): string {
  const memo = state.posMemo.get(node);
  if (memo !== undefined) return memo;
  const expr = emitPositionUncached(node, state);
  state.posMemo.set(node, expr);
  return expr;
}

function emitPositionUncached(node: PositionNode, state: EmitState): string {
  switch (node.kind) {
    case "canvasUv":
      return "p";
    case "translate": {
      const t = alloc(state, "vec2", [node.tx, node.ty]);
      const child = emitPosition(node.child, state);
      // Inverse: subtract the offset from the sample position so the
      // shape moves to (+offset).
      return `(${child} - ${t})`;
    }
    case "scale": {
      state.helpers.add("scalePos");
      const s = alloc(state, "vec2", [node.sx, node.sy]);
      const c = alloc(state, "vec2", [node.cx, node.cy]);
      const child = emitPosition(node.child, state);
      return `posScale(${child}, ${s}, ${c})`;
    }
    case "rotate": {
      state.helpers.add("rotatePos");
      // angle is polymorphic — scalar number → uniform; ScalarFieldNode
      // → inlined per-pixel field expression.
      const angleExpr =
        typeof node.rotation === "number"
          ? alloc(state, "float", node.rotation)
          : emitScalarField(node.rotation, state);
      const c = alloc(state, "vec2", [node.cx, node.cy]);
      const child = emitPosition(node.child, state);
      return `posRotate(${child}, ${angleExpr}, ${c})`;
    }
    case "repeat": {
      const sp = alloc(state, "vec2", [node.spacingX, node.spacingY]);
      const c = alloc(state, "vec2", [node.cx, node.cy]);
      const child = emitPosition(node.child, state);
      // Jitter uniforms are always allocated even when zero, so the
      // structural hash stays stable between "no jitter" and "some
      // jitter" — same compiled shader, just different uniform values.
      const rotJ = alloc(state, "float", node.rotJitter ?? 0);
      const posJ = alloc(state, "vec2", [
        node.posJitterX ?? 0,
        node.posJitterY ?? 0,
      ]);
      const sclJ = alloc(state, "float", node.scaleJitter ?? 0);
      const seed = alloc(state, "float", node.seed ?? 0);
      if (node.bounded) {
        state.helpers.add("repeatBoundedPos");
        const lim = alloc(state, "vec2", [node.limitX, node.limitY]);
        return `posRepeatBounded(${child}, ${sp}, ${c}, ${lim}, ${rotJ}, ${posJ}, ${sclJ}, ${seed})`;
      }
      state.helpers.add("repeatPos");
      return `posRepeat(${child}, ${sp}, ${c}, ${rotJ}, ${posJ}, ${sclJ}, ${seed})`;
    }
    case "mirror": {
      const c = alloc(state, "vec2", [node.cx, node.cy]);
      const child = emitPosition(node.child, state);
      // Inline the mirror math — cheaper than a helper for two
      // conditional abs() calls.
      if (node.axis === 1) {
        return `(${c} + vec2(abs((${child} - ${c}).x), (${child} - ${c}).y))`;
      }
      if (node.axis === 2) {
        return `(${c} + vec2((${child} - ${c}).x, abs((${child} - ${c}).y)))`;
      }
      return `(${c} + abs(${child} - ${c}))`;
    }
    case "polar": {
      state.helpers.add("polarPos");
      const c = alloc(state, "vec2", [node.cx, node.cy]);
      const seg = alloc(state, "float", node.segments);
      const rot = alloc(state, "float", node.rotation);
      const child = emitPosition(node.child, state);
      return `posPolar(${child}, ${c}, ${seg}, ${rot})`;
    }
    case "twist": {
      state.helpers.add("twistPos");
      const c = alloc(state, "vec2", [node.cx, node.cy]);
      const kExpr =
        typeof node.strength === "number"
          ? alloc(state, "float", node.strength)
          : emitScalarField(node.strength, state);
      const child = emitPosition(node.child, state);
      return `posTwist(${child}, ${c}, ${kExpr})`;
    }

    case "cellId": {
      state.helpers.add("cellIdPos");
      const sp = alloc(state, "vec2", [node.spacingX, node.spacingY]);
      const c = alloc(state, "vec2", [node.cx, node.cy]);
      const child = emitPosition(node.child, state);
      return `posCellId(${child}, ${sp}, ${c})`;
    }
  }
}

// Scalar field emitter — returns a `float` GLSL expression evaluated
// per pixel.
function emitScalarField(node: ScalarFieldNode, state: EmitState): string {
  switch (node.kind) {
    case "constant": {
      return alloc(state, "float", node.value);
    }
    case "remap": {
      const child = emitScalarField(node.child, state);
      const inMin = alloc(state, "float", node.inMin);
      const inMax = alloc(state, "float", node.inMax);
      const outMin = alloc(state, "float", node.outMin);
      const outMax = alloc(state, "float", node.outMax);
      // `t` is the [0..1] interpolation parameter; clamping is
      // baked into the structural form so the shader is identical
      // across param changes (only uniforms vary).
      const tExpr = node.clamp
        ? `clamp((${child} - ${inMin}) / max(${inMax} - ${inMin}, 1e-6), 0.0, 1.0)`
        : `((${child} - ${inMin}) / max(${inMax} - ${inMin}, 1e-6))`;
      return `(${outMin} + ${tExpr} * (${outMax} - ${outMin}))`;
    }
    case "mathOp": {
      const a = emitScalarField(node.a, state);
      const b = emitScalarField(node.b, state);
      const c = emitScalarField(node.c, state);
      let r = mathOpExpr(node.op, a, b, c, state);
      if (node.clamp) r = `clamp(${r}, 0.0, 1.0)`;
      return `(${r})`;
    }
    case "noise": {
      // For now only simplex is wired through; perlin/value can be
      // added by emitting different fbm wrappers. The position the
      // fbm samples at is the field's input position chain.
      state.helpers.add("snoise");
      state.helpers.add("snoiseFbm");
      const pos = emitPosition(node.position, state);
      const scale = alloc(state, "float", node.scale);
      const off = alloc(state, "vec2", [node.offsetX, node.offsetY]);
      const seed = alloc(state, "float", node.seed);
      const oct = alloc(state, "float", node.octaves);
      const pers = alloc(state, "float", node.persistence);
      const lac = alloc(state, "float", node.lacunarity);
      const lo = alloc(state, "float", node.outLo);
      const hi = alloc(state, "float", node.outHi);
      const w = alloc(state, "float", node.w ?? 0);
      // Raw fbm is in roughly [-1, 1]. Remap to [outLo, outHi]. The
      // shader-side "(t + 1) * 0.5" centers the raw value into [0, 1]
      // before the linear remap so lo/hi feel natural to the user
      // (white = hi, black = lo, mid-gray = midpoint).
      return `(${lo} + (${hi} - ${lo}) * ((snoiseFbm(${pos}, ${scale}, ${off}, ${seed}, int(${oct}), ${pers}, ${lac}, ${w}) + 1.0) * 0.5))`;
    }
  }
}

// Distance emitter. Each shape primitive emits a position expression
// from its own `position` field, then calls the appropriate distance
// function against it. Combiners / modifiers operate on float-typed
// sub-expressions only.
//
// Memoized on node identity — see EmitState. The Surf emitter routes
// every leaf's distance through here, so the two walks share one set of
// shape uniforms.
function emitSdf(node: SdfNode, state: EmitState): string {
  const memo = state.sdfMemo.get(node);
  if (memo !== undefined) return memo;
  const expr = emitSdfUncached(node, state);
  state.sdfMemo.set(node, expr);
  return expr;
}

function emitSdfUncached(node: SdfNode, state: EmitState): string {
  switch (node.kind) {
    case "empty":
      return "1e10";

    // Colour is not distance — the float pipeline reads straight
    // through, which is what keeps SDF to Mask / to Distance Image /
    // to Spline working unchanged on a materialed tree.
    case "material":
      return emitSdf(node.child, state);

    case "circle": {
      const pos = emitPosition(node.position, state);
      const c = alloc(state, "vec2", [node.cx, node.cy]);
      const r = alloc(state, "float", node.r);
      return `(length(${pos} - ${c}) - ${r})`;
    }

    case "rect": {
      state.helpers.add("rectSdf");
      const pos = emitPosition(node.position, state);
      const c = alloc(state, "vec2", [node.cx, node.cy]);
      const s = alloc(state, "vec2", [node.sx, node.sy]);
      const r = alloc(state, "float", node.cornerRadius);
      return `rectSdf(${pos}, ${c}, ${s}, ${r})`;
    }

    case "lineSegment": {
      state.helpers.add("segSdf");
      const pos = emitPosition(node.position, state);
      const a = alloc(state, "vec2", [node.ax, node.ay]);
      const b = alloc(state, "vec2", [node.bx, node.by]);
      const r = alloc(state, "float", node.r);
      return `segSdf(${pos}, ${a}, ${b}, ${r})`;
    }

    case "polygon": {
      state.helpers.add("polySdf");
      const pos = emitPosition(node.position, state);
      const c = alloc(state, "vec2", [node.cx, node.cy]);
      const r = alloc(state, "float", node.r);
      // Polymorphic sides — number → uniform; ScalarFieldNode →
      // inlined per-pixel field expression. `quantizeSides` rounds
      // the per-pixel value so animated transitions step through
      // clean integer side counts instead of smooth interpolations.
      let nExpr: string;
      if (typeof node.sides === "number") {
        nExpr = alloc(state, "float", node.sides);
      } else {
        const raw = emitScalarField(node.sides, state);
        nExpr = node.quantizeSides ? `max(round(${raw}), 3.0)` : raw;
      }
      return `polySdf(${pos} - ${c}, ${r}, ${nExpr})`;
    }

    case "triangle": {
      state.helpers.add("triSdf");
      const pos = emitPosition(node.position, state);
      const a = alloc(state, "vec2", [node.ax, node.ay]);
      const b = alloc(state, "vec2", [node.bx, node.by]);
      const c = alloc(state, "vec2", [node.cx, node.cy]);
      return `triSdf(${pos}, ${a}, ${b}, ${c})`;
    }

    case "star": {
      state.helpers.add("starSdf");
      const pos = emitPosition(node.position, state);
      const c = alloc(state, "vec2", [node.cx, node.cy]);
      const r = alloc(state, "float", node.r);
      const n = alloc(state, "float", node.sides);
      const m = alloc(state, "float", node.sharpness);
      return `starSdf(${pos} - ${c}, ${r}, ${n}, ${m})`;
    }

    case "splineSdf": {
      state.helpers.add("splineSdf");
      const pos = emitPosition(node.position, state);
      // The segment texture is opaque to the shader cache (textures
      // bind by uniform location at draw time). segCount and closed
      // are values that vary per spline but use the same shader.
      const segs = alloc(state, "sampler2D", node.segmentTexture);
      const segCount = alloc(state, "float", node.segCount);
      const closed = alloc(state, "float", node.closed ? 1 : 0);
      return `splineSdf(${pos}, ${segs}, ${segCount}, ${closed})`;
    }

    case "sdfFromImage": {
      const pos = emitPosition(node.position, state);
      const samp = alloc(state, "sampler2D", node.image);
      const range = alloc(state, "float", node.range);
      // JFA / canvas textures are y-up; our position pipeline is
      // y-down (canvas-UV). Flip Y at sample time so a glyph
      // rasterized at the visual top of the canvas aligns with
      // its sdf source. R channel holds normalized [0, 1] distance
      // with 0.5 = boundary; un-normalize via `(R - 0.5) * 2 * range`
      // so downstream SDF ops see canvas-UV signed distance.
      return `((texture(${samp}, vec2((${pos}).x, 1.0 - (${pos}).y)).r - 0.5) * 2.0 * ${range})`;
    }

    case "union": {
      const a = emitSdf(node.a, state);
      const b = emitSdf(node.b, state);
      return `min(${a}, ${b})`;
    }

    case "intersection": {
      const a = emitSdf(node.a, state);
      const b = emitSdf(node.b, state);
      return `max(${a}, ${b})`;
    }

    case "subtraction": {
      const a = emitSdf(node.a, state);
      const b = emitSdf(node.b, state);
      return `max(${a}, -(${b}))`;
    }

    case "smoothUnion": {
      state.helpers.add("smin");
      const a = emitSdf(node.a, state);
      const b = emitSdf(node.b, state);
      const k = allocFor(state, node, "k", "float", node.k);
      return `smin(${a}, ${b}, ${k})`;
    }

    case "smoothIntersection": {
      state.helpers.add("smax");
      const a = emitSdf(node.a, state);
      const b = emitSdf(node.b, state);
      const k = allocFor(state, node, "k", "float", node.k);
      return `smax(${a}, ${b}, ${k})`;
    }

    case "smoothSubtraction": {
      state.helpers.add("smax");
      const a = emitSdf(node.a, state);
      const b = emitSdf(node.b, state);
      const k = allocFor(state, node, "k", "float", node.k);
      return `smax(${a}, -(${b}), ${k})`;
    }

    case "morph": {
      // An empty (unwired) side degrades to a passthrough of the other,
      // matching union/smooth-union semantics. Mixing with the empty
      // sentinel instead would yield ~t*1e10 — a huge constant that
      // blanks the whole field for any t in (0,1) and overflows to
      // Infinity in fp16 readbacks (SDF to Spline). The structural hash
      // already distinguishes these shapes (empty child hashes as "E"),
      // so the shader cache stays coherent.
      if (node.a.kind === "empty") return emitSdf(node.b, state);
      if (node.b.kind === "empty") return emitSdf(node.a, state);
      // True linear field interpolation. `mix` is a GLSL built-in, no
      // helper needed. t is a uniform so keyframing it only rebinds a
      // value — the shader stays cached.
      const a = emitSdf(node.a, state);
      const b = emitSdf(node.b, state);
      const t = allocFor(state, node, "t", "float", node.t);
      return `mix(${a}, ${b}, ${t})`;
    }

    case "round": {
      const r = allocFor(state, node, "r", "float", node.r);
      const child = emitSdf(node.child, state);
      return `((${child}) - ${r})`;
    }

    case "onion": {
      const t = allocFor(state, node, "thickness", "float", node.thickness);
      const child = emitSdf(node.child, state);
      return `(abs(${child}) - ${t})`;
    }

    case "displace": {
      const samp = allocFor(state, node, "tex", "sampler2D", node.image.texture);
      const amt = allocFor(state, node, "amount", "float", node.amount);
      const child = emitSdf(node.child, state);
      // Sampled at the canvas-UV `p`, not the shape's per-shape
      // position — Displace is a screen-space perturbation.
      return `((${child}) + (texture(${samp}, p).r - 0.5) * 2.0 * ${amt})`;
    }
  }
}

// The material inherited by everything below the current point in the
// descent. Both fields are GLSL expressions, not values — the root one
// is a mode uniform (the terminal's own foreground), so a tree with no
// `material` node in it paints every leaf the terminal's fill colour
// and reproduces the pre-material output exactly.
interface SurfMaterial {
  col: string; // vec3
  weight: string; // float
}

// Colour-carrying emitter. Returns a GLSL `Surf` expression. Mirrors
// emitSdf's structure one-for-one; the only nodes that read the
// material are the leaves, and the only node that rebinds it is
// `material`.
//
// NOT memoized — the emitted expression depends on the inherited
// material, so the same subtree under two different materials must emit
// twice. Leaf DISTANCES still come from emitSdf's memo, which is where
// the uniforms actually live.
function emitSurf(
  node: SdfNode,
  state: EmitState,
  mat: SurfMaterial
): string {
  switch (node.kind) {
    case "material": {
      const weight = allocFor(state, node, "bleed", "float", node.bleed);
      // Ramp mode inlines a LUT fetch driven by a per-pixel field. That
      // expression lands at every leaf below this material, but it is a
      // pure function of `p` and identical at each site, so the GLSL
      // compiler CSEs it back down to one fetch.
      const col = node.ramp
        ? `texture(${allocFor(state, node, "lut", "sampler2D", node.ramp.lut)}, vec2(clamp(${emitScalarField(node.ramp.t, state)}, 0.0, 1.0), 0.5)).rgb`
        : allocFor(state, node, "color", "vec3", node.color);
      return emitSurf(node.child, state, { col, weight });
    }

    // An unwired socket paints nothing — zero weight keeps the
    // sentinel out of the bleed accumulator, and 1e10 keeps it from
    // ever winning the colour.
    case "empty":
      return `sLeaf(1e10, ${mat.col}, 0.0, u_bleedInv)`;

    case "circle":
    case "rect":
    case "lineSegment":
    case "polygon":
    case "triangle":
    case "star":
    case "splineSdf":
    case "sdfFromImage":
      return `sLeaf(${emitSdf(node, state)}, ${mat.col}, ${mat.weight}, u_bleedInv)`;

    case "union":
      return `sUnion(${emitSurf(node.a, state, mat)}, ${emitSurf(node.b, state, mat)})`;

    case "intersection":
      return `sIntersect(${emitSurf(node.a, state, mat)}, ${emitSurf(node.b, state, mat)})`;

    case "subtraction":
      return `sSubtract(${emitSurf(node.a, state, mat)}, ${emitSurf(node.b, state, mat)})`;

    case "smoothUnion": {
      const a = emitSurf(node.a, state, mat);
      const b = emitSurf(node.b, state, mat);
      const k = allocFor(state, node, "k", "float", node.k);
      return `sSmoothUnion(${a}, ${b}, ${k})`;
    }

    case "smoothIntersection": {
      const a = emitSurf(node.a, state, mat);
      const b = emitSurf(node.b, state, mat);
      const k = allocFor(state, node, "k", "float", node.k);
      return `sSmoothIntersect(${a}, ${b}, ${k})`;
    }

    case "smoothSubtraction": {
      const a = emitSurf(node.a, state, mat);
      const b = emitSurf(node.b, state, mat);
      const k = allocFor(state, node, "k", "float", node.k);
      return `sSmoothSubtract(${a}, ${b}, ${k})`;
    }

    case "morph": {
      // Same empty-side degradation as the float emitter — mixing with
      // the 1e10 sentinel would blank the field for any t in (0,1).
      if (node.a.kind === "empty") return emitSurf(node.b, state, mat);
      if (node.b.kind === "empty") return emitSurf(node.a, state, mat);
      const a = emitSurf(node.a, state, mat);
      const b = emitSurf(node.b, state, mat);
      const t = allocFor(state, node, "t", "float", node.t);
      return `sMorph(${a}, ${b}, ${t})`;
    }

    case "round": {
      const child = emitSurf(node.child, state, mat);
      const r = allocFor(state, node, "r", "float", node.r);
      return `sOffset(${child}, ${r})`;
    }

    case "onion": {
      const child = emitSurf(node.child, state, mat);
      const t = allocFor(state, node, "thickness", "float", node.thickness);
      return `sOnion(${child}, ${t})`;
    }

    case "displace": {
      const child = emitSurf(node.child, state, mat);
      const samp = allocFor(state, node, "tex", "sampler2D", node.image.texture);
      const amt = allocFor(state, node, "amount", "float", node.amount);
      return `sDisplace(${child}, (texture(${samp}, p).r - 0.5) * 2.0 * ${amt})`;
    }
  }
}

// Map a Math node op string to a GLSL expression in terms of the
// emitted child expressions a / b / c. Mirrors the CPU implementation
// in nodes/effect/math.ts so a Math node operating in field mode
// produces visually identical results to its scalar mode at the
// same params.
//
// Ops that need helpers (smooth min/max) add them to the helper set
// via `state` so they're declared once in the final shader. Ops not
// listed here fall through to "Add" — defensive default for future
// ops added to the Math node before the field path catches up.
function mathOpExpr(
  op: string,
  a: string,
  b: string,
  c: string,
  state: EmitState
): string {
  switch (op) {
    case "Add":
      return `(${a} + ${b})`;
    case "Subtract":
      return `(${a} - ${b})`;
    case "Multiply":
      return `(${a} * ${b})`;
    case "Divide":
      return `((abs(${b}) < 1e-5) ? 0.0 : (${a} / ${b}))`;
    case "Multiply Add":
      return `(${a} * ${b} + ${c})`;
    case "Power":
      return `pow(max(${a}, 0.0), ${b})`;
    case "Logarithm":
      return `((${a} <= 0.0 || ${b} <= 0.0 || ${b} == 1.0) ? 0.0 : log(${a}) / log(${b}))`;
    case "Square Root":
      return `sqrt(max(${a}, 0.0))`;
    case "Inverse Square Root":
      return `((${a} <= 0.0) ? 0.0 : 1.0 / sqrt(${a}))`;
    case "Absolute":
      return `abs(${a})`;
    case "Exponent":
      return `exp(${a})`;
    case "Minimum":
      return `min(${a}, ${b})`;
    case "Maximum":
      return `max(${a}, ${b})`;
    case "Less Than":
      return `((${a} < ${b}) ? 1.0 : 0.0)`;
    case "Greater Than":
      return `((${a} > ${b}) ? 1.0 : 0.0)`;
    case "Sign":
      return `sign(${a})`;
    case "Compare":
      return `((abs(${a} - ${b}) <= ${c}) ? 1.0 : 0.0)`;
    case "Smooth Minimum":
      state.helpers.add("smin");
      return `smin(${a}, ${b}, ${c})`;
    case "Smooth Maximum":
      state.helpers.add("smax");
      return `smax(${a}, ${b}, ${c})`;
    case "Round":
      return `floor(${a} + 0.5)`;
    case "Floor":
      return `floor(${a})`;
    case "Ceiling":
      return `ceil(${a})`;
    case "Truncate":
      return `trunc(${a})`;
    case "Fraction":
      return `fract(${a})`;
    case "Truncated Modulo":
      return `((abs(${b}) < 1e-5) ? 0.0 : (${a} - trunc(${a} / ${b}) * ${b}))`;
    case "Floored Modulo":
      return `((abs(${b}) < 1e-5) ? 0.0 : (${a} - floor(${a} / ${b}) * ${b}))`;
    case "Wrap":
      return `(${b} + mod(mod(${a} - ${b}, max(${c} - ${b}, 1e-5)) + max(${c} - ${b}, 1e-5), max(${c} - ${b}, 1e-5)))`;
    case "Snap":
      return `((abs(${b}) < 1e-5) ? ${a} : floor(${a} / ${b} + 0.5) * ${b})`;
    case "Ping-Pong": {
      // Match the CPU pingpong: scale-aware triangle wave.
      const twoB = `(2.0 * ${b})`;
      return `((${b}) - abs(mod(mod(${a}, ${twoB}) + ${twoB}, ${twoB}) - ${b}))`;
    }
    case "Sine":
      return `sin(${a})`;
    case "Cosine":
      return `cos(${a})`;
    case "Tangent":
      return `tan(${a})`;
    case "Arcsine":
      return `asin(clamp(${a}, -1.0, 1.0))`;
    case "Arccosine":
      return `acos(clamp(${a}, -1.0, 1.0))`;
    case "Arctangent":
      return `atan(${a})`;
    case "Arctan2":
      return `atan(${a}, ${b})`;
    case "Hyperbolic Sine":
      return `sinh(${a})`;
    case "Hyperbolic Cosine":
      return `cosh(${a})`;
    case "Hyperbolic Tangent":
      return `tanh(${a})`;
    case "To Radians":
      return `(${a} * 0.0174532925199433)`;
    case "To Degrees":
      return `(${a} * 57.29577951308232)`;
    default:
      return `(${a} + ${b})`;
  }
}

// Topology-only fingerprints. Two trees with the same hash produce
// identical GLSL source (uniform names are allocated in DFS order
// across both pipelines, so a given topology always names them the
// same way) and share a compiled shader.
function scalarFieldHash(node: ScalarFieldNode): string {
  switch (node.kind) {
    case "constant":
      return "k";
    case "noise":
      return `n[${positionHash(node.position)}]`;
    case "remap":
      // Clamp flag is part of the structure (different GLSL).
      return `rm${node.clamp ? "c" : ""}(${scalarFieldHash(node.child)})`;
    case "mathOp":
      // Op string IS structure (different GLSL per op). Clamp flag too.
      return `mo:${node.op}${node.clamp ? "c" : ""}(${scalarFieldHash(node.a)},${scalarFieldHash(node.b)},${scalarFieldHash(node.c)})`;
  }
}

function positionHash(node: PositionNode): string {
  switch (node.kind) {
    case "canvasUv":
      return "u";
    case "translate":
      return `t(${positionHash(node.child)})`;
    case "scale":
      return `s(${positionHash(node.child)})`;
    case "rotate": {
      // Polymorphic rotation — the field's structure affects the
      // emitted GLSL, so it has to be in the hash.
      const a =
        typeof node.rotation === "number"
          ? "k"
          : scalarFieldHash(node.rotation);
      return `r{${a}}(${positionHash(node.child)})`;
    }
    case "repeat":
      return `rp${node.bounded ? "b" : ""}(${positionHash(node.child)})`;
    case "cellId":
      return `ci(${positionHash(node.child)})`;
    case "mirror":
      return `mi${node.axis}(${positionHash(node.child)})`;
    case "polar":
      return `po(${positionHash(node.child)})`;
    case "twist": {
      const k =
        typeof node.strength === "number"
          ? "k"
          : scalarFieldHash(node.strength);
      return `tw{${k}}(${positionHash(node.child)})`;
    }
  }
}

export function structuralHash(node: SdfNode): string {
  switch (node.kind) {
    case "empty":
      return "E";
    case "circle":
      return `c[${positionHash(node.position)}]`;
    case "rect":
      return `r[${positionHash(node.position)}]`;
    case "lineSegment":
      return `l[${positionHash(node.position)}]`;
    case "polygon": {
      // Sides field topology must be in the hash — different field
      // shapes emit different GLSL.
      const sidesTag =
        typeof node.sides === "number"
          ? "k"
          : `${node.quantizeSides ? "q" : "f"}[${scalarFieldHash(node.sides)}]`;
      return `g{${sidesTag}}[${positionHash(node.position)}]`;
    }
    case "triangle":
      return `t[${positionHash(node.position)}]`;
    case "star":
      return `*[${positionHash(node.position)}]`;
    case "splineSdf":
      // Closed/open changes the visible result but uses the same
      // shader (the closed flag is a uniform). Position chain is
      // structural.
      return `sp[${positionHash(node.position)}]`;
    case "sdfFromImage":
      return `im[${positionHash(node.position)}]`;
    case "union":
      return `U(${structuralHash(node.a)},${structuralHash(node.b)})`;
    case "intersection":
      return `I(${structuralHash(node.a)},${structuralHash(node.b)})`;
    case "subtraction":
      return `S(${structuralHash(node.a)},${structuralHash(node.b)})`;
    case "smoothUnion":
      return `Su(${structuralHash(node.a)},${structuralHash(node.b)})`;
    case "smoothIntersection":
      return `Si(${structuralHash(node.a)},${structuralHash(node.b)})`;
    case "smoothSubtraction":
      return `Ss(${structuralHash(node.a)},${structuralHash(node.b)})`;
    case "morph":
      // t is a uniform, not structural — same shader across all amounts.
      return `M(${structuralHash(node.a)},${structuralHash(node.b)})`;
    case "round":
      return `R(${structuralHash(node.child)})`;
    case "onion":
      return `On(${structuralHash(node.child)})`;
    // Colour and bleed weight are uniforms, so they are deliberately
    // NOT in the hash — keyframing a material rebinds and never
    // recompiles, the same contract morph's `t` and the repeat jitters
    // already have. The material's PRESENCE is structural: it changes
    // which uniform each leaf below it reads. So is ramp-vs-constant
    // (a LUT fetch is different GLSL) and the driving field's topology
    // — but NOT the stops, which only rebake a texture.
    case "material":
      return `Mt${node.ramp ? `{${scalarFieldHash(node.ramp.t)}}` : ""}(${structuralHash(node.child)})`;
    case "displace":
      return `D(${structuralHash(node.child)})`;
  }
}

export interface CompiledSdf {
  source: string;
  uniforms: SdfUniform[];
}

export interface CompiledSdfSnippet {
  // Uniform + helper-function declarations to splice into another shader's
  // global scope.
  decls: string;
  // GLSL `float` expression for the signed distance, in terms of a `vec2 p`
  // sample position (canvas-UV, aspect-correct the caller's choice — same
  // contract as the Rasterize main() `p`). Distance is in canvas-UV units.
  distExpr: string;
  uniforms: SdfUniform[];
}

// Compile an SDF tree into spliceable fragments instead of a full shader, so a
// consumer (e.g. Liquid Glass) can evaluate the analytic distance inline —
// multiple times per pixel for finite-difference normals — at built-in quality,
// no rasterize/JFA round-trip. Cache the composed program by structuralHash(root).
export function compileSdfSnippet(root: SdfNode): CompiledSdfSnippet {
  const state = newEmitState();
  const distExpr = emitSdf(root, state);
  const helperDecls = Array.from(state.helpers)
    .map((h) => HELPERS[h])
    .join("\n\n");
  const uniformDecls = state.uniforms
    .map((u) => `uniform ${u.type} ${u.name};`)
    .join("\n");
  return { decls: `${uniformDecls}\n${helperDecls}`, distExpr, uniforms: state.uniforms };
}

export type SdfOutputMode =
  | "rasterize"
  | "distance"
  | "mask"
  | "raw"
  | "bevel"
  | "shade";

const SHADE_UNIFORMS = `uniform int u_channel;      // 0 composite, 1 normal, 2 height, 3 glow, 4 bleed, 5 mask
uniform float u_softness;
uniform vec3 u_fillColor;
uniform float u_fillAlpha;
uniform vec3 u_bgColor;
uniform float u_bgAlpha;

uniform float u_bleedMix;

uniform int u_lightOn;
uniform int u_heightMode;   // 0 outer, 1 inner, 2 emboss, 3 pillow, 4 curve
uniform sampler2D u_heightCurve;
uniform float u_depth;
uniform float u_soften;
uniform vec3 u_l1Dir;
uniform float u_l1HiOp;
uniform float u_l1ShOp;
uniform vec3 u_l2Dir;
uniform float u_l2HiOp;
uniform float u_l2ShOp;
uniform vec3 u_hiColor;
uniform vec3 u_shColor;
uniform int u_hiBlend;
uniform int u_shBlend;

uniform int u_glowOn;
uniform float u_glowRadius;
uniform float u_glowIntensity;
uniform int u_glowColorMode;  // 0 material, 1 fixed
uniform vec3 u_glowColor;
uniform int u_glowBlend;      // 0 source-over, 1 add, 2 screen

uniform int u_contourOn;
uniform vec3 u_contourColor;
uniform float u_contourAlpha;
uniform float u_contourWidth;
uniform float u_contourSpacing;`;

// Straight-alpha Porter-Duff source-over. The engine composites this way
// everywhere (invariant #4) — the older rasterize/bevel bodies used a
// plain mix(), which is only equivalent when both sides are opaque. Glow
// over a transparent background is exactly the case where it isn't.
const SHADE_HELPERS = `vec4 srcOver(vec4 s, vec4 d) {
  float a = s.a + d.a * (1.0 - s.a);
  if (a <= 1e-6) return vec4(0.0);
  return vec4((s.rgb * s.a + d.rgb * d.a * (1.0 - s.a)) / a, a);
}

// Signed distance -> relief height, per style. Curve mode runs the emboss
// parameterisation (0.5 at the boundary) through a user LUT, which
// subsumes the four fixed profiles and everything between them.
float shadeHeight(float dd) {
  float depth = max(u_depth, 1e-6);
  if (u_heightMode == 0) return (dd <= 0.0) ? 1.0 : 1.0 - smoothstep(0.0, depth, dd);
  if (u_heightMode == 1) return (dd >= 0.0) ? 0.0 : smoothstep(0.0, depth, -dd);
  if (u_heightMode == 2) return clamp(0.5 - 0.5 * dd / depth, 0.0, 1.0);
  if (u_heightMode == 3) return 1.0 - smoothstep(0.0, depth, abs(dd));
  return texture(u_heightCurve, vec2(clamp(0.5 - 0.5 * dd / depth, 0.0, 1.0), 0.5)).r;
}`;

const RASTERIZE_UNIFORMS = `uniform vec3 u_fg;
uniform vec3 u_bg;
uniform float u_fgAlpha;
uniform float u_bgAlpha;
uniform vec3 u_contour;
uniform float u_contourAlpha;
uniform float u_contourWidth;
uniform float u_softness;`;

const DISTANCE_UNIFORMS = `uniform float u_range;
uniform vec3 u_negColor;
uniform vec3 u_posColor;
uniform vec3 u_zeroColor;
uniform float u_alpha;`;

const MASK_UNIFORMS = `uniform float u_threshold;
uniform float u_softness;
uniform float u_invert;`;

const BEVEL_UNIFORMS = `uniform int u_style;          // 0 outer, 1 inner, 2 emboss, 3 pillow
uniform float u_depth;        // canvas-UV units
uniform float u_soften;       // px multiplier on the central-diff step
uniform vec3 u_l1Dir;
uniform float u_l1HiOp;
uniform float u_l1ShOp;
uniform vec3 u_l2Dir;
uniform float u_l2HiOp;
uniform float u_l2ShOp;
uniform vec3 u_fgColor;
uniform vec3 u_bgColor;
uniform float u_fgAlpha;
uniform float u_bgAlpha;
uniform vec3 u_hiColor;
uniform vec3 u_shColor;
uniform int u_hiBlend;
uniform int u_shBlend;`;

function mainBody(
  mode: SdfOutputMode,
  distExpr: string,
  surfExpr: string
): string {
  const preamble = `vec2 p = v_uv;
  if (u_aspectCorrect > 0.5) {
    float aspect = u_canvasSize.x / u_canvasSize.y;
    p = vec2(p.x, (p.y - 0.5) / aspect + 0.5);
  }`;
  // Surf modes take their distance off the struct; distance-only modes
  // evaluate the float expression directly.
  const setup = `${preamble}
  ${surfExpr ? `Surf s = ${surfExpr};\n  float d = s.d;` : `float d = ${distExpr};`}
  float pixel = 1.0 / max(u_canvasSize.x, u_canvasSize.y);`;

  if (mode === "rasterize") {
    return `${setup}
  float soft = max(u_softness * pixel, pixel * 0.5);
  float fillMask = smoothstep(soft, -soft, d);
  vec4 fg = vec4(s.c, u_fgAlpha);
  vec4 bg = vec4(u_bg, u_bgAlpha);
  vec4 base = mix(bg, fg, fillMask);
  if (u_contourWidth > 0.0) {
    float cw = u_contourWidth * pixel;
    float contourMask = smoothstep(cw + soft, max(cw - soft, 0.0), abs(d));
    base = mix(base, vec4(u_contour, u_contourAlpha), contourMask);
  }
  outColor = base;`;
  }

  if (mode === "distance") {
    return `${setup}
  float t = clamp(d / max(u_range, 1e-5), -1.0, 1.0);
  vec3 col = (t < 0.0)
    ? mix(u_zeroColor, u_negColor, -t)
    : mix(u_zeroColor, u_posColor,  t);
  outColor = vec4(col, u_alpha);`;
  }

  if (mode === "mask") {
    return `${setup}
  float soft = max(u_softness * pixel, pixel * 0.5);
  float m = smoothstep(u_threshold + soft, u_threshold - soft, d);
  if (u_invert > 0.5) m = 1.0 - m;
  outColor = vec4(m, m, m, 1.0);`;
  }

  if (mode === "bevel") {
    // Bevel mode: evaluate the SDF at the pixel and at 4 neighbors,
    // map signed distance to a height field per style, derive a
    // normal via finite differences on that height, then apply two
    // lights' highlight/shadow contributions over a base fg/bg fill.
    //
    // The same `${distExpr}` is inlined 5 times with `p` reassigned
    // between calls — equivalent to wrapping it in a function but
    // without restructuring the emit pipeline. GPU compilers CSE the
    // repeated sub-expressions cheaply.
    return `vec2 p = v_uv;
  if (u_aspectCorrect > 0.5) {
    float aspect = u_canvasSize.x / u_canvasSize.y;
    p = vec2(p.x, (p.y - 0.5) / aspect + 0.5);
  }
  vec2 p_orig = p;
  float pixel = 1.0 / max(u_canvasSize.x, u_canvasSize.y);
  float step = max((1.0 + u_soften * 0.5) * pixel, pixel * 0.5);

  // Colour comes off the struct at the centre; the four neighbour taps
  // only need distance, so they use the float expression (which shares
  // the struct's leaf uniforms via the emit memo).
  Surf s = ${surfExpr};
  float d = s.d;
  p = p_orig - vec2(step, 0.0);
  float dL = ${distExpr};
  p = p_orig + vec2(step, 0.0);
  float dR = ${distExpr};
  p = p_orig - vec2(0.0, step);
  float dD = ${distExpr};
  p = p_orig + vec2(0.0, step);
  float dU = ${distExpr};
  p = p_orig;

  float depthN = max(u_depth, 1e-6);

  float h, hL, hR, hD, hU;
  if (u_style == 0) {
    h  = (d  <= 0.0) ? 1.0 : 1.0 - smoothstep(0.0, depthN, d);
    hL = (dL <= 0.0) ? 1.0 : 1.0 - smoothstep(0.0, depthN, dL);
    hR = (dR <= 0.0) ? 1.0 : 1.0 - smoothstep(0.0, depthN, dR);
    hD = (dD <= 0.0) ? 1.0 : 1.0 - smoothstep(0.0, depthN, dD);
    hU = (dU <= 0.0) ? 1.0 : 1.0 - smoothstep(0.0, depthN, dU);
  } else if (u_style == 1) {
    h  = (d  >= 0.0) ? 0.0 : smoothstep(0.0, depthN, -d);
    hL = (dL >= 0.0) ? 0.0 : smoothstep(0.0, depthN, -dL);
    hR = (dR >= 0.0) ? 0.0 : smoothstep(0.0, depthN, -dR);
    hD = (dD >= 0.0) ? 0.0 : smoothstep(0.0, depthN, -dD);
    hU = (dU >= 0.0) ? 0.0 : smoothstep(0.0, depthN, -dU);
  } else if (u_style == 2) {
    h  = clamp(0.5 - 0.5 * d  / depthN, 0.0, 1.0);
    hL = clamp(0.5 - 0.5 * dL / depthN, 0.0, 1.0);
    hR = clamp(0.5 - 0.5 * dR / depthN, 0.0, 1.0);
    hD = clamp(0.5 - 0.5 * dD / depthN, 0.0, 1.0);
    hU = clamp(0.5 - 0.5 * dU / depthN, 0.0, 1.0);
  } else {
    h  = 1.0 - smoothstep(0.0, depthN, abs(d));
    hL = 1.0 - smoothstep(0.0, depthN, abs(dL));
    hR = 1.0 - smoothstep(0.0, depthN, abs(dR));
    hD = 1.0 - smoothstep(0.0, depthN, abs(dD));
    hU = 1.0 - smoothstep(0.0, depthN, abs(dU));
  }

  vec3 n = normalize(vec3(hL - hR, hU - hD, 0.5));

  float soft = max(u_soften * pixel, pixel * 0.5);
  float fillMask = smoothstep(soft, -soft, d);
  vec4 fg = vec4(s.c, u_fgAlpha);
  vec4 bg = vec4(u_bgColor, u_bgAlpha);
  vec4 base = mix(bg, fg, fillMask);
  vec3 col = base.rgb;

  for (int li = 0; li < 2; li++) {
    vec3 ldir = li == 0 ? u_l1Dir : u_l2Dir;
    float hiOp = li == 0 ? u_l1HiOp : u_l2HiOp;
    float shOp = li == 0 ? u_l1ShOp : u_l2ShOp;
    float diff = dot(n, normalize(ldir));
    if (diff > 0.0) {
      float a = hiOp * diff;
      if (u_hiBlend == 0) {
        col = mix(col, vec3(1.0) - (vec3(1.0) - col) * (vec3(1.0) - u_hiColor), a);
      } else if (u_hiBlend == 1) {
        col = mix(col, min(col + u_hiColor, vec3(1.0)), a);
      } else {
        col = mix(col, u_hiColor, a);
      }
    } else if (diff < 0.0) {
      float a = shOp * (-diff);
      if (u_shBlend == 0) {
        col = mix(col, col * u_shColor, a);
      } else if (u_shBlend == 1) {
        col = mix(col, max(col + u_shColor - vec3(1.0), vec3(0.0)), a);
      } else if (u_shBlend == 2) {
        vec3 cb = vec3(1.0) - clamp((vec3(1.0) - col) / max(u_shColor, vec3(1e-3)), 0.0, 1.0);
        col = mix(col, cb, a);
      } else {
        col = mix(col, u_shColor, a);
      }
    }
  }

  outColor = vec4(col, base.a);`;
  }

  if (mode === "shade") {
    // One pass, layered: background <- glow <- fill (lit) <- contour.
    // `u_channel` selects what actually gets written, so the aux
    // outputs reuse this same compiled program with a different uniform
    // rather than five more shader variants.
    return `${preamble}
  vec2 p_orig = p;
  float pixel = 1.0 / max(u_canvasSize.x, u_canvasSize.y);
  Surf s = ${surfExpr};
  float d = s.d;

  // Winner-takes-all colour vs the weighted wash of every painted leaf.
  vec3 bleedCol = s.acc / max(s.accW, 1e-4);
  vec3 matCol = (s.accW > 1e-6) ? mix(s.c, bleedCol, u_bleedMix) : s.c;

  float soft = max(u_softness * pixel, pixel * 0.5);
  float fillMask = smoothstep(soft, -soft, d);

  if (u_channel == 5) { outColor = vec4(vec3(fillMask), 1.0); return; }
  if (u_channel == 4) { outColor = vec4(bleedCol, 1.0); return; }

  vec4 acc = vec4(u_bgColor, u_bgAlpha);

  // ── Bleed wash. A real layer over the background, NOT just a tint on
  // the fill — the whole point is colour reaching where no shape is.
  // accW (total material weight arriving at this pixel) is the natural
  // coverage: ~1 near the shapes, falling off over the bleed radius.
  if (u_bleedMix > 0.0 && s.accW > 1e-6) {
    acc = srcOver(vec4(bleedCol, clamp(s.accW, 0.0, 1.0) * u_bleedMix), acc);
  }

  // ── Glow: falloff outside the surface, coloured by the material so
  // each shape's own colour bleeds into its halo.
  float glowAmt = 0.0;
  vec3 glowCol = (u_glowColorMode == 0) ? matCol : u_glowColor;
  if (u_glowOn == 1) {
    float g = exp(-max(d, 0.0) / max(u_glowRadius, 1e-5));
    glowAmt = clamp(g * u_glowIntensity, 0.0, 1.0);
  }
  if (u_channel == 3) { outColor = vec4(glowCol, glowAmt); return; }
  if (u_glowOn == 1) {
    if (u_glowBlend == 0) {
      acc = srcOver(vec4(glowCol, glowAmt), acc);
    } else if (u_glowBlend == 1) {
      acc = vec4(acc.rgb + glowCol * glowAmt, max(acc.a, glowAmt));
    } else {
      acc = vec4(vec3(1.0) - (vec3(1.0) - acc.rgb) * (vec3(1.0) - glowCol * glowAmt),
                 max(acc.a, glowAmt));
    }
  }

  // ── Fill (coverage folded into alpha so anti-aliasing composites
  // correctly against a transparent background).
  acc = srcOver(vec4(matCol, u_fillAlpha * fillMask), acc);

  // ── Relief lighting. Height + normal come from four float taps of the
  // SAME distance expression with p reassigned — no struct needed, so
  // the colour channel is evaluated exactly once.
  float h = shadeHeight(d);
  vec3 n = vec3(0.0, 0.0, 1.0);
  if (u_lightOn == 1 || u_channel == 1 || u_channel == 2) {
    float stepPx = max((1.0 + u_soften * 0.5) * pixel, pixel * 0.5);
    p = p_orig - vec2(stepPx, 0.0);
    float dL = ${distExpr};
    p = p_orig + vec2(stepPx, 0.0);
    float dR = ${distExpr};
    p = p_orig - vec2(0.0, stepPx);
    float dD = ${distExpr};
    p = p_orig + vec2(0.0, stepPx);
    float dU = ${distExpr};
    p = p_orig;
    n = normalize(vec3(shadeHeight(dL) - shadeHeight(dR),
                       shadeHeight(dU) - shadeHeight(dD), 0.5));
  }
  if (u_channel == 2) { outColor = vec4(vec3(h), 1.0); return; }
  if (u_channel == 1) { outColor = vec4(n * 0.5 + 0.5, 1.0); return; }

  if (u_lightOn == 1) {
    vec3 col = acc.rgb;
    for (int li = 0; li < 2; li++) {
      vec3 ldir = li == 0 ? u_l1Dir : u_l2Dir;
      float hiOp = li == 0 ? u_l1HiOp : u_l2HiOp;
      float shOp = li == 0 ? u_l1ShOp : u_l2ShOp;
      float diff = dot(n, normalize(ldir));
      if (diff > 0.0) {
        float a = hiOp * diff;
        if (u_hiBlend == 0) {
          col = mix(col, vec3(1.0) - (vec3(1.0) - col) * (vec3(1.0) - u_hiColor), a);
        } else if (u_hiBlend == 1) {
          col = mix(col, min(col + u_hiColor, vec3(1.0)), a);
        } else {
          col = mix(col, u_hiColor, a);
        }
      } else if (diff < 0.0) {
        float a = shOp * (-diff);
        if (u_shBlend == 0) {
          col = mix(col, col * u_shColor, a);
        } else if (u_shBlend == 1) {
          col = mix(col, max(col + u_shColor - vec3(1.0), vec3(0.0)), a);
        } else if (u_shBlend == 2) {
          vec3 cb = vec3(1.0) - clamp((vec3(1.0) - col) / max(u_shColor, vec3(1e-3)), 0.0, 1.0);
          col = mix(col, cb, a);
        } else {
          col = mix(col, u_shColor, a);
        }
      }
    }
    acc = vec4(col, acc.a);
  }

  // ── Contour. Spacing > 0 repeats it as concentric bands through the
  // whole field instead of a single line on the zero-crossing.
  if (u_contourOn == 1 && u_contourWidth > 0.0) {
    float cw = u_contourWidth * pixel;
    float dist;
    if (u_contourSpacing > 0.0) {
      float band = mod(d, u_contourSpacing);
      dist = min(band, u_contourSpacing - band);
    } else {
      dist = abs(d);
    }
    float m = smoothstep(cw + soft, max(cw - soft, 0.0), dist);
    acc = srcOver(vec4(u_contourColor, u_contourAlpha * m), acc);
  }

  outColor = acc;`;
  }

  // raw — CPU readback. R holds signed distance; everything else
  // reads zero. The image must be RGBA16F to preserve the sign + range.
  return `${setup}
  outColor = vec4(d, 0.0, 0.0, 1.0);`;
}

function modeUniformDecls(mode: SdfOutputMode): string {
  switch (mode) {
    case "rasterize":
      return RASTERIZE_UNIFORMS;
    case "distance":
      return DISTANCE_UNIFORMS;
    case "mask":
      return MASK_UNIFORMS;
    case "bevel":
      return BEVEL_UNIFORMS;
    case "shade":
      return SHADE_UNIFORMS;
    case "raw":
      return "";
  }
}

// Modes that carry colour through the tree. Everything else is
// distance-only and stays on the smaller, cheaper float emitter.
const SURF_MODES = new Set<SdfOutputMode>(["rasterize", "bevel", "shade"]);

// The root material each Surf mode inherits — the terminal's own
// foreground uniform. This is what makes an unmaterialed tree render
// exactly as it did before materials existed: every leaf paints
// `u_fg` / `u_fgColor`, so `s.c` is a constant equal to the colour the
// old shader mixed in directly.
const ROOT_MATERIAL: Partial<Record<SdfOutputMode, string>> = {
  rasterize: "u_fg",
  bevel: "u_fgColor",
  shade: "u_fillColor",
};

export function compileSdf(
  root: SdfNode,
  mode: SdfOutputMode = "rasterize"
): CompiledSdf {
  const state = newEmitState();
  const rootMaterial = ROOT_MATERIAL[mode];
  const usesSurf = SURF_MODES.has(mode) && !!rootMaterial;

  // Only bevel needs both walks (float taps at the four neighbours for
  // the normal, struct at the centre for colour). Emitting float FIRST
  // warms the memo so the struct pass reuses one set of leaf uniforms
  // rather than allocating a second copy of every shape parameter.
  const needsFloat = !usesSurf || mode === "bevel" || mode === "shade";
  const distExpr = needsFloat ? emitSdf(root, state) : "";
  const surfExpr = usesSurf
    ? emitSurf(root, state, { col: rootMaterial, weight: "1.0" })
    : "";

  const helperDecls = Array.from(state.helpers)
    .map((h) => HELPERS[h])
    .join("\n\n");
  const uniformDecls = state.uniforms
    .map((u) => `uniform ${u.type} ${u.name};`)
    .join("\n");

  const source = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform vec2 u_canvasSize;
uniform float u_aspectCorrect;
${modeUniformDecls(mode)}
${uniformDecls}

out vec4 outColor;

${usesSurf ? SURF_DECLS : ""}
${mode === "shade" ? SHADE_HELPERS : ""}

${helperDecls}

void main() {
  ${mainBody(mode, distExpr, surfExpr)}
}`;

  return { source, uniforms: state.uniforms };
}

// Bind the per-leaf parameter uniforms collected during compile.
// Samplers consume texture units starting at `firstUnit`; the
// Rasterize-family shaders sample nothing else, so units 0..N are
// theirs to allocate. Returns the next free unit.
//
// Single-sourced here because five nodes (Rasterize / Bevel / to Mask /
// to Distance Image / to Spline) each had their own copy of this loop,
// and every new uniform type had to be added to all five or the odd one
// out would silently bind a colour as a texture.
export function bindSdfUniforms(
  gl: WebGL2RenderingContext,
  prog: WebGLProgram,
  uniforms: SdfUniform[],
  firstUnit = 0
): number {
  let unit = firstUnit;
  for (const u of uniforms) {
    const loc = gl.getUniformLocation(prog, u.name);
    // A uniform the GLSL compiler optimized out has no location — skip
    // it WITHOUT consuming a texture unit.
    if (!loc) continue;
    switch (u.type) {
      case "float":
        gl.uniform1f(loc, u.value as number);
        break;
      case "vec2": {
        const v = u.value as [number, number];
        gl.uniform2f(loc, v[0], v[1]);
        break;
      }
      case "vec3": {
        const v = u.value as [number, number, number];
        gl.uniform3f(loc, v[0], v[1], v[2]);
        break;
      }
      case "sampler2D":
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, u.value as WebGLTexture);
        gl.uniform1i(loc, unit);
        unit++;
        break;
    }
  }
  return unit;
}
