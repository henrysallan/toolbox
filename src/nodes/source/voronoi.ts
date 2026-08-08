import { OPACITY_PARAM } from "@/engine/conventions";
import type {
  ImageValue,
  NodeDefinition,
  PointsValue,
  RenderContext,
  SplineValue,
  UvValue,
} from "@/engine/types";
import {
  disposePlaceholderTex,
  getPlaceholderTex,
} from "@/engine/placeholder-tex";
import { pointsFromArray } from "@/engine/points";
import {
  deriveVoronoiGeometry,
  emptyVoronoiGeometry,
  pcg3d,
  pcgUnit,
  type VoronoiGeometry,
} from "@/engine/voronoi-geometry";

// Unified Voronoi node (specdocs/archive/073026_voronoi-unified.md). Three
// feature-point sources behind one `source` enum:
//
//   lattice — procedural Worley noise on an infinite hashed lattice
//             (the classic Voronoi node), 3×3-search shader.
//   scatter — CPU-generated point set (the former Fracture node):
//             image-density / uniform / random placement + Lloyd
//             relaxation, brute-force points-texture shader.
//   points  — an external `points` input becomes the feature points
//             (Scatter Points, Cursor Trail, Hand Tracker, sims…).
//
// Every source ALSO emits true geometry aux outputs (cells / edges /
// vertices / centers / neighbors — see engine/voronoi-geometry.ts)
// derived from the SAME point set the shader renders, so the splines
// overlay the image exactly. That correspondence is what forced the
// hash swap: feature points are hashed with pcg3d (integer hash,
// bit-exact between GLSL and the TS mirror) instead of the old
// fract(sin(...)) lattice hash, which cannot be reproduced on the CPU
// (GPU sin() precision at the hash's large arguments is
// implementation-defined and the divergence is chaotic). Cost: a given
// seed re-rolls its cell layout once — acceptable, since the old
// pattern already differed across GPUs for the same reason.
//
// Geometry constraints (documented, by design):
//   - The splines are always the EUCLIDEAN diagram; under other
//     metrics the rendered walls aren't straight lines.
//   - The lattice warp / uv_in inputs distort per-pixel — geometry
//     ignores them (use scatter's density for true variable density).
//
// W evolution (lattice): each integer W slice keys its own hash
// stream; fractional W lerps every cell's feature point between its
// two slice positions, and the shader renders the TRUE Voronoi of the
// morphed points — so image and splines match exactly at every W, and
// the morph is smooth (no distance-field ghosting). `animated` drives
// W itself along a seamless always-forward loop (slice keys wrap
// modulo N per loop window) — devlist #167.
//
// Coordinate conventions: CPU geometry is normalized [0,1]² Y-DOWN
// like every spline/points value; the shaders flip v_uv at the
// boundary. Distances are measured in an isotropic metric space so
// cells stay round on non-square canvases — p-space for the lattice
// (cells-across-width semantics), (u·aspect, v) height-units for
// scatter/points. This also fixes two latent Fracture bugs: its aux
// geometry was emitted Y-flipped (readback space), and its shader
// warped the sample position but not the feature points on non-square
// canvases.

// ---------------------------------------------------------------------
// Shared GLSL chunks
// ---------------------------------------------------------------------

// Keep in lockstep with pcg3d/pcgUnit in engine/voronoi-geometry.ts —
// same constants, same statement order.
const PCG3D_GLSL = `
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}
float pcgUnit(uint h) { return float(h) * (1.0 / 4294967296.0); }
`;

// Salt for the cells-mode color hash (kept off the jitter stream so the
// two never correlate). COLOR_SALT is baked into both shaders below;
// DRIVER_SALT feeds the CPU-side per-cell `driver` random.
const COLOR_SALT_GLSL = "0x68bc21ebu";
const DRIVER_SALT = 0x2545f491;

const DIST_GLSL = `
uniform int   u_metric;          // 0=euclidean, 1=manhattan, 2=chebyshev, 3=minkowski
uniform float u_minkowskiN;
float dist(vec2 a, vec2 b) {
  vec2 d = abs(a - b);
  if (u_metric == 0) return length(d);
  if (u_metric == 1) return d.x + d.y;
  if (u_metric == 2) return max(d.x, d.y);
  float n = max(u_minkowskiN, 0.1);
  return pow(pow(d.x, n) + pow(d.y, n), 1.0 / n);
}
`;

// Mode ints shared by both shaders.
// 0=f1, 1=f2-f1, 2=f2, 3=cells, 4=position, 5=mask

// ---------------------------------------------------------------------
// Lattice shader (source: lattice)
// ---------------------------------------------------------------------

const LATTICE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform int   u_mode;
uniform float u_scale;
uniform float u_jitter;
uniform vec2  u_offset;
uniform float u_contrast;
uniform float u_falloff;
uniform float u_edgeWidth;
uniform float u_wf;              // smoothstepped slice-blend factor
uniform uint  u_z0;              // slice hash keys (seed ⊕ slice, CPU-mixed)
uniform uint  u_z1;
uniform vec3  u_colorA;
uniform vec3  u_colorB;
uniform float u_alpha;
uniform float u_invert;          // 0 or 1

uniform int       u_hasWarp;
uniform sampler2D u_warpTex;
uniform float     u_warpLo;
uniform float     u_warpHi;

uniform int       u_hasUvIn;
uniform sampler2D u_uvIn;
uniform vec2      u_uvConst;
uniform vec2      u_canvasSize;

out vec4 outColor;

${PCG3D_GLSL}
${DIST_GLSL}

// Feature point of a lattice cell — the W morph happens HERE, per cell,
// so the whole field is the true Voronoi of the lerped points and the
// CPU geometry (same math in fp64) overlays it exactly.
vec2 fpFor(vec2 cell) {
  uvec2 c = uvec2(ivec2(cell));
  uvec3 h0 = pcg3d(uvec3(c, u_z0));
  vec2 p0 = cell + 0.5 + (vec2(pcgUnit(h0.x), pcgUnit(h0.y)) - 0.5) * u_jitter;
  if (u_wf <= 0.0) return p0;
  uvec3 h1 = pcg3d(uvec3(c, u_z1));
  vec2 p1 = cell + 0.5 + (vec2(pcgUnit(h1.x), pcgUnit(h1.y)) - 0.5) * u_jitter;
  return mix(p0, p1, u_wf);
}

struct Voro {
  float f1;
  float f2;
  vec2  cell;       // integer cell of nearest feature
  vec2  pos;        // p-space position of nearest feature
};

