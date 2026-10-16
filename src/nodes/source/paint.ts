import { OPACITY_PARAM } from "@/engine/conventions";
import {
  paintInputEpoch,
  takePaintInputWaiters,
} from "@/engine/paint-input-registry";
import type {
  ImageValue,
  NodeDefinition,
  PaintParamValue,
  RenderContext,
} from "@/engine/types";

export const PAINT_BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec4 u_bg;
uniform float u_transparent;
out vec4 outColor;
void main() {
  // Source is a 2D canvas (row 0 at top). Flip to WebGL-Y-up so downstream
  // samples match the rest of the pipeline's convention. The canvas is
  // transparent; strokes carry alpha. bg_mode "color" composites them over
  // the configured background (legacy behavior, always opaque); bg_mode
  // "transparent" passes the straight-alpha strokes through untouched — so
  // Paint layers over other content, and image→mask coercion mattes by the
  // stroke silhouette.
  vec4 s = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
  vec4 overBg = vec4(mix(u_bg.rgb, s.rgb, s.a), 1.0);
  outColor = mix(overBg, s, u_transparent);
}`;

// With an image wired in (101526_paint-selection-transform.md §1): the input
// is the live bottom layer, the knockout mask cuts holes in it (eraser,
// moved pixels), and the edit layer sits on top —
// out = over(edit, input × (1 − knockout.a)), all straight alpha, then the
// same bg_mode step as the plain blit. Edit + knockout are 2D canvases (row
// 0 at top) and flip; the input is a pipeline texture and doesn't.
export const PAINT_COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_in;
uniform sampler2D u_ko;
uniform float u_hasSrc;
uniform float u_hasKo;
uniform vec4 u_bg;
uniform float u_transparent;
out vec4 outColor;
void main() {
  vec2 cuv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec4 e = u_hasSrc > 0.5 ? texture(u_src, cuv) : vec4(0.0);
  vec4 b = texture(u_in, v_uv);
  if (u_hasKo > 0.5) b.a *= 1.0 - texture(u_ko, cuv).a;
  float a = e.a + b.a * (1.0 - e.a);
  vec3 rgb = a > 0.0
    ? (e.rgb * e.a + b.rgb * b.a * (1.0 - e.a)) / a
    : vec3(0.0);
  vec4 s = vec4(rgb, a);
  vec4 overBg = vec4(mix(u_bg.rgb, s.rgb, s.a), 1.0);
  outColor = mix(overBg, s, u_transparent);
}`;

interface PaintState {
  bitmapRef: ImageBitmap | null;
  tex: WebGLTexture | null;
}

