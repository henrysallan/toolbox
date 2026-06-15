import type {
  ElementValue,
  ImageValue,
  InputSocketDef,
  OutputSocketDef,
  ParamDef,
  RenderContext,
  SplineSubpath,
} from "@/engine/types";
import { buildPath2D, buildPath2DWith, hexToRgba } from "@/engine/spline-raster";
import { flattenSpline } from "@/engine/spline-flatten";
import {
  aspectFitMeasure,
  emptyElement,
  uploadCanvasToImage,
  type ElementFit,
} from "@/engine/element";
import { OPACITY_PARAM } from "@/engine/conventions";

// Shared "view this spline" rasterizer bundled into the spline primitive
// nodes (Circle, Rectangle, …). Each primitive keeps its `spline` output and
// gains an `image` aux output, so you can drop a primitive in and see the
// shape immediately without wiring up a separate Rasterize Spline node.
//
// A deliberately minimal stroke / fill control set — reach for the full
// Rasterize Spline node when you need dashes, caps, joins, fill rules, etc.

// Spread into a primitive's `params`.
export const SPLINE_RASTER_PARAMS: ParamDef[] = [
  { name: "stroke_enabled", label: "Stroke", type: "boolean", default: true },
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
  { name: "fill_enabled", label: "Fill", type: "boolean", default: false },
  {
    name: "fill_color",
    label: "Fill color",
    type: "color",
    default: "#ffffff",
    visibleIf: (p) => !!p.fill_enabled,
  },
  // How a wired `fill` image maps into the shape. `window` reveals the
  // full-canvas image through the shape (a hole); `contain`/`cover` fit the
  // image into the shape's bounding box. No-op when nothing is wired into
  // the `fill` socket (the flat `fill_color` is used instead).
  {
    name: "fill_fit",
    label: "Fill fit",
    type: "enum",
    options: ["window", "contain", "cover"],
    default: "window",
    visibleIf: (p) => !!p.fill_enabled,
  },
  // Applied by the evaluator's universal opacity pass to the aux image —
  // see OPACITY_PARAM in engine/conventions.
  OPACITY_PARAM,
];

// Optional image input that drives the fill instead of the flat
// `fill_color`. Declared as `image`, so the existing mask→image and
// element→image coercions let it accept masks and elements too. Spread into
// a primitive's `inputs` (the universal mask input is appended separately by
// the evaluator). Only consulted when `fill_enabled` is on.
export const SPLINE_FILL_INPUT: InputSocketDef = {
  name: "fill",
  label: "fill",
  type: "image",
  required: false,
};

// Use as a node's `resolveAuxOutputs`: expose the `image` socket only when
// something is actually drawn (otherwise it would always emit transparent
// pixels and just clutter the node). The `element` socket is always present
// so the primitive can be wired into Auto Layout, where it carries its
// intrinsic aspect ratio and re-rasterizes crisply at any slot size.
export function resolveSplineRasterAux(
  params: Record<string, unknown>
): OutputSocketDef[] {
  const on = !!params.stroke_enabled || !!params.fill_enabled;
  const element: OutputSocketDef = {
    name: "element",
    type: "element",
    description:
      "The shape as an intrinsically-sized element for Auto Layout. Its natural size is the shape's bounding box (so a circle is square, a 2:1 rectangle is 2:1); it keeps that ratio as the layout resizes and re-rasterizes crisp at any size. Slot fit controls contain/cover/stretch.",
  };
  return on ? [{ name: "image", type: "image" }, element] : [element];
}

// Flat blit (no image fill): the CPU canvas already holds the final
// fill+stroke composite, so we just flip Y to the pipeline's convention.
const RASTER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  // Canvas memory is row-0-top; flip Y to the pipeline's Y-up convention.
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

