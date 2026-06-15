import type { ImageValue, RenderContext, SplineSubpath } from "./types";
import { flattenSpline } from "./spline-flatten";

// Shared image-fill compositing for spline rasterizers (Spline Draw, Circle,
// Rectangle, SVG Source, Rasterize Spline, Spline Boolean). When a `fill`
// image is wired, the fill region is rendered as a coverage MASK (white-on-
// transparent) and the stroke as its own color layer; this composites the
// image (sampled per fit mode) through the coverage, with the stroke OVER it.
// Straight-alpha Porter-Duff source-over (matches merge.ts BLEND_FS).
//
// Each caller owns its coverage/stroke canvas rendering (so node-specific fill
// rules / stroke styles are honored) and the textures; this module owns only
// the fit math + the composite draw, so the behavior matches everywhere.

export type SplineFillFit = "window" | "contain" | "cover";

export const SPLINE_COMPOSITE_FS = `#version 300 es
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

// Parse a hex color to straight-alpha floats [r,g,b,a] in [0,1].
export function hexToRgba01(hex: string): [number, number, number, number] {
  const h = (hex || "#ffffff").replace("#", "");
  let r = 255,
    g = 255,
    b = 255,
    a = 255;
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

export interface SplineBbox {
  minX: number;
  minY: number;
  w: number;
  h: number;
}

// Tight bbox in authored [0,1]² space, sampled off the flattened curve so the
// bounds follow the actual bezier extent (not just anchor positions).
export function splineBbox(subpaths: SplineSubpath[]): SplineBbox | null {
  const { segments, segCount } = flattenSpline({ kind: "spline", subpaths }, 24);
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

// Compute the shape's bbox in canvas UV (Y-up) plus the per-axis sample scale
// that fits the (full-canvas) fill image into that bbox per `fit`. The
// rasterizer aspect-corrects Y so the bbox shares the X pixel scale — hence
// the bbox's *pixel* aspect equals its authored w/h.
export function splineFitUniforms(
  subpaths: SplineSubpath[],
  W: number,
  H: number,
  fit: SplineFillFit
): { uvMin: [number, number]; uvSize: [number, number]; fitScale: [number, number] } | null {
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

// A 1×1 transparent texture, so every declared sampler has a valid binding
// even when its layer is absent (WebGL requires it regardless of branching).
export function makeZeroTex(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("spline-fill: failed to create placeholder texture");
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
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

// Composite a (caller-rendered) fill-coverage mask + stroke layer with an
// optional wired fill image into `target`. `strokeTex` null ⇒ no stroke;
// `fillImage` null ⇒ flat `fillColorHex`. `zeroTex` is a 1×1 placeholder for
// the unused samplers.
export function compositeSplineFill(
  ctx: RenderContext,
  target: ImageValue,
  opts: {
    fillMaskTex: WebGLTexture;
    strokeTex: WebGLTexture | null;
    fillImage: ImageValue | null;
    fillColorHex: string;
    fit: SplineFillFit;
    subpaths: SplineSubpath[];
    zeroTex: WebGLTexture;
  }
): void {
  const { fillMaskTex, strokeTex, fillImage, fillColorHex, fit, subpaths, zeroTex } =
    opts;
  const hasImage = !!fillImage;
  const fitU = fit === "window" || !hasImage ? null : splineFitUniforms(subpaths, ctx.width, ctx.height, fit);
  const [fr, fg, fb, fa] = hexToRgba01(fillColorHex);

  const prog = ctx.getShader("spline-fill/composite", SPLINE_COMPOSITE_FS);
  ctx.drawFullscreen(prog, target, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fillMaskTex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_fillMask"), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, strokeTex ?? zeroTex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_stroke"), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, fillImage ? fillImage.texture : zeroTex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_fillImage"), 2);

    gl.uniform1i(gl.getUniformLocation(prog, "u_hasStroke"), strokeTex ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_hasFillImage"), hasImage ? 1 : 0);
    gl.uniform4f(gl.getUniformLocation(prog, "u_fillColor"), fr, fg, fb, fa);
    gl.uniform1i(
      gl.getUniformLocation(prog, "u_fit"),
      fitU ? (fit === "contain" ? 1 : 2) : 0
    );
    gl.uniform2f(
      gl.getUniformLocation(prog, "u_uvMin"),
      fitU ? fitU.uvMin[0] : 0,
      fitU ? fitU.uvMin[1] : 0
    );
    gl.uniform2f(
      gl.getUniformLocation(prog, "u_uvSize"),
      fitU ? fitU.uvSize[0] : 1,
      fitU ? fitU.uvSize[1] : 1
    );
    gl.uniform2f(
      gl.getUniformLocation(prog, "u_fitScale"),
      fitU ? fitU.fitScale[0] : 1,
      fitU ? fitU.fitScale[1] : 1
    );
  });
}
