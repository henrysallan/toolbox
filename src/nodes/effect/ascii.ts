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

// ASCII / glyph-grid effect. Subdivides the input image into cols × rows
// cells, samples each cell's brightness, and renders a glyph in that
// cell picked from a palette (text or image_group).
//
// Two modes share the same shader path by assembling a 1-row atlas of
// glyph sprites:
//   - text:       each character in the palette string is rasterized
//                 into a slot via 2D canvas fillText.
//   - image_set:  each image in the connected image_group is blitted
//                 into a slot via a temp canvas.
//
// The shader samples the input at each cell's center, remaps brightness
// through [in_min, in_max] → [out_min, out_max], picks an atlas slot,
// and mixes the slot's alpha/color against fg/bg. Per-cell scale and
// rotation modulator inputs (same pattern as Array's mod_scale /
// mod_rot) give variety per cell when wired to noise or gradients.
//
// Aux `index` output emits normalized-per-cell grayscale matching
// Array's convention so downstream nodes can drive per-cell effects by
// index.

// ---- shaders -----------------------------------------------------------

const ASCII_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_atlas;
uniform sampler2D u_modScale;
uniform sampler2D u_modRot;
uniform int u_hasModScale;
uniform int u_hasModRot;
uniform float u_modScaleAmt;
uniform float u_modRotAmt;
uniform vec2 u_cells;        // cols, rows
uniform float u_atlasCount;
uniform float u_glyphScale;
uniform float u_inMin;
uniform float u_inMax;
uniform float u_outMin;
uniform float u_outMax;
uniform vec3 u_fgColor;
uniform vec3 u_bgColor;
uniform int u_mode;          // 0 = text, 1 = image_set
out vec4 outColor;

void main() {
  vec2 cellIdxF = floor(v_uv * u_cells);
  vec2 cellCenter = (cellIdxF + 0.5) / u_cells;

  // Brightness via Rec. 601 luminance. Sampling at the cell center
  // gives each cell a single representative value.
  vec3 src = texture(u_src, cellCenter).rgb;
  float bright = dot(src, vec3(0.299, 0.587, 0.114));

  // Remap. Clamp after input-remap so the atlas index is always valid.
  float tNorm = clamp(
    (bright - u_inMin) / max(u_inMax - u_inMin, 1e-6),
    0.0, 1.0
  );
  float t = mix(u_outMin, u_outMax, tNorm);
  float idx = clamp(
    floor(t * u_atlasCount),
    0.0,
    u_atlasCount - 1.0
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
    outColor = vec4(u_bgColor, 1.0);
    return;
  }

  // Atlas is laid out as a single row: slot i occupies the U range
  // [i/N, (i+1)/N). V is the full texture height.
  float atlasU = (idx + localUv.x) / u_atlasCount;
  // 2D canvas texture is row-0-top. Y-flip on sample to land in the
  // pipeline's Y-up convention.
  vec4 s = texture(u_atlas, vec2(atlasU, 1.0 - localUv.y));

  if (u_mode == 0) {
    // Text: glyph alpha is coverage. Mix bg → fg by that coverage.
    outColor = vec4(mix(u_bgColor, u_fgColor, s.a), 1.0);
  } else {
    // Image set: composite slot's RGB over bg via its alpha.
    outColor = vec4(mix(u_bgColor, s.rgb, s.a), 1.0);
  }
}`;

// Per-cell normalized index as grayscale. Matches Array's INDEX_FS so
// downstream nodes can treat "index" the same way in either setting.
const INDEX_FS = `#version 300 es
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

// ---- atlas construction -----------------------------------------------

const SLOT = 64; // pixels per atlas slot
const MONOSPACE_STACK =
  "Menlo, Monaco, 'Courier New', 'SF Mono', monospace";

interface AsciiState {
  atlasCanvas: HTMLCanvasElement;
  atlasTex: WebGLTexture | null;
  tempCanvas: HTMLCanvasElement;
  atlasSig: string | null;
  lastGroupRefs: WebGLTexture[] | null;
  atlasCount: number;
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
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: AsciiState = {
    atlasCanvas: document.createElement("canvas"),
    atlasTex: tex,
    tempCanvas: document.createElement("canvas"),
    atlasSig: null,
    lastGroupRefs: null,
    atlasCount: 0,
  };
  ctx.state[key] = s;
  return s;
}

function buildTextAtlas(state: AsciiState, text: string) {
  const chars = Array.from(text);
  const count = Math.max(1, chars.length);
  const c = state.atlasCanvas;
  c.width = SLOT * count;
  c.height = SLOT;
  const ctx2d = c.getContext("2d");
  if (!ctx2d) return 0;
  ctx2d.clearRect(0, 0, c.width, c.height);
  ctx2d.font = `${Math.floor(SLOT * 0.8)}px ${MONOSPACE_STACK}`;
  ctx2d.textAlign = "center";
  ctx2d.textBaseline = "middle";
  // Render white-on-transparent; shader mixes bg/fg by alpha, so the
  // atlas's RGB doesn't matter — only the alpha channel carries the
  // glyph coverage.
  ctx2d.fillStyle = "#ffffff";
  for (let i = 0; i < count; i++) {
    ctx2d.fillText(chars[i], i * SLOT + SLOT / 2, SLOT / 2);
  }
  return count;
}

