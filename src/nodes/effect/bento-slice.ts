import type { NodeDefinition, RenderContext } from "@/engine/types";
import { OPACITY_PARAM } from "@/engine/conventions";
import { readDriver } from "@/engine/driver-reduce";
import { easeOf, type EasingPreset } from "@/engine/keyframes";
import { EMPTY_POINTS, makePoints } from "@/engine/points";
import { hash01 } from "@/engine/spline-color-source";

// Bento Slice — sliced-image assemble/split animation (specdocs/
// 072326_bento-slice.md). The source is cut into bento-box rectangles by
// recursive binary subdivision (split depth driven by a luminance map — the
// `size_map` input or the source's own luminance, same driver conventions as
// Adaptive Pixelate), then every piece is offset along a per-piece seeded
// scatter vector by `fac`: 0 = assembled, 1 = fully scattered. Stepped mode
// makes each piece travel an axis-aligned staircase toward home (2-step:
// slide in horizontally, then drop vertically into place), one easing curve
// per leg (the keyframe easing catalog, so motion matches keyframed params).
//
// Architecture: the grid is CPU-AUTHORITATIVE (Adaptive Pixelate's argument —
// one cell list drives both the draw and the points aux, so they can never
// disagree). The shared engine/driver-reduce.ts pass shrinks the driver to a
// small analysis grid; a summed-area table makes arbitrary-rect averages
// O(1) for the binary subdivision. The render is an instanced quad scatter
// (Copy-to-Points' pattern: private program/VAO/FBO + RGBA32F data texture,
// straight-alpha source-over) — each quad samples its HOME rect so it
// carries its pixels with it. fac animates per frame, so the cell list is
// cached in ctx.state keyed on a layout signature + the driver input's
// value-object identity (the devguide-sanctioned "upstream recomputed"
// signal); per-eval work is just the offset math + data-texture upload.
//
// The points aux (one point per piece at its CURRENT animated center) is
// built UNCONDITIONALLY — this node caches and consumption isn't part of the
// fingerprint (the loop-weave lesson; see adaptive-pixelate.ts).

const BENTO_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;  // unit-quad corner (0/1 per axis)
uniform sampler2D u_data;  // RGBA32F, 2 texels/piece: home rect, offset
uniform int u_tileW;       // data texture width in texels
uniform vec2 u_res;        // canvas px
uniform float u_gap;       // gutter px (shrinks each piece symmetrically)
out vec2 v_srcUv;

