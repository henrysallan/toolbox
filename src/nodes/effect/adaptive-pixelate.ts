import type { ImageValue, NodeDefinition, RenderContext } from "@/engine/types";
import { OPACITY_PARAM } from "@/engine/conventions";
import { readDriver } from "@/engine/driver-reduce";
import { EMPTY_POINTS, makePoints } from "@/engine/points";

// Adaptive Pixelate — non-constant pixel grids (specdocs/072326_adaptive-
// pixelate.md). Block size is driven by a luminance map: the `size_map` mask
// input (images coerce in as luminance × alpha, splines as their silhouette)
// or, unwired, the source's own luminance. Modes: `uniform` (plain grid),
// `quadtree` (cells split 4-ways where the driver calls for detail),
// `lattice` (full-span rows/columns whose spacing crowds where the driver
// calls for detail).
//
// Architecture: the grid is CPU-AUTHORITATIVE. The GPU reduces the driver to
// a small grid (two separable box passes), a readback hands it to the CPU,
// the CPU builds the cell list (quadtree recursion / lattice inverse-CDF),
// and the grid uploads as lookup textures the single image pass reads
// through — an RGBA32F cell-rect texture at finest-grid resolution
// (quadtree/uniform; cells are unions of finest texels, so it's exact) or
// two per-canvas-pixel axis LUTs (lattice; cuts round to integer px, so
// pixel granularity is exact). One authority means the image pass and the
// points aux can never disagree on a threshold cell.
//
// The points aux (one point per cell) is built UNCONDITIONALLY, not gated on
// consumedOutputs: this node caches, and consumption isn't part of the
// fingerprint — a cache entry built while points were unconsumed would serve
// empty points forever once wired (the loop-weave lesson, 072226 audit #5).
// The grid is already CPU-side for the image pass, so points are ~free.

// The driver reduce/readback (luminance → small grid → CPU) lives in the
// shared engine/driver-reduce.ts — Bento Slice builds its bento grid from
// the same passes.

// Passthrough copy — fills level 0 of the private mipmapped source copy
// (`sample: average` samples its mip chain with textureLod).
const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() { outColor = texture(u_src, v_uv); }`;

// Final pass: resolve this fragment's cell rect (center px y-down + size px)
// from the grid lookup, then sample the source at the cell center — a plain
// center tap, or a mip-chain area tap at the cell's LOD (geometric mean of
// the two axes; lattice cells are non-square).
const APPLY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;     // source (canvas res)
uniform sampler2D u_srcMip;  // mipmapped copy (average mode; else = u_src)
uniform sampler2D u_cells;   // quadtree/uniform: finest-grid rect texture
uniform sampler2D u_cols;    // lattice: W x 1 (centerX px, w px)
uniform sampler2D u_rows;    // lattice: H x 1 (centerY px y-down, h px)
uniform vec2 u_res;          // canvas px
uniform float u_cellPx;      // finest cell size px (index-texture grids)
uniform int u_grid;          // 0: cell-rect texture, 1: per-axis lattice
uniform int u_sample;        // 0: center tap, 1: mip area average
out vec4 outColor;

void main() {
  vec2 pTop = vec2(v_uv.x, 1.0 - v_uv.y) * u_res;  // px, y-down
  vec4 rect;
  if (u_grid == 1) {
    int px = clamp(int(pTop.x), 0, int(u_res.x) - 1);
    int py = clamp(int(pTop.y), 0, int(u_res.y) - 1);
    vec4 c = texelFetch(u_cols, ivec2(px, 0), 0);
    vec4 r = texelFetch(u_rows, ivec2(py, 0), 0);
    rect = vec4(c.x, r.x, c.y, r.y);
  } else {
    ivec2 dims = textureSize(u_cells, 0);
    ivec2 g = clamp(ivec2(floor(pTop / u_cellPx)), ivec2(0), dims - 1);
    rect = texelFetch(u_cells, g, 0);
  }
  vec2 srcUv = vec2(rect.x / u_res.x, 1.0 - rect.y / u_res.y);
  if (u_sample == 1) {
    float lod = 0.5 * log2(max(rect.z * rect.w, 1.0));
    outColor = textureLod(u_srcMip, srcUv, lod);
  } else {
    outColor = texture(u_src, srcUv);
  }
}`;

