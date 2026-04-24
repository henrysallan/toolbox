import type {
  ImageValue,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";
import { buildPath2D, hexToRgba } from "@/engine/spline-raster";

// Rasterize a spline's outline. Output is transparent everywhere except
// the stroked pixels — composite over other layers with a Merge node.
//
// Same 2D-canvas → GL-texture flow as Spline Draw's built-in stroke. A
// signature of the params + input identity lets us skip re-rasterizing
// when nothing has changed (spline values round-trip by reference, so the
// object identity IS the signature for the input).

const STROKE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

interface StrokeState {
  rasterCanvas: HTMLCanvasElement;
  rasterTex: WebGLTexture | null;
  lastSig: string | null;
}

function ensureState(ctx: RenderContext, nodeId: string): StrokeState {
  const key = `spline-stroke:${nodeId}`;
  const existing = ctx.state[key] as StrokeState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("spline-stroke: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: StrokeState = {
    rasterCanvas: document.createElement("canvas"),
    rasterTex: tex,
    lastSig: null,
  };
  ctx.state[key] = s;
  return s;
}

export const strokeNode: NodeDefinition = {
  type: "spline-stroke",
  name: "Stroke",
  category: "spline",
  subcategory: "modifier",
  description:
    "Render a spline as a stroked outline. Color, thickness, cap, and join all exposed — stack multiple Stroke nodes through Merge for offset/outline effects.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "color",
      label: "Color",
      type: "color",
      default: "#ffffff",
    },
    {
      name: "thickness",
      label: "Thickness (px)",
      type: "scalar",
      min: 0,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 4,
    },
    {
      name: "cap",
      label: "Cap",
      type: "enum",
      options: ["round", "butt", "square"],
      default: "round",
    },
    {
      name: "join",
      label: "Join",
      type: "enum",
      options: ["round", "miter", "bevel"],
      default: "round",
    },
    {
      name: "miter_limit",
      label: "Miter limit",
      type: "scalar",
      min: 1,
      max: 20,
      step: 0.1,
      default: 10,
      visibleIf: (p) => p.join === "miter",
    },
    {
      name: "close_open_paths",
      label: "Close open paths",
      type: "boolean",
      default: false,
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

    // Signature covers everything that changes the raster output. The
    // spline value itself rides the input reference — when the upstream
    // evaluator re-emits, it's typically a new object, which busts this
    // cache naturally.
    const sig = JSON.stringify({
      subRef: src.subpaths,
      c: params.color,
      t: params.thickness,
      cap: params.cap,
      jn: params.join,
      ml: params.miter_limit,
      close: !!params.close_open_paths,
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
        const closeOpen = !!params.close_open_paths;
        const path = buildPath2D(src.subpaths, W, H, closeOpen);
        if (path) {
          c2d.lineWidth = Math.max(0, (params.thickness as number) ?? 4);
          c2d.strokeStyle = hexToRgba((params.color as string) ?? "#ffffff");
          c2d.lineCap =
            (params.cap as CanvasLineCap) ?? ("round" as CanvasLineCap);
          c2d.lineJoin =
            (params.join as CanvasLineJoin) ?? ("round" as CanvasLineJoin);
          if (params.join === "miter") {
            c2d.miterLimit = (params.miter_limit as number) ?? 10;
          }
          c2d.stroke(path);
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

    const prog = ctx.getShader("spline-stroke/blit", STROKE_FS);
    const image: ImageValue = output;
    ctx.drawFullscreen(prog, image, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state.rasterTex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
    });

    return { primary: image };
  },

  dispose(ctx, nodeId) {
    const key = `spline-stroke:${nodeId}`;
    const state = ctx.state[key] as StrokeState | undefined;
    if (state?.rasterTex) ctx.gl.deleteTexture(state.rasterTex);
    delete ctx.state[key];
  },
};
