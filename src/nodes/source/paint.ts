import { OPACITY_PARAM } from "@/engine/conventions";
import type { NodeDefinition, PaintParamValue } from "@/engine/types";

const BLIT_FS = `#version 300 es
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

interface PaintState {
  bitmapRef: ImageBitmap | null;
  tex: WebGLTexture | null;
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
  subcategory: "generator",
  description:
    "Draw on the main canvas while this node is selected — brush, eraser, " +
    "blur, fill, and eyedropper tools with editable brushes.",
  backend: "webgl2",
  inputs: [],
  params: [
    OPACITY_PARAM,
    { name: "paint", type: "paint", default: null, hidden: true },
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

  compute({ params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const paint = params.paint as PaintParamValue | null | undefined;
    const bitmap = paint?.snapshot ?? null;

    if (!bitmap) {
      // Empty canvas clears transparent in BOTH modes — matches the legacy
      // behavior for color mode (the bg only appears once strokes exist).
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const stateKey = `paint:${nodeId}`;
    const gl = ctx.gl;
    let cached = ctx.state[stateKey] as PaintState | undefined;
    if (!cached || cached.bitmapRef !== bitmap) {
      if (cached?.tex) gl.deleteTexture(cached.tex);
      const tex = gl.createTexture();
      if (!tex) throw new Error("paint: failed to create texture");
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bitmap
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      cached = { bitmapRef: bitmap, tex };
      ctx.state[stateKey] = cached;
    }

    const prog = ctx.getShader("paint/blit-v2", BLIT_FS);
    const bgHex = (params.background as string) ?? "#000000";
    const bg = hexToRgb(bgHex);
    const transparent = params.bg_mode !== "color";
    ctx.drawFullscreen(prog, output, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, cached!.tex);
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
    const stateKey = `paint:${nodeId}`;
    const cached = ctx.state[stateKey] as PaintState | undefined;
    if (cached?.tex) ctx.gl.deleteTexture(cached.tex);
    delete ctx.state[stateKey];
  },
};
