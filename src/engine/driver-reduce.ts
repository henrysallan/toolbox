import type { ImageValue, MaskValue, RenderContext } from "./types";

// Shared "driver" reduction: render a luminance driver (a mask input's .r, or
// an image's luminance × alpha — the image→mask coercion convention) box-
// reduced to a small uniform analysis grid, then read it back for CPU grid
// building. Extracted from Adaptive Pixelate so its bento-cut sibling (Bento
// Slice) shares one implementation; both nodes' CPU-authoritative grids start
// here. Grid cells are anchored top-left (y-down), matching CPU geometry —
// the single Y flip happens in the vertical pass.

// Horizontal box reduce + driver extraction. Each output texel covers a
// horizontal band of `u_cellPx` source pixels, anchored at the LEFT edge
// (matching the CPU grid's top-left anchoring); rows pass through 1:1.
const DRIVER_H_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform int u_isMask;    // 1: driver is the mask's .r; 0: luminance * alpha
uniform float u_cellPx;  // band width in source px
uniform float u_srcW;    // source width px
uniform float u_outW;    // target width (grid nx)
out vec4 outColor;

void main() {
  float gx = floor(v_uv.x * u_outW);
  int taps = int(clamp(ceil(u_cellPx), 1.0, 256.0));
  float stride = u_cellPx / float(taps);
  float sum = 0.0;
  for (int i = 0; i < taps; i++) {
    float x = (gx * u_cellPx + (float(i) + 0.5) * stride) / u_srcW;
    vec4 c = texture(u_src, vec2(min(x, 1.0), v_uv.y));
    sum += u_isMask == 1
      ? c.r
      : dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) * c.a;
  }
  outColor = vec4(sum / float(taps), 0.0, 0.0, 1.0);
}`;

// Vertical box reduce. Bands are anchored at the visual TOP (y-down, like
// the CPU grid), so the band for output row gyTop covers source pixels
// [gyTop*cell, (gyTop+1)*cell) measured from the top; the v_uv flip happens
// here, once. readImagePixels returns rows top-first, so the readback's row
// r is exactly the CPU grid's row r.
const DRIVER_V_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_cellPx;  // band height in source px
uniform float u_srcH;    // source height px
uniform float u_outH;    // target height (grid ny)
out vec4 outColor;

void main() {
  float gyTop = u_outH - 1.0 - floor(v_uv.y * u_outH);
  int taps = int(clamp(ceil(u_cellPx), 1.0, 256.0));
  float stride = u_cellPx / float(taps);
  float sum = 0.0;
  for (int i = 0; i < taps; i++) {
    float yTop = gyTop * u_cellPx + (float(i) + 0.5) * stride;
    float v = 1.0 - yTop / u_srcH;
    sum += texture(u_src, vec2(v_uv.x, clamp(v, 0.0, 1.0))).r;
  }
  outColor = vec4(sum / float(taps), 0.0, 0.0, 1.0);
}`;

// Render the driver (size map .r, or source luminance × alpha) reduced to an
// nx×ny grid of `cellPx`-sized cells and read it back. Returns y-down rows,
// 0..1, or null if the readback path is unavailable (context loss etc.).
// `src` may be null when a mask is supplied (mask-only callers like Space
// Fill's region/obstacle readback); at least one of the two must be present.
export function readDriver(
  ctx: RenderContext,
  src: ImageValue | null,
  map: MaskValue | null,
  nx: number,
  ny: number,
  cellPx: number
): Float32Array | null {
  const base = map ?? src;
  if (!base) return null;
  const srcTex = base.texture;
  const srcW = base.width;
  const srcH = base.height;

  const passH = ctx.allocImage({ width: nx, height: srcH });
  const progH = ctx.getShader("driver-reduce/h", DRIVER_H_FS);
  ctx.drawFullscreen(progH, passH, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(progH, "u_src"), 0);
    gl.uniform1i(gl.getUniformLocation(progH, "u_isMask"), map ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(progH, "u_cellPx"), cellPx);
    gl.uniform1f(gl.getUniformLocation(progH, "u_srcW"), srcW);
    gl.uniform1f(gl.getUniformLocation(progH, "u_outW"), nx);
  });

  const passV = ctx.allocImage({ width: nx, height: ny });
  const progV = ctx.getShader("driver-reduce/v", DRIVER_V_FS);
  ctx.drawFullscreen(progV, passV, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, passH.texture);
    gl.uniform1i(gl.getUniformLocation(progV, "u_src"), 0);
    gl.uniform1f(gl.getUniformLocation(progV, "u_cellPx"), cellPx);
    gl.uniform1f(gl.getUniformLocation(progV, "u_srcH"), srcH);
    gl.uniform1f(gl.getUniformLocation(progV, "u_outH"), ny);
  });

  const bytes = ctx.readImagePixels(passV, nx, ny);
  ctx.releaseTexture(passH.texture);
  ctx.releaseTexture(passV.texture);
  if (!bytes) return null;
  const out = new Float32Array(nx * ny);
  for (let i = 0; i < out.length; i++) out[i] = bytes[i * 4] / 255;
  return out;
}
