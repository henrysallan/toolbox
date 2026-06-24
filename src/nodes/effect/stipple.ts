import type { NodeDefinition, RenderContext, ImageValue } from "@/engine/types";
import { ensureWebGPUDevice, peekWebGPUDevice } from "@/engine/webgpu/device";
import { pushMediaSettle } from "@/engine/offline-settle";
import {
  ensureStippleRelaxGPU,
  destroyStippleRelaxGPU,
  runStippleRelax,
  type StippleRelaxGPU,
} from "@/engine/webgpu/stipple-relax";

// Stipple — image → image filter that re-renders the input as a field of
// dots whose size and packing follow the input's darkness.
//
// Three distribution modes share a common edge-noise + colorization layer
// but differ in how dot positions are chosen:
//
//   grid    — every cell of a jittered virtual grid produces a dot when
//             local density crosses a threshold. Cheapest. Best for
//             halftone-ish controlled looks.
//   screen  — same grid, but cells are accepted STOCHASTICALLY using
//             density as probability. Light areas get sparse random
//             scatter rather than uniformly-spaced small dots. Adds
//             halftone "screening" character.
//   packed  — pre-baked organic point distribution. The CPU runs
//             density-weighted rejection sampling + light relaxation
//             on the input image once per relevant change, buckets the
//             resulting points into a cell-lookup texture, and the
//             shader walks that texture instead of computing positions
//             from cell IDs. Closer to Lloyd's-relaxed stippling.
//   packed-flow — like packed, but dots have persistent identity
//             across rebakes. When a rebake produces new target
//             positions, each target is matched to its nearest old
//             dot (within `maxMatchDistance`). Matched dots lerp
//             toward the new target. Unmatched targets spawn new
//             dots with `life=0` that fade in. Unmatched old dots
//             flagged dying — life fades to 0 then they're reaped.
//             Render reads `life` as the cell-texture alpha and
//             scales dot radius by it. The result: a continuous,
//             flowing field that hides the bake events.
//
// Common architecture: a virtual square-cell grid spans the canvas
// (`gridSize` cells across the shorter axis × derived axis count). Each
// pixel walks a 5×5 cell neighborhood looking for dot coverage. Cells
// produce dot positions differently per mode but the per-pixel rendering
// (edge noise, size mapping, color compositing) is identical.

const MODES = ["grid", "screen", "packed", "packed-flow"] as const;
type Mode = (typeof MODES)[number];

// One persistent dot in packed-flow mode. `x/y` is current animated
// position; `targetX/targetY` is where the last bake said it should
// go. `life` ∈ [0, 1] gates both alpha and size — fades in from 0
// when spawned, fades to 0 when dying. `fadeDir` is +1 while alive
// (life rising toward 1) or -1 while dying (life falling toward 0).
interface FlowDot {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  density: number;
  life: number;
  fadeDir: number;
}

interface StippleState {
  cellTexture: WebGLTexture | null;
  cellsX: number;
  cellsY: number;
  // Small RGBA texture the source is downsampled into before readback, so
  // scatter/relax sample a cell-resolution density field instead of forcing
  // a full-canvas GPU→CPU read every bake. Reused; reallocated on size change.
  densityImg: ImageValue | null;
  // Persistent CPU-bake working buffers — see ensureBakeScratch. Avoids the
  // per-frame GC churn that made the animated-input packed path stutter.
  bakeScratch: BakeScratch | null;
  // packed-flow state
  flowDots: FlowDot[];
  lastFlowTime: number;

  // --- Relaxation result (shared by packed + packed-flow) ---
  // The relaxation stage runs either synchronously on the CPU or
  // asynchronously on a WebGPU compute pass. Both write their result
  // here; consumers read the freshest available set. `gen` bumps every
  // time the set is replaced so a consumer (cell-texture upload, flow
  // matcher) can tell when there's something new without comparing
  // arrays. `key` / `src` identify which (params, source) the result was
  // baked from, so a stale result triggers a fresh bake.
  relaxResultPts: RawPoint[] | null;
  relaxResultKey: string;
  relaxResultSrc: WebGLTexture | null;
  relaxResultGen: number;
  renderedGen: number; // last gen uploaded to the cell texture (static packed)
  matchedGen: number; // last gen fed to the flow matcher (packed-flow)
  // bakeKey of an in-flight GPU bake, or null. Coalesces: while a bake is
  // running we don't launch another, even if inputs change again.
  relaxBusyKey: string | null;
  gpu: StippleRelaxGPU | null;
  gpuFailed: boolean; // a GPU bake errored — fall back to CPU for good
  disposed: boolean; // node disposed mid-flight — async callback must bail
}

const stateKey = (nodeId: string) => `stipple:${nodeId}`;

// Below this point count the CPU relaxation is faster than the WebGPU
// round trip (source upload + compute + readback), and the one-frame
// "seed then relaxed" pop isn't worth it. Small bakes stay on the CPU.
const GPU_RELAX_MIN_POINTS = 6000;

// Per-node flag, keyed by the params object (stable per node instance
// unless a param is animated — in which case the node already recomputes
// every frame, so the flag is moot). Read by fingerprintExtras to force
// the node to recompute while an async GPU bake is pending, so the result
// gets picked up even on a paused/static scene.
const relaxPending = new WeakMap<object, boolean>();

// Nudge the editor to run one more eval pass. The async GPU result lands
// outside React's render cycle; this coalesced bump (see EffectsApp's
// "pipeline-bump" listener) guarantees a follow-up frame that consumes it.
function requestPipelineReeval(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("pipeline-bump"));
  }
}

// Relaxation step size — must match between CPU and GPU paths.
function computeStepBase(
  relaxStrength: number,
  cellsX: number,
  cellsY: number
): number {
  return relaxStrength * (0.7 / Math.max(cellsX, cellsY));
}

interface ScatterArgs {
  imgW: number;
  imgH: number;
  cellsX: number;
  cellsY: number;
  targetPoints: number;
  invert: boolean;
  densityCurve: number;
  seed: number;
}

interface RelaxArgs {
  iterations: number;
  relaxStrength: number;
}

// =====================================================================
// Shader — grid + screen (unified)
// =====================================================================
//
// `u_mode` selects:
//   0 = grid     — accept cell iff density > threshold
//   1 = screen   — accept cell iff hash(cell) < density^densityCurve

const FS_GRID_SCREEN = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_src;
uniform vec2  u_resolution;
uniform float u_gridSize;
uniform float u_densityCurve;
uniform int   u_invert;
uniform int   u_mode;             // 0 grid, 1 screen
uniform float u_threshold;
uniform float u_dotMin;
uniform float u_dotMax;
uniform float u_jitterMin;
uniform float u_jitterMax;
uniform float u_jitterBias;
uniform float u_noiseScale;
uniform float u_noiseRoughness;
uniform float u_noiseStrength;
uniform vec3  u_dotColor;
uniform vec3  u_bgColor;
uniform float u_bgAlpha;

out vec4 outColor;

