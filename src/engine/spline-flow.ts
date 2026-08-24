// Field-based "liquid" spline union — the sim engine behind Spline Merge's
// Flow mode (devlist #177, spec 071226_spline-merge-flow.md).
//
// Instead of chasing the merged CONTOUR (spring/polyline sims choke exactly
// when loops merge or split), we simulate an implicit scalar FIELD and read
// its iso-line out as a spline. Topology changes — necks forming, bridges
// snapping, pinch-off — fall out of the field for free.
//
// Per eval:
//   1. Rasterize the input's per-op silhouette coverage to a 2D canvas.
//   2. Blur it → the TARGET field T (blur radius = the goo/bridge distance).
//   3. Relax the persistent field F toward T over time (+ surface-tension
//      smoothing, + adhesion asymmetry so separation "holds on").
//   4. Marching-squares F's 0.5 iso-line back into a spline.
//
// All ping-pong fragment passes — no compute shader, no WebGPU. The field
// is held in ctx.state across frames (that persistence IS the simulation);
// textures are pool-leased and freed in disposeFlowState.
//
// Coordinate space: the field covers the CANVAS RECT in authored space plus
// a margin (flowFieldGeometry). Authored space is a uniform scale of screen
// space (aspectCorrectY renders the authored unit square as a W×W-pixel
// square), so one isotropic texels-per-authored-unit scale keeps field
// texels square on screen — blur and tension need no per-axis radii.
// Extraction maps subpaths back to authored Y-DOWN coordinates
// (marchingSquares uvOrigin/uvSize), the same space the exact boolean
// emits, so toggling Flow on/off never shifts the shape. The field used to
// be the authored UNIT SQUARE with an identity map — but on portrait
// canvases visible content is authored outside [0,1] (y spans 0.5 ± H/2W),
// so shapes were flat-cut at the square's edge, visibly INSIDE the frame.
// The margin keeps the field's cut edges offscreen and gives the goo room
// to bridge near the canvas border.

import type {
  ImageValue,
  RenderContext,
  SplineSubpath,
  SplineValue,
} from "./types";
import { buildPath2DWith } from "./spline-raster";
import { marchingSquares } from "./marching-squares";

export type SplineMergeOp = "union" | "intersect" | "exclude";

export interface FlowParams {
  operation: SplineMergeOp;
  speed: number; // 0..1 — how fast the silhouette chases the target
  tension: number; // 0..1 — surface tension (neck thinning / smoothing)
  adhesion: number; // 0..1 — how hard separation "holds on"
  blend: number; // normalized 0..~0.25 — goo / pre-touch bridge radius
  detail: number; // field resolution (texels across the canvas's longer side)
}

interface FlowState {
  canvas: HTMLCanvasElement;
  c2d: CanvasRenderingContext2D | null;
  coverageTex: WebGLTexture | null;
  fieldA: ImageValue | null; // canonical "current F" after every step
  fieldB: ImageValue | null; // ping-pong scratch
  target: ImageValue | null; // T
  scratch: ImageValue | null; // separable-blur intermediate
  geom: FlowFieldGeom | null;
  lastTick: number | null;
  seeded: boolean;
  result: SplineValue;
}

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

const MIN_DETAIL = 128;
const MAX_DETAIL = 768;

// Field padding beyond the canvas rect, as a fraction of the canvas's longer
// side. Marching squares closes contours flat along the grid border; a
// border on (or inside) the visible frame draws as a straight cut, so the
// cut edges are pushed offscreen, and the blur gets room to bridge shapes
// near the canvas edge. Comfortably above the default blend (0.06) goo
// radius; blur reaching past it degrades gracefully via CLAMP_TO_EDGE.
const PAD_FRAC = 0.125;

