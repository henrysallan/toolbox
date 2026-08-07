import { getAudioFrame, rms } from "./audio-analysis";
import { elementToCanvasImage, wrapImageAsElement } from "./element";
import { buildPath2D } from "./spline-raster";
import type {
  MaskValue,
  RenderContext,
  SocketType,
  SocketValue,
  SplineValue,
} from "./types";

// Sample the representative value of an image-like texture by rendering
// it into a 1×1 readback target and pulling that one pixel back. The
// sampled UV is the fullscreen triangle's fragment center ≈ (0.5, 0.5),
// so for smooth inputs (noise, gradients) this is the visual "middle
// value." For high-contrast images it's just whatever single pixel the
// linear-filter sampler lands on — good enough for the common case of
// wiring noise → scalar params.
function sampleImageRed(
  value: { texture: WebGLTexture; width: number; height: number },
  ctx: RenderContext
): number | null {
  const data = ctx.readImagePixels(
    { kind: "image", texture: value.texture, width: value.width, height: value.height },
    1,
    1
  );
  if (!data) return null;
  return data[0] / 255;
}

const MASK_TO_IMAGE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  float m = texture(u_src, v_uv).r;
  outColor = vec4(m, m, m, 1.0);
}`;

// Image → mask is luminance WEIGHTED BY COVERAGE (alpha). For an opaque
// image (alpha == 1 everywhere: noise, gradients, photos) this is exactly the
// old luminance behavior — no regression. For a shape drawn on transparency
// (Rectangle/Circle/Text/SVG rasters, SDF fills) the alpha term zeroes the
// transparent surround (so the mask is the silhouette, not whatever stale RGB
// sits in the cleared region) and passes the drawn coverage through. Net: a
// bright-filled shape mattes by its shape; a grayscale image still mattes by
// brightness. (A dark-*colored* fill still reads dim — use a light fill, or
// the shape's alpha via a coverage source, if you want color-independent.)
const IMAGE_TO_MASK_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  vec4 c = texture(u_src, v_uv);
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  outColor = vec4(l * c.a, 0.0, 0.0, 1.0);
}`;

// Spline → mask rasterizes the shape's filled silhouette (even-odd, open
// subpaths closed for fill — same rules as the primitives' bundled raster)
// into a canvas-sized coverage mask. Identity-cached per SplineValue: a
// cache-hit upstream returns the same object, so a static shape pays the
// canvas fill + upload once; an animated one re-rasterizes per recompute,
// same cost profile as Rasterize Spline.
const splineMaskCache = new WeakMap<SplineValue, MaskValue>();
const SPLINE_MASK_CANVAS_KEY = "__coerce_spline_mask_canvas__";