const MAX_LEVELS = 8;
// Cap the finest-grid area (index texture texels). RGBA32F is 16B/texel —
// 1M texels = 16MB upload worst case; beyond that, drop a subdivision level.
const MAX_GRID_TEXELS = 1 << 20;

interface Cell {
  cx: number; // center px, y-down
  cy: number;
  w: number;
  h: number;
  level: number;
}

interface Span {
  x0: number;
  w: number;
}

interface PixState {
  indexTex: WebGLTexture | null;
  colTex: WebGLTexture | null;
  rowTex: WebGLTexture | null;
  mipTex: WebGLTexture | null;
  mipW: number;
  mipH: number;
}

const stateKey = (nodeId: string) => `adaptive-pixelate:${nodeId}`;

function getState(ctx: RenderContext, nodeId: string): PixState {
  let s = ctx.state[stateKey(nodeId)] as PixState | undefined;
  if (!s) {
    s = {
      indexTex: null,
      colTex: null,
      rowTex: null,
      mipTex: null,
      mipW: 0,
      mipH: 0,
    };
    ctx.state[stateKey(nodeId)] = s;
  }
  return s;
}

// driver value → desired block size in px. Bright drives SMALL blocks
// (detail) by default; `invert` flips; `gamma` shapes the response.
function makeSizeMap(
  blockMin: number,
  blockMax: number,
  invert: boolean,
  gamma: number
): (d: number) => number {
  return (d) => {
    let t = Math.min(1, Math.max(0, invert ? 1 - d : d));
    t = Math.pow(t, gamma);
    return blockMax + (blockMin - blockMax) * t;
  };
}

// Build the quadtree cell list + the finest-grid index rects. `driver` is
// the finest-grid readback (y-down rows, nx×ny where nx = Nx << levels).
function buildQuadtree(
  driver: Float32Array,
  nx: number,
  ny: number,
  levels: number,
  coarsePx: number,
  canvasW: number,
  canvasH: number,
  sizeFor: (d: number) => number
): { cells: Cell[]; rects: Float32Array } {
  // Pyramid of per-cell driver averages, level 0 = coarsest (Nx×Ny),
  // level `levels` = finest (nx×ny). Dims are exact power-of-two multiples
  // by construction, so the 2×2 reduce is alignment-exact.
  const pyr: Float32Array[] = new Array(levels + 1);
  const dims: [number, number][] = new Array(levels + 1);
  pyr[levels] = driver;
  dims[levels] = [nx, ny];
  for (let l = levels - 1; l >= 0; l--) {
    const [fw, fh] = dims[l + 1];
    const w = fw >> 1;
    const h = fh >> 1;
    const fine = pyr[l + 1];
    const coarse = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        coarse[j * w + i] =
          (fine[2 * j * fw + 2 * i] +
            fine[2 * j * fw + 2 * i + 1] +
            fine[(2 * j + 1) * fw + 2 * i] +
            fine[(2 * j + 1) * fw + 2 * i + 1]) *
          0.25;
      }
    }
    pyr[l] = coarse;
    dims[l] = [w, h];
  }

  const cells: Cell[] = [];
  const rects = new Float32Array(nx * ny * 4);

  const emit = (level: number, i: number, j: number) => {
    const s = coarsePx / (1 << level);
    const x = i * s;
    const y = j * s;
    // Cells fully outside the canvas exist only in the padded grid margin —
    // no fragment reads their index texels and no point should represent
    // them, but their rects still fill so the texture has no garbage.
    const inCanvas = x < canvasW && y < canvasH;
    const cell: Cell = { cx: x + s / 2, cy: y + s / 2, w: s, h: s, level };
    if (inCanvas) cells.push(cell);
    const span = 1 << (levels - level);
    for (let fy = j * span; fy < (j + 1) * span; fy++) {
      let o = (fy * nx + i * span) * 4;
      for (let fx = 0; fx < span; fx++) {
        rects[o] = cell.cx;
        rects[o + 1] = cell.cy;
        rects[o + 2] = cell.w;
        rects[o + 3] = cell.h;
        o += 4;
      }
    }
  };

  const subdivide = (level: number, i: number, j: number) => {
    const [w] = dims[level];
    const d = pyr[level][j * w + i];
    const s = coarsePx / (1 << level);
    if (level < levels && sizeFor(d) < s) {
      subdivide(level + 1, 2 * i, 2 * j);
      subdivide(level + 1, 2 * i + 1, 2 * j);
      subdivide(level + 1, 2 * i, 2 * j + 1);
      subdivide(level + 1, 2 * i + 1, 2 * j + 1);
    } else {
      emit(level, i, j);
    }
  };

  const [w0, h0] = dims[0];
  for (let j = 0; j < h0; j++) {
    for (let i = 0; i < w0; i++) subdivide(0, i, j);
  }
  return { cells, rects };
}