// Field geometry for a canvas aspect (W/H) and detail dial. Authored units
// throughout (Y-DOWN; canvas width = 1, canvas height = H/W, vertically
// centered on 0.5): one isotropic texels-per-authored-unit scale plus the
// authored coordinate of the field's top-left corner. Exported for the
// offline mapping check.
export interface FlowFieldGeom {
  fw: number; // field width in texels
  fh: number; // field height in texels
  scale: number; // texels per authored unit (same for both axes)
  originX: number; // authored x of the field's left edge
  originY: number; // authored y of the field's top edge
}

export function flowFieldGeometry(
  canvasAspect: number,
  detail: number
): FlowFieldGeom {
  const a =
    Number.isFinite(canvasAspect) && canvasAspect > 0 ? canvasAspect : 1;
  const ah = 1 / a; // canvas height in authored units (width is 1)
  const long = Math.max(1, ah);
  const margin = PAD_FRAC * long;
  const scale = detail / long; // `detail` texels across the longer side
  const fw = Math.max(2, Math.round((1 + 2 * margin) * scale));
  const fh = Math.max(2, Math.round((ah + 2 * margin) * scale));
  return {
    fw,
    fh,
    scale,
    originX: -margin,
    originY: 0.5 - ah / 2 - margin,
  };
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

// Straight passthrough — used to snap F := T on resets/paused evals.
const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() { outColor = vec4(vec3(texture(u_src, v_uv).r), 1.0); }`;

// Separable Gaussian. Fixed tap count; the per-tap step widens with the
// requested radius so a single pass covers a wide blur (LINEAR filtering on
// the field textures interpolates between texels). R channel only.
const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2  u_axis;         // (1,0) horizontal / (0,1) vertical
uniform vec2  u_texel;        // 1 / size
uniform float u_radiusTexels; // blur radius in texels
out vec4 outColor;
const int TAPS = 24;          // per side
void main() {
  float sigma = max(1.0, u_radiusTexels * 0.5);
  float step  = max(1.0, u_radiusTexels / float(TAPS));
  float sum = 0.0, wsum = 0.0;
  for (int i = -TAPS; i <= TAPS; i++) {
    float off = float(i) * step;
    float w = exp(-0.5 * (off * off) / (sigma * sigma));
    vec2 uv = v_uv + u_axis * (off * u_texel);
    sum  += texture(u_src, uv).r * w;
    wsum += w;
  }
  outColor = vec4(vec3(sum / wsum), 1.0);
}`;

// One simulation substep: relaxation toward T + surface-tension smoothing,
// with adhesion slowing the SHRINK direction so necks stretch before they
// snap. Explicit Euler; the caller pre-clamps u_sigma for stability.
const SIM_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_field;    // current F
uniform sampler2D u_target;   // T
uniform vec2  u_texel;
uniform float u_alpha;        // relaxation fraction this substep (0..1)
uniform float u_sigma;        // tension coefficient (pre-clamped <= 0.2)
uniform float u_adhesion;     // 0..1, already scaled (0.85 * adhesion)
out vec4 outColor;
void main() {
  float c = texture(u_field, v_uv).r;
  float t = texture(u_target, v_uv).r;
  float d = t - c;
  // Adhesion: joining (grow, d>0) runs at full rate; leaving (shrink, d<0)
  // is throttled so a separating bridge lingers and thins instead of
  // snapping cleanly.
  float rate = u_alpha * (d < 0.0 ? (1.0 - u_adhesion) : 1.0);
  float nc = c + rate * d;
  // Surface tension: 4-neighbour Laplacian pulls the level set toward
  // lower curvature (rounds corners, thins necks). Stable while
  // u_sigma <= 0.25.
  float lap =
      texture(u_field, v_uv + vec2(u_texel.x, 0.0)).r
    + texture(u_field, v_uv - vec2(u_texel.x, 0.0)).r
    + texture(u_field, v_uv + vec2(0.0, u_texel.y)).r
    + texture(u_field, v_uv - vec2(0.0, u_texel.y)).r
    - 4.0 * c;
  nc += u_sigma * lap;
  outColor = vec4(vec3(clamp(nc, 0.0, 1.0)), 1.0);
}`;

// ---------------------------------------------------------------------------
// State / textures
// ---------------------------------------------------------------------------

function stateKey(nodeId: string): string {
  return `spline-merge-flow:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): FlowState {
  const key = stateKey(nodeId);
  let s = ctx.state[key] as FlowState | undefined;
  if (!s) {
    const canvas = document.createElement("canvas");
    s = {
      canvas,
      c2d: canvas.getContext("2d"),
      coverageTex: null,
      fieldA: null,
      fieldB: null,
      target: null,
      scratch: null,
      geom: null,
      lastTick: null,
      seeded: false,
      result: EMPTY_SPLINE,
    };
    ctx.state[key] = s;
  }
  return s;
}

