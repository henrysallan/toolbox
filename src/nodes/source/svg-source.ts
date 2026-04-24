import type {
  ImageValue,
  NodeDefinition,
  OutputSocketDef,
  RenderContext,
  SplineValue,
  SvgFileParamValue,
} from "@/engine/types";
import { buildPath2D } from "@/engine/spline-raster";
import { transformSpline } from "@/engine/spline-transform";

// SVG source. The file param holds a pre-parsed payload (see lib/svg-parse)
// in [0,1]² Y-DOWN space. Compute applies the built-in transform (same
// param shape the Text and Transform nodes use, same on-canvas gizmo) and
// optionally rasterizes to an image if stroke or fill is on.

const SPLINE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  // 2D canvas is row-0-top; flip Y on sample to match the pipeline's Y-up
  // rendering convention.
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

interface SvgState {
  rasterCanvas: HTMLCanvasElement;
  rasterTex: WebGLTexture | null;
  lastSig: string | null;
}

function hexToRgba(hex: string, alpha = 1): string {
  const h = hex.replace("#", "");
  let r = 0, g = 0, b = 0, a = alpha;
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
  } else if (h.length === 6) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else if (h.length === 8) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
    a = parseInt(h.slice(6, 8), 16) / 255;
  }
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function ensureState(ctx: RenderContext, nodeId: string): SvgState {
  const key = `svg-source:${nodeId}`;
  const existing = ctx.state[key] as SvgState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("svg-source: failed to create raster texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: SvgState = {
    rasterCanvas: document.createElement("canvas"),
    rasterTex: tex,
    lastSig: null,
  };
  ctx.state[key] = s;
  return s;
}

// Cache key: whatever affects the rasterized output. The SvgFileParamValue
// carries the parsed subpaths by reference — we identify the FILE by its
// filename (unique per user upload) so a re-parse of the same file doesn't
// invalidate the cache, but swapping the file does.
function rasterSig(
  params: Record<string, unknown>,
  W: number,
  H: number
): string {
  const f = params.file as SvgFileParamValue | null | undefined;
  return JSON.stringify({
    fn: f?.filename ?? null,
    n: f?.subpaths?.length ?? 0,
    tx: params.translateX,
    ty: params.translateY,
    sx: params.scaleX,
    sy: params.scaleY,
    r: params.rotate,
    px: params.pivotX,
    py: params.pivotY,
    se: !!params.stroke_enabled,
    st: params.stroke_thickness,
    sc: params.stroke_color,
    fe: !!params.fill_enabled,
    fc: params.fill_color,
    W,
    H,
  });
}

export const svgSourceNode: NodeDefinition = {
  type: "svg-source",
  name: "SVG Source",
  category: "spline",
  subcategory: "generator",
  description:
    "Load an SVG file and emit it as spline data. Built-in translate/scale/rotate operate on the result; stroke and fill rasterize to an image.",
  backend: "webgl2",
  supportsTransformGizmo: true,
  inputs: [],
  params: [
    { name: "file", label: "SVG", type: "svg_file", default: null },
    {
      name: "stroke_enabled",
      label: "Stroke",
      type: "boolean",
      default: false,
    },
    {
      name: "stroke_thickness",
      label: "Thickness (px)",
      type: "scalar",
      min: 0,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 2,
      visibleIf: (p) => !!p.stroke_enabled,
    },
    {
      name: "stroke_color",
      label: "Stroke color",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => !!p.stroke_enabled,
    },
    {
      name: "fill_enabled",
      label: "Fill",
      type: "boolean",
      default: true,
    },
    {
      name: "fill_color",
      label: "Fill color",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => !!p.fill_enabled,
    },

    // Transform block. Same names the Text and Transform nodes use so the
    // shared gizmo knows how to drive them.
    {
      name: "translateX",
      label: "Translate X",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.001,
      default: 0,
    },
    {
      name: "translateY",
      label: "Translate Y",
      type: "scalar",
      min: -2,
      max: 2,
      step: 0.001,
      default: 0,
    },
    {
      name: "scaleX",
      label: "Scale X",
      type: "scalar",
      min: -5,
      max: 5,
      softMax: 3,
      step: 0.001,
      default: 1,
    },
    {
      name: "scaleY",
      label: "Scale Y",
      type: "scalar",
      min: -5,
      max: 5,
      softMax: 3,
      step: 0.001,
      default: 1,
    },
    {
      name: "rotate",
      label: "Rotate (deg)",
      type: "scalar",
      min: -360,
      max: 360,
      step: 0.1,
      default: 0,
    },
    {
      name: "pivotX",
      label: "Pivot X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "pivotY",
      label: "Pivot Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "image", type: "image" }],
  resolveAuxOutputs(params): OutputSocketDef[] {
    const hasRaster = !!params.stroke_enabled || !!params.fill_enabled;
    return hasRaster ? [{ name: "image", type: "image" }] : [];
  },

  compute({ params, ctx, nodeId }) {
    const file = params.file as SvgFileParamValue | null | undefined;
    const raw: SplineValue = {
      kind: "spline",
      subpaths: file?.subpaths ?? [],
    };
    const transformed = transformSpline(raw, {
      translateX: (params.translateX as number) ?? 0,
      translateY: (params.translateY as number) ?? 0,
      scaleX: (params.scaleX as number) ?? 1,
      scaleY: (params.scaleY as number) ?? 1,
      rotateDeg: (params.rotate as number) ?? 0,
      pivotX: (params.pivotX as number) ?? 0.5,
      pivotY: (params.pivotY as number) ?? 0.5,
    });

    const strokeOn = !!params.stroke_enabled;
    const fillOn = !!params.fill_enabled;
    if (!strokeOn && !fillOn) {
      return { primary: transformed };
    }

    const state = ensureState(ctx, nodeId);
    const W = ctx.width;
    const H = ctx.height;
    const sig = rasterSig(params, W, H);
    const needsRepaint = sig !== state.lastSig;

    if (needsRepaint) {
      const canvas = state.rasterCanvas;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      const c2d = canvas.getContext("2d");
      if (c2d) {
        c2d.clearRect(0, 0, W, H);
        const path = buildPath2D(transformed.subpaths, W, H, fillOn);
        if (path) {
          if (fillOn) {
            c2d.fillStyle = hexToRgba(
              (params.fill_color as string) ?? "#ffffff"
            );
            // evenodd: inner subpaths (letter holes, etc.) punch through.
            c2d.fill(path, "evenodd");
          }
          if (strokeOn) {
            c2d.lineWidth = Math.max(
              0,
              (params.stroke_thickness as number) ?? 2
            );
            c2d.strokeStyle = hexToRgba(
              (params.stroke_color as string) ?? "#ffffff"
            );
            c2d.lineCap = "round";
            c2d.lineJoin = "round";
            c2d.stroke(path);
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

    const image: ImageValue = ctx.allocImage();
    const prog = ctx.getShader("svg-source/blit", SPLINE_FS);
    ctx.drawFullscreen(prog, image, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state.rasterTex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
    });

    return { primary: transformed, aux: { image } };
  },

  dispose(ctx, nodeId) {
    const key = `svg-source:${nodeId}`;
    const state = ctx.state[key] as SvgState | undefined;
    if (state?.rasterTex) ctx.gl.deleteTexture(state.rasterTex);
    delete ctx.state[key];
  },
};