function buildUniform(
  size: number,
  canvasW: number,
  canvasH: number
): { cells: Cell[]; rects: Float32Array; nx: number; ny: number } {
  const nx = Math.max(1, Math.ceil(canvasW / size));
  const ny = Math.max(1, Math.ceil(canvasH / size));
  const cells: Cell[] = [];
  const rects = new Float32Array(nx * ny * 4);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cx = (i + 0.5) * size;
      const cy = (j + 0.5) * size;
      cells.push({ cx, cy, w: size, h: size, level: 0 });
      const o = (j * nx + i) * 4;
      rects[o] = cx;
      rects[o + 1] = cy;
      rects[o + 2] = size;
      rects[o + 3] = size;
    }
  }
  return { cells, rects, nx, ny };
}

// ============ lattice ============

// Average the driver grid down each column / row into 1D profiles.
function columnProfile(driver: Float32Array, nx: number, ny: number) {
  const out = new Float32Array(nx);
  for (let x = 0; x < nx; x++) {
    let sum = 0;
    for (let y = 0; y < ny; y++) sum += driver[y * nx + x];
    out[x] = sum / ny;
  }
  return out;
}

function rowProfile(driver: Float32Array, nx: number, ny: number) {
  const out = new Float32Array(ny);
  for (let y = 0; y < ny; y++) {
    let sum = 0;
    for (let x = 0; x < nx; x++) sum += driver[y * nx + x];
    out[y] = sum / nx;
  }
  return out;
}

// Importance-sample grid lines from a 1D driver profile: cell density is
// 1/desiredSize, cuts land at the inverse CDF of i/N, rounded to integer px
// (integer cuts are what make the per-pixel LUT lookup exact). Post-passes
// enforce the size bounds: cuts closer than blockMin merge, spans wider
// than blockMax split evenly.
function buildSpans(
  profile: Float32Array,
  samplePx: number,
  extentPx: number,
  sizeFor: (d: number) => number,
  blockMin: number,
  blockMax: number
): Span[] {
  const binW: number[] = [];
  const binC: number[] = []; // cells consumed by this bin (width × density)
  let total = 0;
  for (let i = 0; i < profile.length; i++) {
    const w = Math.min(samplePx, extentPx - i * samplePx);
    if (w <= 0) break;
    const c = w / sizeFor(profile[i]);
    binW.push(w);
    binC.push(c);
    total += c;
  }
  const N = Math.max(1, Math.round(total));
  const step = total / N;
  const cuts: number[] = [0];
  let acc = 0;
  let k = 1;
  for (let i = 0; i < binW.length && k < N; i++) {
    const inc = binC[i];
    while (k < N && acc + inc >= k * step) {
      const frac = inc > 0 ? (k * step - acc) / inc : 0;
      cuts.push(Math.round(i * samplePx + frac * binW[i]));
      k++;
    }
    acc += inc;
  }
  cuts.push(extentPx);

  // Merge cuts closer than blockMin (the trailing edge always survives).
  const merged: number[] = [0];
  for (let i = 1; i < cuts.length; i++) {
    const isLast = i === cuts.length - 1;
    if (isLast) {
      if (
        cuts[i] - merged[merged.length - 1] < blockMin &&
        merged.length > 1
      ) {
        merged.pop();
      }
      merged.push(cuts[i]);
    } else if (cuts[i] - merged[merged.length - 1] >= blockMin) {
      merged.push(cuts[i]);
    }
  }

  const spans: Span[] = [];
  for (let i = 0; i + 1 < merged.length; i++) {
    const x0 = merged[i];
    const w = merged[i + 1] - x0;
    const parts = Math.max(1, Math.ceil(w / blockMax));
    let start = x0;
    for (let p = 0; p < parts; p++) {
      const end = p === parts - 1 ? x0 + w : x0 + Math.round(((p + 1) * w) / parts);
      if (end > start) spans.push({ x0: start, w: end - start });
      start = end;
    }
  }
  return spans.length > 0 ? spans : [{ x0: 0, w: extentPx }];
}

