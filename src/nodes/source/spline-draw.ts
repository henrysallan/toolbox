import type {
  ImageValue,
  NodeDefinition,
  OutputSocketDef,
  RenderContext,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { buildPath2D } from "@/engine/spline-raster";

// Rasterization of the path happens on a persistent 2D canvas that's re-drawn
// whenever params change and then uploaded to a texture. Canvas memory is
// row-0-top so we flip Y on sample to match the pipeline's Y-up convention.
const SPLINE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

interface SplineState {
  rasterCanvas: HTMLCanvasElement;
  rasterTex: WebGLTexture | null;
  image: ImageValue | null;
  lastSig: string | null;
  lastW: number;
  lastH: number;
}

// Stored param envelope for the `spline_anchors` param type. Mirrors the
// runtime SplineValue shape but without the `kind` discriminator, since the
// param is always a spline.
export interface SplineParamValue {
  subpaths: SplineSubpath[];
}

const EMPTY_SPLINE: SplineParamValue = {
  subpaths: [{ anchors: [], closed: false }],
};

function hexToRgba(hex: string, alpha = 1): string {
  // Accepts "#rgb", "#rrggbb", or "#rrggbbaa". Returns an rgba() that Canvas 2D
  // consumes directly — saves us from parsing into floats just to re-stringify.
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

function rasterSig(
  params: Record<string, unknown>,
  W: number,
  H: number
): string {
  const s = (params.spline as SplineParamValue | null | undefined) ?? EMPTY_SPLINE;
  return JSON.stringify({
    p: s.subpaths,
    se: !!params.stroke_enabled,
    st: params.stroke_thickness,
    sc: params.stroke_color,
    fe: !!params.fill_enabled,
    fc: params.fill_color,
    W,
    H,
  });
}

function ensureState(ctx: RenderContext, nodeId: string): SplineState {
  const key = `spline-draw:${nodeId}`;
  const existing = ctx.state[key] as SplineState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("spline-draw: failed to create raster texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: SplineState = {
    rasterCanvas: document.createElement("canvas"),
    rasterTex: tex,
    image: null,
    lastSig: null,
    lastW: ctx.width,
    lastH: ctx.height,
  };
  ctx.state[key] = s;
  return s;
}

export const splineDrawNode: NodeDefinition = {
  type: "spline-draw",
  name: "Spline Draw",
  category: "spline",
  subcategory: "generator",
  description:
    "Author a bezier path with the pen tool over the preview canvas. Outputs the spline as data and, when stroke or fill is enabled, as a rasterized image.",
  backend: "webgl2",
  inputs: [],
  params: [
    // Anchor data is mutated by the on-canvas overlay, not the params panel —
    // hidden from the UI but still round-trips through save/load.
    {
      name: "spline",
      type: "spline_anchors",
      default: EMPTY_SPLINE,
      hidden: true,
    },
    {
      name: "stroke_enabled",
      label: "Stroke",
      type: "boolean",
      default: true,
    },
    {
      name: "stroke_thickness",
      label: "Thickness (px)",
      type: "scalar",
      min: 0,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 4,
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
      label: "Fill (closes path)",
      type: "boolean",
      default: false,
    },
    {
      name: "fill_color",
      label: "Fill color",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => !!p.fill_enabled,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "image", type: "image" }],
  // Expose the image aux only when at least one of stroke/fill is on — the
  // socket is pointless otherwise (would always emit transparent pixels).
  resolveAuxOutputs(params): OutputSocketDef[] {
    const hasRaster = !!params.stroke_enabled || !!params.fill_enabled;
    return hasRaster ? [{ name: "image", type: "image" }] : [];
  },

  compute({ params, ctx, nodeId }) {
    const spline =
      (params.spline as SplineParamValue | null | undefined) ?? EMPTY_SPLINE;
    const splineOut: SplineValue = {
      kind: "spline",
      subpaths: spline.subpaths,
    };

    const strokeOn = !!params.stroke_enabled;
    const fillOn = !!params.fill_enabled;
    if (!strokeOn && !fillOn) {
      // No raster requested — emit spline data only.
      return { primary: splineOut };
    }

    const state = ensureState(ctx, nodeId);
    const W = ctx.width;
    const H = ctx.height;

    // Rasterize (or reuse the last raster if nothing changed). ImageValue from
    // allocImage is an ephemeral pool entry, so we always draw into a fresh
    // one per eval — the signature just tells us whether to regenerate the
    // 2D canvas pixels and re-upload the texture.
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
        const path = buildPath2D(spline.subpaths, W, H, fillOn);
        if (path) {
          if (fillOn) {
            c2d.fillStyle = hexToRgba(
              (params.fill_color as string) ?? "#ffffff"
            );
            // Even-odd so subpaths punch holes out of filled outer shapes —
            // the natural behavior for SVG glyphs and compound paths.
            c2d.fill(path, "evenodd");
          }
          if (strokeOn) {
            c2d.lineWidth = Math.max(
              0,
              (params.stroke_thickness as number) ?? 4
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
      state.lastW = W;
      state.lastH = H;
    }

    const image = ctx.allocImage();
    const prog = ctx.getShader("spline-draw/blit", SPLINE_FS);
    ctx.drawFullscreen(prog, image, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state.rasterTex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
    });

    return { primary: splineOut, aux: { image } };
  },

  dispose(ctx, nodeId) {
    const key = `spline-draw:${nodeId}`;
    const state = ctx.state[key] as SplineState | undefined;
    if (state?.rasterTex) ctx.gl.deleteTexture(state.rasterTex);
    delete ctx.state[key];
  },
};