// Image-fill composite: the fill region is a coverage mask (white-on-
// transparent, row-0-top) and the stroke is its own color layer (row-0-top).
// The fill is sampled from a wired image (per `fill_fit`) or a flat color,
// modulated by coverage, with the stroke composited OVER it (straight-alpha
// Porter-Duff source-over, matching merge.ts BLEND_FS).
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_fillMask;  // coverage (alpha), row-0-top
uniform sampler2D u_stroke;    // stroke color straight-alpha, row-0-top
uniform sampler2D u_fillImage; // straight-alpha fill image, Y-up canvas space
uniform int u_hasStroke;
uniform int u_hasFillImage;
uniform vec4 u_fillColor;      // straight-alpha solid fill fallback
uniform int u_fit;             // 0 window, 1 contain, 2 cover
uniform vec2 u_uvMin;          // shape bbox in canvas UV (Y-up)
uniform vec2 u_uvSize;
uniform vec2 u_fitScale;       // per-axis sample scale for contain/cover
out vec4 outColor;

vec4 over(vec4 s, vec4 d) {
  float oa = s.a + d.a * (1.0 - s.a);
  vec3 oc = oa < 1e-4
    ? vec3(0.0)
    : (s.rgb * s.a + d.rgb * d.a * (1.0 - s.a)) / oa;
  return vec4(oc, oa);
}