function buildImageSetAtlas(
  state: AsciiState,
  ctx: RenderContext,
  items: ImageValue[]
) {
  const count = Math.max(1, items.length);
  const c = state.atlasCanvas;
  c.width = SLOT * count;
  c.height = SLOT;
  const ctx2d = c.getContext("2d");
  if (!ctx2d) return 0;
  ctx2d.clearRect(0, 0, c.width, c.height);
  state.tempCanvas.width = SLOT;
  state.tempCanvas.height = SLOT;
  for (let i = 0; i < items.length; i++) {
    try {
      // Blit the GPU texture into the temp canvas at slot size, then
      // compose the temp canvas into the atlas. N round-trips, but
      // fine for typical group sizes (< 50).
      ctx.blitToCanvas(items[i], state.tempCanvas);
      ctx2d.drawImage(state.tempCanvas, i * SLOT, 0);
    } catch {
      // Leave the slot transparent on failure. Shader will just render
      // the background there.
    }
  }
  return count;
}

function uploadAtlas(state: AsciiState, ctx: RenderContext) {
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
  } catch {
    // ignore — next eval retries
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s =
    h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s.slice(0, 6), 16);
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ];
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

// ---- node definition ---------------------------------------------------

export const asciiNode: NodeDefinition = {
  type: "ascii",
  name: "ASCII",
  category: "image",
  subcategory: "modifier",
  description:
    "Render the input image as a grid of glyphs — text characters from a palette string, or each image in a connected image_group. Brightness remapping, per-cell modulators, and an aux index output match the Array node's conventions.",
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
    {
      name: "fg_color",
      label: "Foreground",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => p.mode === "text",
    },
    {
      name: "bg_color",
      label: "Background",
      type: "color",
      default: "#000000",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [{ name: "index", type: "image" }],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const indexOut = ctx.allocImage();
    const src = inputs.image;
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      ctx.clearTarget(indexOut, [0, 0, 0, 1]);
      return { primary: output, aux: { index: indexOut } };
    }

    const mode = (params.mode as string) ?? "text";
    const cols = Math.max(2, Math.floor((params.cols as number) ?? 80));
    const rows = Math.max(2, Math.floor((params.rows as number) ?? 48));
    const fg = hexToRgb((params.fg_color as string) ?? "#ffffff");
    const bg = hexToRgb((params.bg_color as string) ?? "#000000");
    const glyphScale = (params.glyph_scale as number) ?? 1;
    const inMin = (params.in_min as number) ?? 0;
    const inMax = (params.in_max as number) ?? 1;
    const outMin = (params.out_min as number) ?? 0;
    const outMax = (params.out_max as number) ?? 1;
    const modScaleAmt = (params.mod_scale_amount as number) ?? 0.5;
    const modRotAmt =
      (((params.mod_rot_degrees as number) ?? 45) * Math.PI) / 180;

    const state = ensureState(ctx, nodeId);

    // Rebuild the atlas when anything that would change its pixels
    // has changed. Text-mode signature covers the palette; image_set
    // compares texture references against the last build.
    if (mode === "text") {
      const text = String(params.text ?? " .:-=+*#%@");
      const sig = `text:${text}`;
      if (state.atlasSig !== sig) {
        state.atlasCount = buildTextAtlas(state, text);
        uploadAtlas(state, ctx);
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
        uploadAtlas(state, ctx);
        state.atlasSig = sig;
        state.lastGroupRefs = refs;
      }
    }

    // Empty atlas → transparent output. Happens when image_set has no
    // group connected or the group is empty.
    if (state.atlasCount === 0) {
      ctx.clearTarget(output, [bg[0], bg[1], bg[2], 1]);
      ctx.clearTarget(indexOut, [0, 0, 0, 1]);
      return { primary: output, aux: { index: indexOut } };
    }

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

    // Main pass.
    const prog = ctx.getShader("ascii/main", ASCII_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, state.atlasTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_atlas"), 1);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, modScale.tex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_modScale"), 2);

      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, modRot.tex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_modRot"), 3);

      gl.uniform1i(
        gl.getUniformLocation(prog, "u_hasModScale"),
        modScale.has
      );
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasModRot"), modRot.has);
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
        gl.getUniformLocation(prog, "u_glyphScale"),
        glyphScale
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_inMin"), inMin);
      gl.uniform1f(gl.getUniformLocation(prog, "u_inMax"), inMax);
      gl.uniform1f(gl.getUniformLocation(prog, "u_outMin"), outMin);
      gl.uniform1f(gl.getUniformLocation(prog, "u_outMax"), outMax);
      gl.uniform3f(
        gl.getUniformLocation(prog, "u_fgColor"),
        fg[0],
        fg[1],
        fg[2]
      );
      gl.uniform3f(
        gl.getUniformLocation(prog, "u_bgColor"),
        bg[0],
        bg[1],
        bg[2]
      );
      gl.uniform1i(
        gl.getUniformLocation(prog, "u_mode"),
        mode === "image_set" ? 1 : 0
      );
    });

    // Aux index pass — normalized cell index as grayscale, column-
    // first order (matches Array's default ordering).
    const idxProg = ctx.getShader("ascii/index", INDEX_FS);
    ctx.drawFullscreen(idxProg, indexOut, (gl) => {
      gl.uniform2f(gl.getUniformLocation(idxProg, "u_cells"), cols, rows);
      gl.uniform1i(gl.getUniformLocation(idxProg, "u_rowFirst"), 0);
    });

    return { primary: output, aux: { index: indexOut } };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const state = ctx.state[key] as AsciiState | undefined;
    if (state?.atlasTex) ctx.gl.deleteTexture(state.atlasTex);
    delete ctx.state[key];
    disposePlaceholderTex(ctx.gl, ctx.state, `ascii:${nodeId}:zero`);
  },
};