// Upload `bitmap` into the per-node cached texture under `stateKey`,
// re-uploading only when the snapshot identity changed (every editor
// mutation mints a fresh ImageBitmap).
function bitmapTexture(
  ctx: RenderContext,
  stateKey: string,
  bitmap: ImageBitmap
): WebGLTexture {
  const gl = ctx.gl;
  const cached = ctx.state[stateKey] as PaintState | undefined;
  if (cached?.tex && cached.bitmapRef === bitmap) return cached.tex;
  if (cached?.tex) gl.deleteTexture(cached.tex);
  const tex = gl.createTexture();
  if (!tex) throw new Error("paint: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  ctx.state[stateKey] = { bitmapRef: bitmap, tex } satisfies PaintState;
  return tex;
}

// Answer the editor's pending input-pixel requests (paint-input-registry).
// Runs before any early return so a request never strands. A region request
// on an input already at edit-canvas size reads just that crop on the GPU
// (readImageRegion); otherwise the input is resampled to the canvas size and
// cropped on the CPU.
function serveInputRequests(
  ctx: RenderContext,
  nodeId: string,
  input: ImageValue | null
) {
  for (const w of takePaintInputWaiters(nodeId)) {
    if (!input) {
      w.resolve(null);
      continue;
    }
    const r = w.rect ?? { x: 0, y: 0, w: w.width, h: w.height };
    const sameSize = input.width === w.width && input.height === w.height;
    if (w.rect && sameSize && typeof ctx.readImageRegion === "function") {
      const f = ctx.readImageRegion(input, r.x, r.y, r.w, r.h);
      if (f) {
        const data = new Uint8ClampedArray(f.length);
        for (let i = 0; i < f.length; i++) data[i] = Math.round(f[i] * 255);
        w.resolve({ x: r.x, y: r.y, width: r.w, height: r.h, data });
        continue;
      }
    }
    const full =
      typeof ctx.readImagePixels === "function"
        ? ctx.readImagePixels(input, w.width, w.height)
        : null;
    if (!full) {
      w.resolve(null);
      continue;
    }
    if (!w.rect) {
      w.resolve({ x: 0, y: 0, width: w.width, height: w.height, data: full });
      continue;
    }
    const data = new Uint8ClampedArray(r.w * r.h * 4);
    for (let y = 0; y < r.h; y++) {
      const src = ((r.y + y) * w.width + r.x) * 4;
      data.set(full.subarray(src, src + r.w * 4), y * r.w * 4);
    }
    w.resolve({ x: r.x, y: r.y, width: r.w, height: r.h, data });
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

export const paintNode: NodeDefinition = {
  type: "paint",
  name: "Paint",
  category: "image",
  pickable: true,
  subcategory: "generator",
  description:
    "Draw on the main canvas while this node is selected — brush, eraser, " +
    "blur, fill, and eyedropper tools with editable brushes. Wire an image " +
    "in to paint over it and erase into it; Flatten bakes it into the layer.",
  facts: {
    space: { "param:size": "pixels" },
    gotchas: [
      "compute() only composites the already-drawn snapshot bitmaps; color, size, brush, and fill_tolerance shape the NEXT stroke in the Paint tool overlay and do nothing to strokes already painted.",
      "With `image` wired, output = strokes over the input minus the hidden `knockout` mask; unpainted pixels stay live, and the eraser cuts holes in the input itself.",
      "Flatten (tool dock) bakes the current input into the strokes and knocks the live input out entirely, so upstream changes stop showing after it.",
      "The eraser only writes the knockout while an image is wired; erasing on an unwired Paint removes strokes only, so connecting an image later shows it everywhere the strokes don't cover.",
      "bg_mode=transparent passes straight-alpha strokes through untouched (composites over other layers, mattes cleanly to a mask); bg_mode=color composites them over `background` and is always opaque.",
      "Unwired, an empty canvas outputs fully transparent even in bg_mode=color (the background only shows once a stroke exists); wired, the input passes through.",
      "size is the brush diameter in canvas pixels at render resolution, so it does not scale automatically with output size.",
    ],
  },
  backend: "webgl2",
  inputs: [{ name: "image", label: "Image", type: "image", required: false }],
  params: [
    OPACITY_PARAM,
    { name: "paint", type: "paint", default: null, hidden: true },
    // Input knockout mask (101526_paint-selection-transform.md §1): alpha 1
    // hides the wired-in image there. Written by the eraser (and Flatten)
    // only while an image is wired; created lazily, so null on most nodes.
    { name: "knockout", type: "paint", default: null, hidden: true },
    // Full brush-settings blob (BrushSettingsValue), edited via the Brush
    // Editor window — null resolves to defaults editor-side. Hidden from the
    // generic panel; ParamPanel renders the paint node's bespoke brush block
    // instead. Spec: 071926_paint-toolkit.md.
    { name: "brush", label: "Brush", type: "brush_settings", default: null, hidden: true },
    { name: "color", label: "Color", type: "color", default: "#ffffff" },
    {
      name: "size",
      label: "Brush size",
      type: "scalar",
      min: 1,
      max: 400,
      softMax: 120,
      step: 1,
      default: 12,
    },
    {
      name: "fill_tolerance",
      label: "Fill tolerance",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.05,
    },
    // New nodes default to transparent output (straight alpha — composites
    // over other layers, coerces to a clean mask). Old saves are pinned to
    // "color" in migrateLoadedParams (lib/project.ts) so they render
    // identically.
    {
      name: "bg_mode",
      label: "Background",
      type: "enum",
      options: ["transparent", "color"],
      default: "transparent",
      control: "segmented",
    },
    {
      name: "background",
      label: "Bg color",
      type: "color",
      default: "#000000",
      visibleIf: (p) => p.bg_mode === "color",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  // A pending editor request for the input's pixels bumps the epoch, so
  // compute re-runs to serve it even when params and inputs are unchanged.
  fingerprintExtras: (_params, _ctx, nodeId) =>
    nodeId ? String(paintInputEpoch(nodeId)) : "",

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const input = inputs.image?.kind === "image" ? inputs.image : null;
    serveInputRequests(ctx, nodeId, input);
    const paint = params.paint as PaintParamValue | null | undefined;
    const bitmap = paint?.snapshot ?? null;
    const bg = hexToRgb((params.background as string) ?? "#000000");
    const transparent = params.bg_mode !== "color";

    if (input) {
      const knockout = params.knockout as PaintParamValue | null | undefined;
      const koBitmap = knockout?.snapshot ?? null;
      const srcTex = bitmap ? bitmapTexture(ctx, `paint:${nodeId}`, bitmap) : null;
      const koTex = koBitmap
        ? bitmapTexture(ctx, `paint-ko:${nodeId}`, koBitmap)
        : null;
      const prog = ctx.getShader("paint/composite", PAINT_COMPOSITE_FS);
      ctx.drawFullscreen(prog, output, (gl2) => {
        // Absent layers are gated by uniform; bind the input in their slot
        // so no unit samples an unbound texture.
        gl2.activeTexture(gl2.TEXTURE0);
        gl2.bindTexture(gl2.TEXTURE_2D, srcTex ?? input.texture);
        gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
        gl2.activeTexture(gl2.TEXTURE1);
        gl2.bindTexture(gl2.TEXTURE_2D, input.texture);
        gl2.uniform1i(gl2.getUniformLocation(prog, "u_in"), 1);
        gl2.activeTexture(gl2.TEXTURE2);
        gl2.bindTexture(gl2.TEXTURE_2D, koTex ?? input.texture);
        gl2.uniform1i(gl2.getUniformLocation(prog, "u_ko"), 2);
        gl2.uniform1f(gl2.getUniformLocation(prog, "u_hasSrc"), srcTex ? 1 : 0);
        gl2.uniform1f(gl2.getUniformLocation(prog, "u_hasKo"), koTex ? 1 : 0);
        gl2.uniform4f(gl2.getUniformLocation(prog, "u_bg"), bg[0], bg[1], bg[2], 1);
        gl2.uniform1f(
          gl2.getUniformLocation(prog, "u_transparent"),
          transparent ? 1.0 : 0.0
        );
        gl2.activeTexture(gl2.TEXTURE0);
      });
      return { primary: output };
    }

    // No input: the original blit, unchanged (an unwired Paint renders
    // byte-identically to before the input existed).
    if (!bitmap) {
      // Empty canvas clears transparent in BOTH modes — matches the legacy
      // behavior for color mode (the bg only appears once strokes exist).
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const tex = bitmapTexture(ctx, `paint:${nodeId}`, bitmap);
    const prog = ctx.getShader("paint/blit-v2", PAINT_BLIT_FS);
    ctx.drawFullscreen(prog, output, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, tex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
      gl2.uniform4f(
        gl2.getUniformLocation(prog, "u_bg"),
        bg[0],
        bg[1],
        bg[2],
        1.0
      );
      gl2.uniform1f(
        gl2.getUniformLocation(prog, "u_transparent"),
        transparent ? 1.0 : 0.0
      );
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    for (const stateKey of [`paint:${nodeId}`, `paint-ko:${nodeId}`]) {
      const cached = ctx.state[stateKey] as PaintState | undefined;
      if (cached?.tex) ctx.gl.deleteTexture(cached.tex);
      delete ctx.state[stateKey];
    }
  },
};
