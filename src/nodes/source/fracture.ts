import type {
  ImageValue,
  NodeDefinition,
  Point,
  RenderContext,
  SplineSubpath,
} from "@/engine/types";
import { Delaunay } from "d3-delaunay";

// True variable-density Voronoi via a CPU-generated point set. This is
// the node to reach for when you want "more cells where the image is
// bright" — Voronoi-with-warp distorts the lattice but doesn't change
// cell count per region. Fracture solves it by:
//
//   1. Reading the density input back to a small CPU-side luminance
//      buffer (128×128 by default).
//   2. Rejection-sampling N points weighted by that luminance —
//      brighter pixels accept more candidates, naturally producing
//      denser cell layouts where the image is bright.
//   3. Optionally relaxing those points with Lloyd's algorithm
//      (weighted by the same luminance) to spread them out without
//      losing the density distribution.
//   4. Uploading the points as a 1×N texture and running a brute-force
//      nearest-point shader. Points are packed 16-bit per axis into
//      RGBA8 so we don't need float-texture upload paths.
//
// Output modes mirror the Voronoi node so they slot into the same
// downstream effects (Displace, Stroke, etc.).

const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, v_uv);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform int   u_mode;       // 0=cells, 1=edges, 2=f1, 3=mask, 4=position
uniform int   u_metric;     // 0=euclidean, 1=manhattan, 2=chebyshev, 3=minkowski
uniform float u_minkowskiN;
uniform sampler2D u_pointsTex;
uniform int   u_count;
uniform float u_falloff;
uniform float u_contrast;
uniform float u_invert;
uniform float u_edgeWidth;
uniform vec3  u_colorA;
uniform vec3  u_colorB;
uniform float u_alpha;
uniform float u_seed;        // for cell-color hash, not point placement

out vec4 outColor;

const int MAX_POINTS = 1024;

vec2 unpack(vec4 c) {
  // Points are packed 16-bit per axis into RGBA8 — RG = X, BA = Y.
  // Constants below are 65280/65535 and 255/65535 for the high/low
  // byte weights in the [0,1] reconstruction.
  return vec2(
    c.r * 0.99610501 + c.g * 0.00389499,
    c.b * 0.99610501 + c.a * 0.00389499
  );
}

vec3 hash23(vec2 p) {
  return fract(sin(vec3(
    dot(p, vec2(127.1, 311.7)),
    dot(p, vec2(269.5, 183.3)),
    dot(p, vec2(419.2, 371.9))
  )) * 43758.5453123);
}

float dist(vec2 a, vec2 b) {
  vec2 d = abs(a - b);
  if (u_metric == 0) return length(d);
  if (u_metric == 1) return d.x + d.y;
  if (u_metric == 2) return max(d.x, d.y);
  float n = max(u_minkowskiN, 0.1);
  return pow(pow(d.x, n) + pow(d.y, n), 1.0 / n);
}