vec2 hash22(ivec2 p) {
  uint x = uint(p.x) * 1973u;
  uint y = uint(p.y) * 9277u;
  uint h = x ^ y;
  h = h * 747796405u + 2891336453u;
  uint h2 = (h >> 22) ^ h;
  h2 = h2 * 277803737u;
  uint h3 = (h2 >> 22) ^ h2;
  return vec2(
    float(h2 & 0xffffffu) / float(0x1000000u),
    float(h3 & 0xffffffu) / float(0x1000000u)
  );
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash22(ivec2(i)).x;
  float b = hash22(ivec2(i) + ivec2(1, 0)).x;
  float c = hash22(ivec2(i) + ivec2(0, 1)).x;
  float d = hash22(ivec2(i) + ivec2(1, 1)).x;
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float sampleDensity(vec2 uv) {
  vec4 c = texture(u_src, clamp(uv, 0.0, 1.0));
  float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  float raw = (u_invert == 1) ? lum : (1.0 - lum);
  raw *= c.a;
  return pow(clamp(raw, 0.0, 1.0), u_densityCurve);
}

void main() {
  float aspect = u_resolution.x / u_resolution.y;
  vec2 cells = (aspect >= 1.0)
    ? vec2(u_gridSize * aspect, u_gridSize)
    : vec2(u_gridSize, u_gridSize / aspect);
  float cellPx = u_resolution.y / cells.y;

  vec2 gridPos = v_uv * cells;
  ivec2 baseCell = ivec2(floor(gridPos));

  vec2 pxPos = v_uv * u_resolution;
  // Composite in PREMULTIPLIED alpha. If we blended straight colors, a
  // transparent-but-colored background (low bgAlpha, but bgColor e.g. cream)
  // would bleed its color into the antialiased dot edges — invisible while
  // bgAlpha is 1, but a pale fringe once the alpha is respected (ProRes 4444
  // export, any real compositor). Premultiplied "over" keeps edge color = dot
  // color; we un-premultiply back to straight alpha at the end.
  vec4 acc = vec4(u_bgColor * u_bgAlpha, u_bgAlpha);

  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      ivec2 cid = baseCell + ivec2(dx, dy);
      vec2 cellCenterUv = (vec2(cid) + 0.5) / cells;

      float density = sampleDensity(cellCenterUv);

      vec2 r1 = hash22(cid);
      vec2 r2 = hash22(cid + ivec2(7919, 6151));

      // Mode-specific accept. Grid: threshold reject. Screen: probability
      // reject (hash > density → skip), so light areas thin out.
      if (u_mode == 0) {
        if (density < u_threshold) continue;
      } else {
        if (r2.y > density) continue;
      }

      float jShape = pow(density, u_jitterBias);
      float jAmt = mix(u_jitterMin, u_jitterMax, jShape);
      vec2 jitter = (r1 - 0.5) * jAmt;
      vec2 dotUv = cellCenterUv + jitter / cells;
      vec2 dotPx = dotUv * u_resolution;

      float radius = mix(u_dotMin, u_dotMax, density) * cellPx * 0.5;
      if (radius <= 0.0) continue;

      vec2 d = pxPos - dotPx;
      float dist = length(d);
      if (dist > radius * (1.0 + u_noiseStrength) + 1.0) continue;

      float ang = atan(d.y, d.x);
      vec2 nP = vec2(cos(ang), sin(ang)) * u_noiseScale + r2 * 137.0;
      float n1 = valueNoise(nP);
      float n2 = valueNoise(nP * 2.37);
      float n = mix(n1, n2, u_noiseRoughness) - 0.5;

      float rAdj = radius * (1.0 + n * u_noiseStrength);

      // Fixed sub-pixel AA. fwidth(dist) is unsafe here because dist
      // depends on cid, which differs across the 2×2 quad at cell
      // boundaries — the derivative is undefined and shows up as the
      // grid-aligned light crosshatch you'd otherwise see.
      float aa = 0.75;
      float cov = 1.0 - smoothstep(rAdj - aa, rAdj + aa, dist);
      if (cov <= 0.0) continue;

      // Source-over in premultiplied space (see the acc init note above).
      acc.rgb = u_dotColor * cov + acc.rgb * (1.0 - cov);
      acc.a   = cov + acc.a * (1.0 - cov);
    }
  }

  // Un-premultiply back to the engine's straight-alpha convention. Where
  // nothing was drawn (acc.a ~ 0) the color is irrelevant — emit 0.
  outColor = acc.a > 1e-5 ? vec4(acc.rgb / acc.a, acc.a) : vec4(0.0);
}`;

// =====================================================================
// Shader — packed (reads pre-baked cell-lookup texture)
// =====================================================================
//
// Cell texture layout (RGBA32F): one texel per virtual grid cell.
//   .rg = baked dot position in UV space
//   .b  = density at that position (0..1) — used for size and edge phase
//   .a  = 1.0 if a point exists in this cell, 0.0 otherwise
//
// Shader iterates the 5×5 neighborhood as in grid mode, but instead of
// computing the dot center from cell ID, it reads it from u_cells.

const FS_PACKED = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_cells;
uniform vec2  u_cellsRes;        // (cellsX, cellsY)
uniform vec2  u_resolution;
uniform float u_dotMin;
uniform float u_dotMax;
uniform float u_noiseScale;
uniform float u_noiseRoughness;
uniform float u_noiseStrength;
uniform vec3  u_dotColor;
uniform vec3  u_bgColor;
uniform float u_bgAlpha;

out vec4 outColor;

vec2 hash22(ivec2 p) {
  uint x = uint(p.x) * 1973u;
  uint y = uint(p.y) * 9277u;
  uint h = x ^ y;
  h = h * 747796405u + 2891336453u;
  uint h2 = (h >> 22) ^ h;
  h2 = h2 * 277803737u;
  uint h3 = (h2 >> 22) ^ h2;
  return vec2(
    float(h2 & 0xffffffu) / float(0x1000000u),
    float(h3 & 0xffffffu) / float(0x1000000u)
  );
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash22(ivec2(i)).x;
  float b = hash22(ivec2(i) + ivec2(1, 0)).x;
  float c = hash22(ivec2(i) + ivec2(0, 1)).x;
  float d = hash22(ivec2(i) + ivec2(1, 1)).x;
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  vec2 cells = u_cellsRes;
  float cellPx = u_resolution.y / cells.y;
  vec2 gridPos = v_uv * cells;
  ivec2 baseCell = ivec2(floor(gridPos));

  vec2 pxPos = v_uv * u_resolution;
  // Composite in PREMULTIPLIED alpha. If we blended straight colors, a
  // transparent-but-colored background (low bgAlpha, but bgColor e.g. cream)
  // would bleed its color into the antialiased dot edges — invisible while
  // bgAlpha is 1, but a pale fringe once the alpha is respected (ProRes 4444
  // export, any real compositor). Premultiplied "over" keeps edge color = dot
  // color; we un-premultiply back to straight alpha at the end.
  vec4 acc = vec4(u_bgColor * u_bgAlpha, u_bgAlpha);

  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      ivec2 cid = baseCell + ivec2(dx, dy);
      if (cid.x < 0 || cid.y < 0 || cid.x >= int(cells.x) || cid.y >= int(cells.y)) continue;
      vec4 cell = texelFetch(u_cells, cid, 0);
      // alpha channel doubles as life — 0 = no dot, 1 = fully alive,
      // intermediate values = fading in/out (packed-flow mode).
      if (cell.a < 0.01) continue;

      vec2 dotUv = cell.rg;
      float density = cell.b;
      float life = cell.a;
      vec2 dotPx = dotUv * u_resolution;

      float radius = mix(u_dotMin, u_dotMax, density) * life * cellPx * 0.5;
      if (radius <= 0.0) continue;

      vec2 d = pxPos - dotPx;
      float dist = length(d);
      if (dist > radius * (1.0 + u_noiseStrength) + 1.0) continue;

      vec2 r2 = hash22(cid + ivec2(7919, 6151));
      float ang = atan(d.y, d.x);
      vec2 nP = vec2(cos(ang), sin(ang)) * u_noiseScale + r2 * 137.0;
      float n1 = valueNoise(nP);
      float n2 = valueNoise(nP * 2.37);
      float n = mix(n1, n2, u_noiseRoughness) - 0.5;
      float rAdj = radius * (1.0 + n * u_noiseStrength);

      // Fixed sub-pixel AA. fwidth(dist) is unsafe here because dist
      // depends on cid, which differs across the 2×2 quad at cell
      // boundaries — the derivative is undefined and shows up as the
      // grid-aligned light crosshatch you'd otherwise see.
      float aa = 0.75;
      float cov = 1.0 - smoothstep(rAdj - aa, rAdj + aa, dist);
      if (cov <= 0.0) continue;

      // Source-over in premultiplied space (see the acc init note above).
      acc.rgb = u_dotColor * cov + acc.rgb * (1.0 - cov);
      acc.a   = cov + acc.a * (1.0 - cov);
    }
  }

  // Un-premultiply back to the engine's straight-alpha convention. Where
  // nothing was drawn (acc.a ~ 0) the color is irrelevant — emit 0.
  outColor = acc.a > 1e-5 ? vec4(acc.rgb / acc.a, acc.a) : vec4(0.0);
}`;

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

