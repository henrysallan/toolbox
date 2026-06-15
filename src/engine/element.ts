// Element helpers — the GL side of the `element` socket type.
//
// An ElementValue is a deferred, intrinsically-sized renderable (see
// types.ts). This module owns the shared shader work around it:
//
//   - wrapping a plain texture as an element (the image → element coercion
//     and the Frame node both build on this),
//   - flattening an element back to a canvas-sized image (the element →
//     image coercion, which is what makes element wires acceptable to
//     every existing image consumer and powers previews),
//   - positioned source-over compositing (Auto Layout's blit-children pass),
//   - the alpha-bounding-box scan behind Auto Layout's per-slot "trim".
//
// Identity-keyed WeakMap caches make the per-eval cost of coercions
// near-zero: a cache-hit upstream returns the *same* value object every
// eval, and any recompute produces a new one — so object identity is a
// sound invalidation signal (the same contract text.ts relies on).

import type {
  ElementSize,
  ElementValue,
  ImageValue,
  LayoutConstraints,
  RenderContext,
} from "./types";

export type ElementFit = "cover" | "contain" | "stretch";

// Where to place content within a rect when fit leaves slack (contain
// letterbox / cover crop). Default centered; Auto Layout passes its
// container alignment so e.g. "center-left" leans content to the left
// instead of always centering it.
export type ElementAxisAlign = "start" | "center" | "end";

// The output-space center to pivot the fit sampling around, per axis.
// At align "center" it's 0.5 (the rect center, the historical default).
// "start"/"end" shift it so the fitted content sits flush to that edge:
// the content occupies a 1/invScale-wide band of the output, and we
// place that band's center accordingly. Works for both contain
// (invScale > 1, letterbox) and cover (invScale < 1, crop).
function axisAlignCenter(invScale: number, align: ElementAxisAlign): number {
  if (align === "start") return 0.5 / invScale;
  if (align === "end") return 1 - 0.5 / invScale;
  return 0.5;
}

// Aspect-ratio-aware measure for content with a fixed intrinsic ratio
// (raster images, shapes). The layout solver passes the resolved size of
// one axis as a constraint; we return the proportional other axis so the
// content keeps its ratio and scales with the layout instead of pinning
// to its full natural pixel size. With no constraint it reports its
// natural size (Figma's "hug = pixel size"); with both, it contains
// within the box preserving ratio. This is THE mechanism that makes
// image/spline elements "maintain ratio and scale with changing
// dimensions" — text elements wrap instead, so they don't use this.
export function aspectFitMeasure(
  naturalW: number,
  naturalH: number,
  { maxWidth, maxHeight }: LayoutConstraints
): ElementSize {
  const w0 = Math.max(1, naturalW);
  const h0 = Math.max(1, naturalH);
  const aspect = w0 / h0;
  if (maxWidth != null && maxHeight != null) {
    // Contain within both bounds, preserving aspect.
    const w = Math.min(maxWidth, maxHeight * aspect);
    return { width: w, height: w / aspect };
  }
  if (maxWidth != null) return { width: maxWidth, height: maxWidth / aspect };
  if (maxHeight != null) return { width: maxHeight * aspect, height: maxHeight };
  return { width: w0, height: h0 };
}