// 3×3 neighborhood search — sufficient for jitter ≤ 1 (the morphed
// point is a lerp of two in-cell points, so it stays in the envelope).
Voro voronoiAt(vec2 p) {
  vec2 i = floor(p);
  Voro v;
  v.f1 = 1e9;
  v.f2 = 1e9;
  v.cell = i;
  v.pos = i;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 cell = i + vec2(float(x), float(y));
      vec2 fp = fpFor(cell);
      float d = dist(p, fp);
      if (d < v.f1) {
        v.f2 = v.f1;
        v.f1 = d;
        v.cell = cell;
        v.pos = fp;
      } else if (d < v.f2) {
        v.f2 = d;
      }
    }
  }
  return v;
}

void main() {
  vec2 uv;
  if (u_hasUvIn == 1) uv = texture(u_uvIn, v_uv).rg;
  else if (u_hasUvIn == 2) uv = u_uvConst;
  else uv = vec2(v_uv.x, 1.0 - v_uv.y);   // canonical y-down — matches CPU geometry

  // Per-pixel lattice warp (lens-like distortion of the cell field).
  // Geometry can't follow this — documented on the node.
  float warpScale = 1.0;
  if (u_hasWarp == 1) {
    vec3 dRgb = texture(u_warpTex, v_uv).rgb;
    float lum = dot(dRgb, vec3(0.2126, 0.7152, 0.0722));
    warpScale = mix(u_warpLo, u_warpHi, lum);
  }

  // Aspect-correct p-space: 1 unit = one cell, u_scale cells across the
  // width, isotropic on any canvas. Must stay in lockstep with
  // latticeGeometry() below.
  float aspect = u_canvasSize.x / u_canvasSize.y;
  vec2 p = (uv - 0.5) * (u_scale * warpScale);
  p.y /= aspect;
  p += u_offset;

  Voro v = voronoiAt(p);

  if (u_mode == 4) {
    // Position mode: nearest feature's position within its cell,
    // packed into RG (compatible with Displace channel R/G).
    vec2 rel = v.pos - floor(v.pos);
    outColor = vec4(rel, 0.0, u_alpha);
    return;
  }

  if (u_mode == 3) {
    // Cell-id colorization. Dominant slice keys the color so ids snap
    // at the wf=0.5 crossover — same identity the CPU geometry uses.
    uint zd = (u_wf < 0.5) ? u_z0 : u_z1;
    uvec3 hc = pcg3d(uvec3(uvec2(ivec2(v.cell)), zd ^ ${COLOR_SALT_GLSL}));
    vec3 rgb = vec3(pcgUnit(hc.x), pcgUnit(hc.y), pcgUnit(hc.z));
    if (u_invert > 0.5) rgb = 1.0 - rgb;
    rgb = clamp(0.5 + (rgb - 0.5) * u_contrast, 0.0, 1.0);
    outColor = vec4(rgb, u_alpha);
    return;
  }

  if (u_mode == 5) {
    // Mask: white interior, dark cracks at the f2-f1 boundaries.
    float edge = smoothstep(0.0, max(u_edgeWidth, 0.0001), v.f2 - v.f1);
    if (u_invert > 0.5) edge = 1.0 - edge;
    edge = clamp(0.5 + (edge - 0.5) * u_contrast, 0.0, 1.0);
    outColor = vec4(vec3(edge), u_alpha);
    return;
  }

  float t;
  if (u_mode == 0) {
    t = pow(clamp(v.f1, 0.0, 1.0), max(u_falloff, 0.001));
  } else if (u_mode == 1) {
    t = clamp(v.f2 - v.f1, 0.0, 1.0);
    t = pow(t, max(u_falloff, 0.001));
  } else {
    t = pow(clamp(v.f2, 0.0, 1.0), max(u_falloff, 0.001));
  }

  if (u_invert > 0.5) t = 1.0 - t;
  t = clamp(0.5 + (t - 0.5) * u_contrast, 0.0, 1.0);
  outColor = vec4(mix(u_colorA, u_colorB, t), u_alpha);
}`;

// ---------------------------------------------------------------------
// Points-texture shader (sources: scatter, points)
// ---------------------------------------------------------------------

const POINTS_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform int   u_mode;
uniform sampler2D u_pointsTex;
uniform int   u_count;
uniform float u_falloff;
uniform float u_contrast;
uniform float u_invert;
uniform float u_edgeWidth;
uniform vec3  u_colorA;
uniform vec3  u_colorB;
uniform float u_alpha;
uniform uint  u_seedInt;     // cells-mode color hash only, not placement
uniform vec2  u_canvasSize;

out vec4 outColor;

const int MAX_POINTS = 1024;

${PCG3D_GLSL}
${DIST_GLSL}

vec2 unpack(vec4 c) {
  // Points are packed 16-bit per axis into RGBA8 — RG = X, BA = Y.
  // Constants are 65280/65535 and 255/65535 (high/low byte weights).
  return vec2(
    c.r * 0.99610501 + c.g * 0.00389499,
    c.b * 0.99610501 + c.a * 0.00389499
  );
}

void main() {
  // Metric space (u·aspect, v) in y-down uv: isotropic in height units,
  // so cells stay round on non-square canvases. Must stay in lockstep
  // with the m-space mapping in the node's compute.
  float aspect = u_canvasSize.x / u_canvasSize.y;
  vec2 uvd = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 m = vec2(uvd.x * aspect, uvd.y);
  float f1 = 1e9, f2 = 1e9;
  int nearest = 0;

  for (int i = 0; i < MAX_POINTS; i++) {
    if (i >= u_count) break;
    vec2 fp = unpack(texelFetch(u_pointsTex, ivec2(i, 0), 0));
    float d = dist(m, vec2(fp.x * aspect, fp.y));
    if (d < f1) {
      f2 = f1;
      f1 = d;
      nearest = i;
    } else if (d < f2) {
      f2 = d;
    }
  }

  if (u_mode == 4) {
    // Position mode — absolute feature point packed into RG, y-up
    // (matches the old Fracture packing so downstream Displace setups
    // are unchanged).
    vec2 fp = unpack(texelFetch(u_pointsTex, ivec2(nearest, 0), 0));
    outColor = vec4(fp.x, 1.0 - fp.y, 0.0, u_alpha);
    return;
  }

  if (u_mode == 3) {
    // Cells — random color per cell from its index; seed re-rolls the
    // colors without moving the points.
    uvec3 hc = pcg3d(uvec3(uint(nearest), u_seedInt, ${COLOR_SALT_GLSL}));
    vec3 rgb = vec3(pcgUnit(hc.x), pcgUnit(hc.y), pcgUnit(hc.z));
    if (u_invert > 0.5) rgb = 1.0 - rgb;
    rgb = clamp(0.5 + (rgb - 0.5) * u_contrast, 0.0, 1.0);
    outColor = vec4(rgb, u_alpha);
    return;
  }

  if (u_mode == 5) {
    float edge = smoothstep(0.0, max(u_edgeWidth, 0.0001), f2 - f1);
    if (u_invert > 0.5) edge = 1.0 - edge;
    edge = clamp(0.5 + (edge - 0.5) * u_contrast, 0.0, 1.0);
    outColor = vec4(vec3(edge), u_alpha);
    return;
  }

  float t;
  if (u_mode == 0) {
    t = pow(clamp(f1, 0.0, 1.0), max(u_falloff, 0.001));
  } else if (u_mode == 1) {
    t = clamp(f2 - f1, 0.0, 1.0);
    t = pow(t, max(u_falloff, 0.001));
  } else {
    t = pow(clamp(f2, 0.0, 1.0), max(u_falloff, 0.001));
  }

  if (u_invert > 0.5) t = 1.0 - t;
  t = clamp(0.5 + (t - 0.5) * u_contrast, 0.0, 1.0);
  outColor = vec4(mix(u_colorA, u_colorB, t), u_alpha);
}`;