function setFilter(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture | null,
  mode: number
) {
  if (!tex) return;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mode);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mode);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

// Pool textures come back NEAREST; the blur wants LINEAR. We own these for
// the node's lifetime, so flip them to LINEAR on alloc and restore NEAREST
// before returning them to the pool (so a later leaser gets the default).
function releaseField(ctx: RenderContext, img: ImageValue | null) {
  if (!img) return;
  setFilter(ctx.gl, img.texture, ctx.gl.NEAREST);
  ctx.releaseTexture(img.texture);
}

function ensureTargets(
  ctx: RenderContext,
  s: FlowState,
  geom: FlowFieldGeom
): void {
  // Origin/scale ride along even when the texel dims are unchanged (a tiny
  // aspect nudge can move the mapping without changing the rounded dims).
  const same = s.geom && s.geom.fw === geom.fw && s.geom.fh === geom.fh;
  s.geom = geom;
  if (same && s.fieldA && s.fieldB && s.target && s.scratch) return;
  releaseField(ctx, s.fieldA);
  releaseField(ctx, s.fieldB);
  releaseField(ctx, s.target);
  releaseField(ctx, s.scratch);
  s.fieldA = ctx.allocImage({ width: geom.fw, height: geom.fh });
  s.fieldB = ctx.allocImage({ width: geom.fw, height: geom.fh });
  s.target = ctx.allocImage({ width: geom.fw, height: geom.fh });
  s.scratch = ctx.allocImage({ width: geom.fw, height: geom.fh });
  for (const img of [s.fieldA, s.fieldB, s.target, s.scratch]) {
    setFilter(ctx.gl, img.texture, ctx.gl.LINEAR);
  }
  s.canvas.width = geom.fw;
  s.canvas.height = geom.fh;
  s.seeded = false; // field must be re-seeded from the new-res target
}

// ---------------------------------------------------------------------------
// Coverage rasterization
// ---------------------------------------------------------------------------

function drawCoverage(
  s: FlowState,
  subpaths: SplineSubpath[],
  op: SplineMergeOp
): void {
  const c2d = s.c2d;
  const geom = s.geom;
  if (!c2d || !geom) return;
  c2d.setTransform(1, 0, 0, 1, 0, 0);
  c2d.clearRect(0, 0, geom.fw, geom.fh);
  c2d.globalCompositeOperation = "source-over";
  c2d.fillStyle = "#ffffff";
  // Authored → field texels: shift by the field origin, scale isotropically.
  // This IS the aspect-correct map — authored space is a uniform scale of
  // screen space (see file header).
  const map = (p: readonly [number, number]) =>
    [
      (p[0] - geom.originX) * geom.scale,
      (p[1] - geom.originY) * geom.scale,
    ] as const;

  if (op === "exclude") {
    // Even-odd XOR across all subpaths in one fill.
    const path = buildPath2DWith(subpaths as SplineSubpath[], map, true);
    if (path) c2d.fill(path, "evenodd");
    return;
  }
  if (op === "intersect") {
    // Region common to ALL subpaths: draw the first, then keep only the
    // overlap with each subsequent one via source-in.
    if (subpaths.length === 0) return;
    const first = buildPath2DWith([subpaths[0]], map, true);
    if (first) c2d.fill(first);
    for (let i = 1; i < subpaths.length; i++) {
      const path = buildPath2DWith([subpaths[i]], map, true);
      if (!path) continue;
      c2d.globalCompositeOperation = "source-in";
      c2d.fill(path);
    }
    return;
  }
  // union: fill each subpath solid so overlaps merge regardless of winding.
  for (const sub of subpaths) {
    const path = buildPath2DWith([sub], map, true);
    if (path) c2d.fill(path);
  }
}