// Sample a sub-region of a source texture into the full target, honoring
// fit. Region is in source UV (Y-up); both ends are engine textures so no
// Y flip is needed.
const REGION_FIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec4 u_region;   // x0, y0, w, h in source UV (Y-up)
uniform vec2 u_invScale;
uniform vec2 u_alignCenter; // output-space pivot per axis (0.5 = centered)
uniform float u_letterbox;
out vec4 outColor;
void main() {
  vec2 s = 0.5 + (v_uv - u_alignCenter) * u_invScale;
  if (u_letterbox > 0.5 && (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0)) {
    outColor = vec4(0.0);
    return;
  }
  s = clamp(s, 0.0, 1.0);
  outColor = texture(u_src, u_region.xy + s * u_region.zw);
}`;

// Porter-Duff source-over of a child texture positioned at a rect over a
// base (straight alpha, matching merge.ts's BLEND_FS math). Rect is in
// TARGET UV, Y-up.
const COMPOSITE_RECT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_base;
uniform sampler2D u_child;
uniform vec4 u_rect; // x0, y0, w, h in target UV (Y-up)
out vec4 outColor;
void main() {
  vec4 a = texture(u_base, v_uv);
  vec2 local = (v_uv - u_rect.xy) / max(u_rect.zw, vec2(1e-6));
  vec4 b = vec4(0.0);
  if (local.x >= 0.0 && local.x <= 1.0 && local.y >= 0.0 && local.y <= 1.0) {
    b = texture(u_child, local);
  }
  float srcA = clamp(b.a, 0.0, 1.0);
  float outA = srcA + a.a * (1.0 - srcA);
  vec3 rgb = outA < 1e-4
    ? vec3(0.0)
    : (b.rgb * srcA + a.rgb * a.a * (1.0 - srcA)) / outA;
  outColor = vec4(rgb, outA);
}`;