const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, v_uv);
}`;

// ---------------------------------------------------------------------
// CPU-side scatter generation (the former Fracture pipeline)
// ---------------------------------------------------------------------

// Mulberry32 RNG. Deterministic given seed; cheap; period 2^32.
function makeRng(seed: number): () => number {
  let s = (seed * 0x9e3779b9) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DensityBuffer {
  data: Uint8Array; // RGBA8 row-major, readPixels order (row 0 = canvas BOTTOM)
  w: number;
  h: number;
}

// Bilinear-sample Rec.709 luminance at a Y-DOWN normalized uv. The
// buffer rows come straight from readPixels (bottom-up), so the y axis
// flips here — this is the boundary flip that keeps every CPU-side
// coordinate in canonical y-down space (the old Fracture skipped it and
// its geometry aux came out vertically mirrored).
function sampleDensity(
  buf: DensityBuffer | null,
  x: number,
  y: number
): number {
  if (!buf) return 1;
  const fx = Math.max(0, Math.min(1, x)) * (buf.w - 1);
  const fy = (1 - Math.max(0, Math.min(1, y))) * (buf.h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(buf.w - 1, x0 + 1);
  const y1 = Math.min(buf.h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const idx = (px: number, py: number) => (py * buf.w + px) * 4;
  const lum = (i: number) =>
    (0.2126 * buf.data[i] +
      0.7152 * buf.data[i + 1] +
      0.0722 * buf.data[i + 2]) /
    255;
  const a = lum(idx(x0, y0));
  const b = lum(idx(x1, y0));
  const c = lum(idx(x0, y1));
  const d = lum(idx(x1, y1));
  return (
    a * (1 - tx) * (1 - ty) +
    b * tx * (1 - ty) +
    c * (1 - tx) * ty +
    d * tx * ty
  );
}

interface GenOpts {
  count: number;
  seed: number;
  placement: "uniform" | "random" | "image";
  density: DensityBuffer | null;
  densityGamma: number;
  densityFloor: number;
  lloydIterations: number;
}

// Point coordinates are y-down normalized uv throughout.
function generatePoints(opts: GenOpts): Float32Array {
  const rng = makeRng(opts.seed);
  const points: number[] = [];

  if (opts.placement === "uniform") {
    // Stratified grid with light jitter.
    const cols = Math.max(1, Math.ceil(Math.sqrt(opts.count)));
    const rows = Math.max(1, Math.ceil(opts.count / cols));
    for (let r = 0; r < rows && points.length / 2 < opts.count; r++) {
      for (let c = 0; c < cols && points.length / 2 < opts.count; c++) {
        const jx = (rng() - 0.5) * 0.7;
        const jy = (rng() - 0.5) * 0.7;
        points.push((c + 0.5 + jx) / cols, (r + 0.5 + jy) / rows);
      }
    }
  } else {
    // Random / image-weighted rejection sampling.
    const maxAttempts = opts.count * 200;
    let attempts = 0;
    while (points.length / 2 < opts.count && attempts < maxAttempts) {
      attempts++;
      const x = rng();
      const y = rng();
      let p = 1;
      if (opts.placement === "image" && opts.density) {
        const lum = sampleDensity(opts.density, x, y);
        p = Math.max(opts.densityFloor, Math.pow(lum, opts.densityGamma));
      }
      if (rng() < p) {
        points.push(x, y);
      }
    }
    while (points.length / 2 < opts.count) {
      points.push(rng(), rng());
    }
  }

  // Lloyd's relaxation against the density buffer — spreads points
  // evenly while still honoring density.
  if (opts.lloydIterations > 0) {
    const gridW = opts.density?.w ?? 64;
    const gridH = opts.density?.h ?? 64;
    for (let iter = 0; iter < opts.lloydIterations; iter++) {
      const sumX = new Float32Array(opts.count);
      const sumY = new Float32Array(opts.count);
      const sumW = new Float32Array(opts.count);

      for (let py = 0; py < gridH; py++) {
        for (let px = 0; px < gridW; px++) {
          const x = (px + 0.5) / gridW;
          const y = (py + 0.5) / gridH;
          let nearest = 0;
          let bestD = Infinity;
          for (let i = 0; i < opts.count; i++) {
            const dx = points[i * 2] - x;
            const dy = points[i * 2 + 1] - y;
            const d = dx * dx + dy * dy;
            if (d < bestD) {
              bestD = d;
              nearest = i;
            }
          }
          const w = opts.density
            ? Math.max(opts.densityFloor, sampleDensity(opts.density, x, y))
            : 1;
          sumX[nearest] += x * w;
          sumY[nearest] += y * w;
          sumW[nearest] += w;
        }
      }

      for (let i = 0; i < opts.count; i++) {
        if (sumW[i] > 0) {
          points[i * 2] = sumX[i] / sumW[i];
          points[i * 2 + 1] = sumY[i] / sumW[i];
        }
      }
    }
  }

  return new Float32Array(points);
}

// ---------------------------------------------------------------------
// GL helpers (cached in ctx.state per nodeId)
// ---------------------------------------------------------------------

interface CachedGeoAux {
  cells: SplineValue;
  edges: SplineValue;
  vertices: PointsValue;
  centers: PointsValue;
  neighbors: SplineValue;
}

interface VoronoiState {
  // 1×N RGBA8 texture holding the packed point list (scatter/points).
  pointsTex: WebGLTexture | null;
  pointsCount: number;
  // Small RGBA8 fbo for the density readback (scatter).
  downsampleTex: WebGLTexture | null;
  downsampleFbo: WebGLFramebuffer | null;
  downsampleW: number;
  downsampleH: number;
  readback: Uint8Array | null;
  // Geometry signature cache. Object identity of the aux values is
  // stable while the key matches — downstream identity-keyed caches
  // (spline→mask rasterization etc.) stay hot across e.g. color edits.
  geoKey: string;
  geo: CachedGeoAux | null;
  // Points-input identity tracking (value identity = "upstream
  // recomputed" signal, per the devguide) + one-shot truncation warn.
  lastPointsInput: PointsValue | null;
  pointsGen: number;
  warnedTruncate: number;
}

function getState(ctx: RenderContext, nodeId: string): VoronoiState {
  const key = `voronoi:${nodeId}`;
  let state = ctx.state[key] as VoronoiState | undefined;
  if (!state) {
    state = {
      pointsTex: null,
      pointsCount: 0,
      downsampleTex: null,
      downsampleFbo: null,
      downsampleW: 0,
      downsampleH: 0,
      readback: null,
      geoKey: "",
      geo: null,
      lastPointsInput: null,
      pointsGen: 0,
      warnedTruncate: -1,
    };
    ctx.state[key] = state;
  }
  return state;
}

function ensureDownsampleTarget(
  ctx: RenderContext,
  state: VoronoiState,
  w: number,
  h: number
) {
  if (state.downsampleW === w && state.downsampleH === h && state.downsampleTex)
    return;
  const gl = ctx.gl;
  if (state.downsampleTex) gl.deleteTexture(state.downsampleTex);
  if (state.downsampleFbo) gl.deleteFramebuffer(state.downsampleFbo);
  const tex = gl.createTexture();
  if (!tex) throw new Error("voronoi: failed to create downsample texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error("voronoi: failed to create downsample fbo");
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    tex,
    0
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  state.downsampleTex = tex;
  state.downsampleFbo = fbo;
  state.downsampleW = w;
  state.downsampleH = h;
  state.readback = new Uint8Array(w * h * 4);
}

// Render the density input to a small RGBA8 fbo and read pixels back.
function readbackDensity(
  ctx: RenderContext,
  density: ImageValue,
  state: VoronoiState,
  resolution: number
): DensityBuffer {
  ensureDownsampleTarget(ctx, state, resolution, resolution);
  const gl = ctx.gl;
  const fakeTarget: ImageValue = {
    kind: "image",
    texture: state.downsampleTex!,
    width: state.downsampleW,
    height: state.downsampleH,
  };
  const prog = ctx.getShader("voronoi/downsample", DOWNSAMPLE_FS);
  ctx.drawFullscreen(prog, fakeTarget, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, density.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, state.downsampleFbo);
  gl.readPixels(
    0,
    0,
    state.downsampleW,
    state.downsampleH,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    state.readback!
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    data: state.readback!,
    w: state.downsampleW,
    h: state.downsampleH,
  };
}

function uploadPoints(
  ctx: RenderContext,
  state: VoronoiState,
  positions: Float32Array,
  count: number
) {
  const gl = ctx.gl;
  if (state.pointsCount !== count || !state.pointsTex) {
    if (state.pointsTex) gl.deleteTexture(state.pointsTex);
    const tex = gl.createTexture();
    if (!tex) throw new Error("voronoi: failed to create points texture");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      Math.max(1, count),
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    state.pointsTex = tex;
    state.pointsCount = count;
  }
  // Pack each point into 4 bytes: R+G = X (16-bit), B+A = Y (16-bit).
  const packed = new Uint8Array(Math.max(1, count) * 4);
  for (let i = 0; i < count; i++) {
    const x = Math.max(0, Math.min(1, positions[i * 2]));
    const y = Math.max(0, Math.min(1, positions[i * 2 + 1]));
    const xi = Math.round(x * 65535);
    const yi = Math.round(y * 65535);
    packed[i * 4] = (xi >> 8) & 0xff;
    packed[i * 4 + 1] = xi & 0xff;
    packed[i * 4 + 2] = (yi >> 8) & 0xff;
    packed[i * 4 + 3] = yi & 0xff;
  }
  gl.bindTexture(gl.TEXTURE_2D, state.pointsTex);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    Math.max(1, count),
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    packed
  );
}

// ---------------------------------------------------------------------
// Lattice CPU mirror (feature-point enumeration for geometry)
// ---------------------------------------------------------------------

// Extreme-portrait × max-scale can reach ~26k cells; bail on geometry
// there (the image still renders) rather than stall the frame.
const MAX_LATTICE_CELLS = 20000;

interface LatticeOpts {
  scale: number;
  jitter: number;
  offX: number;
  offY: number;
  aspect: number;
  z0: number;
  z1: number;
  wf: number;
}

function latticeGeometry(opts: LatticeOpts, edgeBow: number): VoronoiGeometry {
  const { scale, jitter, offX, offY, aspect, z0, z1, wf } = opts;
  // Canvas rect in p-space — must stay in lockstep with LATTICE_FS.
  const spanY = scale / aspect;
  const minX = -0.5 * scale + offX;
  const maxX = 0.5 * scale + offX;
  const minY = -0.5 * spanY + offY;
  const maxY = 0.5 * spanY + offY;
  const cx0 = Math.floor(minX) - 1;
  const cx1 = Math.floor(maxX) + 1;
  const cy0 = Math.floor(minY) - 1;
  const cy1 = Math.floor(maxY) + 1;
  const nx = cx1 - cx0 + 1;
  const ny = cy1 - cy0 + 1;
  const total = nx * ny;
  if (total > MAX_LATTICE_CELLS || total < 2) return emptyVoronoiGeometry();

  const sites = new Float64Array(total * 2);
  const drivers = new Float32Array(total);
  const zd = wf < 0.5 ? z0 : z1;
  let i = 0;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const h0 = pcg3d(cx, cy, z0);
      let fx = cx + 0.5 + (pcgUnit(h0[0]) - 0.5) * jitter;
      let fy = cy + 0.5 + (pcgUnit(h0[1]) - 0.5) * jitter;
      if (wf > 0) {
        const h1 = pcg3d(cx, cy, z1);
        const gx = cx + 0.5 + (pcgUnit(h1[0]) - 0.5) * jitter;
        const gy = cy + 0.5 + (pcgUnit(h1[1]) - 0.5) * jitter;
        fx += (gx - fx) * wf;
        fy += (gy - fy) * wf;
      }
      sites[i * 2] = fx;
      sites[i * 2 + 1] = fy;
      // Per-cell random keyed on the lattice coords — stable under
      // panning even though the dense groupIndex reindexes.
      drivers[i] = pcgUnit(pcg3d(cx, cy, (zd ^ DRIVER_SALT) >>> 0)[0]);
      i++;
    }
  }

  // Map p-space → AUTHORED spline space (engine/aspect.ts): authored
  // x = canvas u, authored y = 0.5 + (canvas v − 0.5)/aspect. Folding
  // the uncorrect into the p→uv map collapses both axes to 1/scale —
  // authored space is width-units, same as p-space.
  return deriveVoronoiGeometry({
    sites,
    siteCount: total,
    bounds: [minX, minY, maxX, maxY],
    map: {
      sx: 1 / scale,
      ox: 0.5 - offX / scale,
      sy: 1 / scale,
      oy: 0.5 - offY / scale,
    },
    ids: null,
    drivers,
    edgeBow,
  });
}

// ---------------------------------------------------------------------
// Node definition
// ---------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ];
}

const SOURCES = ["lattice", "scatter", "points"] as const;
const VORONOI_MODES = ["f1", "f2-f1", "f2", "cells", "mask", "position"] as const;
const METRICS = ["euclidean", "manhattan", "chebyshev", "minkowski"] as const;
const PLACEMENTS = ["image", "uniform", "random"] as const;

const MAX_POINTS = 1024;
const DENSITY_RES = 128;

function modeToInt(m: string): number {
  switch (m) {
    case "f1": return 0;
    case "f2-f1": return 1;
    case "f2": return 2;
    case "cells": return 3;
    case "position": return 4;
    case "mask": return 5;
    default: return 1;
  }
}

function metricToInt(m: string): number {
  switch (m) {
    case "euclidean": return 0;
    case "manhattan": return 1;
    case "chebyshev": return 2;
    case "minkowski": return 3;
    default: return 0;
  }
}

function srcOf(p: Record<string, unknown>): string {
  return (p.source as string) ?? "lattice";
}

const GRADIENT_MODES = new Set(["f1", "f2-f1", "f2"]);

// W evolution state. Manual: `w` slider, unbounded slice keys. Animated
// (devlist #167): W itself advances through N slices per loop window
// with slice keys wrapping modulo N — seamless AND always-forward
// (rate ≤ 0 turns evolution off; otherwise N = max(2, round(rate·2))).
function evolutionState(
  params: Record<string, unknown>,
  ctx: RenderContext
): { z0: number; z1: number; wf: number } {
  const animated = (params.animated as boolean) ?? false;
  let w = (params.w as number) ?? 0;
  let wrapN = 0;
  if (animated) {
    const start = (params.anim_start as number) ?? 0;
    const end = (params.anim_end as number) ?? 120;
    const rate = (params.anim_rate as number) ?? 1;
    const n = rate <= 0 ? 0 : Math.max(2, Math.round(rate * 2));
    if (n > 0 && end > start) {
      const frameNow = ctx.tick / ctx.ticksPerFrame;
      let phase = (frameNow - start) / (end - start);
      phase = ((phase % 1) + 1) % 1;
      w = phase * n;
      wrapN = n;
    } else {
      w = 0;
    }
  }
  const wi = Math.floor(w);
  let wf = w - wi;
  wf = wf * wf * (3 - 2 * wf);
  const seedInt = Math.round((params.seed as number) ?? 0) >>> 0;
  const sliceKey = (s: number) => {
    const sw = wrapN > 0 ? ((s % wrapN) + wrapN) % wrapN : s;
    return ((seedInt ^ Math.imul(sw | 0, 0x9e3779b9)) >>> 0);
  };
  return { z0: sliceKey(wi), z1: sliceKey(wi + 1), wf };
}

function wrapGeo(g: VoronoiGeometry): CachedGeoAux {
  return {
    cells: { kind: "spline", subpaths: g.cells },
    edges: { kind: "spline", subpaths: g.edges },
    vertices: pointsFromArray(g.vertices),
    centers: g.centers,
    neighbors: { kind: "spline", subpaths: g.neighbors },
  };
}

// m-space geometry input for the scatter/points sources — must stay in
// lockstep with POINTS_FS's metric mapping. `positions` are CANVAS-uv
// y-down (what the shader texture holds); the map folds in the
// authored-space uncorrect (engine/aspect.ts) so the emitted geometry
// renders back onto the canvas positions exactly.
function pointSetGeometry(
  positions: Float32Array,
  count: number,
  aspect: number,
  ids: Int32Array | null,
  seedInt: number,
  edgeBow: number
): VoronoiGeometry {
  if (count < 2) return emptyVoronoiGeometry();
  const sites = new Float64Array(count * 2);
  const drivers = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    sites[i * 2] = positions[i * 2] * aspect;
    sites[i * 2 + 1] = positions[i * 2 + 1];
    drivers[i] = pcgUnit(pcg3d(i, seedInt, DRIVER_SALT)[0]);
  }
  return deriveVoronoiGeometry({
    sites,
    siteCount: count,
    bounds: [0, 0, aspect, 1],
    // authored x = mx/aspect; authored y = 0.5 + (my − 0.5)/aspect.
    map: { sx: 1 / aspect, ox: 0, sy: 1 / aspect, oy: 0.5 - 0.5 / aspect },
    ids,
    drivers,
    edgeBow,
  });
}

export const voronoiNode: NodeDefinition = {
  type: "voronoi",
  name: "Voronoi",
  category: "image",
  subcategory: "generator",
  description:
    "Worley/Voronoi cells from one of three point sources — an infinite procedural lattice, a CPU-scattered set (image-density placement + Lloyd relaxation, the former Fracture node), or an external Points input. Renders F1 / F2-F1 / F2 / cell-id / mask / position modes with selectable distance metric, and emits the true cell geometry as aux outputs: cell polygons (grouped, with per-cell driver), deduped edges, vertices, centers (area-scaled points), and the Delaunay neighbor graph. Geometry is the euclidean diagram and ignores the lattice warp/UV inputs; the Cell Bow param bulges cell edges outward (bubbles) or inward (pebbles).",
  backend: "webgl2",
  inputs: [
    { name: "uv_in", label: "UV", type: "uv", required: false },
    { name: "warp", label: "Warp", type: "image", required: false },
  ],
  resolveInputs(params) {
    const src = srcOf(params);
    if (src === "scatter") {
      return [{ name: "density", label: "Density", type: "image", required: false }];
    }
    if (src === "points") {
      return [{ name: "points", label: "Points", type: "points", required: false }];
    }
    return [
      { name: "uv_in", label: "UV", type: "uv", required: false },
      { name: "warp", label: "Warp", type: "image", required: false },
    ];
  },
  headerControl: { paramName: "source" },
  params: [
    OPACITY_PARAM,
    {
      name: "source",
      label: "Source",
      type: "enum",
      options: SOURCES as unknown as string[],
      default: "lattice",
    },
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: VORONOI_MODES as unknown as string[],
      default: "f2-f1",
    },
    {
      name: "metric",
      label: "Distance metric",
      type: "enum",
      options: METRICS as unknown as string[],
      default: "euclidean",
    },
    {
      name: "minkowski_n",
      label: "Minkowski N",
      type: "scalar",
      min: 0.1,
      max: 16,
      step: 0.05,
      default: 2,
      visibleIf: (p) => p.metric === "minkowski",
    },
    // ---- lattice ----------------------------------------------------
    {
      name: "scale",
      label: "Scale",
      type: "scalar",
      min: 0.5,
      max: 80,
      softMax: 30,
      step: 0.1,
      default: 8,
      visibleIf: (p) => srcOf(p) === "lattice",
    },
    {
      name: "jitter",
      label: "Jitter",
      type: "scalar",
      // 0 = perfect grid, 1 = full random within the cell. >1 breaks
      // the 3×3 search guarantee, so cap at 1.
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
      visibleIf: (p) => srcOf(p) === "lattice",
    },
    {
      name: "offset_x",
      label: "Offset X",
      type: "scalar",
      min: -50,
      max: 50,
      step: 0.01,
      default: 0,
      visibleIf: (p) => srcOf(p) === "lattice",
    },
    {
      name: "offset_y",
      label: "Offset Y",
      type: "scalar",
      min: -50,
      max: 50,
      step: 0.01,
      default: 0,
      visibleIf: (p) => srcOf(p) === "lattice",
    },
    // ---- scatter (former Fracture) ----------------------------------
    {
      name: "count",
      label: "Cell count",
      type: "scalar",
      min: 4,
      max: MAX_POINTS,
      softMax: 256,
      step: 1,
      default: 80,
      visibleIf: (p) => srcOf(p) === "scatter",
    },
    {
      name: "placement",
      label: "Placement",
      type: "enum",
      options: PLACEMENTS as unknown as string[],
      default: "image",
      visibleIf: (p) => srcOf(p) === "scatter",
    },
    {
      name: "density_gamma",
      label: "Density bias",
      type: "scalar",
      min: 0.1,
      max: 8,
      step: 0.05,
      default: 1.5,
      visibleIf: (p) => srcOf(p) === "scatter" && p.placement === "image",
    },
    {
      name: "density_floor",
      label: "Density floor",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.005,
      default: 0.05,
      visibleIf: (p) => srcOf(p) === "scatter" && p.placement === "image",
    },
    {
      name: "relax",
      label: "Lloyd iterations",
      type: "scalar",
      min: 0,
      max: 8,
      step: 1,
      default: 1,
      visibleIf: (p) => srcOf(p) === "scatter",
    },
    // ---- shared -----------------------------------------------------
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 1000,
      step: 1,
      default: 0,
    },
    // Manual evolution position. Each integer slice is its own hash
    // stream; fractional W is a true point-morph between slices.
    {
      name: "w",
      label: "W (Evolution)",
      type: "scalar",
      min: -100,
      max: 100,
      softMax: 10,
      step: 0.01,
      default: 0,
      visibleIf: (p) => srcOf(p) === "lattice" && !p.animated,
    },
    // Looping evolution: drives W from scene time along a seamless,
    // always-forward loop (slice keys wrap per loop window). Replaces
    // the manual W slider while active. Devlist #167.
    {
      name: "animated",
      label: "Animated",
      type: "boolean",
      default: false,
      visibleIf: (p) => srcOf(p) === "lattice",
    },
    {
      name: "anim_start",
      label: "Start (frame)",
      type: "scalar",
      min: 0,
      max: 100000,
      softMax: 300,
      step: 1,
      default: 0,
      visibleIf: (p) => srcOf(p) === "lattice" && p.animated === true,
    },
    {
      name: "anim_end",
      label: "End (frame)",
      type: "scalar",
      min: 1,
      max: 100000,
      softMax: 300,
      step: 1,
      default: 120,
      visibleIf: (p) => srcOf(p) === "lattice" && p.animated === true,
    },
    {
      name: "anim_rate",
      label: "Rate",
      type: "scalar",
      min: 0,
      max: 10,
      softMax: 4,
      step: 0.01,
      default: 1,
      visibleIf: (p) => srcOf(p) === "lattice" && p.animated === true,
    },
    // ---- styling ----------------------------------------------------
    {
      name: "edge_width",
      label: "Edge width",
      type: "scalar",
      min: 0.0001,
      max: 0.2,
      step: 0.0005,
      default: 0.01,
      visibleIf: (p) => p.mode === "mask",
    },
    {
      name: "falloff",
      label: "Falloff",
      type: "scalar",
      min: 0.1,
      max: 8,
      softMax: 4,
      step: 0.01,
      default: 1,
      visibleIf: (p) => GRADIENT_MODES.has(p.mode as string),
    },
    {
      name: "contrast",
      label: "Contrast",
      type: "scalar",
      min: 0.1,
      max: 5,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.mode !== "position",
    },
    {
      name: "invert",
      label: "Invert",
      type: "boolean",
      default: false,
      visibleIf: (p) => p.mode !== "position",
    },
    // Warp-field range (lattice only): per-pixel luminance mapped
    // through [lo, hi] multiplies the sample scale — a lens-like lattice
    // distortion, NOT variable density (use scatter for that).
    {
      name: "warp_lo",
      label: "Warp (dark)",
      type: "scalar",
      min: 0.1,
      max: 8,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => srcOf(p) === "lattice",
    },
    {
      name: "warp_hi",
      label: "Warp (bright)",
      type: "scalar",
      min: 0.1,
      max: 8,
      step: 0.01,
      default: 2,
      visibleIf: (p) => srcOf(p) === "lattice",
    },
    {
      name: "color_a",
      label: "Color A (low)",
      type: "color",
      default: "#000000",
      visibleIf: (p) => GRADIENT_MODES.has(p.mode as string),
    },
    {
      name: "color_b",
      label: "Color B (high)",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => GRADIENT_MODES.has(p.mode as string),
    },
    {
      name: "alpha",
      label: "Alpha",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    // Spline-output shaping: bow each CELL edge into a bezier. >0
    // bulges outward (bubble packing), <0 inward (pebble mosaic).
    // Splines only — the rendered image is unaffected.
    {
      name: "edge_bow",
      label: "Cell bow (splines)",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.01,
      default: 0,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [
    // One closed subpath per cell; groupIndex = stable cell id, driver =
    // per-cell random (feeds Rasterize/Stroke's driver-mapped ramps).
    { name: "cells", type: "spline" },
    // Deduplicated cell walls as 2-anchor open segments.
    { name: "edges", type: "spline" },
    // Cell corners (incl. canvas clip points).
    { name: "vertices", type: "points" },
    // The feature points; groupIndices = cell ids, scales = relative
    // cell area (Copy-to-Points sizes instances by cell for free).
    { name: "centers", type: "points" },
    // Delaunay dual: segments between adjacent cell centers.
    { name: "neighbors", type: "spline" },
  ],

  compute({ inputs, params, ctx, nodeId }) {
    const state = getState(ctx, nodeId);
    const src = srcOf(params);
    const output = ctx.allocImage();

    const mode = modeToInt((params.mode as string) ?? "f2-f1");
    const metric = metricToInt((params.metric as string) ?? "euclidean");
    const minkowskiN = (params.minkowski_n as number) ?? 2;
    const falloff = (params.falloff as number) ?? 1;
    const contrast = (params.contrast as number) ?? 1;
    const invert = (params.invert as boolean) ? 1 : 0;
    const edgeWidth = (params.edge_width as number) ?? 0.01;
    const [ar, ag, ab] = hexToRgb((params.color_a as string) ?? "#000000");
    const [br, bg, bb] = hexToRgb((params.color_b as string) ?? "#ffffff");
    const alpha = (params.alpha as number) ?? 1;
    const seedInt = Math.round((params.seed as number) ?? 0) >>> 0;
    const edgeBow = (params.edge_bow as number) ?? 0;
    const aspect = ctx.width / ctx.height;

    const setSharedUniforms = (
      gl: WebGL2RenderingContext,
      prog: WebGLProgram
    ) => {
      gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), mode);
      gl.uniform1i(gl.getUniformLocation(prog, "u_metric"), metric);
      gl.uniform1f(gl.getUniformLocation(prog, "u_minkowskiN"), minkowskiN);
      gl.uniform1f(gl.getUniformLocation(prog, "u_falloff"), falloff);
      gl.uniform1f(gl.getUniformLocation(prog, "u_contrast"), contrast);
      gl.uniform1f(gl.getUniformLocation(prog, "u_invert"), invert);
      gl.uniform1f(gl.getUniformLocation(prog, "u_edgeWidth"), edgeWidth);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorA"), ar, ag, ab);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorB"), br, bg, bb);
      gl.uniform1f(gl.getUniformLocation(prog, "u_alpha"), alpha);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_canvasSize"),
        ctx.width,
        ctx.height
      );
    };

    if (src === "lattice") {
      const scale = (params.scale as number) ?? 8;
      const jitter = Math.max(0, Math.min(1, (params.jitter as number) ?? 1));
      const offX = (params.offset_x as number) ?? 0;
      const offY = (params.offset_y as number) ?? 0;
      const { z0, z1, wf } = evolutionState(params, ctx);

      const geoKey = `L|${scale}|${jitter}|${offX}|${offY}|${z0}|${z1}|${wf}|${aspect}|${edgeBow}`;
      if (state.geoKey !== geoKey || !state.geo) {
        state.geo = wrapGeo(
          latticeGeometry(
            { scale, jitter, offX, offY, aspect, z0, z1, wf },
            edgeBow
          )
        );
        state.geoKey = geoKey;
      }

      // Optional UV input — same protocol as the noise node.
      const uvIn = inputs.uv_in;
      const uvKey = `voronoi:${nodeId}:uvzero`;
      let uvInMode = 0;
      let uvInTex: WebGLTexture = getPlaceholderTex(ctx.gl, ctx.state, uvKey);
      let uvConst: [number, number] = [0, 0];
      if (uvIn) {
        if (uvIn.kind === "uv") {
          uvInMode = 1;
          uvInTex = (uvIn as UvValue).texture;
        } else if (uvIn.kind === "scalar") {
          uvInMode = 2;
          uvConst = [uvIn.value, uvIn.value];
        }
      }

      const warpIn = inputs.warp;
      const warpKey = `voronoi:${nodeId}:warpzero`;
      let hasWarp = 0;
      let warpTex: WebGLTexture = getPlaceholderTex(ctx.gl, ctx.state, warpKey);
      if (warpIn && warpIn.kind === "image") {
        hasWarp = 1;
        warpTex = (warpIn as ImageValue).texture;
      }
      const warpLo = (params.warp_lo as number) ?? 0.5;
      const warpHi = (params.warp_hi as number) ?? 2;

      const prog = ctx.getShader("voronoi/lattice-fs", LATTICE_FS);
      ctx.drawFullscreen(prog, output, (gl) => {
        setSharedUniforms(gl, prog);
        gl.uniform1f(gl.getUniformLocation(prog, "u_scale"), scale);
        gl.uniform1f(gl.getUniformLocation(prog, "u_jitter"), jitter);
        gl.uniform2f(gl.getUniformLocation(prog, "u_offset"), offX, offY);
        gl.uniform1f(gl.getUniformLocation(prog, "u_wf"), wf);
        gl.uniform1ui(gl.getUniformLocation(prog, "u_z0"), z0);
        gl.uniform1ui(gl.getUniformLocation(prog, "u_z1"), z1);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, uvInTex);
        gl.uniform1i(gl.getUniformLocation(prog, "u_uvIn"), 0);
        gl.uniform1i(gl.getUniformLocation(prog, "u_hasUvIn"), uvInMode);
        gl.uniform2f(
          gl.getUniformLocation(prog, "u_uvConst"),
          uvConst[0],
          uvConst[1]
        );

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, warpTex);
        gl.uniform1i(gl.getUniformLocation(prog, "u_warpTex"), 1);
        gl.uniform1i(gl.getUniformLocation(prog, "u_hasWarp"), hasWarp);
        gl.uniform1f(gl.getUniformLocation(prog, "u_warpLo"), warpLo);
        gl.uniform1f(gl.getUniformLocation(prog, "u_warpHi"), warpHi);
      });
    } else {
      // scatter / points — the points-texture pipeline.
      let geoKey: string;
      let positions: Float32Array | null = null;
      let count = 0;
      let ids: Int32Array | null = null;

      if (src === "points") {
        const pv =
          inputs.points && inputs.points.kind === "points"
            ? (inputs.points as PointsValue)
            : null;
        if (pv !== state.lastPointsInput) {
          state.lastPointsInput = pv;
          state.pointsGen++;
        }
        count = Math.min(pv?.count ?? 0, MAX_POINTS);
        if ((pv?.count ?? 0) > MAX_POINTS && state.warnedTruncate !== pv!.count) {
          state.warnedTruncate = pv!.count;
          console.warn(
            `voronoi: points input has ${pv!.count} points; using the first ${MAX_POINTS}`
          );
        }
        // Incoming points are AUTHORED space (engine/aspect.ts, same as
        // Copy-to-Points/PointsOverlay read them); the shader texture and
        // the metric space both want canvas uv, so apply the shape→pixel
        // y-correction here. Identity on square canvases.
        positions = new Float32Array(count * 2);
        if (pv) {
          for (let i = 0; i < count; i++) {
            positions[i * 2] = pv.positions[i * 2];
            positions[i * 2 + 1] =
              0.5 + (pv.positions[i * 2 + 1] - 0.5) * aspect;
          }
        }
        ids = pv?.groupIndices ?? null;
        geoKey = `P|${state.pointsGen}|${count}|${aspect}|${edgeBow}|${seedInt}`;
      } else {
        const placement =
          (params.placement as "image" | "uniform" | "random") ?? "image";
        count = Math.max(
          4,
          Math.min(MAX_POINTS, Math.round((params.count as number) ?? 80))
        );
        const densityGamma = (params.density_gamma as number) ?? 1.5;
        const densityFloor = (params.density_floor as number) ?? 0.05;
        const lloydIterations = Math.max(
          0,
          Math.min(8, Math.round((params.relax as number) ?? 1))
        );

        const densityIn = inputs.density;
        const density: DensityBuffer | null =
          placement === "image" && densityIn && densityIn.kind === "image"
            ? readbackDensity(ctx, densityIn as ImageValue, state, DENSITY_RES)
            : null;
        // Cheap content hash of the readback so an unchanged density
        // (same fingerprint-triggering upstream, same pixels) reuses
        // the previous point set + geometry.
        let densityHash = 0;
        if (density) {
          const d = density.data;
          for (let i = 0; i < d.length; i += 4) {
            densityHash = (Math.imul(densityHash, 31) + d[i]) >>> 0;
          }
        }
        const effectivePlacement: GenOpts["placement"] =
          placement === "image" && !density ? "uniform" : placement;

        geoKey =
          `S|${count}|${effectivePlacement}|${seedInt}|${densityGamma}|` +
          `${densityFloor}|${lloydIterations}|${densityHash}|${aspect}|${edgeBow}`;
        if (state.geoKey !== geoKey || !state.geo) {
          positions = generatePoints({
            count,
            seed: Math.round((params.seed as number) ?? 0),
            placement: effectivePlacement,
            density,
            densityGamma,
            densityFloor,
            lloydIterations,
          });
        }
      }

      if (state.geoKey !== geoKey || !state.geo) {
        const pts = positions ?? new Float32Array(0);
        uploadPoints(ctx, state, pts, count);
        state.geo = wrapGeo(
          pointSetGeometry(pts, count, aspect, ids, seedInt, edgeBow)
        );
        state.geoKey = geoKey;
      }

      const prog = ctx.getShader("voronoi/points-fs", POINTS_FS);
      ctx.drawFullscreen(prog, output, (gl) => {
        setSharedUniforms(gl, prog);
        gl.uniform1i(gl.getUniformLocation(prog, "u_count"), state.pointsCount);
        gl.uniform1ui(gl.getUniformLocation(prog, "u_seedInt"), seedInt);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, state.pointsTex!);
        gl.uniform1i(gl.getUniformLocation(prog, "u_pointsTex"), 0);
      });
    }

    const geo = state.geo!;
    return {
      primary: output,
      aux: {
        cells: geo.cells,
        edges: geo.edges,
        vertices: geo.vertices,
        centers: geo.centers,
        neighbors: geo.neighbors,
      },
    };
  },

  dispose(ctx, nodeId) {
    disposePlaceholderTex(ctx.gl, ctx.state, `voronoi:${nodeId}:uvzero`);
    disposePlaceholderTex(ctx.gl, ctx.state, `voronoi:${nodeId}:warpzero`);
    const state = ctx.state[`voronoi:${nodeId}`] as VoronoiState | undefined;
    if (!state) return;
    if (state.pointsTex) ctx.gl.deleteTexture(state.pointsTex);
    if (state.downsampleTex) ctx.gl.deleteTexture(state.downsampleTex);
    if (state.downsampleFbo) ctx.gl.deleteFramebuffer(state.downsampleFbo);
    delete ctx.state[`voronoi:${nodeId}`];
  },

  // Recompute per tick only while the evolution loop runs. Everything
  // else (incl. scatter's density content) is covered by the standard
  // fingerprint's input folding — the old Fracture's `stable: false`
  // was unnecessary and invalidated every downstream node per eval.
  fingerprintExtras(params, ctx) {
    return srcOf(params) === "lattice" && params.animated
      ? `anim:${ctx.tick}`
      : "";
  },
};

// Legacy registration: Fracture merged into Voronoi (073026). The def is
// the SAME — only the defaults differ (source: scatter, mode: cells), so
// old saves load with identical behavior and gain the new geometry
// outputs. `migrateLoadedParams` injects `source: "scatter"` and
// normalizes mode "edges" → "f2-f1" on load. Hidden from the add menu.
export const fractureLegacyNode: NodeDefinition = {
  ...voronoiNode,
  type: "fracture",
  name: "Fracture",
  hidden: true,
  description:
    "Legacy Fracture — merged into the Voronoi node as its 'scatter' source. Old saves keep working; new graphs should use Voronoi.",
  params: voronoiNode.params.map((p) => {
    if (p.name === "source") return { ...p, default: "scatter" };
    if (p.name === "mode") return { ...p, default: "cells" };
    return p;
  }),
};