function modeToInt(m: string): number {
  return m === "screen" ? 1 : 0;
}

// =====================================================================
// Packed mode — CPU bake
// =====================================================================

// xorshift32 — deterministic seedable random.
function makeRng(seed: number) {
  let s = seed >>> 0;
  if (s === 0) s = 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 0x100000000;
  };
}

function sampleDensityCPU(
  data: Float32Array, w: number, h: number,
  u: number, v: number,
  invert: boolean, curve: number
): number {
  const x = Math.max(0, Math.min(w - 1, Math.floor(u * w)));
  const y = Math.max(0, Math.min(h - 1, Math.floor(v * h)));
  const idx = (y * w + x) * 4;
  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  const a = data[idx + 3];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let d = invert ? lum : (1 - lum);
  d *= a;
  return Math.pow(Math.max(0, Math.min(1, d)), curve);
}

interface RawPoint { x: number; y: number; density: number; }

// Persistent CPU-bake working buffers. The animated-input packed path rebakes
// every frame, so allocating scatter arrays / relax bins / cell data fresh
// each time was a steady source of GC stutter. These grow monotonically (never
// shrink) and are reused, mirroring the WebGPU buffer policy in stipple-relax.
interface BakeScratch {
  xs: Float32Array;       // point positions, length >= ptCap
  ys: Float32Array;
  densities: Float32Array;
  dx: Float32Array;       // per-point relaxation displacement
  dy: Float32Array;
  order: Int32Array;      // CSR-sorted point indices (relax binning)
  cellCount: Int32Array;  // per-cell counts, then reused as scatter cursor
  cellStart: Int32Array;  // CSR offsets, length >= cellCap + 1
  ptList: RawPoint[];     // pooled output objects, mutated in place
  cellData: Float32Array; // cell-lookup texture data, length >= cellCap * 4
  ptCap: number;
  cellCap: number;
}

function ensureBakeScratch(
  state: StippleState, maxPts: number, cells: number
): BakeScratch {
  let s = state.bakeScratch;
  if (!s) {
    s = {
      xs: new Float32Array(0), ys: new Float32Array(0),
      densities: new Float32Array(0),
      dx: new Float32Array(0), dy: new Float32Array(0),
      order: new Int32Array(0),
      cellCount: new Int32Array(0), cellStart: new Int32Array(1),
      ptList: [], cellData: new Float32Array(0),
      ptCap: 0, cellCap: 0,
    };
    state.bakeScratch = s;
  }
  if (maxPts > s.ptCap) {
    s.xs = new Float32Array(maxPts);
    s.ys = new Float32Array(maxPts);
    s.densities = new Float32Array(maxPts);
    s.dx = new Float32Array(maxPts);
    s.dy = new Float32Array(maxPts);
    s.order = new Int32Array(maxPts);
    s.ptCap = maxPts;
  }
  if (cells > s.cellCap) {
    s.cellCount = new Int32Array(cells);
    s.cellStart = new Int32Array(cells + 1);
    s.cellData = new Float32Array(cells * 4);
    s.cellCap = cells;
  }
  return s;
}

// ----- Bake stage 1: density-weighted scatter -----
// Seeded rejection sampling into scratch.xs/ys; returns the accepted count.
// Stays on the CPU in every backend so a given seed yields the exact same
// point set — the GPU path only relaxes this fixed set, never regenerates it.
function scatterInto(
  s: BakeScratch,
  densityImage: Float32Array,
  a: ScatterArgs
): number {
  const rng = makeRng(a.seed);
  const maxPts = Math.min(a.targetPoints, a.cellsX * a.cellsY);
  const maxAttempts = maxPts * 40;
  const { xs, ys } = s;
  let n = 0;
  let attempts = 0;
  while (n < maxPts && attempts < maxAttempts) {
    const u = rng();
    const v = rng();
    const d = sampleDensityCPU(
      densityImage, a.imgW, a.imgH, u, v, a.invert, a.densityCurve
    );
    if (rng() < d) {
      xs[n] = u;
      ys[n] = v;
      n++;
    }
    attempts++;
  }
  return n;
}