function uploadCoverage(ctx: RenderContext, s: FlowState): void {
  const gl = ctx.gl;
  if (!s.coverageTex) {
    s.coverageTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, s.coverageTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  gl.bindTexture(gl.TEXTURE_2D, s.coverageTex);
  // The canvas is Y-DOWN (row 0 = top); flip on upload so texel t=1 is the
  // canvas top, matching the framebuffer's Y-UP v_uv. One readback flip at
  // extraction then lands the grid Y-DOWN (like SDF to Spline).
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s.canvas);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

// ---------------------------------------------------------------------------
// GL passes
// ---------------------------------------------------------------------------

function blurToTarget(ctx: RenderContext, s: FlowState, radius: number): void {
  const gl = ctx.gl;
  const prog = ctx.getShader("spline-flow/blur", BLUR_FS);
  // Texels are screen-square, so one radius (in texels) is isotropic on
  // screen; only the UV step differs per axis.
  const texel: [number, number] = [1 / s.geom!.fw, 1 / s.geom!.fh];
  const runPass = (
    src: WebGLTexture | null,
    dst: ImageValue,
    axis: [number, number]
  ) => {
    ctx.drawFullscreen(prog, dst, (g) => {
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, src);
      g.uniform1i(g.getUniformLocation(prog, "u_src"), 0);
      g.uniform2f(g.getUniformLocation(prog, "u_axis"), axis[0], axis[1]);
      g.uniform2f(g.getUniformLocation(prog, "u_texel"), texel[0], texel[1]);
      g.uniform1f(g.getUniformLocation(prog, "u_radiusTexels"), radius);
    });
  };
  runPass(s.coverageTex, s.scratch!, [1, 0]);
  runPass(s.scratch!.texture, s.target!, [0, 1]);
}

function snapFieldToTarget(ctx: RenderContext, s: FlowState): void {
  const prog = ctx.getShader("spline-flow/copy", COPY_FS);
  ctx.drawFullscreen(prog, s.fieldA!, (g) => {
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, s.target!.texture);
    g.uniform1i(g.getUniformLocation(prog, "u_src"), 0);
  });
}

