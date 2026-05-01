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

export type SdfUniformType = "float" | "vec2" | "sampler2D";
export interface SdfUniform {
  name: string;
  type: SdfUniformType;
  value: number | [number, number] | WebGLTexture;
}

interface EmitState {
  uniforms: SdfUniform[];
  helpers: Set<HelperKey>;
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
  snoiseFbm: `float snoiseFbm(vec2 p, float scl, vec2 off, float seed,
                  int oct, float pers, float lac) {
  vec2 sp = (p - 0.5) * scl + off + vec2(seed * 127.1, seed * 311.7);
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
}`,
};

function alloc(
  state: EmitState,
  type: SdfUniformType,
  value: number | [number, number] | WebGLTexture
): string {
  const idx = state.uniforms.length;
  const name = `u_p${idx}`;
  state.uniforms.push({ name, type, value });
  return name;
}

// Position pipeline emitter. Returns a GLSL `vec2` expression that
// computes the per-pixel sample position. Default `canvasUv` returns
// the bare `p` (the canvas-UV variable in scope at the call site).
function emitPosition(node: PositionNode, state: EmitState): string {
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
      // Raw fbm is in roughly [-1, 1]. Remap to [outLo, outHi]. The
      // shader-side "(t + 1) * 0.5" centers the raw value into [0, 1]
      // before the linear remap so lo/hi feel natural to the user
      // (white = hi, black = lo, mid-gray = midpoint).
      return `(${lo} + (${hi} - ${lo}) * ((snoiseFbm(${pos}, ${scale}, ${off}, ${seed}, int(${oct}), ${pers}, ${lac}) + 1.0) * 0.5))`;
    }
  }
}

// Distance emitter. Each shape primitive emits a position expression
// from its own `position` field, then calls the appropriate distance
// function against it. Combiners / modifiers operate on float-typed
// sub-expressions only.
function emitSdf(node: SdfNode, state: EmitState): string {
  switch (node.kind) {
    case "empty":
      return "1e10";

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
      const n = alloc(state, "float", node.sides);
      return `polySdf(${pos} - ${c}, ${r}, ${n})`;
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
      const k = alloc(state, "float", node.k);
      return `smin(${a}, ${b}, ${k})`;
    }

    case "smoothIntersection": {
      state.helpers.add("smax");
      const a = emitSdf(node.a, state);
      const b = emitSdf(node.b, state);
      const k = alloc(state, "float", node.k);
      return `smax(${a}, ${b}, ${k})`;
    }

    case "smoothSubtraction": {
      state.helpers.add("smax");
      const a = emitSdf(node.a, state);
      const b = emitSdf(node.b, state);
      const k = alloc(state, "float", node.k);
      return `smax(${a}, -(${b}), ${k})`;
    }

    case "round": {
      const r = alloc(state, "float", node.r);
      const child = emitSdf(node.child, state);
      return `((${child}) - ${r})`;
    }

    case "onion": {
      const t = alloc(state, "float", node.thickness);
      const child = emitSdf(node.child, state);
      return `(abs(${child}) - ${t})`;
    }

    case "displace": {
      const samp = alloc(state, "sampler2D", node.image.texture);
      const amt = alloc(state, "float", node.amount);
      const child = emitSdf(node.child, state);
      // Sampled at the canvas-UV `p`, not the shape's per-shape
      // position — Displace is a screen-space perturbation.
      return `((${child}) + (texture(${samp}, p).r - 0.5) * 2.0 * ${amt})`;
    }
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
    case "polygon":
      return `g[${positionHash(node.position)}]`;
    case "triangle":
      return `t[${positionHash(node.position)}]`;
    case "star":
      return `*[${positionHash(node.position)}]`;
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
    case "round":
      return `R(${structuralHash(node.child)})`;
    case "onion":
      return `On(${structuralHash(node.child)})`;
    case "displace":
      return `D(${structuralHash(node.child)})`;
  }
}

export interface CompiledSdf {
  source: string;
  uniforms: SdfUniform[];
}

export type SdfOutputMode = "rasterize" | "distance" | "mask" | "raw";

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

function mainBody(mode: SdfOutputMode, distExpr: string): string {
  const setup = `vec2 p = v_uv;
  if (u_aspectCorrect > 0.5) {
    float aspect = u_canvasSize.x / u_canvasSize.y;
    p = vec2(p.x, (p.y - 0.5) / aspect + 0.5);
  }
  float d = ${distExpr};
  float pixel = 1.0 / max(u_canvasSize.x, u_canvasSize.y);`;

  if (mode === "rasterize") {
    return `${setup}
  float soft = max(u_softness * pixel, pixel * 0.5);
  float fillMask = smoothstep(soft, -soft, d);
  vec4 fg = vec4(u_fg, u_fgAlpha);
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
    case "raw":
      return "";
  }
}

export function compileSdf(
  root: SdfNode,
  mode: SdfOutputMode = "rasterize"
): CompiledSdf {
  const state: EmitState = { uniforms: [], helpers: new Set() };
  const distExpr = emitSdf(root, state);

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

${helperDecls}

void main() {
  ${mainBody(mode, distExpr)}
}`;

  return { source, uniforms: state.uniforms };
}