// ----- Bake stage 2 (CPU): relaxation -----
// Mutates scratch.xs/ys[0..n) in place. Jacobi nearest-neighbour push over a
// uniform grid whose cell size matches the output cell grid. The WebGPU kernel
// in engine/webgpu/wgsl/stipple-relax.ts mirrors this exactly; this is the
// fallback when WebGPU is unavailable or the point count is small.
//
// Binning uses a flat CSR counting sort (count → prefix-sum → scatter) instead
// of a Map<cell, idx[]> rebuilt each iteration: zero allocation, and within a
// cell the index order is ascending — identical to the old Map's push order —
// so the nearest-neighbour pick and tie-breaks match the previous CPU bake
// bit-for-bit (and still converge to the same field as the WGSL kernel).
function relaxInto(
  s: BakeScratch, n: number,
  densityImage: Float32Array,
  a: ScatterArgs, r: RelaxArgs
): void {
  if (r.iterations <= 0 || n <= 1) return;
  const { cellsX, cellsY, imgW, imgH, invert, densityCurve } = a;
  const cells = cellsX * cellsY;
  const stepBase = computeStepBase(r.relaxStrength, cellsX, cellsY);
  const { xs, ys, dx, dy, order, cellCount, cellStart } = s;

  for (let iter = 0; iter < r.iterations; iter++) {
    // Count points per cell.
    cellCount.fill(0, 0, cells);
    for (let i = 0; i < n; i++) {
      const cx = Math.max(0, Math.min(cellsX - 1, Math.floor(xs[i] * cellsX)));
      const cy = Math.max(0, Math.min(cellsY - 1, Math.floor(ys[i] * cellsY)));
      cellCount[cy * cellsX + cx]++;
    }
    // Prefix-sum into cell start offsets.
    let acc = 0;
    for (let c = 0; c < cells; c++) {
      cellStart[c] = acc;
      acc += cellCount[c];
    }
    cellStart[cells] = acc;
    // Scatter indices into `order`, reusing cellCount as a per-cell cursor.
    for (let c = 0; c < cells; c++) cellCount[c] = cellStart[c];
    for (let i = 0; i < n; i++) {
      const cx = Math.max(0, Math.min(cellsX - 1, Math.floor(xs[i] * cellsX)));
      const cy = Math.max(0, Math.min(cellsY - 1, Math.floor(ys[i] * cellsY)));
      const cell = cy * cellsX + cx;
      order[cellCount[cell]++] = i;
    }

    for (let i = 0; i < n; i++) {
      const px = xs[i];
      const py = ys[i];
      const cx = Math.max(0, Math.min(cellsX - 1, Math.floor(px * cellsX)));
      const cy = Math.max(0, Math.min(cellsY - 1, Math.floor(py * cellsY)));
      let nearestDist2 = Infinity;
      let nnDx = 0, nnDy = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const ncy = cy + oy;
        if (ncy < 0 || ncy >= cellsY) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const ncx = cx + ox;
          if (ncx < 0 || ncx >= cellsX) continue;
          const cell = ncy * cellsX + ncx;
          const start = cellStart[cell];
          const end = cellStart[cell + 1];
          for (let k = start; k < end; k++) {
            const j = order[k];
            if (j === i) continue;
            const ddx = px - xs[j];
            const ddy = py - ys[j];
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < nearestDist2) {
              nearestDist2 = d2;
              nnDx = ddx;
              nnDy = ddy;
            }
          }
        }
      }
      if (nearestDist2 < Infinity && nearestDist2 > 0) {
        const mag = Math.sqrt(nearestDist2);
        // Allow tighter packing where density is high — push less.
        const localD = sampleDensityCPU(densityImage, imgW, imgH, px, py, invert, densityCurve);
        const ease = 1.0 - localD * 0.85;
        dx[i] = (nnDx / mag) * stepBase * ease;
        dy[i] = (nnDy / mag) * stepBase * ease;
      } else {
        dx[i] = 0;
        dy[i] = 0;
      }
    }
    for (let i = 0; i < n; i++) {
      xs[i] = Math.max(0, Math.min(1, xs[i] + dx[i]));
      ys[i] = Math.max(0, Math.min(1, ys[i] + dy[i]));
    }
  }
}

// ----- Bake stage 3: finalize -----
// Re-sample density at the final (relaxed) positions and pack into the
// RawPoint shape consumers expect. Accepts number[] (CPU) or Float32Array
// (GPU readback) transparently.
function finalizePoints(
  xs: ArrayLike<number>, ys: ArrayLike<number>,
  densityImage: Float32Array,
  a: ScatterArgs
): RawPoint[] {
  const n = xs.length;
  const out: RawPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = xs[i];
    const v = ys[i];
    const d = sampleDensityCPU(
      densityImage, a.imgW, a.imgH, u, v, a.invert, a.densityCurve
    );
    out[i] = { x: u, y: v, density: d };
  }
  return out;
}

// Pooled variant of finalizePoints for the synchronous CPU bake: re-sample
// density at scratch.xs/ys[0..n) and write into the reused scratch.ptList
// (objects mutated in place, length pinned to n) instead of allocating n fresh
// RawPoints every frame. Returns the list, which becomes state.relaxResultPts.
function finalizeInto(
  s: BakeScratch, n: number,
  densityImage: Float32Array,
  a: ScatterArgs
): RawPoint[] {
  const list = s.ptList;
  list.length = n;
  for (let i = 0; i < n; i++) {
    const u = s.xs[i];
    const v = s.ys[i];
    const d = sampleDensityCPU(
      densityImage, a.imgW, a.imgH, u, v, a.invert, a.densityCurve
    );
    s.densities[i] = d;
    let o = list[i];
    if (!o) {
      o = { x: 0, y: 0, density: 0 };
      list[i] = o;
    }
    o.x = u;
    o.y = v;
    o.density = d;
  }
  return list;
}

// Bucket raw positions into a cell-lookup texture (RGBA32F).
//
//   .rg = baked dot position in UV space
//   .b  = density at that position
//   .a  = 1.0 = fully alive (or any 0..1 life value when used by flow mode)
//
// If multiple points land in the same cell, the higher-life one wins.
// For static packed mode every life is 1.0 so it's effectively "last
// non-empty wins"; for flow mode this hides collisions between
// shrinking and growing dots that briefly overlap during transitions.
function buildCellData(
  points: Array<{ x: number; y: number; density: number; life: number }>,
  cellsX: number, cellsY: number
): Float32Array {
  const cellData = new Float32Array(cellsX * cellsY * 4);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.life <= 0) continue;
    const cx = Math.max(0, Math.min(cellsX - 1, Math.floor(p.x * cellsX)));
    const cy = Math.max(0, Math.min(cellsY - 1, Math.floor(p.y * cellsY)));
    const idx = (cy * cellsX + cx) * 4;
    if (cellData[idx + 3] > p.life) continue;
    cellData[idx + 0] = p.x;
    cellData[idx + 1] = p.y;
    cellData[idx + 2] = p.density;
    cellData[idx + 3] = p.life;
  }
  return cellData;
}

// Static-packed variant of buildCellData: all dots are fully alive (life = 1),
// so it skips the life logic and writes into a persistent `out` buffer (zeroed
// each call) — no per-frame Float32Array and no intermediate {...p, life}
// object array. "Last point in a cell wins", matching buildCellData when every
// life is equal.
function fillCellDataStatic(
  points: RawPoint[],
  cellsX: number, cellsY: number,
  out: Float32Array
): Float32Array {
  out.fill(0, 0, cellsX * cellsY * 4);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const cx = Math.max(0, Math.min(cellsX - 1, Math.floor(p.x * cellsX)));
    const cy = Math.max(0, Math.min(cellsY - 1, Math.floor(p.y * cellsY)));
    const idx = (cy * cellsX + cx) * 4;
    out[idx + 0] = p.x;
    out[idx + 1] = p.y;
    out[idx + 2] = p.density;
    out[idx + 3] = 1;
  }
  return out;
}