void main() {
  vec2 uv = v_uv;
  float f1 = 1e9, f2 = 1e9;
  int nearest = 0;

  for (int i = 0; i < MAX_POINTS; i++) {
    if (i >= u_count) break;
    vec2 fp = unpack(texelFetch(u_pointsTex, ivec2(i, 0), 0));
    float d = dist(uv, fp);
    if (d < f1) {
      f2 = f1;
      f1 = d;
      nearest = i;
    } else if (d < f2) {
      f2 = d;
    }
  }

  if (u_mode == 4) {
    // Position mode — pack feature point into RG. Feeds straight into
    // a downstream Displace (channel R/G).
    vec2 fp = unpack(texelFetch(u_pointsTex, ivec2(nearest, 0), 0));
    outColor = vec4(fp, 0.0, u_alpha);
    return;
  }

  if (u_mode == 0) {
    // Cells — random color per shard from a hash of its index. The
    // seed is mixed in so changing the seed re-rolls colors without
    // needing to also re-roll point placement.
    vec3 rgb = hash23(vec2(float(nearest), u_seed));
    if (u_invert > 0.5) rgb = 1.0 - rgb;
    rgb = clamp(0.5 + (rgb - 0.5) * u_contrast, 0.0, 1.0);
    outColor = vec4(rgb, u_alpha);
    return;
  }

  if (u_mode == 3) {
    // Mask — solid white interior, dark cracks at f2-f1 boundaries.
    // Useful as an alpha or threshold input for downstream effects.
    float edge = smoothstep(0.0, max(u_edgeWidth, 0.0001), f2 - f1);
    if (u_invert > 0.5) edge = 1.0 - edge;
    outColor = vec4(vec3(edge), u_alpha);
    return;
  }

  float t;
  if (u_mode == 1) {
    // Edges — F2-F1, classic Voronoi crack pattern.
    t = clamp(f2 - f1, 0.0, 1.0);
    t = pow(t, max(u_falloff, 0.001));
  } else {
    // F1 distance gradient.
    t = pow(clamp(f1, 0.0, 1.0), max(u_falloff, 0.001));
  }

  if (u_invert > 0.5) t = 1.0 - t;
  t = clamp(0.5 + (t - 0.5) * u_contrast, 0.0, 1.0);
  outColor = vec4(mix(u_colorA, u_colorB, t), u_alpha);
}`;

// ============================================================
// CPU-side helpers
// ============================================================

// Mulberry32 RNG. Deterministic given seed; cheap; period 2^32 — plenty
// for the few thousand draws we make per frame.
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
  data: Uint8Array; // RGBA8 row-major
  w: number;
  h: number;
}

// Sample the density buffer with bilinear interpolation in [0,1]² uv
// space. Returns Rec.709 luminance in [0,1]. When no buffer is given,
// returns 1.0 (uniform density).
function sampleDensity(
  buf: DensityBuffer | null,
  x: number,
  y: number
): number {
  if (!buf) return 1;
  const fx = Math.max(0, Math.min(1, x)) * (buf.w - 1);
  const fy = Math.max(0, Math.min(1, y)) * (buf.h - 1);
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
  // Power applied to luminance before rejection. >1 sharpens contrast
  // (only the brightest regions get points), <1 flattens it.
  densityGamma: number;
  // Floor on accept probability so even pure-black regions get *some*
  // points. Prevents catastrophic placement failure when the density
  // image has large empty areas.
  densityFloor: number;
  lloydIterations: number;
}

function generatePoints(opts: GenOpts): Float32Array {
  const rng = makeRng(opts.seed);
  const points: number[] = [];

  if (opts.placement === "uniform") {
    // Stratified grid with light jitter — visually pleasing without
    // needing rejection sampling.
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
    // Random or image-weighted — both go through rejection sampling.
    // For "random" the accept probability is constant 1; for "image"
    // it's the gamma'd luminance with a floor.
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
    // If rejection sampling fell short (very dark image, low floor),
    // pad with random points so we hit the requested count.
    while (points.length / 2 < opts.count) {
      points.push(rng(), rng());
    }
  }

  // Lloyd's relaxation against the density buffer. Each iteration:
  //   1. Bin every density-buffer pixel to its nearest point
  //   2. Move each point to the density-weighted centroid of its bin
  // Result: points spread out evenly while honoring density (denser
  // regions still hold more points but they're better-distributed
  // within each region).
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
          // Weight by the same density used during placement so dense
          // regions pull points toward their centroid more strongly.
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

// ============================================================
// Voronoi geometry extraction (CPU)
// ============================================================
//
// Once we have the point set we can also derive the actual Voronoi
// diagram and emit it as splines + points for downstream nodes.
// d3-delaunay computes Delaunay → Voronoi in O(n log n) and exposes
// the clipped cell polygons we need.
//
// Edges: each Voronoi edge is shared by at most two cells, so we
// deduplicate by canonicalizing endpoint pairs. Each edge is emitted
// as a 2-anchor open subpath (a line segment) — Stroke / Sample
// Along Path / etc. all work the way you'd expect on these.
//
// Vertices: each Voronoi vertex is the circumcenter of a Delaunay
// triangle, but we re-derive them from the (clipped) cell polygons
// instead so boundary clip-points count too — those are real
// intersections from the user's perspective even though they aren't
// "true" Voronoi vertices in the unbounded diagram.
//
// Identity coordinate space is normalized [0,1] Y-DOWN, matching
// every other spline / points value in the engine.
function deriveGeometry(points: Float32Array): {
  edges: SplineSubpath[];
  vertices: Point[];
} {
  const n = points.length / 2;
  if (n < 2) return { edges: [], vertices: [] };
  const delaunay = new Delaunay(points);
  const voronoi = delaunay.voronoi([0, 0, 1, 1]);

  const edges: SplineSubpath[] = [];
  const seenEdges = new Set<string>();
  const seenVerts = new Set<string>();
  const vertices: Point[] = [];

  // Quantize to a 6-decimal grid for dedup keys. d3-delaunay shares
  // the same circumcenters array between adjacent cells so endpoints
  // are byte-identical for shared edges, but bounding-box clip
  // intersections can land on slightly different coordinates from
  // each cell's perspective; quantization makes both cases robust.
  const q = (v: number) => Math.round(v * 1e6) / 1e6;
  const vk = (x: number, y: number) => `${q(x)},${q(y)}`;

  for (let i = 0; i < n; i++) {
    const poly = voronoi.cellPolygon(i);
    if (!poly || poly.length < 2) continue;
    for (let j = 0; j < poly.length - 1; j++) {
      const [x0, y0] = poly[j];
      const [x1, y1] = poly[j + 1];
      const a = vk(x0, y0);
      const b = vk(x1, y1);
      // Skip degenerate zero-length segments.
      if (a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({
        anchors: [{ pos: [x0, y0] }, { pos: [x1, y1] }],
        closed: false,
      });
      if (!seenVerts.has(a)) {
        seenVerts.add(a);
        vertices.push({ pos: [x0, y0] });
      }
      if (!seenVerts.has(b)) {
        seenVerts.add(b);
        vertices.push({ pos: [x1, y1] });
      }
    }
  }
  return { edges, vertices };
}

// ============================================================
// GL helpers (cached in ctx.state per nodeId)
// ============================================================

interface FractureCache {
  // 1×N RGBA8 texture holding the packed point list. Re-allocated when
  // count changes so we don't keep a bloated buffer around.
  pointsTex: WebGLTexture | null;
  pointsCount: number;
  // Small RGBA8 framebuffer used to downsample the density input for
  // CPU readback. Re-allocated when resolution changes.
  downsampleTex: WebGLTexture | null;
  downsampleFbo: WebGLFramebuffer | null;
  downsampleW: number;
  downsampleH: number;
  // Reusable readback buffer.
  readback: Uint8Array | null;
  // Last-rendered points, used to short-circuit re-uploads when the
  // CPU-generated point set hasn't changed (same params + same density
  // readback). The cache key is a stringified hash; the exact format
  // is stable so simple equality works.
  lastKey: string;
}

function getCache(
  ctx: RenderContext,
  nodeId: string
): FractureCache {
  const stateKey = `fracture:${nodeId}`;
  let cache = ctx.state[stateKey] as FractureCache | undefined;
  if (!cache) {
    cache = {
      pointsTex: null,
      pointsCount: 0,
      downsampleTex: null,
      downsampleFbo: null,
      downsampleW: 0,
      downsampleH: 0,
      readback: null,
      lastKey: "",
    };
    ctx.state[stateKey] = cache;
  }
  return cache;
}

function ensureDownsampleTarget(
  ctx: RenderContext,
  cache: FractureCache,
  w: number,
  h: number
) {
  if (cache.downsampleW === w && cache.downsampleH === h && cache.downsampleTex)
    return;
  const gl = ctx.gl;
  if (cache.downsampleTex) gl.deleteTexture(cache.downsampleTex);
  if (cache.downsampleFbo) gl.deleteFramebuffer(cache.downsampleFbo);
  const tex = gl.createTexture();
  if (!tex) throw new Error("fracture: failed to create downsample texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    w,
    h,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error("fracture: failed to create downsample fbo");
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    tex,
    0
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  cache.downsampleTex = tex;
  cache.downsampleFbo = fbo;
  cache.downsampleW = w;
  cache.downsampleH = h;
  cache.readback = new Uint8Array(w * h * 4);
}

// Render the input density image to a small RGBA8 fbo and read pixels
// back. We piggy-back on ctx.drawFullscreen by passing it a fake
// ImageValue that points at our RGBA8 texture — the engine's bindTarget
// only cares about `.texture / .width / .height`.
function readbackDensity(
  ctx: RenderContext,
  density: ImageValue,
  cache: FractureCache,
  resolution: number
): DensityBuffer {
  ensureDownsampleTarget(ctx, cache, resolution, resolution);
  const gl = ctx.gl;
  const fakeTarget: ImageValue = {
    kind: "image",
    texture: cache.downsampleTex!,
    width: cache.downsampleW,
    height: cache.downsampleH,
  };
  const prog = ctx.getShader("fracture/downsample", DOWNSAMPLE_FS);
  ctx.drawFullscreen(prog, fakeTarget, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, density.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
  });
  // Bind fbo to read from it.
  gl.bindFramebuffer(gl.FRAMEBUFFER, cache.downsampleFbo);
  gl.readPixels(
    0,
    0,
    cache.downsampleW,
    cache.downsampleH,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    cache.readback!
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    data: cache.readback!,
    w: cache.downsampleW,
    h: cache.downsampleH,
  };
}

function uploadPoints(
  ctx: RenderContext,
  cache: FractureCache,
  points: Float32Array
) {
  const gl = ctx.gl;
  const count = points.length / 2;
  // Re-create the texture when the count changes — simpler than
  // resizing in-place and the cost is negligible at a few hundred
  // points.
  if (cache.pointsCount !== count || !cache.pointsTex) {
    if (cache.pointsTex) gl.deleteTexture(cache.pointsTex);
    const tex = gl.createTexture();
    if (!tex) throw new Error("fracture: failed to create points texture");
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
    cache.pointsTex = tex;
    cache.pointsCount = count;
  }
  // Pack each point into 4 bytes: R+G = X (16-bit), B+A = Y (16-bit).
  const packed = new Uint8Array(Math.max(1, count) * 4);
  for (let i = 0; i < count; i++) {
    const x = Math.max(0, Math.min(1, points[i * 2]));
    const y = Math.max(0, Math.min(1, points[i * 2 + 1]));
    const xi = Math.round(x * 65535);
    const yi = Math.round(y * 65535);
    packed[i * 4] = (xi >> 8) & 0xff;
    packed[i * 4 + 1] = xi & 0xff;
    packed[i * 4 + 2] = (yi >> 8) & 0xff;
    packed[i * 4 + 3] = yi & 0xff;
  }
  gl.bindTexture(gl.TEXTURE_2D, cache.pointsTex);
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

const MODES = ["cells", "edges", "f1", "mask", "position"] as const;
const PLACEMENTS = ["image", "uniform", "random"] as const;
const METRICS = ["euclidean", "manhattan", "chebyshev", "minkowski"] as const;

function modeToInt(m: string): number {
  switch (m) {
    case "cells": return 0;
    case "edges": return 1;
    case "f1": return 2;
    case "mask": return 3;
    case "position": return 4;
    default: return 0;
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

const MAX_POINTS = 1024;
const DENSITY_RES = 128;

export const fractureNode: NodeDefinition = {
  type: "fracture",
  name: "Fracture",
  category: "image",
  subcategory: "generator",
  description:
    "Variable-density Voronoi via a CPU-generated point set. Connect an image to the Density input and the cells will pack tighter where it's bright. Optional Lloyd's relaxation evens out the distribution.",
  backend: "webgl2",
  // `stable: false` tells the evaluator not to cache us — the point
  // set depends on the *content* of the density input, which the
  // standard input fingerprint can't see. Without this, animating the
  // density would show stale points.
  stable: false,
  inputs: [
    { name: "density", label: "Density", type: "image", required: false },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: MODES as unknown as string[],
      default: "cells",
    },
    {
      name: "placement",
      label: "Placement",
      type: "enum",
      options: PLACEMENTS as unknown as string[],
      default: "image",
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
    {
      name: "count",
      label: "Cell count",
      type: "scalar",
      min: 4,
      max: MAX_POINTS,
      softMax: 256,
      step: 1,
      default: 80,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 1000,
      step: 1,
      default: 0,
    },
    {
      name: "density_gamma",
      label: "Density bias",
      type: "scalar",
      // <1 flattens the density influence (placement looks more
      // uniform); >1 sharpens it (only the brightest regions get
      // points). 1 = linear.
      min: 0.1,
      max: 8,
      step: 0.05,
      default: 1.5,
      visibleIf: (p) => p.placement === "image",
    },
    {
      name: "density_floor",
      label: "Density floor",
      type: "scalar",
      // Minimum accept probability so dark regions still pick up at
      // least *some* points — set to 0 for purely-image-driven layouts.
      min: 0,
      max: 1,
      step: 0.005,
      default: 0.05,
      visibleIf: (p) => p.placement === "image",
    },
    {
      name: "relax",
      label: "Lloyd iterations",
      type: "scalar",
      // 0 = raw rejection sampling (clumpy). 1-2 = nicely spread
      // while still honoring density. >3 = effectively uniform.
      min: 0,
      max: 8,
      step: 1,
      default: 1,
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
      visibleIf: (p) => p.mode === "f1" || p.mode === "edges",
    },
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
    {
      name: "color_a",
      label: "Color A (low)",
      type: "color",
      default: "#000000",
      visibleIf: (p) => p.mode === "f1" || p.mode === "edges",
    },
    {
      name: "color_b",
      label: "Color B (high)",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => p.mode === "f1" || p.mode === "edges",
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
  ],
  primaryOutput: "image",
  auxOutputs: [
    // Edges as individual 2-anchor open subpaths in normalized [0,1]²
    // Y-DOWN. Stroke/Sample Along Path/Connect Points all consume
    // these directly.
    { name: "edges", type: "spline" },
    // Voronoi vertices (cell intersections + bbox clip-points) as
    // points. Use with Copy-to-Points to place objects at every node,
    // or feed into Set Position / Jitter for further effects.
    { name: "vertices", type: "points" },
  ],

  compute({ inputs, params, ctx, nodeId }) {
    const cache = getCache(ctx, nodeId);
    const output = ctx.allocImage();

    const mode = modeToInt((params.mode as string) ?? "cells");
    const metric = metricToInt((params.metric as string) ?? "euclidean");
    const minkowskiN = (params.minkowski_n as number) ?? 2;
    const placementStr =
      (params.placement as "image" | "uniform" | "random") ?? "image";
    const count = Math.max(
      4,
      Math.min(MAX_POINTS, Math.round((params.count as number) ?? 80))
    );
    const seed = Math.round((params.seed as number) ?? 0);
    const densityGamma = (params.density_gamma as number) ?? 1.5;
    const densityFloor = (params.density_floor as number) ?? 0.05;
    const lloydIterations = Math.max(
      0,
      Math.min(8, Math.round((params.relax as number) ?? 1))
    );
    const falloff = (params.falloff as number) ?? 1;
    const edgeWidth = (params.edge_width as number) ?? 0.01;
    const contrast = (params.contrast as number) ?? 1;
    const invert = (params.invert as boolean) ? 1 : 0;
    const [ar, ag, ab] = hexToRgb((params.color_a as string) ?? "#000000");
    const [br, bg, bb] = hexToRgb((params.color_b as string) ?? "#ffffff");
    const alpha = (params.alpha as number) ?? 1;

    // Density readback — only when the placement mode actually needs
    // it. Skipping in uniform/random saves a per-frame fbo+readPixels
    // round-trip.
    const densityIn = inputs.density;
    const density: DensityBuffer | null =
      placementStr === "image" && densityIn && densityIn.kind === "image"
        ? readbackDensity(
            ctx,
            densityIn as ImageValue,
            cache,
            DENSITY_RES
          )
        : null;

    // If the placement requested image but no image was connected,
    // silently fall back to uniform so the node still produces output.
    const effectivePlacement: GenOpts["placement"] =
      placementStr === "image" && !density ? "uniform" : placementStr;

    const points = generatePoints({
      count,
      seed,
      placement: effectivePlacement,
      density,
      densityGamma,
      densityFloor,
      lloydIterations,
    });

    uploadPoints(ctx, cache, points);

    // Derive the Voronoi diagram from the same point set so the aux
    // outputs match the GPU rendering pixel-for-pixel.
    const { edges, vertices } = deriveGeometry(points);

    const prog = ctx.getShader("fracture/main", FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), mode);
      gl.uniform1i(gl.getUniformLocation(prog, "u_metric"), metric);
      gl.uniform1f(gl.getUniformLocation(prog, "u_minkowskiN"), minkowskiN);
      gl.uniform1i(gl.getUniformLocation(prog, "u_count"), count);
      gl.uniform1f(gl.getUniformLocation(prog, "u_falloff"), falloff);
      gl.uniform1f(gl.getUniformLocation(prog, "u_contrast"), contrast);
      gl.uniform1f(gl.getUniformLocation(prog, "u_invert"), invert);
      gl.uniform1f(gl.getUniformLocation(prog, "u_edgeWidth"), edgeWidth);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorA"), ar, ag, ab);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorB"), br, bg, bb);
      gl.uniform1f(gl.getUniformLocation(prog, "u_alpha"), alpha);
      gl.uniform1f(gl.getUniformLocation(prog, "u_seed"), seed);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cache.pointsTex!);
      gl.uniform1i(gl.getUniformLocation(prog, "u_pointsTex"), 0);
    });

    return {
      primary: output,
      aux: {
        edges: { kind: "spline", subpaths: edges },
        vertices: { kind: "points", points: vertices },
      },
    };
  },

  dispose(ctx, nodeId) {
    const cache = ctx.state[`fracture:${nodeId}`] as
      | FractureCache
      | undefined;
    if (!cache) return;
    if (cache.pointsTex) ctx.gl.deleteTexture(cache.pointsTex);
    if (cache.downsampleTex) ctx.gl.deleteTexture(cache.downsampleTex);
    if (cache.downsampleFbo) ctx.gl.deleteFramebuffer(cache.downsampleFbo);
    delete ctx.state[`fracture:${nodeId}`];
  },
};
