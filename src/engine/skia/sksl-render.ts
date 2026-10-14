// Runs a compiled SkSL effect on CanvasKit's own WebGL context and lands the
// result in an engine image (specdocs/101326_skia-target.md).
//
// Two GL contexts, one copy each way:
//   - Skia renders into a private offscreen canvas (one shared surface,
//     resized to the request). The context is created premultipliedAlpha:
//     false so the browser hands texImage2D Skia's raw premultiplied bytes
//     instead of un-premultiplying them in 8 bits; the engine-side blit
//     divides alpha out in float and flips Skia's Y-down rows into the
//     engine's Y-up convention.
//   - Wired images go the other way through readImagePixels (RGBA8, row 0 =
//     top) → CanvasKit.MakeImage → an image shader. That is a CPU round trip
//     per input per frame and 8-bit; fine for a staging preview, and the
//     reason inputs are listed as an M2 optimisation in the spec.
//
// The surface is sRGB, like React Native Skia's default canvas, so shader
// math runs on gamma-encoded values exactly as the engine's own shaders do.

import type { CanvasKit, GrDirectContext, RuntimeEffect, Surface } from "canvaskit-wasm";
import type { ImageValue, RenderContext } from "../types";

interface SkiaGpu {
  canvas: HTMLCanvasElement;
  grCtx: GrDirectContext;
  surface: Surface;
  width: number;
  height: number;
}

let gpu: SkiaGpu | null = null;
let gpuError: string | null = null;

export function skiaGpuError(): string | null {
  return gpuError;
}

function ensureSurface(kit: CanvasKit, width: number, height: number): Surface | null {
  if (gpu && gpu.width === width && gpu.height === height) return gpu.surface;
  if (typeof document === "undefined") {
    gpuError = "no document — the SkSL preview needs a browser WebGL context";
    return null;
  }
  if (!gpu) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const handle = kit.GetWebGLContext(canvas, {
      premultipliedAlpha: 0,
      preserveDrawingBuffer: 1,
      antialias: 0,
      depth: 0,
      stencil: 8,
      majorVersion: 2,
    });
    const grCtx = handle ? kit.MakeWebGLContext(handle) : null;
    if (!grCtx) {
      gpuError = "CanvasKit could not create a WebGL context";
      return null;
    }
    const surface = kit.MakeOnScreenGLSurface(grCtx, width, height, kit.ColorSpace.SRGB);
    if (!surface) {
      gpuError = "CanvasKit could not create a surface";
      return null;
    }
    gpu = { canvas, grCtx, surface, width, height };
    gpuError = null;
    return surface;
  }
  gpu.surface.delete();
  gpu.canvas.width = width;
  gpu.canvas.height = height;
  const surface = kit.MakeOnScreenGLSurface(gpu.grCtx, width, height, kit.ColorSpace.SRGB);
  if (!surface) {
    gpuError = "CanvasKit could not resize its surface";
    return null;
  }
  gpu.surface = surface;
  gpu.width = width;
  gpu.height = height;
  return surface;
}

// Skia's bytes are premultiplied with row 0 at the top; the engine wants
// straight alpha with v_uv Y-up.
const SKIA_IMPORT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  vec4 c = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
  outColor = c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0);
}`;

function childShader(kit: CanvasKit, ctx: RenderContext, img: ImageValue | undefined) {
  if (!img) return { shader: kit.Shader.MakeColor(kit.TRANSPARENT, kit.ColorSpace.SRGB), image: null };
  const bytes = ctx.readImagePixels(img);
  if (!bytes) return { shader: kit.Shader.MakeColor(kit.TRANSPARENT, kit.ColorSpace.SRGB), image: null };
  const image = kit.MakeImage(
    {
      width: img.width,
      height: img.height,
      alphaType: kit.AlphaType.Unpremul,
      colorType: kit.ColorType.RGBA_8888,
      colorSpace: kit.ColorSpace.SRGB,
    },
    bytes,
    img.width * 4
  );
  if (!image) return { shader: kit.Shader.MakeColor(kit.TRANSPARENT, kit.ColorSpace.SRGB), image: null };
  const shader = image.makeShaderOptions(
    kit.TileMode.Clamp,
    kit.TileMode.Clamp,
    kit.FilterMode.Linear,
    kit.MipmapMode.None
  );
  return { shader, image };
}

export function renderSkslToImage(
  ctx: RenderContext,
  kit: CanvasKit,
  effect: RuntimeEffect,
  uniforms: Float32Array,
  children: (ImageValue | undefined)[],
  width: number,
  height: number
): ImageValue | null {
  const surface = ensureSurface(kit, width, height);
  if (!surface || !gpu) return null;

  const kids = children.map((c) => childShader(kit, ctx, c));
  const shader = kids.length
    ? effect.makeShaderWithChildren(uniforms, kids.map((k) => k.shader))
    : effect.makeShader(uniforms);
  const paint = new kit.Paint();
  paint.setShader(shader);
  // Src, not SrcOver: the node's output is the shader's value, not the
  // shader composited over last frame.
  paint.setBlendMode(kit.BlendMode.Src);
  const canvas = surface.getCanvas();
  canvas.clear(kit.TRANSPARENT);
  canvas.drawPaint(paint);
  surface.flush();
  paint.delete();
  shader.delete();
  for (const k of kids) {
    k.shader.delete();
    k.image?.delete();
  }

  const gl = ctx.gl;
  const tmp = gl.createTexture();
  if (!tmp) return null;
  gl.bindTexture(gl.TEXTURE_2D, tmp);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, gpu.canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  const out = ctx.allocImage({ width, height });
  const prog = ctx.getShader("sksl/import", SKIA_IMPORT_FS);
  ctx.drawFullscreen(prog, out, (g) => {
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, tmp);
    g.uniform1i(g.getUniformLocation(prog, "u_src"), 0);
  });
  gl.deleteTexture(tmp);
  return out;
}