// Downsample the source into a small RGBA texture and read that back, instead
// of reading the whole canvas every bake. Scatter/relax only sample density at
// ~cell granularity (packed is ≤1 dot/cell), so a (sampW × sampH) field is
// plenty and the GPU→CPU read shrinks by orders of magnitude. The pooled target
// is LINEAR, so the blit is a real bilinear box-ish downsample; sampling and
// readback share the source's v_uv space, so point positions are unaffected.
// Falls back to a direct full-res read when the sampler isn't actually smaller.
const FS_DOWNSAMPLE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() { outColor = texture(u_src, v_uv); }`;

function readDensityField(
  ctx: RenderContext, state: StippleState,
  src: ImageValue, sampW: number, sampH: number
): Float32Array {
  if (sampW >= src.width && sampH >= src.height) {
    return ctx.readImageToFloat32(src);
  }
  let img = state.densityImg;
  if (!img || img.width !== sampW || img.height !== sampH) {
    if (img) ctx.releaseTexture(img.texture);
    img = ctx.allocImage({ width: sampW, height: sampH });
    state.densityImg = img;
  }
  const prog = ctx.getShader("stipple/downsample", FS_DOWNSAMPLE);
  ctx.drawFullscreen(prog, img, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
  });
  return ctx.readImageToFloat32(img);
}

// =====================================================================
// Relaxation orchestration — CPU sync or WebGPU async
// =====================================================================

// Fire-and-forget WebGPU bake. Scatter has already run on the CPU; this
// uploads the fixed point set, runs the relaxation kernel, reads it back,
// and stores the finalized result on `state`. Errors are swallowed into a
// permanent CPU fallback. Always requests a follow-up eval so the result
// is consumed even on a paused scene.
async function launchGpuRelax(
  ctx: RenderContext,
  state: StippleState,
  paramsRef: object,
  bakeKey: string,
  srcTex: WebGLTexture | null,
  xs: Float32Array,
  ys: Float32Array,
  srcData: Float32Array,
  a: ScatterArgs,
  r: RelaxArgs
): Promise<void> {
  try {
    const status = await ensureWebGPUDevice(ctx);
    if (!status.ok) throw new Error(status.message);
    const cells = a.cellsX * a.cellsY;
    state.gpu = ensureStippleRelaxGPU(
      status.device, state.gpu, xs.length, cells, srcData.length
    );
    const relaxed = await runStippleRelax(state.gpu, xs, ys, srcData, {
      cellsX: a.cellsX,
      cellsY: a.cellsY,
      imgW: a.imgW,
      imgH: a.imgH,
      invert: a.invert,
      curve: a.densityCurve,
      stepBase: computeStepBase(r.relaxStrength, a.cellsX, a.cellsY),
      iterations: r.iterations,
    });
    if (state.disposed) return;
    state.relaxResultPts = finalizePoints(relaxed.xs, relaxed.ys, srcData, a);
    state.relaxResultKey = bakeKey;
    state.relaxResultSrc = srcTex;
    state.relaxResultGen++;
  } catch (e) {
    console.warn("Stipple GPU relax failed; falling back to CPU.", e);
    state.gpuFailed = true;
    // Invalidate so the next compute() rebakes on the CPU path.
    state.relaxResultKey = "";
    state.relaxResultSrc = null;
  } finally {
    relaxPending.set(paramsRef, false);
    if (state.relaxBusyKey === bakeKey) state.relaxBusyKey = null;
    requestPipelineReeval();
  }
}

// Return the freshest relaxed point set for the current (params, source),
// kicking off a fresh bake when the held result is stale. The returned
// `gen` lets callers detect a new set without comparing arrays. The GPU
// path is async: it returns a seed (un-relaxed) or stale set immediately
// and the relaxed set lands a frame or two later.
function ensureRelaxedTargets(
  ctx: RenderContext,
  state: StippleState,
  src: ImageValue,
  paramsRef: object,
  bakeKey: string,
  a: ScatterArgs,
  r: RelaxArgs,
  scratch: BakeScratch,
  gpuOk: boolean
): { pts: RawPoint[]; gen: number } {
  const stale =
    state.relaxResultKey !== bakeKey || state.relaxResultSrc !== src.texture;

  const useGpu =
    gpuOk &&
    !state.gpuFailed &&
    r.iterations > 0 &&
    a.targetPoints >= GPU_RELAX_MIN_POINTS;

  if (useGpu) {
    if (stale && state.relaxBusyKey === null) {
      const srcData = readDensityField(ctx, state, src, a.imgW, a.imgH);
      // Scatter is synchronous and consumed before any async work, so it can
      // share the pooled scratch. The relaxed-result objects, however, are
      // produced in launchGpuRelax's deferred callback — that path keeps
      // allocating (pooling across async would race), so it uses finalizePoints
      // on copies of the seed positions.
      const n = scatterInto(scratch, srcData, a);
      if (n === 0) {
        // Degenerate scatter (near-white image): nothing to relax. Settle
        // synchronously on the empty set so we don't spin launching jobs.
        state.relaxResultPts = [];
        state.relaxResultKey = bakeKey;
        state.relaxResultSrc = src.texture;
        state.relaxResultGen++;
        relaxPending.set(paramsRef, false);
      } else {
        const xs = scratch.xs.subarray(0, n);
        const ys = scratch.ys.subarray(0, n);
        // Seed an un-relaxed result so the first frame before the GPU bake
        // lands shows points rather than a blank / stale image.
        if (!state.relaxResultPts) {
          state.relaxResultPts = finalizePoints(xs, ys, srcData, a);
          state.relaxResultKey = bakeKey;
          state.relaxResultSrc = src.texture;
          state.relaxResultGen++;
        }
        state.relaxBusyKey = bakeKey;
        relaxPending.set(paramsRef, true);
        const job = launchGpuRelax(
          ctx, state, paramsRef, bakeKey, src.texture,
          Float32Array.from(xs), Float32Array.from(ys), srcData, a, r
        );
        if (ctx.offline) {
          // Deterministic export: register the relax job so the two-pass
          // render waits for the GPU readback, then re-renders with the
          // settled result. Realtime leaves it fire-and-forget — the
          // continuous loop picks the result up via pipeline-bump.
          pushMediaSettle(ctx, job);
        } else {
          void job;
        }
      }
    }
    return { pts: state.relaxResultPts ?? [], gen: state.relaxResultGen };
  }

  // CPU path: no WebGPU, GPU failed, relax disabled, or below threshold.
  if (stale) {
    const srcData = readDensityField(ctx, state, src, a.imgW, a.imgH);
    const n = scatterInto(scratch, srcData, a);
    relaxInto(scratch, n, srcData, a, r);
    state.relaxResultPts = finalizeInto(scratch, n, srcData, a);
    state.relaxResultKey = bakeKey;
    state.relaxResultSrc = src.texture;
    state.relaxResultGen++;
    relaxPending.set(paramsRef, false);
  }
  return { pts: state.relaxResultPts ?? [], gen: state.relaxResultGen };
}

// =====================================================================
// packed-flow — persistent dot identity across rebakes
// =====================================================================

// Match the new bake's targets to existing flow dots using
// nearest-neighbour within `maxMatchDistance` (UV space). Targets that
// find a match update that dot's `targetX/Y` and force `fadeDir=+1`
// (so a dot that was dying can be reclaimed). Unmatched targets spawn
// new dots at life=0. Old dots not matched have their fadeDir flipped
// to -1 so they fade out.
//
// Uses a spatial bin keyed on the cell grid so a target only scans
// a few cells of dots, not all of them.
function matchFlowTargets(
  dots: FlowDot[],
  targets: RawPoint[],
  maxMatchDistance: number,
  cellsX: number, cellsY: number
) {
  const originalCount = dots.length;
  const matched = new Uint8Array(originalCount);

  // Bin existing dots by their current position so a target can scan
  // only nearby cells. Targets cluster around dense areas of the
  // input, so this is much cheaper than O(targets × dots).
  const bins = new Map<number, number[]>();
  for (let i = 0; i < originalCount; i++) {
    const cx = Math.max(0, Math.min(cellsX - 1, Math.floor(dots[i].x * cellsX)));
    const cy = Math.max(0, Math.min(cellsY - 1, Math.floor(dots[i].y * cellsY)));
    const key = cy * cellsX + cx;
    const arr = bins.get(key);
    if (arr) arr.push(i);
    else bins.set(key, [i]);
  }

  const maxDist2 = maxMatchDistance * maxMatchDistance;
  const searchRadius = Math.max(1, Math.ceil(maxMatchDistance * cellsX));

  for (let t = 0; t < targets.length; t++) {
    const target = targets[t];
    const cx = Math.max(0, Math.min(cellsX - 1, Math.floor(target.x * cellsX)));
    const cy = Math.max(0, Math.min(cellsY - 1, Math.floor(target.y * cellsY)));

    let best = -1;
    let bestDist2 = maxDist2;
    for (let oy = -searchRadius; oy <= searchRadius; oy++) {
      for (let ox = -searchRadius; ox <= searchRadius; ox++) {
        const ncx = cx + ox;
        const ncy = cy + oy;
        if (ncx < 0 || ncy < 0 || ncx >= cellsX || ncy >= cellsY) continue;
        const bucket = bins.get(ncy * cellsX + ncx);
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const i = bucket[k];
          if (matched[i]) continue;
          const dx = target.x - dots[i].x;
          const dy = target.y - dots[i].y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestDist2) {
            bestDist2 = d2;
            best = i;
          }
        }
      }
    }

    if (best >= 0) {
      const dot = dots[best];
      dot.targetX = target.x;
      dot.targetY = target.y;
      dot.density = target.density;
      dot.fadeDir = 1;
      matched[best] = 1;
    } else {
      dots.push({
        x: target.x, y: target.y,
        targetX: target.x, targetY: target.y,
        density: target.density,
        life: 0, fadeDir: 1,
      });
    }
  }

  // Anything that didn't get matched is now dying. (Don't touch the
  // newly-appended dots — they're past originalCount.)
  for (let i = 0; i < originalCount; i++) {
    if (!matched[i]) dots[i].fadeDir = -1;
  }
}

// One simulation tick. Advance life toward 0 or 1 at the per-direction
// rate, lerp position toward target with an exponential approach so
// the speed param is frame-rate independent, and reap dots that have
// fully faded out. `dt` is wall-clock seconds since the last tick.
function stepFlowDots(
  dots: FlowDot[], dt: number,
  fadeInTime: number, fadeOutTime: number, flowSpeed: number
): FlowDot[] {
  const lerp = 1.0 - Math.exp(-dt * Math.max(0.01, flowSpeed));
  const out: FlowDot[] = [];
  for (let i = 0; i < dots.length; i++) {
    const d = dots[i];
    const fadeTime = d.fadeDir > 0 ? fadeInTime : fadeOutTime;
    d.life += d.fadeDir * (dt / Math.max(0.01, fadeTime));
    if (d.life > 1) d.life = 1;
    if (d.life < 0) d.life = 0;
    d.x += (d.targetX - d.x) * lerp;
    d.y += (d.targetY - d.y) * lerp;
    if (d.life > 0 || d.fadeDir > 0) out.push(d);
  }
  return out;
}

function ensureCellTexture(
  ctx: RenderContext,
  state: StippleState,
  data: Float32Array,
  cellsX: number, cellsY: number
) {
  const gl = ctx.gl;
  const needsRealloc =
    !state.cellTexture || state.cellsX !== cellsX || state.cellsY !== cellsY;
  if (needsRealloc) {
    if (state.cellTexture) gl.deleteTexture(state.cellTexture);
    state.cellTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, state.cellTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA32F, cellsX, cellsY, 0,
      gl.RGBA, gl.FLOAT, data
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    state.cellsX = cellsX;
    state.cellsY = cellsY;
  } else {
    gl.bindTexture(gl.TEXTURE_2D, state.cellTexture!);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, cellsX, cellsY,
      gl.RGBA, gl.FLOAT, data
    );
  }
}

// =====================================================================
// Node definition
// =====================================================================

export const stippleNode: NodeDefinition = {
  type: "stipple",
  name: "Stipple",
  category: "image",
  subcategory: "modifier",
  description:
    "Re-renders the input as a field of dots whose size and density follow input darkness. Grid (jittered halftone-ish), Screen (stochastic), Packed (organic relaxed-Poisson), and Packed-Flow (persistent dots with fade-in/out + position lerp for animated inputs) modes share the same edge-noise and colorization layer.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "mode", label: "Mode", type: "enum",
      options: [...MODES], default: "grid",
    },
    {
      name: "gridSize", label: "Grid Density", type: "scalar",
      min: 10, max: 500, step: 1, default: 120,
    },
    {
      name: "densityCurve", label: "Density Curve", type: "scalar",
      min: 0.1, max: 5, step: 0.01, default: 1.0,
    },
    { name: "invert", label: "Invert", type: "boolean", default: false },
    {
      name: "threshold", label: "Threshold", type: "scalar",
      min: 0, max: 1, step: 0.001, default: 0.02,
      visibleIf: (p) => p.mode === "grid",
    },
    {
      name: "pointCount", label: "Point Count", type: "scalar",
      min: 100, max: 20000, step: 1, default: 4000,
      visibleIf: (p) => p.mode === "packed" || p.mode === "packed-flow",
    },
    {
      name: "relaxIterations", label: "Relax Iterations", type: "scalar",
      min: 0, max: 20, step: 1, default: 4,
      visibleIf: (p) => p.mode === "packed" || p.mode === "packed-flow",
    },
    {
      name: "relaxStrength", label: "Relax Strength", type: "scalar",
      min: 0, max: 3, step: 0.01, default: 1.0,
      visibleIf: (p) => p.mode === "packed" || p.mode === "packed-flow",
    },
    {
      name: "packedSeed", label: "Seed", type: "scalar",
      min: 0, max: 9999, step: 1, default: 1,
      visibleIf: (p) => p.mode === "packed" || p.mode === "packed-flow",
    },
    {
      // Density sampler resolution as a multiple of grid cells. The source is
      // downsampled to this size before dot positions are computed: lower is
      // faster (less GPU→CPU readback) but blockier; higher recovers detail up
      // to the source resolution. The main lever for animated-input speed.
      name: "samplerResolution", label: "Sampler Resolution", type: "scalar",
      min: 0.5, max: 8, step: 0.1, default: 2,
      visibleIf: (p) => p.mode === "packed" || p.mode === "packed-flow",
    },
    {
      name: "fadeInTime", label: "Fade In (s)", type: "scalar",
      min: 0.01, max: 5, step: 0.01, default: 0.4,
      visibleIf: (p) => p.mode === "packed-flow",
    },
    {
      name: "fadeOutTime", label: "Fade Out (s)", type: "scalar",
      min: 0.01, max: 5, step: 0.01, default: 0.6,
      visibleIf: (p) => p.mode === "packed-flow",
    },
    {
      name: "flowSpeed", label: "Flow Speed", type: "scalar",
      min: 0.1, max: 30, step: 0.1, default: 4,
      visibleIf: (p) => p.mode === "packed-flow",
    },
    {
      name: "maxMatchDistance", label: "Max Match Dist", type: "scalar",
      min: 0, max: 1, step: 0.001, default: 0.08,
      visibleIf: (p) => p.mode === "packed-flow",
    },
    {
      name: "dotMinSize", label: "Dot Min Size", type: "scalar",
      min: 0, max: 3, step: 0.01, default: 0.1,
    },
    {
      name: "dotMaxSize", label: "Dot Max Size", type: "scalar",
      min: 0, max: 3, step: 0.01, default: 1.4,
    },
    {
      name: "jitterMin", label: "Jitter Min", type: "scalar",
      min: 0, max: 1, step: 0.01, default: 0.0,
      visibleIf: (p) => p.mode === "grid" || p.mode === "screen",
    },
    {
      name: "jitterMax", label: "Jitter Max", type: "scalar",
      min: 0, max: 1, step: 0.01, default: 0.6,
      visibleIf: (p) => p.mode === "grid" || p.mode === "screen",
    },
    {
      name: "jitterBias", label: "Jitter Bias", type: "scalar",
      min: 0.1, max: 5, step: 0.01, default: 1.0,
      visibleIf: (p) => p.mode === "grid" || p.mode === "screen",
    },
    {
      name: "noiseScale", label: "Edge Noise Scale", type: "scalar",
      min: 0.1, max: 40, step: 0.1, default: 6,
    },
    {
      name: "noiseRoughness", label: "Edge Roughness", type: "scalar",
      min: 0, max: 1, step: 0.01, default: 0.4,
    },
    {
      name: "noiseStrength", label: "Edge Strength", type: "scalar",
      min: 0, max: 1, step: 0.01, default: 0.18,
    },
    { name: "dotColor", label: "Dot Color", type: "color", default: "#4ca134" },
    { name: "backgroundColor", label: "Background", type: "color", default: "#ece5d0" },
    {
      name: "backgroundAlpha", label: "Background Alpha", type: "scalar",
      min: 0, max: 1, step: 0.01, default: 1.0,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],
  linkedPairs: [{ a: "dotMinSize", b: "dotMaxSize" }],

  // packed-flow ticks every frame so dots can animate even when the
  // upstream input is static. packed forces a recompute only while an
  // async GPU relax bake is pending, so the result is picked up even on a
  // paused scene (see relaxPending / requestPipelineReeval). Other modes
  // are purely fingerprint-driven and need no time mixed in.
  fingerprintExtras(params, ctx) {
    if (params.mode === "packed-flow") return `t:${ctx.time.toFixed(3)}`;
    if (params.mode === "packed" && relaxPending.get(params)) {
      return `p:${ctx.time.toFixed(3)}`;
    }
    return "";
  },

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const src = inputs["image"];
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const mode = ((params.mode as string) ?? "grid") as Mode;

    // Shared params
    const gridSize = Math.max(1, (params.gridSize as number) ?? 120);
    const densityCurve = Math.max(0.0001, (params.densityCurve as number) ?? 1);
    const invert = (params.invert as boolean) ? 1 : 0;
    const dotMinRaw = Math.max(0, (params.dotMinSize as number) ?? 0.1);
    const dotMaxRaw = Math.max(0, (params.dotMaxSize as number) ?? 1.4);
    const dotMin = Math.min(dotMinRaw, dotMaxRaw);
    const dotMax = Math.max(dotMinRaw, dotMaxRaw);
    const noiseScale = (params.noiseScale as number) ?? 6;
    const noiseRoughness = (params.noiseRoughness as number) ?? 0.4;
    const noiseStrength = (params.noiseStrength as number) ?? 0.18;
    const bgAlpha = (params.backgroundAlpha as number) ?? 1;

    const [dr, dg, db] = hexToRgb((params.dotColor as string) ?? "#4ca134");
    const [bgR, bgG, bgB] = hexToRgb((params.backgroundColor as string) ?? "#ece5d0");

    if (mode === "packed" || mode === "packed-flow") {
      // ----- Packed (and packed-flow) shared setup -----
      const pointCount = Math.max(10, Math.floor((params.pointCount as number) ?? 4000));
      const relaxIterations = Math.max(0, Math.floor((params.relaxIterations as number) ?? 4));
      const relaxStrength = Math.max(0, (params.relaxStrength as number) ?? 1);
      const seed = Math.floor((params.packedSeed as number) ?? 1);

      const aspect = output.width / output.height;
      const realCellsX = aspect >= 1
        ? Math.max(2, Math.round(gridSize * aspect))
        : Math.max(2, Math.round(gridSize));
      const realCellsY = aspect >= 1
        ? Math.max(2, Math.round(gridSize))
        : Math.max(2, Math.round(gridSize / aspect));

      const key = stateKey(nodeId);
      let state = ctx.state[key] as StippleState | undefined;
      if (!state) {
        state = {
          cellTexture: null, cellsX: 0, cellsY: 0,
          densityImg: null, bakeScratch: null,
          flowDots: [], lastFlowTime: ctx.time,
          relaxResultPts: null, relaxResultKey: "", relaxResultSrc: null,
          relaxResultGen: 0, renderedGen: -1, matchedGen: -1,
          relaxBusyKey: null, gpu: null, gpuFailed: false, disposed: false,
        };
        ctx.state[key] = state;
      }

      // Density sampler resolution: a multiple of the cell grid (aspect comes
      // from the cells), capped at the source so a high value degrades to a
      // full-res read. Scatter/relax only need ~cell-granular density, so this
      // is what lets the animated-input bake avoid a full-canvas readback.
      const samplerResolution = Math.max(0.1, (params.samplerResolution as number) ?? 2);
      const sampW = Math.max(4, Math.min(src.width, Math.round(realCellsX * samplerResolution)));
      const sampH = Math.max(4, Math.min(src.height, Math.round(realCellsY * samplerResolution)));

      const bakeKey = [
        src.width, src.height,
        pointCount, relaxIterations, relaxStrength.toFixed(3),
        densityCurve.toFixed(3), invert, seed,
        realCellsX, realCellsY, sampW, sampH,
      ].join("|");

      // Kick the WebGPU boot once (async, cached); use the resolved status
      // synchronously thereafter. Until it resolves the relaxation runs on
      // the CPU — a brief warmup, not a fallback.
      //
      // Offline export also uses the GPU: the relax job registers itself as
      // a settle promise (see ensureRelaxedTargets), so the two-pass export
      // render waits for the readback and captures the settled result. This
      // keeps export visually identical to the realtime preview.
      void ensureWebGPUDevice(ctx);
      const gpuOk = peekWebGPUDevice(ctx)?.ok === true;

      const scatterArgs: ScatterArgs = {
        imgW: sampW, imgH: sampH,
        cellsX: realCellsX, cellsY: realCellsY,
        targetPoints: pointCount,
        invert: invert === 1, densityCurve, seed,
      };
      const relaxArgs: RelaxArgs = {
        iterations: relaxIterations, relaxStrength,
      };

      const scratch = ensureBakeScratch(
        state,
        Math.min(pointCount, realCellsX * realCellsY),
        realCellsX * realCellsY
      );

      const { pts, gen } = ensureRelaxedTargets(
        ctx, state, src, params, bakeKey, scatterArgs, relaxArgs, scratch, gpuOk
      );

      if (mode === "packed-flow") {
        // ----- Flow path: persistent dots, fade in/out, position lerp -----
        const fadeInTime = Math.max(0.01, (params.fadeInTime as number) ?? 0.4);
        const fadeOutTime = Math.max(0.01, (params.fadeOutTime as number) ?? 0.6);
        const flowSpeed = Math.max(0.01, (params.flowSpeed as number) ?? 4);
        const maxMatchDistance = Math.max(0, (params.maxMatchDistance as number) ?? 0.08);

        // Wall-clock dt for this tick. Clamp to a sensible upper bound
        // so a long pause (tab inactive) doesn't snap everything to
        // its target in a single frame.
        const rawDt = ctx.time - state.lastFlowTime;
        const dt = Math.max(0, Math.min(0.1, rawDt));
        state.lastFlowTime = ctx.time;

        // A fresh relaxed set (new gen) is the trigger to re-match. Until
        // one lands the dots keep flowing toward their existing targets.
        if (gen !== state.matchedGen) {
          if (state.flowDots.length === 0) {
            // First bake: seed dots at full life so the user sees
            // something immediately instead of a one-fadeInTime wait.
            for (let i = 0; i < pts.length; i++) {
              const t = pts[i];
              state.flowDots.push({
                x: t.x, y: t.y, targetX: t.x, targetY: t.y,
                density: t.density, life: 1, fadeDir: 1,
              });
            }
          } else {
            matchFlowTargets(
              state.flowDots, pts, maxMatchDistance,
              realCellsX, realCellsY
            );
          }
          state.matchedGen = gen;
        }

        state.flowDots = stepFlowDots(
          state.flowDots, dt, fadeInTime, fadeOutTime, flowSpeed
        );

        const cellData = buildCellData(state.flowDots, realCellsX, realCellsY);
        ensureCellTexture(ctx, state, cellData, realCellsX, realCellsY);
      } else {
        // ----- Static packed path -----
        // Rebuild the cell texture whenever a new relaxed set has landed
        // (gen changed) — this includes the async GPU result arriving on a
        // later frame, not just the synchronous CPU path.
        const cellsChanged =
          state.cellsX !== realCellsX || state.cellsY !== realCellsY;
        if (gen !== state.renderedGen || cellsChanged || !state.cellTexture) {
          const cellData = fillCellDataStatic(
            pts, realCellsX, realCellsY, scratch.cellData
          );
          ensureCellTexture(ctx, state, cellData, realCellsX, realCellsY);
          state.renderedGen = gen;
        }
      }

      const prog = ctx.getShader("stipple/packed", FS_PACKED);
      ctx.drawFullscreen(prog, output, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, state!.cellTexture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_cells"), 0);
        gl.uniform2f(gl.getUniformLocation(prog, "u_cellsRes"), state!.cellsX, state!.cellsY);
        gl.uniform2f(gl.getUniformLocation(prog, "u_resolution"), output.width, output.height);
        gl.uniform1f(gl.getUniformLocation(prog, "u_dotMin"), dotMin);
        gl.uniform1f(gl.getUniformLocation(prog, "u_dotMax"), dotMax);
        gl.uniform1f(gl.getUniformLocation(prog, "u_noiseScale"), noiseScale);
        gl.uniform1f(gl.getUniformLocation(prog, "u_noiseRoughness"), noiseRoughness);
        gl.uniform1f(gl.getUniformLocation(prog, "u_noiseStrength"), noiseStrength);
        gl.uniform3f(gl.getUniformLocation(prog, "u_dotColor"), dr, dg, db);
        gl.uniform3f(gl.getUniformLocation(prog, "u_bgColor"), bgR, bgG, bgB);
        gl.uniform1f(gl.getUniformLocation(prog, "u_bgAlpha"), bgAlpha);
      });
      return { primary: output };
    }

    // ----- Grid / Screen mode -----
    const threshold = (params.threshold as number) ?? 0.02;
    const jMinRaw = Math.max(0, (params.jitterMin as number) ?? 0);
    const jMaxRaw = Math.max(0, (params.jitterMax as number) ?? 0.6);
    const jitterMin = Math.min(jMinRaw, jMaxRaw);
    const jitterMax = Math.max(jMinRaw, jMaxRaw);
    const jitterBias = Math.max(0.0001, (params.jitterBias as number) ?? 1);
    const modeInt = modeToInt(mode);

    const prog = ctx.getShader("stipple/grid", FS_GRID_SCREEN);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform2f(gl.getUniformLocation(prog, "u_resolution"), output.width, output.height);
      gl.uniform1f(gl.getUniformLocation(prog, "u_gridSize"), gridSize);
      gl.uniform1f(gl.getUniformLocation(prog, "u_densityCurve"), densityCurve);
      gl.uniform1i(gl.getUniformLocation(prog, "u_invert"), invert);
      gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), modeInt);
      gl.uniform1f(gl.getUniformLocation(prog, "u_threshold"), threshold);
      gl.uniform1f(gl.getUniformLocation(prog, "u_dotMin"), dotMin);
      gl.uniform1f(gl.getUniformLocation(prog, "u_dotMax"), dotMax);
      gl.uniform1f(gl.getUniformLocation(prog, "u_jitterMin"), jitterMin);
      gl.uniform1f(gl.getUniformLocation(prog, "u_jitterMax"), jitterMax);
      gl.uniform1f(gl.getUniformLocation(prog, "u_jitterBias"), jitterBias);
      gl.uniform1f(gl.getUniformLocation(prog, "u_noiseScale"), noiseScale);
      gl.uniform1f(gl.getUniformLocation(prog, "u_noiseRoughness"), noiseRoughness);
      gl.uniform1f(gl.getUniformLocation(prog, "u_noiseStrength"), noiseStrength);
      gl.uniform3f(gl.getUniformLocation(prog, "u_dotColor"), dr, dg, db);
      gl.uniform3f(gl.getUniformLocation(prog, "u_bgColor"), bgR, bgG, bgB);
      gl.uniform1f(gl.getUniformLocation(prog, "u_bgAlpha"), bgAlpha);
    });

    return { primary: output };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const key = stateKey(nodeId);
    const state = ctx.state[key] as StippleState | undefined;
    if (state) {
      // Flag for any in-flight GPU bake so its async callback bails
      // instead of writing into freed state.
      state.disposed = true;
      if (state.cellTexture) ctx.gl.deleteTexture(state.cellTexture);
      if (state.densityImg) ctx.releaseTexture(state.densityImg.texture);
      if (state.gpu) destroyStippleRelaxGPU(state.gpu);
    }
    delete ctx.state[key];
  },
};