// Per-canvas-pixel axis LUT: (cell center px, cell size px) for every pixel
// column (or row) — RGBA32F, extent×1.
function spansToLut(spans: Span[], extentPx: number): Float32Array {
  const lut = new Float32Array(extentPx * 4);
  for (const s of spans) {
    const c = s.x0 + s.w / 2;
    const end = Math.min(s.x0 + s.w, extentPx);
    for (let p = s.x0; p < end; p++) {
      lut[p * 4] = c;
      lut[p * 4 + 1] = s.w;
    }
  }
  return lut;
}

// ============ GPU plumbing ============

// Upload a Float32Array as an RGBA32F data texture (NEAREST, clamped),
// reusing the existing texture object when present.
function uploadDataTexture(
  ctx: RenderContext,
  existing: WebGLTexture | null,
  data: Float32Array,
  w: number,
  h: number
): WebGLTexture | null {
  const gl = ctx.gl;
  const tex = existing ?? gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

// Private mipmapped copy of the source for `sample: average` — copy into
// level 0 via the shared fullscreen path (a synthetic ImageValue is a legal
// drawFullscreen target: bindTarget only reads texture/width/height), then
// generateMipmap. RGBA16F is filterable + renderable in WebGL2, and NPOT
// mip generation is core.
function ensureMipCopy(
  ctx: RenderContext,
  state: PixState,
  src: ImageValue
): WebGLTexture | null {
  const gl = ctx.gl;
  if (state.mipTex && (state.mipW !== src.width || state.mipH !== src.height)) {
    gl.deleteTexture(state.mipTex);
    state.mipTex = null;
  }
  if (!state.mipTex) {
    const tex = gl.createTexture();
    if (!tex) return null;
    const levels = Math.floor(Math.log2(Math.max(src.width, src.height))) + 1;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, src.width, src.height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    state.mipTex = tex;
    state.mipW = src.width;
    state.mipH = src.height;
  }
  const target: ImageValue = {
    kind: "image",
    texture: state.mipTex,
    width: src.width,
    height: src.height,
  };
  const prog = ctx.getShader("adaptive-pixelate/copy", COPY_FS);
  ctx.drawFullscreen(prog, target, (gl2) => {
    gl2.activeTexture(gl2.TEXTURE0);
    gl2.bindTexture(gl2.TEXTURE_2D, src.texture);
    gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
  });
  gl.bindTexture(gl.TEXTURE_2D, state.mipTex);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return state.mipTex;
}

// Cell list → points aux: centers in normalized [0,1]² y-down, scales
// relative to the coarsest block (1.0 = a full-size block; quadtree children
// halve per level), groupIndex = subdivision level (0 = coarsest).
function cellsToPoints(
  cells: Cell[],
  canvasW: number,
  canvasH: number,
  blockRef: number
) {
  const pts = makePoints(cells.length, {
    withScales: true,
    withGroupIndices: true,
  });
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    pts.positions[i * 2] = c.cx / canvasW;
    pts.positions[i * 2 + 1] = c.cy / canvasH;
    pts.scales![i * 2] = c.w / blockRef;
    pts.scales![i * 2 + 1] = c.h / blockRef;
    pts.groupIndices![i] = c.level;
  }
  return pts;
}