void main() {
  vec2 m = vec2(v_uv.x, 1.0 - v_uv.y);   // sample CPU canvases (row-0-top)
  float cov = texture(u_fillMask, m).a;

  vec4 col;
  if (u_hasFillImage == 1) {
    vec2 uv;
    if (u_fit == 0) {
      uv = v_uv;                          // window: image stays in canvas
    } else {
      vec2 local = (v_uv - u_uvMin) / max(u_uvSize, vec2(1e-6));
      uv = (local - 0.5) * u_fitScale + 0.5;
    }
    col = texture(u_fillImage, uv);
    // contain: anything outside the fitted image is letterbox (transparent).
    if (u_fit == 1 &&
        (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))))) {
      col = vec4(0.0);
    }
  } else {
    col = u_fillColor;
  }
  vec4 fill = vec4(col.rgb, col.a * cov);

  vec4 stroke = u_hasStroke == 1 ? texture(u_stroke, m) : vec4(0.0);
  outColor = over(stroke, fill);          // stroke over fill
}`;

interface RasterState {
  rasterCanvas: HTMLCanvasElement;
  // Single-bake fill+stroke (flat-fill path).
  rasterTex: WebGLTexture | null;
  // Composite path layers (image-fill path), created lazily.
  fillTex: WebGLTexture | null;
  strokeTex: WebGLTexture | null;
  zeroTex: WebGLTexture | null;
  lastSig: string | null;
}

function stateKey(nodeId: string): string {
  return `spline-raster-aux:${nodeId}`;
}

function makeTex(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("spline-raster-aux: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function ensureState(ctx: RenderContext, nodeId: string): RasterState {
  const key = stateKey(nodeId);
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

// 1×1 transparent placeholder so every declared sampler has a binding even
// when its layer is absent (WebGL requires it regardless of branching).
function ensureZeroTex(ctx: RenderContext, state: RasterState): WebGLTexture {
  if (state.zeroTex) return state.zeroTex;
  const gl = ctx.gl;
  const tex = makeTex(gl);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0])
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
  state.zeroTex = tex;
  return tex;
}

function uploadCanvas(gl: WebGL2RenderingContext, tex: WebGLTexture, c: HTMLCanvasElement) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

// Parse a hex color to straight-alpha floats [r,g,b,a] in [0,1].
function hexToRgba01(hex: string): [number, number, number, number] {
  const h = (hex || "#ffffff").replace("#", "");
  let r = 255, g = 255, b = 255, a = 255;
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
  } else if (h.length >= 6) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
    if (h.length === 8) a = parseInt(h.slice(6, 8), 16);
  }
  return [r / 255, g / 255, b / 255, a / 255];
}

// Compute the shape's bbox in canvas UV (Y-up) plus the per-axis sample
// scale that fits the (full-canvas) fill image into that bbox per `fit`.
// The rasterizer aspect-corrects Y so the bbox shares the X pixel scale —
// hence the bbox's *pixel* aspect equals its authored w/h.
function fitUniforms(
  subpaths: SplineSubpath[],
  W: number,
  H: number,
  fit: "window" | "contain" | "cover"
): {
  uvMin: [number, number];
  uvSize: [number, number];
  fitScale: [number, number];
} | null {
  const bbox = splineBbox(subpaths);
  if (!bbox) return null;
  const aspect = W / H;
  // authored (Y-down) bbox → canvas UV (Y-up): u = x; v = 0.5 - (y-0.5)*aspect.
  const vTop = 0.5 - (bbox.minY - 0.5) * aspect; // authored top (minY) → max v
  const vBot = 0.5 - (bbox.minY + bbox.h - 0.5) * aspect;
  const uvMin: [number, number] = [bbox.minX, vBot];
  const uvSize: [number, number] = [bbox.w, vTop - vBot];

  let sx = 1;
  let sy = 1;
  if (fit !== "window") {
    const aImg = W / H; // full-canvas content aspect
    const aBox = bbox.w / bbox.h; // bbox pixel aspect (Y shares X scale)
    if (fit === "contain") {
      if (aBox > aImg) sx = aBox / aImg;
      else sy = aImg / aBox;
    } else {
      // cover
      if (aBox > aImg) sy = aImg / aBox;
      else sx = aBox / aImg;
    }
  }
  return { uvMin, uvSize, fitScale: [sx, sy] };
}

// Rasterize the given subpaths into a fresh ImageValue using the bundled
// stroke/fill params. When `fillImage` is provided and fill is enabled, the
// fill region samples that image (per `fill_fit`) instead of `fill_color`.
// Returns null when neither stroke nor fill is enabled (the caller should
// then emit spline data only).
export function rasterizeSplineAux(
  ctx: RenderContext,
  nodeId: string,
  subpaths: SplineSubpath[],
  params: Record<string, unknown>,
  fillImage?: ImageValue | null
): ImageValue | null {
  const strokeOn = !!params.stroke_enabled;
  const fillOn = !!params.fill_enabled;
  if (!strokeOn && !fillOn) return null;

  const img =
    fillImage && fillImage.kind === "image" ? (fillImage as ImageValue) : null;
  const hasImageFill = fillOn && !!img;

  const state = ensureState(ctx, nodeId);
  const W = ctx.width;
  const H = ctx.height;
  const gl = ctx.gl;

  if (!hasImageFill) {
    // --- Flat-fill path: bake fill + stroke into one canvas, blit. ---
    const sig = JSON.stringify({
      mode: "flat",
      p: subpaths,
      se: strokeOn,
      st: params.stroke_thickness,
      sc: params.stroke_color,
      fe: fillOn,
      fc: params.fill_color,
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
        const path = buildPath2D(subpaths, W, H, fillOn);
        if (path) {
          if (fillOn) {
            c2d.fillStyle = hexToRgba(
              (params.fill_color as string) ?? "#ffffff"
            );
            // Even-odd so nested subpaths punch holes — matches Spline Draw.
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
        uploadCanvas(gl, state.rasterTex!, canvas);
      }
      state.lastSig = sig;
    }

    const image = ctx.allocImage();
    const prog = ctx.getShader("spline-raster-aux/blit", RASTER_FS);
    ctx.drawFullscreen(prog, image, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state.rasterTex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
    });
    return image;
  }

  // --- Image-fill path: separate coverage + stroke layers, composite. ---
  const fit = ((params.fill_fit as string) ?? "window") as
    | "window"
    | "contain"
    | "cover";
  if (!state.fillTex) state.fillTex = makeTex(gl);
  if (!state.strokeTex) state.strokeTex = makeTex(gl);
  const zeroTex = ensureZeroTex(ctx, state);

  // CPU rasters (coverage + stroke) don't depend on the image pixels — only
  // on geometry and stroke style. So dragging only the upstream fill image
  // re-composites without re-rasterizing the canvas layers.
  const sig = JSON.stringify({
    mode: "img",
    p: subpaths,
    se: strokeOn,
    st: params.stroke_thickness,
    sc: params.stroke_color,
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
      // Fill coverage: solid white where the (closed) path fills.
      c2d.clearRect(0, 0, W, H);
      const fillPath = buildPath2D(subpaths, W, H, true);
      if (fillPath) {
        c2d.fillStyle = "#ffffff";
        c2d.fill(fillPath, "evenodd");
      }
      uploadCanvas(gl, state.fillTex, canvas);

      // Stroke layer in its own color.
      c2d.clearRect(0, 0, W, H);
      if (strokeOn) {
        const strokePath = buildPath2D(subpaths, W, H, false);
        if (strokePath) {
          c2d.lineWidth = Math.max(0, (params.stroke_thickness as number) ?? 4);
          c2d.strokeStyle = hexToRgba(
            (params.stroke_color as string) ?? "#ffffff"
          );
          c2d.lineCap = "round";
          c2d.lineJoin = "round";
          c2d.stroke(strokePath);
        }
      }
      uploadCanvas(gl, state.strokeTex, canvas);
    }
    state.lastSig = sig;
  }

  const fitU = fit === "window" ? null : fitUniforms(subpaths, W, H, fit);
  const [fr, fg, fb, fa] = hexToRgba01((params.fill_color as string) ?? "#ffffff");

  const image = ctx.allocImage();
  const prog = ctx.getShader("spline-raster-aux/composite", COMPOSITE_FS);
  ctx.drawFullscreen(prog, image, (gl2) => {
    gl2.activeTexture(gl2.TEXTURE0);
    gl2.bindTexture(gl2.TEXTURE_2D, state.fillTex);
    gl2.uniform1i(gl2.getUniformLocation(prog, "u_fillMask"), 0);

    gl2.activeTexture(gl2.TEXTURE1);
    gl2.bindTexture(gl2.TEXTURE_2D, strokeOn ? state.strokeTex : zeroTex);
    gl2.uniform1i(gl2.getUniformLocation(prog, "u_stroke"), 1);

    gl2.activeTexture(gl2.TEXTURE2);
    gl2.bindTexture(gl2.TEXTURE_2D, img!.texture);
    gl2.uniform1i(gl2.getUniformLocation(prog, "u_fillImage"), 2);

    gl2.uniform1i(gl2.getUniformLocation(prog, "u_hasStroke"), strokeOn ? 1 : 0);
    gl2.uniform1i(gl2.getUniformLocation(prog, "u_hasFillImage"), 1);
    gl2.uniform4f(gl2.getUniformLocation(prog, "u_fillColor"), fr, fg, fb, fa);
    // window when fit math is unavailable (degenerate bbox) too.
    gl2.uniform1i(
      gl2.getUniformLocation(prog, "u_fit"),
      fitU ? (fit === "contain" ? 1 : 2) : 0
    );
    gl2.uniform2f(
      gl2.getUniformLocation(prog, "u_uvMin"),
      fitU ? fitU.uvMin[0] : 0,
      fitU ? fitU.uvMin[1] : 0
    );
    gl2.uniform2f(
      gl2.getUniformLocation(prog, "u_uvSize"),
      fitU ? fitU.uvSize[0] : 1,
      fitU ? fitU.uvSize[1] : 1
    );
    gl2.uniform2f(
      gl2.getUniformLocation(prog, "u_fitScale"),
      fitU ? fitU.fitScale[0] : 1,
      fitU ? fitU.fitScale[1] : 1
    );
  });
  return image;
}

export function disposeSplineRasterAux(ctx: RenderContext, nodeId: string) {
  const key = stateKey(nodeId);
  const state = ctx.state[key] as RasterState | undefined;
  if (state?.rasterTex) ctx.gl.deleteTexture(state.rasterTex);
  if (state?.fillTex) ctx.gl.deleteTexture(state.fillTex);
  if (state?.strokeTex) ctx.gl.deleteTexture(state.strokeTex);
  if (state?.zeroTex) ctx.gl.deleteTexture(state.zeroTex);
  delete ctx.state[key];
}

interface SplineBbox {
  minX: number;
  minY: number;
  w: number;
  h: number;
}

// Tight bbox in authored [0,1]² space, sampled off the flattened curve so
// the bounds follow the actual bezier extent (not just anchor positions).
function splineBbox(subpaths: SplineSubpath[]): SplineBbox | null {
  const { segments, segCount } = flattenSpline(
    { kind: "spline", subpaths },
    24
  );
  if (segCount === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < segCount * 4; i += 2) {
    const x = segments[i];
    const y = segments[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (!(w > 1e-6) || !(h > 1e-6)) return null;
  return { minX, minY, w, h };
}

// Build an Auto Layout element from a spline primitive's subpaths + the
// bundled stroke/fill params. Natural size is the shape's bbox in canvas
// pixels (aspect correction collapses to a uniform width-scale on both
// axes, so the bbox aspect IS the shape's visual aspect — a circle reads
// as square). measure is aspect-aware; render maps the bbox into the
// granted rect per the slot's fit, scaling the stroke with it.
export function buildSplineElement(
  ctx: RenderContext,
  subpaths: SplineSubpath[],
  params: Record<string, unknown>
): ElementValue {
  const bbox = splineBbox(subpaths);
  if (!bbox) return emptyElement();

  // Visual pixel size of the bbox. Both axes scale by the canvas width
  // because the rasterizer's Y aspect-correction makes the y-axis share
  // the x-axis pixel scale (see buildPath2D). Captured now; the eval
  // cache (and this closure) is dropped on canvas resize.
  const ref = ctx.width;
  const naturalW = Math.max(1, bbox.w * ref);
  const naturalH = Math.max(1, bbox.h * ref);

  const strokeOn = !!params.stroke_enabled;
  const fillOn = !!params.fill_enabled;
  // Nothing styled → fall back to a flat fill so the element is visible in
  // a layout (an invisible-but-space-taking child is a footgun).
  const drawFill = fillOn || !strokeOn;
  const fillColor = drawFill
    ? hexToRgba(
        (fillOn ? (params.fill_color as string) : undefined) ?? "#ffffff"
      )
    : null;
  const strokeColor = strokeOn
    ? hexToRgba((params.stroke_color as string) ?? "#ffffff")
    : null;
  const strokeThickness = Math.max(0, (params.stroke_thickness as number) ?? 4);

  return {
    kind: "element",
    measure: (c) => aspectFitMeasure(naturalW, naturalH, c),
    preferredSizing: { width: "hug", height: "hug" },
    render: (rctx, width, height, opts) => {
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const c2d = canvas.getContext("2d");
      if (!c2d) {
        const out = rctx.allocImage({ width: w, height: h });
        rctx.clearTarget(out, [0, 0, 0, 0]);
        return out;
      }

      // Map the bbox into the rect per fit. The bbox aspect is naturalW/
      // naturalH; the rect is w×h. contain fits the whole shape inside;
      // cover fills (overflow clipped by the buffer); stretch distorts.
      const fit: ElementFit = opts?.fit ?? "contain";
      const a = naturalW / naturalH;
      let dw = w;
      let dh = h;
      if (fit === "contain") {
        if (w / h > a) dw = h * a;
        else dh = w / a;
      } else if (fit === "cover") {
        if (w / h > a) dh = w / a;
        else dw = h * a;
      }
      // Scale the stroke with the drawn geometry, and inset by half its
      // width so it isn't clipped at the buffer edge.
      const sScale = Math.min(dw / naturalW, dh / naturalH);
      const strokePx = strokeOn ? strokeThickness * sScale : 0;
      const margin = strokePx / 2 + (strokeOn ? 1 : 0);
      const innerW = Math.max(1, dw - 2 * margin);
      const innerH = Math.max(1, dh - 2 * margin);
      // Place the fitted shape within the slot per alignment (default
      // centered) — the layout passes its container alignment so the
      // contained shape leans to the same edge as everything else.
      const slack = (total: number, drawn: number, align?: string) =>
        align === "start"
          ? 0
          : align === "end"
            ? total - drawn
            : (total - drawn) / 2;
      const offX = slack(w, dw, opts?.alignX) + margin;
      const offY = slack(h, dh, opts?.alignY) + margin;
      const toPx = (p: [number, number]) =>
        [
          offX + ((p[0] - bbox.minX) / bbox.w) * innerW,
          offY + ((p[1] - bbox.minY) / bbox.h) * innerH,
        ] as const;

      const path = buildPath2DWith(subpaths, toPx, drawFill);
      if (path) {
        if (drawFill && fillColor) {
          c2d.fillStyle = fillColor;
          c2d.fill(path, "evenodd");
        }
        if (strokeOn && strokeColor) {
          c2d.lineWidth = Math.max(0, strokePx);
          c2d.strokeStyle = strokeColor;
          c2d.lineCap = "round";
          c2d.lineJoin = "round";
          c2d.stroke(path);
        }
      }
      return uploadCanvasToImage(rctx, canvas);
    },
  };
}
