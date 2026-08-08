import type {
  ImageGroupValue,
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";
import {
  disposePlaceholderTex,
  getPlaceholderTex,
} from "@/engine/placeholder-tex";
import { OPACITY_PARAM } from "@/engine/conventions";
import {
  COLOR_RAMP_MAX_STOPS,
  type ColorRampStop,
} from "@/engine/color-ramp";
import { hexToRgba01 } from "@/engine/spline-fill";
import { CURATED_FONTS, ensureFontLoaded, isFontReady } from "@/lib/fonts";

// ASCII / glyph-grid effect. Subdivides the input image into cols × rows
// cells, box-averages each cell's color/brightness via a two-pass reduce
// (driver-reduce pattern, GPU-resident — no readback), and renders a
// glyph in that cell picked from a palette (text or image_group).
//
// Two modes share the same shader path by assembling a multi-row atlas
// of glyph sprites (64px slots, 8px gutters, mipmapped):
//   - text:       each character in the palette string is rasterized
//                 into a slot via 2D canvas fillText (font_family param;
//                 curated + local picker, same control as the Text node).
//   - image_set:  each image in the connected image_group is blitted
//                 into a slot GPU-side (slot-rect fragment blit — no CPU
//                 readbacks, so per-frame animated groups are viable).
//
// Glyph (fg) and cell-background colors each source from flat | source
// (the cell's average input color) | ramp. Ramp drivers mirror the
// per-subpath ColorRampBy semantics (spline-color-source.ts), cell-
// flavored: index (column-first ordinal, matches the aux index output),
// random (hash01 mirror), position (Y-DOWN steerable axis), brightness
// (the remapped cell luminance), image (a wired mod_fg/mod_bg driver).
// Compositing is straight-alpha source-over, so ramp per-stop alpha and
// 8-digit flat colors give transparent cell backgrounds; opaque flat
// defaults reduce exactly to the pre-upgrade mix(bg, fg, coverage).
//
// Per-cell scale and rotation modulator inputs (same pattern as Array's
// mod_scale / mod_rot) give variety per cell when wired to noise or
// gradients. Aux `index` emits normalized-per-cell grayscale matching
// Array's convention; aux `brightness` emits the per-cell remapped
// luminance driver. Spec: specdocs/archive/073026_ascii-upgrade.md.

// ---- shaders -----------------------------------------------------------
// FS sources are exported for the headless Electron shader compile check.

// Horizontal box reduce: out texel gx averages the source band
// [gx/outW, (gx+1)/outW) at its row, accumulating PREMULTIPLIED rgba so
// transparent pixels don't pollute cell color. Pure uv-space (no y-flip
// — this grid is only ever sampled back in the same orientation).
export const REDUCE_H_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_srcW;
uniform float u_outW;
out vec4 outColor;
void main() {
  float gx = floor(v_uv.x * u_outW);
  float cellPx = u_srcW / u_outW;
  int taps = int(clamp(ceil(cellPx), 1.0, 256.0));
  float stride = cellPx / float(taps);
  vec4 sum = vec4(0.0);
  for (int i = 0; i < taps; i++) {
    float x = (gx * cellPx + (float(i) + 0.5) * stride) / u_srcW;
    vec4 c = texture(u_src, vec2(min(x, 1.0), v_uv.y));
    sum += vec4(c.rgb * c.a, c.a);
  }
  outColor = sum / float(taps);
}`;

// Vertical box reduce over the H pass (already premultiplied).
export const REDUCE_V_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_srcH;
uniform float u_outH;
out vec4 outColor;
void main() {
  float gy = floor(v_uv.y * u_outH);
  float cellPx = u_srcH / u_outH;
  int taps = int(clamp(ceil(cellPx), 1.0, 256.0));
  float stride = cellPx / float(taps);
  vec4 sum = vec4(0.0);
  for (int i = 0; i < taps; i++) {
    float y = (gy * cellPx + (float(i) + 0.5) * stride) / u_srcH;
    sum += texture(u_src, vec2(v_uv.x, min(y, 1.0)));
  }
  outColor = sum / float(taps);
}`;

// Per-prefix copy of the Color Ramp node's sampleRamp (same stop
// semantics: sort/clamp/bracket, constant holds left, ease smoothsteps).
// Generated per prefix rather than passing GLSL array params — identical
// behavior for fg/bg without leaning on array-parameter driver support.
function rampGlsl(p: string): string {
  return `
uniform int u_${p}StopCount;
uniform float u_${p}Positions[${COLOR_RAMP_MAX_STOPS}];
uniform vec4 u_${p}Colors[${COLOR_RAMP_MAX_STOPS}];
uniform int u_${p}Interp; // 0: linear, 1: ease, 2: constant
vec4 sample_${p}_ramp(float t) {
  if (u_${p}StopCount == 0) return vec4(t, t, t, 1.0);
  if (u_${p}StopCount == 1) return u_${p}Colors[0];
  if (t <= u_${p}Positions[0]) return u_${p}Colors[0];
  if (t >= u_${p}Positions[u_${p}StopCount - 1])
    return u_${p}Colors[u_${p}StopCount - 1];
  for (int i = 0; i < ${COLOR_RAMP_MAX_STOPS - 1}; i++) {
    if (i + 1 >= u_${p}StopCount) break;
    float a = u_${p}Positions[i];
    float b = u_${p}Positions[i + 1];
    if (t >= a && t <= b) {
      float f = (t - a) / max(b - a, 0.0001);
      if (u_${p}Interp == 2) return u_${p}Colors[i];
      if (u_${p}Interp == 1) f = smoothstep(0.0, 1.0, f);
      return mix(u_${p}Colors[i], u_${p}Colors[i + 1], f);
    }
  }
  return u_${p}Colors[u_${p}StopCount - 1];
}`;
}

export const ASCII_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_grid;    // cols×rows premultiplied cell averages
uniform sampler2D u_atlas;
uniform sampler2D u_modScale;
uniform sampler2D u_modRot;
uniform sampler2D u_modFg;
uniform sampler2D u_modBg;
uniform int u_hasModScale;
uniform int u_hasModRot;
uniform int u_hasModFg;
uniform int u_hasModBg;
uniform float u_modScaleAmt;
uniform float u_modRotAmt;
uniform vec2 u_cells;        // cols, rows
uniform float u_atlasCount;
uniform float u_slotsPerRow;
uniform vec2 u_slotUvStride; // slot pitch in atlas uv
uniform vec2 u_slotUvPad;    // gutter offset in atlas uv
uniform vec2 u_slotUvSize;   // glyph box in atlas uv
uniform float u_glyphScale;
uniform float u_inMin;
uniform float u_inMax;
uniform float u_outMin;
uniform float u_outMax;
uniform float u_threshold;
uniform int u_bgTransform;   // 1 = bg follows the glyph scale/rotation
uniform int u_mode;          // 0 = text, 1 = image_set
uniform int u_fgSource;      // 0 flat, 1 source, 2 ramp
uniform vec4 u_fgColor;
uniform int u_fgBy;          // 0 index, 1 random, 2 position, 3 brightness, 4 image
uniform float u_fgSeed;
uniform float u_fgAngle;     // radians
uniform int u_bgSource;
uniform vec4 u_bgColor;
uniform int u_bgBy;
uniform float u_bgSeed;
uniform float u_bgAngle;
out vec4 outColor;
${rampGlsl("fg")}
${rampGlsl("bg")}

// Bit-exact uint mirror of spline-color-source's hash01 — same mix, so
// "random" scatters identically to per-subpath random elsewhere.
float hash01(uint idx, uint seed) {
  uint h = idx * 374761393u + seed * 668265263u;
  h = h ^ (h >> 13u);
  h = h * 1274126177u;
  h = h ^ (h >> 16u);
  return float(h) / 4294967296.0;
}

// Cell analog of makeSubpathDriverFn: resolve this cell's t in [0,1]
// from the configured by-mode.
float cellDriver(
  int by,
  float seed,
  float angle,
  vec2 cellIdxF,
  float bright,
  float modVal
) {
  // Column-first ordinal — matches the aux index output.
  float ordinal = cellIdxF.x * u_cells.y + cellIdxF.y;
  if (by == 1) return hash01(uint(ordinal), uint(seed));
  if (by == 2) {
    // Cell center projected on a steerable axis. Y-DOWN like the spline
    // subpath convention (angle 0 = left→right, 90 = top→bottom).
    vec2 c = (cellIdxF + 0.5) / u_cells;
    float cx = c.x - 0.5;
    float cy = 0.5 - c.y;
    float ca = cos(angle);
    float sa = sin(angle);
    float projHalf = 0.5 * (abs(ca) + abs(sa));
    float proj = cx * ca + cy * sa;
    return clamp(0.5 + proj / max(2.0 * projHalf, 1e-6), 0.0, 1.0);
  }
  if (by == 3) return bright;
  if (by == 4) return modVal;
  float total = max(u_cells.x * u_cells.y, 1.0);
  return ordinal / max(total - 1.0, 1.0);
}

// Straight-alpha source-over. With an opaque bottom this reduces to
// mix(bot.rgb, top.rgb, top.a) at alpha 1 — the pre-upgrade output.
vec4 overComposite(vec4 top, vec4 bot) {
  float a = top.a + bot.a * (1.0 - top.a);
  vec3 rgb =
    (top.rgb * top.a + bot.rgb * bot.a * (1.0 - top.a)) / max(a, 1e-6);
  return vec4(rgb, a);
}

void main() {
  vec2 cellIdxF = floor(v_uv * u_cells);
  vec2 cellCenter = (cellIdxF + 0.5) / u_cells;

  // Cell average from the reduce pre-pass (premultiplied). Brightness
  // via Rec. 601 luminance of the unpremultiplied average — the box
  // average keeps video stable where center-texel sampling flickered.
  vec4 cellAvg = texture(u_grid, cellCenter);
  float avgA = cellAvg.a;
  vec3 avgRgb = cellAvg.rgb / max(avgA, 1e-5);
  float bright = dot(avgRgb, vec3(0.299, 0.587, 0.114));

  // Remap. Clamp after input-remap so the atlas index is always valid.
  float tNorm = clamp(
    (bright - u_inMin) / max(u_inMax - u_inMin, 1e-6),
    0.0, 1.0
  );
  // True-blank gate: below the threshold the cell renders nothing at
  // all — no background fill under blank glyphs, so a space in the
  // palette reads as genuinely empty rather than a filled cell. Strict
  // <, so the default 0 disables the gate entirely.
  if (tNorm < u_threshold) {
    outColor = vec4(0.0);
    return;
  }

  float t = mix(u_outMin, u_outMax, tNorm);
  float idx = clamp(
    floor(t * u_atlasCount),
    0.0,
    u_atlasCount - 1.0
  );

  // Per-cell fg/bg colors.
  float fgMod = u_hasModFg == 1 ? texture(u_modFg, cellCenter).r : 0.5;
  float bgMod = u_hasModBg == 1 ? texture(u_modBg, cellCenter).r : 0.5;
  vec4 fg = u_fgColor;
  if (u_fgSource == 1) fg = vec4(avgRgb, avgA);
  else if (u_fgSource == 2)
    fg = sample_fg_ramp(
      cellDriver(u_fgBy, u_fgSeed, u_fgAngle, cellIdxF, tNorm, fgMod)
    );
  vec4 bg = u_bgColor;
  if (u_bgSource == 1) bg = vec4(avgRgb, avgA);
  else if (u_bgSource == 2)
    bg = sample_bg_ramp(
      cellDriver(u_bgBy, u_bgSeed, u_bgAngle, cellIdxF, tNorm, bgMod)
    );

  // Per-cell modulators (same 0.5-center neutral mapping Array uses —
  // a mid-gray mod image leaves the cell unchanged).
  float effScale = u_glyphScale;
  if (u_hasModScale == 1) {
    float m = texture(u_modScale, cellCenter).r;
    effScale *= 1.0 + (m - 0.5) * 2.0 * u_modScaleAmt;
  }
  float effRot = 0.0;
  if (u_hasModRot == 1) {
    float m = texture(u_modRot, cellCenter).r;
    effRot = (m - 0.5) * 2.0 * u_modRotAmt;
  }

  // Local UV inside the cell, centered at 0.5. Apply scale + rotation
  // around the cell center, then lookup the atlas slot.
  vec2 localUv = fract(v_uv * u_cells);
  vec2 p = localUv - 0.5;
  float co = cos(-effRot);
  float si = sin(-effRot);
  p = vec2(co * p.x - si * p.y, si * p.x + co * p.y);
  p /= max(effScale, 1e-4);
  localUv = p + 0.5;

  if (
    localUv.x < 0.0 || localUv.x > 1.0 ||
    localUv.y < 0.0 || localUv.y > 1.0
  ) {
    // Outside the glyph's transformed box. With bg-transform on, the
    // background IS the transformed tile, so nothing renders here; off
    // (default), the background fills the whole cell rect.
    outColor = u_bgTransform == 1 ? vec4(0.0) : bg;
    return;
  }

  // Multi-row atlas: slot idx at (idx % perRow, idx / perRow), glyph box
  // inset by the gutter. Atlas v grows downward (canvas convention) —
  // Y-flip on sample to land in the pipeline's Y-up convention.
  float sx = mod(idx, u_slotsPerRow);
  float sy = floor(idx / u_slotsPerRow);
  vec2 slotOrigin = vec2(sx, sy) * u_slotUvStride + u_slotUvPad;
  vec2 glyphUv = vec2(localUv.x, 1.0 - localUv.y) * u_slotUvSize;
  vec4 s = texture(u_atlas, slotOrigin + glyphUv);

  // Text: glyph alpha is coverage, tinted by the resolved fg color.
  // Image set: the slot carries its own color; composite over bg.
  vec4 glyph = u_mode == 0 ? vec4(fg.rgb, fg.a * s.a) : s;
  outColor = overComposite(glyph, bg);
}`;

// Per-cell normalized index as grayscale. Matches Array's INDEX_FS so
// downstream nodes can treat "index" the same way in either setting.
export const INDEX_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_cells;
uniform int u_rowFirst;
out vec4 outColor;
void main() {
  vec2 idxF = floor(v_uv * u_cells);
  float total = max(u_cells.x * u_cells.y, 1.0);
  float idx = u_rowFirst == 1
    ? idxF.y * u_cells.x + idxF.x
    : idxF.x * u_cells.y + idxF.y;
  float t = idx / max(total - 1.0, 1.0);
  outColor = vec4(t, t, t, 1.0);
}`;

// Per-cell remapped luminance (the glyph-selection driver) as grayscale
// — feed it downstream the way Adaptive Pixelate consumes drivers.
export const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_grid;
uniform vec2 u_cells;
uniform float u_inMin;
uniform float u_inMax;
out vec4 outColor;
void main() {
  vec2 cellCenter = (floor(v_uv * u_cells) + 0.5) / u_cells;
  vec4 cellAvg = texture(u_grid, cellCenter);
  vec3 avgRgb = cellAvg.rgb / max(cellAvg.a, 1e-5);
  float bright = dot(avgRgb, vec3(0.299, 0.587, 0.114));
  float t = clamp(
    (bright - u_inMin) / max(u_inMax - u_inMin, 1e-6),
    0.0, 1.0
  );
  outColor = vec4(t, t, t, 1.0);
}`;

// Blit one image_set item into its atlas slot: fragments outside the
// slot's glyph box discard (drawFullscreen doesn't clear, so successive
// slot draws compose). Items are engine images (Y-up); the atlas is
// canvas-oriented (v grows downward) — flip on sample.
export const BLIT_SLOT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_item;
uniform vec4 u_slotRect; // xy origin, zw size — glyph box in atlas uv
out vec4 outColor;
void main() {
  vec2 t = (v_uv - u_slotRect.xy) / u_slotRect.zw;
  if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) discard;
  outColor = texture(u_item, vec2(t.x, 1.0 - t.y));
}`;

// ---- atlas construction -----------------------------------------------

const SLOT = 64; // glyph box px per atlas slot
const PAD = 8; // gutter px around each glyph box (mip-bleed guard)
const PITCH = SLOT + PAD * 2;
// Gutter width 8px = mip level 3; clamping LOD there means no usable
// level ever blends texels across slot boundaries.
const MAX_ATLAS_LOD = 3;
const MONOSPACE_STACK =
  "Menlo, Monaco, 'Courier New', 'SF Mono', monospace";

interface AsciiState {
  atlasCanvas: HTMLCanvasElement;
  atlasTex: WebGLTexture | null;
  atlasSig: string | null;
  lastGroupRefs: WebGLTexture[] | null;
  atlasCount: number;
  slotsPerRow: number;
  atlasW: number;
  atlasH: number;
}

function stateKey(nodeId: string): string {
  return `ascii:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): AsciiState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as AsciiState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("ascii: failed to create atlas texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAX_LOD, MAX_ATLAS_LOD);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: AsciiState = {
    atlasCanvas: document.createElement("canvas"),
    atlasTex: tex,
    atlasSig: null,
    lastGroupRefs: null,
    atlasCount: 0,
    slotsPerRow: 1,
    atlasW: PITCH,
    atlasH: PITCH,
  };
  ctx.state[key] = s;
  return s;
}

// Row-major multi-row layout, width capped so long palettes / big image
// groups never hit MAX_TEXTURE_SIZE (the old single-row atlas did at
// 256 slots on common GPUs).
function atlasLayout(gl: WebGL2RenderingContext, count: number) {
  const maxW = Math.min(
    (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096,
    4096
  );
  const slotsPerRow = Math.max(
    1,
    Math.min(count, Math.floor(maxW / PITCH))
  );
  const rowCount = Math.ceil(count / slotsPerRow);
  return {
    slotsPerRow,
    rowCount,
    width: slotsPerRow * PITCH,
    height: rowCount * PITCH,
  };
}

function buildTextAtlas(
  state: AsciiState,
  ctx: RenderContext,
  text: string,
  family: string
): number {
  const chars = Array.from(text);
  const count = Math.max(1, chars.length);
  const layout = atlasLayout(ctx.gl, count);
  const c = state.atlasCanvas;
  c.width = layout.width;
  c.height = layout.height;
  const ctx2d = c.getContext("2d");
  if (!ctx2d) return 0;
  ctx2d.clearRect(0, 0, c.width, c.height);
  ctx2d.font = `${Math.floor(SLOT * 0.8)}px "${family}", ${MONOSPACE_STACK}`;
  ctx2d.textAlign = "center";
  ctx2d.textBaseline = "middle";
  // Render white-on-transparent; shader tints by the resolved fg color,
  // so the atlas's RGB doesn't matter — only the alpha channel carries
  // the glyph coverage.
  ctx2d.fillStyle = "#ffffff";
  for (let i = 0; i < count; i++) {
    const col = i % layout.slotsPerRow;
    const row = Math.floor(i / layout.slotsPerRow);
    ctx2d.fillText(
      chars[i],
      col * PITCH + PAD + SLOT / 2,
      row * PITCH + PAD + SLOT / 2
    );
  }
  state.slotsPerRow = layout.slotsPerRow;
  state.atlasW = layout.width;
  state.atlasH = layout.height;
  return count;
}

function uploadTextAtlas(state: AsciiState, ctx: RenderContext) {
  const gl = ctx.gl;
  gl.bindTexture(gl.TEXTURE_2D, state.atlasTex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  try {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      state.atlasCanvas
    );
    gl.generateMipmap(gl.TEXTURE_2D);
  } catch {
    // ignore — next eval retries
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
}

// GPU-side image_set atlas: reallocate the persistent texture at layout
// size, then blit each item into its slot via slot-rect fragment draws.
// Replaces the old per-item readImagePixels CPU readbacks, which stalled
// the pipeline every rebuild (every frame, for animated groups).
function buildImageSetAtlas(
  state: AsciiState,
  ctx: RenderContext,
  items: ImageValue[]
): number {
  const gl = ctx.gl;
  const count = Math.max(1, items.length);
  const layout = atlasLayout(gl, count);
  gl.bindTexture(gl.TEXTURE_2D, state.atlasTex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    layout.width,
    layout.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null
  );
  gl.bindTexture(gl.TEXTURE_2D, null);

  const target: ImageValue = {
    kind: "image",
    texture: state.atlasTex!,
    width: layout.width,
    height: layout.height,
  };
  ctx.clearTarget(target, [0, 0, 0, 0]);
  const prog = ctx.getShader("ascii/atlas-blit", BLIT_SLOT_FS);
  for (let i = 0; i < items.length; i++) {
    const col = i % layout.slotsPerRow;
    const row = Math.floor(i / layout.slotsPerRow);
    const rect = [
      (col * PITCH + PAD) / layout.width,
      (row * PITCH + PAD) / layout.height,
      SLOT / layout.width,
      SLOT / layout.height,
    ];
    ctx.drawFullscreen(prog, target, (g) => {
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, items[i].texture);
      g.uniform1i(g.getUniformLocation(prog, "u_item"), 0);
      g.uniform4f(
        g.getUniformLocation(prog, "u_slotRect"),
        rect[0],
        rect[1],
        rect[2],
        rect[3]
      );
    });
  }
  gl.bindTexture(gl.TEXTURE_2D, state.atlasTex);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);

  state.slotsPerRow = layout.slotsPerRow;
  state.atlasW = layout.width;
  state.atlasH = layout.height;
  return count;
}

function groupRefsEqual(
  prev: WebGLTexture[] | null,
  next: WebGLTexture[]
): boolean {
  if (!prev || prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return false;
  }
  return true;
}

// ---- ramp / color param plumbing ---------------------------------------

function interpToInt(m: string): number {
  switch (m) {
    case "ease":
      return 1;
    case "constant":
      return 2;
    default:
      return 0;
  }
}

function byToInt(m: string): number {
  switch (m) {
    case "random":
      return 1;
    case "position":
      return 2;
    case "brightness":
      return 3;
    // "input" is the pre-rename value for the wired-driver mode — accept
    // both so a graph saved during the few hours it existed still works.
    case "image":
    case "input":
      return 4;
    default:
      return 0; // index
  }
}

function uploadRamp(
  gl: WebGL2RenderingContext,
  prog: WebGLProgram,
  prefix: string,
  stops: ColorRampStop[],
  interp: string
) {
  const sorted = [...stops]
    .filter((s) => typeof s.position === "number")
    .sort((a, b) => a.position - b.position)
    .slice(0, COLOR_RAMP_MAX_STOPS);
  const positions = new Float32Array(COLOR_RAMP_MAX_STOPS);
  const colors = new Float32Array(COLOR_RAMP_MAX_STOPS * 4);
  for (let i = 0; i < sorted.length; i++) {
    positions[i] = Math.max(0, Math.min(1, sorted[i].position));
    const [r, g, b, a] = hexToRgba01(sorted[i].color ?? "#000000");
    colors[i * 4 + 0] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] =
      Math.max(0, Math.min(1, sorted[i].alpha ?? 1)) * a;
  }
  gl.uniform1i(
    gl.getUniformLocation(prog, `u_${prefix}StopCount`),
    sorted.length
  );
  gl.uniform1fv(
    gl.getUniformLocation(prog, `u_${prefix}Positions[0]`),
    positions
  );
  gl.uniform4fv(
    gl.getUniformLocation(prog, `u_${prefix}Colors[0]`),
    colors
  );
  gl.uniform1i(
    gl.getUniformLocation(prog, `u_${prefix}Interp`),
    interpToInt(interp)
  );
}

const CELL_RAMP_BY = [
  "index",
  "random",
  "position",
  "brightness",
  "image",
];

// ---- node definition ---------------------------------------------------

export const asciiNode: NodeDefinition = {
  type: "ascii",
  name: "ASCII",
  category: "image",
  subcategory: "modifier",
  description:
    "Render the input image as a grid of glyphs — text characters from a palette string (any font), or each image in a connected image_group. Glyph and per-cell background colors source from flat / the cell's own color / a color ramp driven by index, seeded hash, position, brightness, or a wired image. Brightness remapping, per-cell modulators, and aux index/brightness outputs match the Array node's conventions.",
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  inputs: [
    { name: "image", type: "image", required: true },
    { name: "mod_scale", type: "image", required: false },
    { name: "mod_rot", type: "image", required: false },
  ],
  resolveInputs(params): InputSocketDef[] {
    const mode = (params.mode as string) ?? "text";
    const base: InputSocketDef[] = [
      { name: "image", type: "image", required: true },
      { name: "mod_scale", type: "image", required: false },
      { name: "mod_rot", type: "image", required: false },
    ];
    if (mode === "image_set") {
      base.splice(1, 0, {
        name: "image_set",
        type: "image_group",
        required: true,
      });
    }
    const isImageBy = (v: unknown) => v === "image" || v === "input";
    if (
      mode === "text" &&
      params.fg_source === "ramp" &&
      isImageBy(params.fg_ramp_by)
    ) {
      base.push({ name: "mod_fg", type: "image", required: false });
    }
    if (params.bg_source === "ramp" && isImageBy(params.bg_ramp_by)) {
      base.push({ name: "mod_bg", type: "image", required: false });
    }
    return base;
  },
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["text", "image_set"],
      default: "text",
    },
    {
      name: "text",
      label: "Palette",
      type: "string",
      default: " .:-=+*#%@",
      visibleIf: (p) => p.mode === "text",
    },
    {
      name: "font_family",
      label: "Font",
      type: "enum",
      control: "font",
      options: CURATED_FONTS,
      // Head of the old hardcoded mono stack — unset projects render as
      // before (the full stack stays as the fallback chain).
      default: "Menlo",
      visibleIf: (p) => p.mode === "text",
    },
    {
      name: "cols",
      label: "Cols",
      type: "scalar",
      min: 2,
      max: 512,
      softMax: 128,
      step: 1,
      default: 80,
    },
    {
      name: "rows",
      label: "Rows",
      type: "scalar",
      min: 2,
      max: 512,
      softMax: 128,
      step: 1,
      default: 48,
    },
    {
      name: "glyph_scale",
      label: "Glyph scale",
      type: "scalar",
      min: 0.1,
      max: 2,
      step: 0.01,
      default: 1,
    },
    {
      name: "in_min",
      label: "Remap in min",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "in_max",
      label: "Remap in max",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    {
      name: "out_min",
      label: "Remap out min",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "out_max",
      label: "Remap out max",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    // Cells whose remapped brightness sits below this render fully
    // transparent — background included. 0 = every cell fills (the
    // pre-threshold behavior).
    {
      name: "threshold",
      label: "Blank below",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      name: "mod_scale_amount",
      label: "Scale mod",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "mod_rot_degrees",
      label: "Rotate mod (deg)",
      type: "scalar",
      min: 0,
      max: 360,
      softMax: 90,
      step: 1,
      default: 45,
    },
    // ---- glyph (fg) color ----
    // flat | source (the cell's average input color — colored ASCII) |
    // ramp (per-cell driver → color ramp, per-stop alpha honored).
    {
      name: "fg_source",
      label: "Glyph color",
      type: "enum",
      options: ["flat", "source", "ramp"],
      default: "flat",
      visibleIf: (p) => p.mode === "text",
    },
    {
      name: "fg_color",
      label: "Foreground",
      type: "color",
      default: "#ffffff",
      alpha: true,
      visibleIf: (p) =>
        p.mode === "text" &&
        p.fg_source !== "ramp" &&
        p.fg_source !== "source",
    },
    {
      name: "fg_ramp",
      label: "Glyph ramp",
      type: "color_ramp",
      default: [
        { id: "stop-a", position: 0, color: "#ffffff" },
        { id: "stop-b", position: 1, color: "#000000" },
      ] as ColorRampStop[],
      visibleIf: (p) => p.mode === "text" && p.fg_source === "ramp",
    },
    // Which value drives each cell's position along the ramp.
    //   index      — column-first cell ordinal (matches the aux index)
    //   random     — seeded per-cell hash (scattered; seed reshuffles)
    //   position   — cell center projected on a steerable axis (Y-DOWN,
    //                like per-subpath position mode)
    //   brightness — the cell's remapped luminance (duotone ASCII)
    //   image      — a wired mod_fg image's value at the cell center
    //                (the socket appears when this mode is selected)
    {
      name: "fg_ramp_by",
      label: "Ramp by",
      type: "enum",
      options: CELL_RAMP_BY,
      default: "brightness",
      visibleIf: (p) => p.mode === "text" && p.fg_source === "ramp",
    },
    {
      name: "fg_ramp_seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 9999,
      step: 1,
      default: 0,
      visibleIf: (p) =>
        p.mode === "text" &&
        p.fg_source === "ramp" &&
        p.fg_ramp_by === "random",
    },
    {
      name: "fg_ramp_angle",
      label: "Gradient angle",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      visibleIf: (p) =>
        p.mode === "text" &&
        p.fg_source === "ramp" &&
        p.fg_ramp_by === "position",
    },
    {
      name: "fg_ramp_interp",
      label: "Ramp interpolation",
      type: "enum",
      options: ["linear", "ease", "constant"],
      default: "linear",
      visibleIf: (p) => p.mode === "text" && p.fg_source === "ramp",
    },
    // ---- cell background ----
    // The background tile follows the glyph's effective transform
    // (glyph_scale × mod_scale, mod_rot) instead of filling the whole
    // cell rect — cells become scaled/rotated cards, and glyph_scale < 1
    // opens transparent gutters between them.
    {
      name: "bg_transform",
      label: "Transform background",
      type: "boolean",
      default: false,
    },
    {
      name: "bg_source",
      label: "Cell background",
      type: "enum",
      options: ["flat", "source", "ramp"],
      default: "flat",
    },
    {
      name: "bg_color",
      label: "Background",
      type: "color",
      default: "#000000",
      alpha: true,
      visibleIf: (p) =>
        p.bg_source !== "ramp" && p.bg_source !== "source",
    },
    {
      name: "bg_ramp",
      label: "Background ramp",
      type: "color_ramp",
      default: [
        { id: "stop-a", position: 0, color: "#000000" },
        { id: "stop-b", position: 1, color: "#ffffff" },
      ] as ColorRampStop[],
      visibleIf: (p) => p.bg_source === "ramp",
    },
    {
      name: "bg_ramp_by",
      label: "Ramp by",
      type: "enum",
      options: CELL_RAMP_BY,
      default: "index",
      visibleIf: (p) => p.bg_source === "ramp",
    },
    {
      name: "bg_ramp_seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 9999,
      step: 1,
      default: 0,
      visibleIf: (p) =>
        p.bg_source === "ramp" && p.bg_ramp_by === "random",
    },
    {
      name: "bg_ramp_angle",
      label: "Gradient angle",
      type: "scalar",
      min: -180,
      max: 180,
      step: 1,
      default: 0,
      visibleIf: (p) =>
        p.bg_source === "ramp" && p.bg_ramp_by === "position",
    },
    {
      name: "bg_ramp_interp",
      label: "Ramp interpolation",
      type: "enum",
      options: ["linear", "ease", "constant"],
      default: "linear",
      visibleIf: (p) => p.bg_source === "ramp",
    },
    OPACITY_PARAM,
  ],
  primaryOutput: "image",
  auxOutputs: [
    { name: "index", type: "image" },
    { name: "brightness", type: "image" },
  ],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const indexOut = ctx.allocImage();
    const brightOut = ctx.allocImage();
    const src = inputs.image;
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      ctx.clearTarget(indexOut, [0, 0, 0, 1]);
      ctx.clearTarget(brightOut, [0, 0, 0, 1]);
      return {
        primary: output,
        aux: { index: indexOut, brightness: brightOut },
      };
    }

    const mode = (params.mode as string) ?? "text";
    const cols = Math.max(2, Math.floor((params.cols as number) ?? 80));
    const rows = Math.max(2, Math.floor((params.rows as number) ?? 48));
    const fgFlat = hexToRgba01((params.fg_color as string) ?? "#ffffff");
    const bgFlat = hexToRgba01((params.bg_color as string) ?? "#000000");
    const glyphScale = (params.glyph_scale as number) ?? 1;
    const inMin = (params.in_min as number) ?? 0;
    const inMax = (params.in_max as number) ?? 1;
    const outMin = (params.out_min as number) ?? 0;
    const outMax = (params.out_max as number) ?? 1;
    const threshold = (params.threshold as number) ?? 0;
    const modScaleAmt = (params.mod_scale_amount as number) ?? 0.5;
    const modRotAmt =
      (((params.mod_rot_degrees as number) ?? 45) * Math.PI) / 180;
    const srcToInt = (v: unknown): number =>
      v === "source" ? 1 : v === "ramp" ? 2 : 0;
    const fgSource = mode === "text" ? srcToInt(params.fg_source) : 0;
    const bgSource = srcToInt(params.bg_source);

    const state = ensureState(ctx, nodeId);

    // Rebuild the atlas when anything that would change its pixels has
    // changed. Text-mode signature covers palette + font (+ webfont
    // readiness, so the atlas re-bakes when a loading font lands — same
    // pattern as the Text node); image_set compares texture references
    // against the last build.
    if (mode === "text") {
      const text = String(params.text ?? " .:-=+*#%@");
      const family = (params.font_family as string) ?? "Menlo";
      const ready = isFontReady(family);
      if (!ready) ensureFontLoaded(family);
      const sig = `text:${family}:${ready ? 1 : 0}:${text}`;
      if (state.atlasSig !== sig) {
        state.atlasCount = buildTextAtlas(state, ctx, text, family);
        uploadTextAtlas(state, ctx);
        state.atlasSig = sig;
        state.lastGroupRefs = null;
      }
    } else {
      const group = inputs.image_set as ImageGroupValue | undefined;
      const items =
        group && group.kind === "image_group" ? group.items : [];
      const refs = items.map((i) => i.texture);
      const sig = `image_set:${items.length}`;
      const refsSame = groupRefsEqual(state.lastGroupRefs, refs);
      if (state.atlasSig !== sig || !refsSame) {
        state.atlasCount = buildImageSetAtlas(state, ctx, items);
        state.atlasSig = sig;
        state.lastGroupRefs = refs;
      }
    }

    // Empty atlas → flat background. Happens when the text-mode canvas
    // context is unavailable.
    if (state.atlasCount === 0) {
      ctx.clearTarget(output, bgFlat);
      ctx.clearTarget(indexOut, [0, 0, 0, 1]);
      ctx.clearTarget(brightOut, [0, 0, 0, 1]);
      return {
        primary: output,
        aux: { index: indexOut, brightness: brightOut },
      };
    }

    // Cell-average reduce: box-filter the source down to cols × rows
    // (premultiplied RGBA), so brightness and the `source` color modes
    // read a true area average instead of a single center texel.
    const gridH = ctx.allocImage({ width: cols, height: src.height });
    const progH = ctx.getShader("ascii/reduce-h", REDUCE_H_FS);
    ctx.drawFullscreen(progH, gridH, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(progH, "u_src"), 0);
      gl.uniform1f(gl.getUniformLocation(progH, "u_srcW"), src.width);
      gl.uniform1f(gl.getUniformLocation(progH, "u_outW"), cols);
    });
    const grid = ctx.allocImage({ width: cols, height: rows });
    const progV = ctx.getShader("ascii/reduce-v", REDUCE_V_FS);
    ctx.drawFullscreen(progV, grid, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, gridH.texture);
      gl.uniform1i(gl.getUniformLocation(progV, "u_src"), 0);
      gl.uniform1f(gl.getUniformLocation(progV, "u_srcH"), src.height);
      gl.uniform1f(gl.getUniformLocation(progV, "u_outH"), rows);
    });
    ctx.releaseTexture(gridH.texture);

    // Modulator inputs — placeholder texture when unconnected.
    const placeholderKey = `ascii:${nodeId}:zero`;
    const placeholder = getPlaceholderTex(
      ctx.gl,
      ctx.state,
      placeholderKey
    );
    const resolveMod = (
      sv: ImageValue | undefined
    ): { has: 0 | 1; tex: WebGLTexture } =>
      sv && sv.kind === "image"
        ? { has: 1, tex: sv.texture }
        : { has: 0, tex: placeholder };
    const modScale = resolveMod(inputs.mod_scale as ImageValue | undefined);
    const modRot = resolveMod(inputs.mod_rot as ImageValue | undefined);
    const modFg = resolveMod(inputs.mod_fg as ImageValue | undefined);
    const modBg = resolveMod(inputs.mod_bg as ImageValue | undefined);

    // Main pass.
    const prog = ctx.getShader("ascii/main", ASCII_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      const bind = (unit: number, name: string, tex: WebGLTexture) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(gl.getUniformLocation(prog, name), unit);
      };
      bind(0, "u_grid", grid.texture);
      bind(1, "u_atlas", state.atlasTex!);
      bind(2, "u_modScale", modScale.tex);
      bind(3, "u_modRot", modRot.tex);
      bind(4, "u_modFg", modFg.tex);
      bind(5, "u_modBg", modBg.tex);

      gl.uniform1i(
        gl.getUniformLocation(prog, "u_hasModScale"),
        modScale.has
      );
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasModRot"), modRot.has);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasModFg"), modFg.has);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasModBg"), modBg.has);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_modScaleAmt"),
        modScaleAmt
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_modRotAmt"), modRotAmt);

      gl.uniform2f(gl.getUniformLocation(prog, "u_cells"), cols, rows);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_atlasCount"),
        state.atlasCount
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_slotsPerRow"),
        state.slotsPerRow
      );
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_slotUvStride"),
        PITCH / state.atlasW,
        PITCH / state.atlasH
      );
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_slotUvPad"),
        PAD / state.atlasW,
        PAD / state.atlasH
      );
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_slotUvSize"),
        SLOT / state.atlasW,
        SLOT / state.atlasH
      );
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_glyphScale"),
        glyphScale
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_inMin"), inMin);
      gl.uniform1f(gl.getUniformLocation(prog, "u_inMax"), inMax);
      gl.uniform1f(gl.getUniformLocation(prog, "u_outMin"), outMin);
      gl.uniform1f(gl.getUniformLocation(prog, "u_outMax"), outMax);
      gl.uniform1f(
        gl.getUniformLocation(prog, "u_threshold"),
        threshold
      );
      gl.uniform1i(
        gl.getUniformLocation(prog, "u_bgTransform"),
        params.bg_transform === true ? 1 : 0
      );
      gl.uniform1i(
        gl.getUniformLocation(prog, "u_mode"),
        mode === "image_set" ? 1 : 0
      );

      gl.uniform1i(gl.getUniformLocation(prog, "u_fgSource"), fgSource);
      gl.uniform4f(
        gl.getUniformLocation(prog, "u_fgColor"),
        fgFlat[0],
        fgFlat[1],
        fgFlat[2],
        fgFlat[3]
      );
      gl.uniform1i(gl.getUniformLocation(prog, "u_bgSource"), bgSource);
      gl.uniform4f(
        gl.getUniformLocation(prog, "u_bgColor"),
        bgFlat[0],
        bgFlat[1],
        bgFlat[2],
        bgFlat[3]
      );
      if (fgSource === 2) {
        gl.uniform1i(
          gl.getUniformLocation(prog, "u_fgBy"),
          byToInt((params.fg_ramp_by as string) ?? "brightness")
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_fgSeed"),
          Math.floor((params.fg_ramp_seed as number) ?? 0)
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_fgAngle"),
          (((params.fg_ramp_angle as number) ?? 0) * Math.PI) / 180
        );
        uploadRamp(
          gl,
          prog,
          "fg",
          Array.isArray(params.fg_ramp)
            ? (params.fg_ramp as ColorRampStop[])
            : [],
          (params.fg_ramp_interp as string) ?? "linear"
        );
      }
      if (bgSource === 2) {
        gl.uniform1i(
          gl.getUniformLocation(prog, "u_bgBy"),
          byToInt((params.bg_ramp_by as string) ?? "index")
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_bgSeed"),
          Math.floor((params.bg_ramp_seed as number) ?? 0)
        );
        gl.uniform1f(
          gl.getUniformLocation(prog, "u_bgAngle"),
          (((params.bg_ramp_angle as number) ?? 0) * Math.PI) / 180
        );
        uploadRamp(
          gl,
          prog,
          "bg",
          Array.isArray(params.bg_ramp)
            ? (params.bg_ramp as ColorRampStop[])
            : [],
          (params.bg_ramp_interp as string) ?? "linear"
        );
      }
    });

    // Aux index pass — normalized cell index as grayscale, column-
    // first order (matches Array's default ordering).
    const idxProg = ctx.getShader("ascii/index", INDEX_FS);
    ctx.drawFullscreen(idxProg, indexOut, (gl) => {
      gl.uniform2f(gl.getUniformLocation(idxProg, "u_cells"), cols, rows);
      gl.uniform1i(gl.getUniformLocation(idxProg, "u_rowFirst"), 0);
    });

    // Aux brightness pass — the per-cell remapped luminance driver.
    const brightProg = ctx.getShader("ascii/brightness", BRIGHT_FS);
    ctx.drawFullscreen(brightProg, brightOut, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, grid.texture);
      gl.uniform1i(gl.getUniformLocation(brightProg, "u_grid"), 0);
      gl.uniform2f(
        gl.getUniformLocation(brightProg, "u_cells"),
        cols,
        rows
      );
      gl.uniform1f(gl.getUniformLocation(brightProg, "u_inMin"), inMin);
      gl.uniform1f(gl.getUniformLocation(brightProg, "u_inMax"), inMax);
    });
    ctx.releaseTexture(grid.texture);

    return {
      primary: output,
      aux: { index: indexOut, brightness: brightOut },
    };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const state = ctx.state[key] as AsciiState | undefined;
    if (state?.atlasTex) ctx.gl.deleteTexture(state.atlasTex);
    delete ctx.state[key];
    disposePlaceholderTex(ctx.gl, ctx.state, `ascii:${nodeId}:zero`);
  },
};