void main() {
  int base = gl_InstanceID * 2;
  ivec2 t0 = ivec2(base % u_tileW, base / u_tileW);
  ivec2 t1 = ivec2((base + 1) % u_tileW, (base + 1) / u_tileW);
  vec4 rect = texelFetch(u_data, t0, 0);   // cx, cy, w, h — px, y-down
  vec2 off = texelFetch(u_data, t1, 0).xy; // current offset px
  vec2 halfSize = max(rect.zw * 0.5 - vec2(u_gap * 0.5), vec2(0.5));
  vec2 local = (a_pos * 2.0 - 1.0) * halfSize;  // ±half, y-down px
  vec2 pos = rect.xy + off + local;             // moved corner
  gl_Position = vec4(pos.x / u_res.x * 2.0 - 1.0,
                     1.0 - pos.y / u_res.y * 2.0, 0.0, 1.0);
  vec2 home = rect.xy + local;                  // sample from the home rect
  v_srcUv = vec2(home.x / u_res.x, 1.0 - home.y / u_res.y);
}`;

const BENTO_FS = `#version 300 es
precision highp float;
in vec2 v_srcUv;
uniform sampler2D u_src;
out vec4 outColor;
void main() { outColor = texture(u_src, v_srcUv); }`;

const TAU = Math.PI * 2;
const MAX_DEPTH = 24;
// Piece-count ceiling: raise the effective min piece size until the worst
// case fits. Keeps extreme min-size + 4K canvases from exploding the
// per-eval CPU offset loop and data upload.
const MAX_PIECES = 1 << 16;
// Analysis-grid texel cap (readback + SAT size).
const MAX_ANALYSIS_TEXELS = 1 << 20;

// Friendly dropdown options → keyframe easing presets. Everything except
// customBezier (needs handle data); `hold` degenerates to a leg-by-leg
// teleport, kept as a stylized snap.
const EASING_OPTIONS: readonly (readonly [string, EasingPreset])[] = [
  ["linear", "linear"],
  ["in-sine", "easeInSine"],
  ["out-sine", "easeOutSine"],
  ["in-out-sine", "easeInOutSine"],
  ["in-quad", "easeInQuad"],
  ["out-quad", "easeOutQuad"],
  ["in-out-quad", "easeInOutQuad"],
  ["in-cubic", "easeInCubic"],
  ["out-cubic", "easeOutCubic"],
  ["in-out-cubic", "easeInOutCubic"],
  ["in-expo", "easeInExpo"],
  ["out-expo", "easeOutExpo"],
  ["in-back", "easeInBack"],
  ["out-back", "easeOutBack"],
  ["out-bounce", "easeOutBounce"],
  ["out-elastic", "easeOutElastic"],
  ["hold", "hold"],
];
const EASING_BY_OPTION = new Map(EASING_OPTIONS);

interface Cell {
  x: number; // top-left px, y-down
  y: number;
  w: number;
  h: number;
  depth: number;
}

interface BentoState {
  program: WebGLProgram | null;
  locs: Record<string, WebGLUniformLocation | null> | null;
  vao: WebGLVertexArrayObject | null;
  quadVbo: WebGLBuffer | null;
  fbo: WebGLFramebuffer | null;
  dataTex: WebGLTexture | null;
  dataW: number;
  dataH: number;
  dataBuf: Float32Array | null;
  // Cached grid — rebuilt only when the layout signature or the driver
  // input's value-object identity changes (fac ticks reuse it).
  cells: Cell[] | null;
  gridSig: string;
  driverRef: unknown;
}

const stateKey = (nodeId: string) => `bento-slice:${nodeId}`;

function getState(ctx: RenderContext, nodeId: string): BentoState {
  let s = ctx.state[stateKey(nodeId)] as BentoState | undefined;
  if (!s) {
    s = {
      program: null,
      locs: null,
      vao: null,
      quadVbo: null,
      fbo: null,
      dataTex: null,
      dataW: 0,
      dataH: 0,
      dataBuf: null,
      cells: null,
      gridSig: "",
      driverRef: null,
    };
    ctx.state[stateKey(nodeId)] = s;
  }
  return s;
}

const UNIFORMS = ["u_data", "u_tileW", "u_res", "u_gap", "u_src"] as const;

// Lazy GL setup — instanced shader pair, unit-quad VAO, private FBO, and the
// per-piece data texture. Copy-to-Points' recipe.
function ensureResources(ctx: RenderContext, state: BentoState): boolean {
  const gl = ctx.gl;
  if (!state.program) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vs || !fs) return false;
    gl.shaderSource(vs, BENTO_VS);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.warn("bento-slice VS:", gl.getShaderInfoLog(vs));
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }
    gl.shaderSource(fs, BENTO_FS);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.warn("bento-slice FS:", gl.getShaderInfoLog(fs));
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }
    const prog = gl.createProgram();
    if (!prog) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("bento-slice link:", gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return false;
    }
    state.program = prog;
    const locs: Record<string, WebGLUniformLocation | null> = {};
    for (const name of UNIFORMS) locs[name] = gl.getUniformLocation(prog, name);
    state.locs = locs;
  }
  if (!state.quadVbo || !state.vao) {
    state.quadVbo = gl.createBuffer();
    state.vao = gl.createVertexArray();
    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    gl.bindVertexArray(state.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindVertexArray(null);
  }
  if (!state.fbo) state.fbo = gl.createFramebuffer();
  if (!state.dataTex) {
    state.dataTex = gl.createTexture();
    if (!state.dataTex) return false;
    gl.bindTexture(gl.TEXTURE_2D, state.dataTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  return !!(state.program && state.vao && state.fbo && state.dataTex);
}

// Deterministic per-cell hash. Identity = quantized center (+ depth for cut
// decisions), so scatter directions survive small param nudges; collisions
// are harmless (two pieces sharing a direction).
function cellHash(
  cx: number,
  cy: number,
  depth: number,
  seed: number,
  salt: number
): number {
  const idx = Math.round(cx) * 2 + Math.round(cy) * 16411 + depth * 2971;
  return hash01(idx, (seed * 8 + salt) | 0);
}

// Recursive binary bento subdivision. The driver (analysis-grid readback,
// y-down rows) is summed into a SAT so any rect's average is O(1); split
// while the longer side exceeds the driver's desired size, cutting the
// longer axis at a jittered position clamped so no child edge goes below
// pieceMin. Emit order is the draw order (stable). Exported (with
// stepFractions) for testability — pure functions, no GL.
export function buildBento(
  driver: Float32Array | null,
  gx: number,
  gy: number,
  analysisPx: number,
  W: number,
  H: number,
  pieceMin: number,
  pieceMax: number,
  invert: boolean,
  gamma: number,
  cutJitter: number,
  seed: number
): Cell[] {
  let sat: Float64Array | null = null;
  if (driver) {
    sat = new Float64Array((gx + 1) * (gy + 1));
    for (let j = 0; j < gy; j++) {
      let rowSum = 0;
      for (let i = 0; i < gx; i++) {
        rowSum += driver[j * gx + i];
        sat[(j + 1) * (gx + 1) + (i + 1)] =
          sat[j * (gx + 1) + (i + 1)] + rowSum;
      }
    }
  }
  const avg = (x: number, y: number, w: number, h: number): number => {
    if (!sat) return 0.5; // no readback — mid driver, still slices
    const x0 = Math.min(gx - 1, Math.max(0, Math.floor(x / analysisPx)));
    const x1 = Math.min(gx, Math.max(x0 + 1, Math.ceil((x + w) / analysisPx)));
    const y0 = Math.min(gy - 1, Math.max(0, Math.floor(y / analysisPx)));
    const y1 = Math.min(gy, Math.max(y0 + 1, Math.ceil((y + h) / analysisPx)));
    const s =
      sat[y1 * (gx + 1) + x1] -
      sat[y0 * (gx + 1) + x1] -
      sat[y1 * (gx + 1) + x0] +
      sat[y0 * (gx + 1) + x0];
    return s / ((x1 - x0) * (y1 - y0));
  };
  const sizeFor = (d: number): number => {
    let t = Math.min(1, Math.max(0, invert ? 1 - d : d));
    t = Math.pow(t, gamma);
    return pieceMax + (pieceMin - pieceMax) * t;
  };

  const cells: Cell[] = [];
  const recurse = (x: number, y: number, w: number, h: number, depth: number) => {
    const longer = Math.max(w, h);
    const canW = w >= 2 * pieceMin;
    const canH = h >= 2 * pieceMin;
    if (
      depth >= MAX_DEPTH ||
      (!canW && !canH) ||
      longer <= sizeFor(avg(x, y, w, h))
    ) {
      cells.push({ x, y, w, h, depth });
      return;
    }
    // Cut the longer splittable side; exact ties flip a seeded coin.
    let splitW: boolean;
    if (canW && canH) {
      splitW =
        w > h
          ? true
          : h > w
            ? false
            : cellHash(x + w / 2, y + h / 2, depth, seed, 4) < 0.5;
    } else {
      splitW = canW;
    }
    const L = splitW ? w : h;
    const r = cellHash(x + w / 2, y + h / 2, depth, seed, 3);
    let c = 0.5 + 0.25 * cutJitter * (2 * r - 1);
    c = Math.min(1 - pieceMin / L, Math.max(pieceMin / L, c));
    if (splitW) {
      const cw = c * w;
      recurse(x, y, cw, h, depth + 1);
      recurse(x + cw, y, w - cw, h, depth + 1);
    } else {
      const ch = c * h;
      recurse(x, y, w, ch, depth + 1);
      recurse(x, y + ch, w, h - ch, depth + 1);
    }
  };
  recurse(0, 0, W, H, 0);
  return cells;
}

// Per-axis travel fractions (0..1 of each axis' total) at assembly progress
// `a` (0 = scattered, 1 = home) — the same for every piece, so computed once
// per eval. steps = 1 is a straight eased slide; steps ≥ 2 alternate axes
// starting with `hFirst`, the fac domain cut into equal per-leg sub-ranges,
// each leg shaped by the easing (back/elastic overshoot the leg and settle;
// `hold` teleports at leg boundaries).
export function stepFractions(
  a: number,
  steps: number,
  hFirst: boolean,
  preset: EasingPreset
): { fx: number; fy: number } {
  if (a <= 0) return { fx: 0, fy: 0 };
  if (a >= 1) return { fx: 1, fy: 1 };
  if (steps <= 1) {
    const e = easeOf(preset, a);
    return { fx: e, fy: e };
  }
  const isH = (k: number) => (k % 2 === 0) === hFirst;
  let nH = 0;
  for (let k = 0; k < steps; k++) if (isH(k)) nH++;
  const nV = steps - nH;
  const k = Math.min(steps - 1, Math.floor(a * steps));
  const u = a * steps - k;
  let hDone = 0;
  let vDone = 0;
  for (let l = 0; l < k; l++) {
    if (isH(l)) hDone++;
    else vDone++;
  }
  const e = easeOf(preset, u);
  return {
    fx: (hDone + (isH(k) ? e : 0)) / Math.max(1, nH),
    fy: (vDone + (isH(k) ? 0 : e)) / Math.max(1, nV),
  };
}

export const bentoSliceNode: NodeDefinition = {
  type: "bento-slice",
  name: "Bento Slice",
  category: "image",
  subcategory: "modifier",
  description:
    "Slice the image into bento-box rectangles (recursive cuts driven by a luminance map — the Size Map input, or the image's own luminance) and offset every piece along a seeded scatter direction by Fac: 0 = assembled, 1 = split apart. Animate Fac to assemble or shatter the image. Steps > 1 makes pieces travel an axis-aligned staircase (2 = slide in sideways, then drop into place), with one easing curve per step. Emits one point per piece at its animated center for driving systems downstream.",
  backend: "webgl2",
  inputs: [
    { name: "image", type: "image", required: true },
    { name: "size_map", label: "Size Map", type: "mask", required: false },
  ],
  params: [
    {
      name: "fac",
      label: "Fac",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "piece_min",
      label: "Min piece (px)",
      type: "scalar",
      min: 8,
      max: 256,
      softMax: 64,
      step: 1,
      default: 24,
    },
    {
      name: "piece_max",
      label: "Max piece (px)",
      type: "scalar",
      min: 32,
      max: 1024,
      softMax: 512,
      step: 1,
      default: 256,
    },
    {
      name: "invert",
      label: "Invert map",
      type: "boolean",
      default: false,
    },
    {
      name: "gamma",
      label: "Map response",
      type: "scalar",
      min: 0.25,
      max: 4,
      step: 0.01,
      default: 1,
    },
    {
      name: "cut_jitter",
      label: "Cut jitter",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.35,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 10000,
      step: 1,
      default: 1,
    },
    {
      name: "gap",
      label: "Gap (px)",
      type: "scalar",
      min: 0,
      max: 64,
      step: 0.5,
      default: 0,
    },
    {
      name: "distance",
      label: "Distance",
      type: "scalar",
      min: 0,
      max: 2,
      softMax: 1,
      step: 0.01,
      default: 0.75,
    },
    {
      name: "distance_jitter",
      label: "Distance jitter",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "steps",
      label: "Steps",
      type: "scalar",
      min: 1,
      max: 8,
      step: 1,
      default: 2,
    },
    {
      name: "first_axis",
      label: "First axis",
      type: "enum",
      options: ["horizontal", "vertical"],
      default: "horizontal",
      visibleIf: (p) => ((p.steps as number) ?? 2) > 1,
    },
    {
      name: "easing",
      label: "Easing",
      type: "enum",
      options: EASING_OPTIONS.map(([opt]) => opt),
      default: "in-out-sine",
    },
    OPACITY_PARAM,
  ],
  primaryOutput: "image",
  auxOutputs: [
    {
      name: "points",
      type: "points",
      description:
        "One point per piece at its CURRENT (Fac-animated) center: scale relative to the max piece size, groupIndex = subdivision depth.",
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

    const pieceMax = Math.min(
      Math.max(32, (params.piece_max as number) ?? 256),
      Math.max(32, Math.max(W, H))
    );
    // Floor the effective min so the worst-case piece count stays bounded.
    const pieceMin = Math.min(
      Math.max(
        8,
        (params.piece_min as number) ?? 24,
        Math.sqrt((W * H) / MAX_PIECES)
      ),
      pieceMax / 2
    );
    const invert = params.invert === true;
    const gamma = Math.min(4, Math.max(0.25, (params.gamma as number) ?? 1));
    const cutJitter = Math.min(
      1,
      Math.max(0, (params.cut_jitter as number) ?? 0.35)
    );
    const seed = Math.max(0, Math.round((params.seed as number) ?? 1));

    // ---- grid (cached across fac ticks) ------------------------------
    const gridSig = [
      W,
      H,
      pieceMin,
      pieceMax,
      invert ? 1 : 0,
      gamma,
      cutJitter,
      seed,
      map ? 1 : 0,
    ].join("|");
    const driverRef: unknown = map ?? src;
    let cells = state.cells;
    if (!cells || state.gridSig !== gridSig || state.driverRef !== driverRef) {
      let analysisPx = Math.max(2, pieceMin / 4);
      while (
        Math.ceil(W / analysisPx) * Math.ceil(H / analysisPx) >
        MAX_ANALYSIS_TEXELS
      ) {
        analysisPx *= 2;
      }
      const gx = Math.max(1, Math.ceil(W / analysisPx));
      const gy = Math.max(1, Math.ceil(H / analysisPx));
      const driver = readDriver(ctx, src, map, gx, gy, analysisPx);
      cells = buildBento(
        driver,
        gx,
        gy,
        analysisPx,
        W,
        H,
        pieceMin,
        pieceMax,
        invert,
        gamma,
        cutJitter,
        seed
      );
      state.cells = cells;
      state.gridSig = gridSig;
      state.driverRef = driverRef;
    }
    const count = cells.length;

    // ---- per-eval animation state ------------------------------------
    const fac = Math.min(1, Math.max(0, (params.fac as number) ?? 0));
    const steps = Math.min(
      8,
      Math.max(1, Math.round((params.steps as number) ?? 2))
    );
    const hFirst = ((params.first_axis as string) ?? "horizontal") !== "vertical";
    const preset =
      EASING_BY_OPTION.get((params.easing as string) ?? "in-out-sine") ??
      "easeInOutSine";
    const distPx = Math.max(0, (params.distance as number) ?? 0.75) * W;
    const distJitter = Math.min(
      1,
      Math.max(0, (params.distance_jitter as number) ?? 0.5)
    );
    const gap = Math.max(0, (params.gap as number) ?? 0);

    // Assembly progress: fac 1 → scattered (a = 0), fac 0 → home (a = 1).
    const { fx, fy } = stepFractions(1 - fac, steps, hFirst, preset);

    if (count === 0 || !ensureResources(ctx, state)) {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output, aux: { points: EMPTY_POINTS } };
    }

    // ---- data texture + points (one loop feeds both) -----------------
    const texels = count * 2;
    const tileW = Math.min(2048, Math.max(2, texels));
    const texH = Math.max(1, Math.ceil(texels / tileW));
    const need = tileW * texH * 4;
    if (!state.dataBuf || state.dataBuf.length < need) {
      state.dataBuf = new Float32Array(need);
    }
    const buf = state.dataBuf;
    const pts = makePoints(count, {
      withScales: true,
      withGroupIndices: true,
    });
    for (let i = 0; i < count; i++) {
      const c = cells[i];
      const cx = c.x + c.w / 2;
      const cy = c.y + c.h / 2;
      // Scatter vector at fac = 1 — seeded direction + jittered magnitude,
      // keyed on the piece's home center so it survives param nudges.
      const th = TAU * cellHash(cx, cy, 0, seed, 1);
      const mag = distPx * (1 - distJitter * cellHash(cx, cy, 0, seed, 2));
      const offX = Math.cos(th) * mag * (1 - fx);
      const offY = Math.sin(th) * mag * (1 - fy);
      const o = i * 8;
      buf[o] = cx;
      buf[o + 1] = cy;
      buf[o + 2] = c.w;
      buf[o + 3] = c.h;
      buf[o + 4] = offX;
      buf[o + 5] = offY;
      buf[o + 6] = 0;
      buf[o + 7] = 0;
      pts.positions[i * 2] = (cx + offX) / W;
      pts.positions[i * 2 + 1] = (cy + offY) / H;
      pts.scales![i * 2] = c.w / pieceMax;
      pts.scales![i * 2 + 1] = c.h / pieceMax;
      pts.groupIndices![i] = c.depth;
    }

    const gl = ctx.gl;
    gl.bindTexture(gl.TEXTURE_2D, state.dataTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (state.dataW !== tileW || state.dataH !== texH) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        tileW,
        texH,
        0,
        gl.RGBA,
        gl.FLOAT,
        buf.subarray(0, need)
      );
      state.dataW = tileW;
      state.dataH = texH;
    } else {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        tileW,
        texH,
        gl.RGBA,
        gl.FLOAT,
        buf.subarray(0, need)
      );
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    // ---- instanced scatter draw --------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      output.texture,
      0
    );
    gl.viewport(0, 0, output.width, output.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA
    );
    gl.disable(gl.DEPTH_TEST);

    gl.useProgram(state.program);
    gl.bindVertexArray(state.vao);
    const L = state.locs!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(L.u_src, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, state.dataTex);
    gl.uniform1i(L.u_data, 1);
    gl.uniform1i(L.u_tileW, tileW);
    gl.uniform2f(L.u_res, W, H);
    gl.uniform1f(L.u_gap, gap);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.useProgram(null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      null,
      0
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { primary: output, aux: { points: pts } };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const s = ctx.state[stateKey(nodeId)] as BentoState | undefined;
    if (s) {
      const gl = ctx.gl;
      if (s.program) gl.deleteProgram(s.program);
      if (s.vao) gl.deleteVertexArray(s.vao);
      if (s.quadVbo) gl.deleteBuffer(s.quadVbo);
      if (s.fbo) gl.deleteFramebuffer(s.fbo);
      if (s.dataTex) gl.deleteTexture(s.dataTex);
    }
    delete ctx.state[stateKey(nodeId)];
  },
};
