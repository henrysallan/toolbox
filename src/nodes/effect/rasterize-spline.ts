import type {
  NodeDefinition,
  RenderContext,
  SplineSubpath,
} from "@/engine/types";
import { buildPath2D, hexToRgba } from "@/engine/spline-raster";
import {
  compositeSplineFill,
  makeZeroTex,
  type SplineFillFit,
} from "@/engine/spline-fill";
import { SPLINE_FILL_INPUT } from "@/nodes/source/spline-raster-aux";

// One-shot rasterizer that does Fill + Stroke in a single Canvas2D pass.
// Equivalent to wiring a Fill into a Stroke through a Merge, but skips
// the intermediate framebuffers and the second canvas. Either pass can
// be toggled off independently. Fill draws first so the stroke sits on
// top — matches what you'd get from compositing Fill under Stroke.

const RASTER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

function makeTex(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("rasterize-spline: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

interface RasterState {
  rasterCanvas: HTMLCanvasElement;
  // Single-bake fill+stroke (flat-fill path).
  rasterTex: WebGLTexture | null;
  // Image-fill path layers, created lazily.
  fillTex: WebGLTexture | null;
  strokeTex: WebGLTexture | null;
  zeroTex: WebGLTexture | null;
  lastSig: string | null;
}

function ensureState(ctx: RenderContext, nodeId: string): RasterState {
  const key = `rasterize-spline:${nodeId}`;
  const existing = ctx.state[key] as RasterState | undefined;
  if (existing) return existing;
  const s: RasterState = {
    rasterCanvas: document.createElement("canvas"),
    rasterTex: makeTex(ctx.gl),
    fillTex: null,
    strokeTex: null,
    zeroTex: null,
    lastSig: null,
  };
  ctx.state[key] = s;
  return s;
}

function uploadCanvas(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture,
  c: HTMLCanvasElement
) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

// Fill the spline into the 2D context with `colorStyle` (a real color for the
// baked path; "#ffffff" for the image-fill coverage mask). Honors the
// stack-subpaths / fill-rule params.
function drawSplineFill(
  c2d: CanvasRenderingContext2D,
  subpaths: SplineSubpath[],
  params: Record<string, unknown>,
  W: number,
  H: number,
  colorStyle: string
) {
  c2d.fillStyle = colorStyle;
  if (params.stack_subpaths !== false) {
    for (const sub of subpaths) {
      const path = buildPath2D([sub], W, H, true);
      if (path) c2d.fill(path);
    }
  } else {
    const path = buildPath2D(subpaths, W, H, true);
    if (path) c2d.fill(path, (params.fill_rule as CanvasFillRule) ?? "evenodd");
  }
}

// Stroke the spline with the configured style (solid / dashed / dotted),
// cap / join / miter, in `stroke_color`.
function drawSplineStroke(
  c2d: CanvasRenderingContext2D,
  subpaths: SplineSubpath[],
  params: Record<string, unknown>,
  W: number,
  H: number
) {
  const path = buildPath2D(subpaths, W, H, !!params.close_open_paths);
  if (!path) return;
  const style = (params.style as string) ?? "solid";
  c2d.lineWidth = Math.max(0, (params.thickness as number) ?? 4);
  c2d.strokeStyle = hexToRgba((params.stroke_color as string) ?? "#000000");
  c2d.lineJoin =
    (params.join as CanvasLineJoin) ?? ("round" as CanvasLineJoin);
  if (params.join === "miter") {
    c2d.miterLimit = (params.miter_limit as number) ?? 10;
  }
  if (style === "dashed") {
    const dash = Math.max(0.5, (params.dash_length as number) ?? 10);
    const gap = Math.max(0.5, (params.dash_gap as number) ?? 8);
    c2d.setLineDash([dash, gap]);
    c2d.lineCap = (params.cap as CanvasLineCap) ?? ("round" as CanvasLineCap);
  } else if (style === "dotted") {
    const spacing = Math.max(1, (params.dot_spacing as number) ?? 12);
    c2d.setLineDash([0, spacing]);
    c2d.lineCap = "round";
  } else {
    c2d.setLineDash([]);
    c2d.lineCap = (params.cap as CanvasLineCap) ?? ("round" as CanvasLineCap);
  }
  c2d.stroke(path);
}

export const rasterizeSplineNode: NodeDefinition = {
  type: "rasterize-spline",
  name: "Rasterize Spline",
  category: "spline",
  subcategory: "modifier",
  description:
    "Rasterize a spline as fill, stroke, or both in a single pass. Fill draws underneath the stroke. Toggle each independently.",
  backend: "webgl2",
  inputs: [
    { name: "path", type: "spline", required: true },
    // Optional fill image — fills the spline with that image (per fill_fit)
    // instead of the flat fill color when wired and Fill is on.
    SPLINE_FILL_INPUT,
  ],
  params: [
    // ---- Fill ----
    {
      name: "enable_fill",
      label: "Fill",
      type: "boolean",
      default: true,
    },
    {
      name: "fill_color",
      label: "Fill color",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => p.enable_fill !== false,
    },
    {
      name: "fill_fit",
      label: "Fill fit",
      type: "enum",
      options: ["window", "contain", "cover"],
      default: "window",
      visibleIf: (p) => p.enable_fill !== false,
    },
    {
      name: "stack_subpaths",
      label: "Stack subpaths",
      type: "boolean",
      default: true,
      visibleIf: (p) => p.enable_fill !== false,
    },
    {
      name: "fill_rule",
      label: "Fill rule",
      type: "enum",
      options: ["evenodd", "nonzero"],
      default: "evenodd",
      visibleIf: (p) =>
        p.enable_fill !== false && p.stack_subpaths === false,
    },

    // ---- Stroke ----
    {
      name: "enable_stroke",
      label: "Stroke",
      type: "boolean",
      default: true,
    },
    {
      name: "stroke_color",
      label: "Stroke color",
      type: "color",
      default: "#000000",
      visibleIf: (p) => p.enable_stroke !== false,
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
      visibleIf: (p) => p.enable_stroke !== false,
    },
    {
      name: "style",
      label: "Style",
      type: "enum",
      options: ["solid", "dashed", "dotted"],
      default: "solid",
      visibleIf: (p) => p.enable_stroke !== false,
    },
    {
      name: "dash_length",
      label: "Dash length (px)",
      type: "scalar",
      min: 0.5,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 10,
      visibleIf: (p) => p.enable_stroke !== false && p.style === "dashed",
    },
    {
      name: "dash_gap",
      label: "Dash gap (px)",
      type: "scalar",
      min: 0.5,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 8,
      visibleIf: (p) => p.enable_stroke !== false && p.style === "dashed",
    },
    {
      name: "dot_spacing",
      label: "Dot spacing (px)",
      type: "scalar",
      min: 1,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 12,
      visibleIf: (p) => p.enable_stroke !== false && p.style === "dotted",
    },
    {
      name: "cap",
      label: "Cap",
      type: "enum",
      options: ["round", "butt", "square"],
      default: "round",
      visibleIf: (p) => p.enable_stroke !== false && p.style !== "dotted",
    },
    {
      name: "join",
      label: "Join",
      type: "enum",
      options: ["round", "miter", "bevel"],
      default: "round",
      visibleIf: (p) => p.enable_stroke !== false,
    },
    {
      name: "miter_limit",
      label: "Miter limit",
      type: "scalar",
      min: 1,
      max: 20,
      step: 0.1,
      default: 10,
      visibleIf: (p) => p.enable_stroke !== false && p.join === "miter",
    },
    {
      name: "close_open_paths",
      label: "Close open paths",
      type: "boolean",
      default: false,
      visibleIf: (p) => p.enable_stroke !== false,
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
    const gl = ctx.gl;

    const enableFill = params.enable_fill !== false;
    const enableStroke = params.enable_stroke !== false;

    const fillImage =
      enableFill && inputs.fill?.kind === "image" ? inputs.fill : null;
    const hasImageFill = !!fillImage;

    if (!hasImageFill) {
      // --- Flat path: bake fill (under) + stroke (over) into one canvas. ---
      const sig = JSON.stringify({
        mode: "flat",
        subRef: src.subpaths,
        ef: enableFill,
        fc: params.fill_color,
        stack: params.stack_subpaths,
        fr: params.fill_rule,
        es: enableStroke,
        sc: params.stroke_color,
        t: params.thickness,
        st: params.style,
        dl: params.dash_length,
        dg: params.dash_gap,
        ds: params.dot_spacing,
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
          // Fill first so the stroke sits on top.
          if (enableFill) {
            drawSplineFill(
              c2d,
              src.subpaths,
              params,
              W,
              H,
              hexToRgba((params.fill_color as string) ?? "#ffffff")
            );
          }
          if (enableStroke) drawSplineStroke(c2d, src.subpaths, params, W, H);
          uploadCanvas(gl, state.rasterTex!, canvas);
        }
        state.lastSig = sig;
      }

      const prog = ctx.getShader("rasterize-spline/blit", RASTER_FS);
      ctx.drawFullscreen(prog, output, (gl2) => {
        gl2.activeTexture(gl2.TEXTURE0);
        gl2.bindTexture(gl2.TEXTURE_2D, state.rasterTex);
        gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
      });
      return { primary: output };
    }

    // --- Image-fill path: coverage + stroke layers, composite the image. ---
    if (!state.fillTex) state.fillTex = makeTex(gl);
    if (!state.strokeTex) state.strokeTex = makeTex(gl);
    if (!state.zeroTex) state.zeroTex = makeZeroTex(gl);

    // Coverage + stroke don't depend on the image pixels or fill color, so
    // dragging only the upstream image re-composites without re-rastering.
    const sig = JSON.stringify({
      mode: "img",
      subRef: src.subpaths,
      stack: params.stack_subpaths,
      fr: params.fill_rule,
      es: enableStroke,
      sc: params.stroke_color,
      t: params.thickness,
      st: params.style,
      dl: params.dash_length,
      dg: params.dash_gap,
      ds: params.dot_spacing,
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
        // Fill coverage (white-on-transparent), honoring stack / fill rule.
        c2d.clearRect(0, 0, W, H);
        drawSplineFill(c2d, src.subpaths, params, W, H, "#ffffff");
        uploadCanvas(gl, state.fillTex, canvas);
        // Stroke layer in its own color.
        c2d.clearRect(0, 0, W, H);
        if (enableStroke) drawSplineStroke(c2d, src.subpaths, params, W, H);
        uploadCanvas(gl, state.strokeTex, canvas);
      }
      state.lastSig = sig;
    }

    const fit = ((params.fill_fit as string) ?? "window") as SplineFillFit;
    compositeSplineFill(ctx, output, {
      fillMaskTex: state.fillTex,
      strokeTex: enableStroke ? state.strokeTex : null,
      fillImage,
      fillColorHex: (params.fill_color as string) ?? "#ffffff",
      fit,
      subpaths: src.subpaths,
      zeroTex: state.zeroTex,
    });
    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const key = `rasterize-spline:${nodeId}`;
    const state = ctx.state[key] as RasterState | undefined;
    if (state?.rasterTex) ctx.gl.deleteTexture(state.rasterTex);
    if (state?.fillTex) ctx.gl.deleteTexture(state.fillTex);
    if (state?.strokeTex) ctx.gl.deleteTexture(state.strokeTex);
    if (state?.zeroTex) ctx.gl.deleteTexture(state.zeroTex);
    delete ctx.state[key];
  },
};