// Place a single texture at a rect on an otherwise-transparent target.
// One-pass version of COMPOSITE_RECT_FS for when there is no base.
const PLACE_RECT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_child;
uniform vec4 u_rect; // x0, y0, w, h in target UV (Y-up)
out vec4 outColor;
void main() {
  vec2 local = (v_uv - u_rect.xy) / max(u_rect.zw, vec2(1e-6));
  if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  outColor = texture(u_child, local);
}`;

// Fit math shared with image-source: how much of the source region the
// output window sees on each axis.
export function fitInvScale(
  srcAspect: number,
  outAspect: number,
  fit: ElementFit
): { invScale: [number, number]; letterbox: number } {
  const alpha = srcAspect / outAspect;
  if (fit === "stretch") return { invScale: [1, 1], letterbox: 0 };
  if (fit === "cover") {
    return {
      invScale: alpha > 1 ? [1 / alpha, 1] : [1, alpha],
      letterbox: 0,
    };
  }
  return {
    invScale: alpha > 1 ? [1, alpha] : [1 / alpha, 1],
    letterbox: 1,
  };
}

// Region of a source texture, in source UV with Y-up (texel space).
// A negative width/height samples the region mirrored on that axis —
// pass { x: 0, y: 1, width: 1, height: -1 } to flip a Y-down upload
// (e.g. a raw bitmap texture) into engine orientation while fitting.
export interface UvRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Render `region` of `src` into a freshly-allocated width×height texture,
// honoring fit. Caller owns the result.
export function renderRegionToRect(
  ctx: RenderContext,
  src: { texture: WebGLTexture; width: number; height: number },
  region: UvRegion,
  width: number,
  height: number,
  fit: ElementFit,
  alignX: ElementAxisAlign = "center",
  alignY: ElementAxisAlign = "center"
): ImageValue {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const out = ctx.allocImage({ width: w, height: h });
  const regionPxW = Math.max(1e-6, Math.abs(region.width) * src.width);
  const regionPxH = Math.max(1e-6, Math.abs(region.height) * src.height);
  const { invScale, letterbox } = fitInvScale(
    regionPxW / regionPxH,
    w / h,
    fit
  );
  const alignCenter: [number, number] = [
    axisAlignCenter(invScale[0], alignX),
    axisAlignCenter(invScale[1], alignY),
  ];
  const prog = ctx.getShader("element/region-fit", REGION_FIT_FS);
  ctx.drawFullscreen(prog, out, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
    gl.uniform4f(
      gl.getUniformLocation(prog, "u_region"),
      region.x,
      region.y,
      region.width,
      region.height
    );
    gl.uniform2f(
      gl.getUniformLocation(prog, "u_invScale"),
      invScale[0],
      invScale[1]
    );
    gl.uniform2f(
      gl.getUniformLocation(prog, "u_alignCenter"),
      alignCenter[0],
      alignCenter[1]
    );
    gl.uniform1f(gl.getUniformLocation(prog, "u_letterbox"), letterbox);
  });
  return out;
}

// Pixel rect within a target texture, Y-DOWN (layout convention).
export interface PxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectToUvYUp(
  rect: PxRect,
  targetW: number,
  targetH: number
): [number, number, number, number] {
  return [
    rect.x / targetW,
    (targetH - (rect.y + rect.height)) / targetH,
    rect.width / targetW,
    rect.height / targetH,
  ];
}

// Source-over `child` at `rect` (Y-down px) over `base`, into a fresh
// texture the caller owns. Does not release base or child.
export function compositeOverAt(
  ctx: RenderContext,
  base: ImageValue,
  child: ImageValue,
  rect: PxRect
): ImageValue {
  const out = ctx.allocImage({ width: base.width, height: base.height });
  const uv = rectToUvYUp(rect, base.width, base.height);
  const prog = ctx.getShader("element/composite-rect", COMPOSITE_RECT_FS);
  ctx.drawFullscreen(prog, out, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, base.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_base"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, child.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_child"), 1);
    gl.uniform4f(gl.getUniformLocation(prog, "u_rect"), ...uv);
  });
  return out;
}

// Place `child` at `rect` (Y-down px) on a transparent targetW×targetH
// texture. Caller owns the result.
export function placeAt(
  ctx: RenderContext,
  child: ImageValue,
  rect: PxRect,
  targetW: number,
  targetH: number
): ImageValue {
  const out = ctx.allocImage({ width: targetW, height: targetH });
  const uv = rectToUvYUp(rect, targetW, targetH);
  const prog = ctx.getShader("element/place-rect", PLACE_RECT_FS);
  ctx.drawFullscreen(prog, out, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, child.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_child"), 0);
    gl.uniform4f(gl.getUniformLocation(prog, "u_rect"), ...uv);
  });
  return out;
}

// ---------------------------------------------------------------------
// image → element (coercion + Frame both route through this)
// ---------------------------------------------------------------------

const wrapCache = new WeakMap<ImageValue, ElementValue>();

// Wrap a plain texture as an element. Natural size = the image's own px
// dimensions (= canvas-sized for anything mid-pipeline); render samples
// the full texture into the rect honoring fit. Cached by value identity
// so repeated coercions of a cache-hit upstream are free.
export function wrapImageAsElement(
  value: ImageValue,
  region?: UvRegion
): ElementValue {
  if (!region) {
    const cached = wrapCache.get(value);
    if (cached) return cached;
  }
  const r = region ?? { x: 0, y: 0, width: 1, height: 1 };
  const naturalW = Math.max(1, Math.round(Math.abs(r.width) * value.width));
  const naturalH = Math.max(1, Math.round(Math.abs(r.height) * value.height));
  const el: ElementValue = {
    kind: "element",
    // Aspect-aware: a coerced canvas image keeps the canvas ratio and
    // scales with the layout rather than pinning to full canvas pixels.
    measure: (c) => aspectFitMeasure(naturalW, naturalH, c),
    render: (ctx, width, height, opts) =>
      renderRegionToRect(
        ctx,
        value,
        r,
        width,
        height,
        opts?.fit ?? "cover",
        opts?.alignX,
        opts?.alignY
      ),
    preferredSizing: { width: "fixed", height: "fixed" },
    sourceImage: value,
  };
  if (!region) wrapCache.set(value, el);
  return el;
}

// ---------------------------------------------------------------------
// element → image (coercion: render at natural size, composite centered)
// ---------------------------------------------------------------------

const flattenCache = new WeakMap<ElementValue, ImageValue>();

export function elementToCanvasImage(
  value: ElementValue,
  ctx: RenderContext
): ImageValue {
  const cached = flattenCache.get(value);
  // Identity-keyed, but the canvas may have been resized between evals
  // (backend recreation clears the eval cache yet module caches persist) —
  // double-check dimensions before trusting the entry.
  if (cached && cached.width === ctx.width && cached.height === ctx.height) {
    return cached;
  }
  const natural = value.measure({
    maxWidth: ctx.width,
    maxHeight: ctx.height,
  });
  const w = Math.min(ctx.width, Math.max(0, Math.round(natural.width)));
  const h = Math.min(ctx.height, Math.max(0, Math.round(natural.height)));
  let out: ImageValue;
  if (w < 1 || h < 1) {
    out = ctx.allocImage();
    ctx.clearTarget(out, [0, 0, 0, 0]);
  } else {
    const rendered = value.render(ctx, w, h);
    out = placeAt(
      ctx,
      rendered,
      {
        x: Math.round((ctx.width - w) / 2),
        y: Math.round((ctx.height - h) / 2),
        width: w,
        height: h,
      },
      ctx.width,
      ctx.height
    );
    ctx.releaseTexture(rendered.texture);
  }
  flattenCache.set(value, out);
  return out;
}

// Zero-size element — emitted for gated clips and unwired inputs that
// still need a representable empty.
export function emptyElement(): ElementValue {
  return {
    kind: "element",
    measure: () => ({ width: 0, height: 0 }),
    render: (ctx, width, height) => {
      const out = ctx.allocImage({
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
      });
      ctx.clearTarget(out, [0, 0, 0, 0]);
      return out;
    },
  };
}

// Sample with a vertical flip — for canvas2d uploads, whose row 0 sits at
// the top rather than the engine's bottom-origin convention.
const FLIP_Y_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

// Upload a canvas2d raster into a fresh engine-oriented (Y-up) image the
// caller owns. The temp upload texture is deleted before returning.
export function uploadCanvasToImage(
  ctx: RenderContext,
  canvas: HTMLCanvasElement
): ImageValue {
  const gl = ctx.gl;
  const tmp = gl.createTexture();
  if (!tmp) throw new Error("element: failed to create upload texture");
  gl.bindTexture(gl.TEXTURE_2D, tmp);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  const out = ctx.allocImage({ width: canvas.width, height: canvas.height });
  const prog = ctx.getShader("element/flip-y", FLIP_Y_FS);
  ctx.drawFullscreen(prog, out, (gl2) => {
    gl2.activeTexture(gl2.TEXTURE0);
    gl2.bindTexture(gl2.TEXTURE_2D, tmp);
    gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
  });
  gl.deleteTexture(tmp);
  return out;
}

// ---------------------------------------------------------------------
// Trim — alpha bounding box of a source texture
// ---------------------------------------------------------------------

// Cached per ImageValue identity: a cache-hit upstream returns the same
// object, any recompute produces a new one, so invalidation is free.
// null = fully transparent (no content).
const bboxCache = new WeakMap<ImageValue, UvRegion | null>();

const PROXY_MAX = 256;

// Measure the alpha bounding box of `src` via a ≤256px proxy and one
// readback. Returns the content rect in source UV (Y-up), or null when
// the image has no alpha > 1/255 anywhere. Precision is ~dimension/256 —
// fine for layout.
export function alphaBoundingBox(
  ctx: RenderContext,
  src: ImageValue
): UvRegion | null {
  const hit = bboxCache.get(src);
  if (hit !== undefined) return hit;

  const scale = Math.min(1, PROXY_MAX / Math.max(src.width, src.height, 1));
  const pw = Math.max(1, Math.round(src.width * scale));
  const ph = Math.max(1, Math.round(src.height * scale));
  const proxy = renderRegionToRect(
    ctx,
    src,
    { x: 0, y: 0, width: 1, height: 1 },
    pw,
    ph,
    "stretch"
  );
  const data = ctx.readImageToFloat32(proxy);
  ctx.releaseTexture(proxy.texture);

  const threshold = 1 / 255;
  let minX = pw;
  let minY = ph;
  let maxX = -1;
  let maxY = -1;
  // readPixels rows come back bottom-up, which IS Y-up — exactly the
  // orientation the region wants, so no flip.
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      if (data[(y * pw + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const region: UvRegion | null =
    maxX < 0
      ? null
      : {
          x: minX / pw,
          y: minY / ph,
          width: (maxX - minX + 1) / pw,
          height: (maxY - minY + 1) / ph,
        };
  bboxCache.set(src, region);
  return region;
}
