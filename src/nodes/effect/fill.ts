import type {
  ImageValue,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";
import { buildPath2D, hexToRgba } from "@/engine/spline-raster";

// Rasterize the interior of a spline. Open subpaths close implicitly (they
// have to — fill semantics require a region). Fill rule determines how
// overlapping subpaths combine: `evenodd` punches holes on every nested
// subpath (natural for SVG glyphs), `nonzero` unions regions by winding
// direction.
//
// `stack_subpaths` (default on): each subpath is rasterized as its own
// Path2D and stacked in order. Overlaps render as opaque, which is what
// you want for Copy-to-Points spline output where each instance is a
// distinct shape that happens to overlap its neighbours. Turn this off
// to revert to the SVG-glyph behaviour: all subpaths combine into a
// single path so the chosen fill rule can punch holes through nested
// subpaths.

const FILL_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

interface FillState {
  rasterCanvas: HTMLCanvasElement;
  rasterTex: WebGLTexture | null;
  lastSig: string | null;
}

function ensureState(ctx: RenderContext, nodeId: string): FillState {
  const key = `spline-fill:${nodeId}`;
  const existing = ctx.state[key] as FillState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("spline-fill: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: FillState = {
    rasterCanvas: document.createElement("canvas"),
    rasterTex: tex,
    lastSig: null,
  };
  ctx.state[key] = s;
  return s;
}

export const fillNode: NodeDefinition = {
  type: "spline-fill",
  name: "Fill",
  category: "spline",
  subcategory: "modifier",
  description:
    "Fill the interior of a spline. Open subpaths close implicitly for rendering. Choose evenodd (SVG default, punches holes in nested subpaths) or nonzero winding rule.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    { name: "color", label: "Color", type: "color", default: "#ffffff" },
    {
      name: "stack_subpaths",
      label: "Stack subpaths",
      type: "boolean",
      default: true,
    },
    {
      name: "rule",
      label: "Fill rule",
      type: "enum",
      options: ["evenodd", "nonzero"],
      default: "evenodd",
      visibleIf: (p) => !p.stack_subpaths,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const src = inputs.path;
    if (!src || src.kind !== "spline") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const state = ensureState(ctx, nodeId);
    const W = ctx.width;
    const H = ctx.height;

    const stackSubpaths = params.stack_subpaths !== false;
    const sig = JSON.stringify({
      subRef: src.subpaths,
      c: params.color,
      r: params.rule,
      stack: stackSubpaths,
      W,
      H,
    });

    if (sig !== state.lastSig) {
      const canvas = state.rasterCanvas;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      const c2d = canvas.getContext("2d");
      if (c2d) {
        c2d.clearRect(0, 0, W, H);
        c2d.fillStyle = hexToRgba((params.color as string) ?? "#ffffff");
        if (stackSubpaths) {
          // Per-subpath fill — each subpath rasterizes independently so
          // overlapping copies (e.g. Copy-to-Points spline output) render
          // as opaque stacks rather than evenodd-punching each other.
          for (const sub of src.subpaths) {
            const path = buildPath2D([sub], W, H, true);
            if (path) c2d.fill(path);
          }
        } else {
          // Single-path mode — original behaviour, lets the fill rule
          // decide overlap semantics (evenodd for SVG glyph holes, etc.).
          const path = buildPath2D(src.subpaths, W, H, true);
          if (path) {
            const rule = (params.rule as CanvasFillRule) ?? "evenodd";
            c2d.fill(path, rule);
          }
        }
        const gl = ctx.gl;
        gl.bindTexture(gl.TEXTURE_2D, state.rasterTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          canvas
        );
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      state.lastSig = sig;
    }

    const prog = ctx.getShader("spline-fill/blit", FILL_FS);
    const image: ImageValue = output;
    ctx.drawFullscreen(prog, image, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state.rasterTex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
    });

    return { primary: image };
  },

  dispose(ctx, nodeId) {
    const key = `spline-fill:${nodeId}`;
    const state = ctx.state[key] as FillState | undefined;
    if (state?.rasterTex) ctx.gl.deleteTexture(state.rasterTex);
    delete ctx.state[key];
  },
};