function integrate(
  ctx: RenderContext,
  s: FlowState,
  p: FlowParams,
  dtFrames: number
): void {
  const prog = ctx.getShader("spline-flow/sim", SIM_FS);
  const texel: [number, number] = [1 / s.geom!.fw, 1 / s.geom!.fh];
  // Sub-step so the explicit tension term stays stable on big frame jumps.
  const nSub = Math.max(1, Math.min(8, Math.ceil(dtFrames / 0.5)));
  const dtSub = dtFrames / nSub;
  // Relaxation as an unconditionally-stable exponential approach (fps-
  // independent). speed→relaxation rate is a first-pass curve; M2 tunes it.
  const lambda = 0.2 + 5 * p.speed * p.speed;
  const alpha = 1 - Math.exp(-lambda * dtSub);
  const sigma = Math.min(0.2, Math.max(0, p.tension) * 0.2);
  const adhesion = 0.85 * Math.min(1, Math.max(0, p.adhesion));

  for (let i = 0; i < nSub; i++) {
    const src = s.fieldA!;
    const dst = s.fieldB!;
    ctx.drawFullscreen(prog, dst, (g) => {
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, src.texture);
      g.uniform1i(g.getUniformLocation(prog, "u_field"), 0);
      g.activeTexture(g.TEXTURE1);
      g.bindTexture(g.TEXTURE_2D, s.target!.texture);
      g.uniform1i(g.getUniformLocation(prog, "u_target"), 1);
      g.uniform2f(g.getUniformLocation(prog, "u_texel"), texel[0], texel[1]);
      g.uniform1f(g.getUniformLocation(prog, "u_alpha"), alpha);
      g.uniform1f(g.getUniformLocation(prog, "u_sigma"), sigma);
      g.uniform1f(g.getUniformLocation(prog, "u_adhesion"), adhesion);
    });
    // Swap so fieldA is always the freshest F.
    s.fieldA = dst;
    s.fieldB = src;
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function extractSpline(ctx: RenderContext, s: FlowState): SplineValue {
  const field = s.fieldA!;
  const data = ctx.readImageToFloat32(field);
  const w = field.width;
  const h = field.height;
  // R channel into a contiguous grid; Y-flip (readback is bottom-up, our
  // spline space is Y-DOWN).
  const grid = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w;
    const dstRow = y * w;
    for (let x = 0; x < w; x++) {
      grid[dstRow + x] = data[(srcRow + x) * 4];
    }
  }
  // Grid texels → authored space via the field geometry (inverse of
  // drawCoverage's map).
  const g = s.geom!;
  const subpaths = marchingSquares(grid, w, h, {
    iso: 0.5,
    uvOrigin: [g.originX, g.originY],
    uvSize: [w / g.scale, h / g.scale],
  });
  return { kind: "spline", subpaths };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function runSplineFlow(
  ctx: RenderContext,
  nodeId: string,
  src: SplineValue,
  p: FlowParams
): SplineValue {
  const s = ensureState(ctx, nodeId);
  const detail = Math.max(
    MIN_DETAIL,
    Math.min(MAX_DETAIL, Math.round(p.detail))
  );
  // A canvas-resize (aspect change) lands here as new field dims →
  // realloc + reseed, same as a detail change.
  const geom = flowFieldGeometry(ctx.width / ctx.height, detail);
  ensureTargets(ctx, s, geom);

  // 1–2: coverage → blurred target field T. Blend is authored units
  // (fractions of the canvas width), converted to texels via the field
  // scale — identical to the old blend·detail on a square canvas.
  drawCoverage(s, src.subpaths, p.operation);
  uploadCoverage(ctx, s);
  blurToTarget(ctx, s, Math.max(0, p.blend * geom.scale));

  // 3: advance / snap the persistent field F.
  const tick = ctx.tick;
  const tpf = ctx.ticksPerFrame || 1000;
  const last = s.lastTick;
  let snap = !s.seeded || last === null;
  if (!snap && last !== null) {
    const dtTicks = tick - last;
    // Snap on: scrub-back / loop restart (dt<0), paused re-eval (dt==0, the
    // "fix A" settled-preview), and large jumps (flow just enabled, seek).
    if (dtTicks <= 0 || dtTicks > 3 * tpf) {
      snap = true;
    } else {
      integrate(ctx, s, p, dtTicks / tpf);
    }
  }
  if (snap) {
    snapFieldToTarget(ctx, s);
    s.seeded = true;
  }
  s.lastTick = tick;

  // 4: read the iso-line back out as a spline.
  s.result = extractSpline(ctx, s);
  return s.result;
}

export function disposeFlowState(ctx: RenderContext, nodeId: string): void {
  const key = stateKey(nodeId);
  const s = ctx.state[key] as FlowState | undefined;
  if (!s) return;
  releaseField(ctx, s.fieldA);
  releaseField(ctx, s.fieldB);
  releaseField(ctx, s.target);
  releaseField(ctx, s.scratch);
  if (s.coverageTex) ctx.gl.deleteTexture(s.coverageTex);
  delete ctx.state[key];
}