export const adaptivePixelateNode: NodeDefinition = {
  type: "adaptive-pixelate",
  name: "Adaptive Pixelate",
  category: "image",
  subcategory: "modifier",
  description:
    "Pixelate with a non-constant grid: block size is driven by a luminance map (the Size Map input, or the image's own luminance). Quadtree mode splits blocks 4-ways where the map calls for detail; lattice mode crowds full-span rows/columns; uniform mode is a plain grid. Emits one point per block (center, scale, level) for building systems downstream.",
  backend: "webgl2",
  inputs: [
    { name: "image", type: "image", required: true },
    { name: "size_map", label: "Size Map", type: "mask", required: false },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["uniform", "quadtree", "lattice"],
      default: "quadtree",
    },
    {
      name: "size",
      label: "Block size (px)",
      type: "scalar",
      min: 2,
      max: 256,
      softMax: 64,
      step: 1,
      default: 16,
      visibleIf: (p) => p.mode === "uniform",
    },
    {
      name: "block_min",
      label: "Min block (px)",
      type: "scalar",
      min: 2,
      max: 128,
      softMax: 32,
      step: 1,
      default: 8,
      visibleIf: (p) => p.mode !== "uniform",
    },
    {
      name: "block_max",
      label: "Max block (px)",
      type: "scalar",
      min: 8,
      max: 512,
      softMax: 128,
      step: 1,
      default: 64,
      visibleIf: (p) => p.mode !== "uniform",
    },
    {
      name: "invert",
      label: "Invert map",
      type: "boolean",
      default: false,
      visibleIf: (p) => p.mode !== "uniform",
    },
    {
      name: "gamma",
      label: "Map response",
      type: "scalar",
      min: 0.25,
      max: 4,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.mode !== "uniform",
    },
    {
      name: "lattice_axes",
      label: "Axes",
      type: "enum",
      options: ["both", "columns", "rows"],
      default: "both",
      visibleIf: (p) => p.mode === "lattice",
    },
    {
      name: "sample",
      label: "Sampling",
      type: "enum",
      options: ["center", "average"],
      default: "center",
    },
    OPACITY_PARAM,
  ],
  headerControl: { paramName: "mode" },
  primaryOutput: "image",
  auxOutputs: [
    {
      name: "points",
      type: "points",
      description:
        "One point per block: center, scale relative to the max block size, groupIndex = subdivision level.",
    },
  ],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const src = inputs.image;
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output, aux: { points: EMPTY_POINTS } };
    }
    const mapIn = inputs.size_map;
    const map = mapIn && mapIn.kind === "mask" ? mapIn : null;
    const state = getState(ctx, nodeId);
    const W = ctx.width;
    const H = ctx.height;
    const mode = (params.mode as string) ?? "quadtree";
    const average = (params.sample as string) === "average";

    const blockMax = Math.min(
      Math.max(8, (params.block_max as number) ?? 64),
      Math.max(8, Math.min(W, H))
    );
    const blockMin = Math.min(
      Math.max(2, (params.block_min as number) ?? 8),
      blockMax / 2
    );
    const invert = params.invert === true;
    const gamma = Math.min(4, Math.max(0.25, (params.gamma as number) ?? 1));
    const sizeFor = makeSizeMap(blockMin, blockMax, invert, gamma);

    let cells: Cell[];
    let gridKind: 0 | 1 = 0; // 0: cell-rect index texture, 1: lattice LUTs
    let cellPx = 1; // finest cell px (index-texture grids only)
    let blockRef: number;
    let indexTex: WebGLTexture | null = null;

    // Falls back to a plain uniform grid when the driver readback is
    // unavailable (context loss etc.) — degrade, don't emit garbage.
    const uniformGridFallback = (size: number) => {
      const grid = buildUniform(size, W, H);
      cells = grid.cells;
      cellPx = size;
      state.indexTex = uploadDataTexture(
        ctx,
        state.indexTex,
        grid.rects,
        grid.nx,
        grid.ny
      );
      indexTex = state.indexTex;
    };

    if (mode === "uniform") {
      const size = Math.max(2, (params.size as number) ?? 16);
      blockRef = size;
      uniformGridFallback(size);
    } else if (mode === "lattice") {
      blockRef = blockMax;
      const samplePx = Math.max(2, Math.min(blockMin, 64));
      const nx = Math.max(1, Math.ceil(W / samplePx));
      const ny = Math.max(1, Math.ceil(H / samplePx));
      const driver = readDriver(ctx, src, map, nx, ny, samplePx);
      if (!driver) {
        uniformGridFallback(blockMax);
      } else {
        const axes = (params.lattice_axes as string) ?? "both";
        const colSpans =
          axes === "rows"
            ? [{ x0: 0, w: W }]
            : buildSpans(
                columnProfile(driver, nx, ny),
                samplePx,
                W,
                sizeFor,
                blockMin,
                blockMax
              );
        const rowSpans =
          axes === "columns"
            ? [{ x0: 0, w: H }]
            : buildSpans(
                rowProfile(driver, nx, ny),
                samplePx,
                H,
                sizeFor,
                blockMin,
                blockMax
              );
        cells = [];
        for (const r of rowSpans) {
          for (const c of colSpans) {
            cells.push({
              cx: c.x0 + c.w / 2,
              cy: r.x0 + r.w / 2,
              w: c.w,
              h: r.w,
              level: 0,
            });
          }
        }
        state.colTex = uploadDataTexture(
          ctx,
          state.colTex,
          spansToLut(colSpans, W),
          W,
          1
        );
        state.rowTex = uploadDataTexture(
          ctx,
          state.rowTex,
          spansToLut(rowSpans, H),
          H,
          1
        );
        if (!state.colTex || !state.rowTex) {
          uniformGridFallback(blockMax);
        } else {
          gridKind = 1;
        }
      }
    } else {
      blockRef = blockMax;
      let levels = Math.min(
        MAX_LEVELS,
        Math.max(1, Math.ceil(Math.log2(blockMax / blockMin)))
      );
      const Nx = Math.max(1, Math.ceil(W / blockMax));
      const Ny = Math.max(1, Math.ceil(H / blockMax));
      while (levels > 1 && (Nx << levels) * (Ny << levels) > MAX_GRID_TEXELS) {
        levels--;
      }
      const nx = Nx << levels;
      const ny = Ny << levels;
      cellPx = blockMax / (1 << levels);

      const driver = readDriver(ctx, src, map, nx, ny, cellPx);
      if (!driver) {
        uniformGridFallback(blockMax);
      } else {
        const grid = buildQuadtree(
          driver,
          nx,
          ny,
          levels,
          blockMax,
          W,
          H,
          sizeFor
        );
        cells = grid.cells;
        state.indexTex = uploadDataTexture(
          ctx,
          state.indexTex,
          grid.rects,
          nx,
          ny
        );
        indexTex = state.indexTex;
        if (!indexTex) uniformGridFallback(blockMax);
      }
    }

    if (gridKind === 0 && !indexTex) {
      // Even the uniform fallback couldn't allocate — bail clean.
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output, aux: { points: EMPTY_POINTS } };
    }

    const mipTex = average ? ensureMipCopy(ctx, state, src) : null;

    const prog = ctx.getShader("adaptive-pixelate/apply", APPLY_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      const bind = (unit: number, name: string, tex: WebGLTexture) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(gl.getUniformLocation(prog, name), unit);
      };
      bind(0, "u_src", src.texture);
      bind(1, "u_srcMip", mipTex ?? src.texture);
      bind(2, "u_cells", indexTex ?? src.texture);
      bind(3, "u_cols", state.colTex ?? src.texture);
      bind(4, "u_rows", state.rowTex ?? src.texture);
      gl.uniform2f(gl.getUniformLocation(prog, "u_res"), W, H);
      gl.uniform1f(gl.getUniformLocation(prog, "u_cellPx"), cellPx);
      gl.uniform1i(gl.getUniformLocation(prog, "u_grid"), gridKind);
      gl.uniform1i(
        gl.getUniformLocation(prog, "u_sample"),
        mipTex ? 1 : 0
      );
    });

    return {
      primary: output,
      aux: { points: cellsToPoints(cells!, W, H, blockRef) },
    };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const s = ctx.state[stateKey(nodeId)] as PixState | undefined;
    if (s) {
      const gl = ctx.gl;
      if (s.indexTex) gl.deleteTexture(s.indexTex);
      if (s.colTex) gl.deleteTexture(s.colTex);
      if (s.rowTex) gl.deleteTexture(s.rowTex);
      if (s.mipTex) gl.deleteTexture(s.mipTex);
    }
    delete ctx.state[stateKey(nodeId)];
  },
};