// Canvas memory is row-0-top; flip Y to the pipeline's Y-up convention.
// Coverage = r * a like image→mask, so antialiased edges stay soft.
const SPLINE_TO_MASK_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  vec4 c = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
  outColor = vec4(c.r * c.a, 0.0, 0.0, 1.0);
}`;

function splineToMask(value: SplineValue, ctx: RenderContext): MaskValue | undefined {
  const cached = splineMaskCache.get(value);
  if (cached && cached.width === ctx.width && cached.height === ctx.height) {
    return cached;
  }
  let canvas = ctx.state[SPLINE_MASK_CANVAS_KEY] as HTMLCanvasElement | undefined;
  if (!canvas) {
    canvas = document.createElement("canvas");
    ctx.state[SPLINE_MASK_CANVAS_KEY] = canvas;
  }
  if (canvas.width !== ctx.width) canvas.width = ctx.width;
  if (canvas.height !== ctx.height) canvas.height = ctx.height;
  const c2d = canvas.getContext("2d");
  if (!c2d) return undefined;
  c2d.clearRect(0, 0, canvas.width, canvas.height);
  const path = buildPath2D(value.subpaths, canvas.width, canvas.height, true);
  if (path) {
    c2d.fillStyle = "#ffffff";
    c2d.fill(path, "evenodd");
  }

  const gl = ctx.gl;
  const tmp = gl.createTexture();
  if (!tmp) return undefined;
  gl.bindTexture(gl.TEXTURE_2D, tmp);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  const out = ctx.allocMask();
  const program = ctx.getShader("__spline_to_mask__", SPLINE_TO_MASK_FS);
  ctx.drawFullscreen(program, out, (gl2) => {
    gl2.activeTexture(gl2.TEXTURE0);
    gl2.bindTexture(gl2.TEXTURE_2D, tmp);
    gl2.uniform1i(gl2.getUniformLocation(program, "u_src"), 0);
  });
  gl.deleteTexture(tmp);
  splineMaskCache.set(value, out);
  return out;
}

export function coerceValue(
  value: SocketValue | undefined,
  target: SocketType,
  ctx: RenderContext
): SocketValue | undefined {
  if (!value) return undefined;
  if (value.kind === target) return value;

  if (value.kind === "mask" && target === "image") {
    const out = ctx.allocImage({ width: value.width, height: value.height });
    const program = ctx.getShader("__mask_to_image__", MASK_TO_IMAGE_FS);
    ctx.drawFullscreen(program, out, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, value.texture);
      gl.uniform1i(gl.getUniformLocation(program, "u_src"), 0);
    });
    return out;
  }

  if (value.kind === "image" && target === "mask") {
    const out = ctx.allocMask({ width: value.width, height: value.height });
    const program = ctx.getShader("__image_to_mask__", IMAGE_TO_MASK_FS);
    ctx.drawFullscreen(program, out, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, value.texture);
      gl.uniform1i(gl.getUniformLocation(program, "u_src"), 0);
    });
    return out;
  }

  // Spline → mask: the shape as its filled silhouette. This is what lets a
  // primitive (Rectangle, Circle, Spline Draw…) wire straight into any mask
  // socket — the universal matte, Merge's per-layer masks — without routing
  // through its raster aux output or a Rasterize Spline node.
  if (value.kind === "spline" && target === "mask") {
    return splineToMask(value, ctx);
  }

  if (value.kind === "scalar") {
    const v = value.value;
    if (target === "vec2") return { kind: "vec2", value: [v, v] };
    if (target === "vec3") return { kind: "vec3", value: [v, v, v] };
    if (target === "vec4") return { kind: "vec4", value: [v, v, v, v] };
    // Scalar → UV passes through as a ScalarValue. UV-accepting nodes branch
    // on `.kind` and broadcast the scalar in-shader as a uniform vec2, which
    // avoids allocating a 1×1 texture per scalar coercion per evaluation.
    if (target === "uv") return value;
  }

  // Vector widening — pad with z = 0 and w = 1 (a point's homogeneous
  // coordinate; a colour's opaque alpha). Widening only, deliberately: see
  // `coercible` in graph-helpers.ts. This is what lets a Switch mix vec
  // arities across its slots, and lets a vec3 drive a colour (vec4) param.
  if (value.kind === "vec2") {
    const [x, y] = value.value;
    if (target === "vec3") return { kind: "vec3", value: [x, y, 0] };
    if (target === "vec4") return { kind: "vec4", value: [x, y, 0, 1] };
  }
  if (value.kind === "vec3") {
    const [x, y, z] = value.value;
    if (target === "vec4") return { kind: "vec4", value: [x, y, z, 1] };
  }

  // Image → uv: reinterpret R/G as per-pixel (u, v). Zero-copy — UV fields
  // live in the same RGBA pool textures as images (see allocUv), and every
  // uv consumer samples `.rg`, so re-wrapping the texture is the whole job.
  // The wrapper is transient (built at input-resolution, consumed inside the
  // downstream compute), so aliasing the source texture is safe. A grayscale
  // image (R == G) maps to the (f, f) diagonal — wiring Noise into another
  // Noise's UV input is Blender's Fac → Vector marble trick, re-evaluating
  // the second noise at coordinates read from the first. Curl noise's signed
  // RG field warps as a true vector field. Mask is deliberately NOT
  // coercible to uv (its R-format texture reads G = 0).
  if (value.kind === "image" && target === "uv") {
    return {
      kind: "uv",
      texture: value.texture,
      width: value.width,
      height: value.height,
    };
  }

  // Image / mask → scalar. Sample the source's "middle value" via a 1×1
  // readback. Intentionally general so any scalar-typed input or exposed
  // param accepts an image — noise wired into Transform scale, gradient
  // wired into rotation, etc. The readback is a sync GPU stall but only
  // fires when a consumer actually requests the coercion, and only on
  // one pixel.
  if ((value.kind === "image" || value.kind === "mask") && target === "scalar") {
    const v = sampleImageRed(value, ctx);
    if (v == null) return undefined;
    return { kind: "scalar", value: v };
  }

  // Audio → scalar. Reads the shared analysis frame (one AnalyserNode per
  // element, cached per frame in audio-analysis.ts) and emits the RMS of
  // the current time-domain buffer: 0 when silent, ~1 on a loud signal.
  // Wire Audio Source into Transform's scale, a Math node, a Remap's
  // input, etc. — anywhere a scalar belongs.
  if (value.kind === "audio" && target === "scalar") {
    const frame = getAudioFrame(value, ctx);
    if (!frame) return { kind: "scalar", value: 0 };
    return { kind: "scalar", value: rms(frame.timeDomain) };
  }

  // Image → element. Wraps the texture as a deferred renderable whose
  // natural size is the image's own px dimensions. This is what makes
  // ANY existing image chain wirable into Auto Layout directly
  // (Image Source → Blur → Auto Layout, no adapter node). Identity-
  // cached inside the helper so per-eval cost is near-zero.
  if (value.kind === "image" && target === "element") {
    return wrapImageAsElement(value);
  }

  // Element → image. Renders at natural size (clamped to canvas) and
  // composites centered onto a transparent canvas-sized image — element
  // wires become acceptable to every existing image consumer, and the
  // preview canvas works. Identity-cached inside the helper.
  if (value.kind === "element" && target === "image") {
    return elementToCanvasImage(value, ctx);
  }

  return undefined;
}
