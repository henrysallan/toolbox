// =====================================================================
// 3D→2D render bridge (path B — isolated context, GPU canvas upload)
// =====================================================================
//
// Shared helper for getting a three.js render (an HTMLCanvasElement) into
// the engine's RGBA16F texture pool, the same way Video Source pulls a
// <video> frame: upload the canvas into an RGBA8 texture via texImage2D (a
// GPU-side copy, no CPU Float32 roundtrip), then blit it into a pool image
// with a vertical flip (canvas is DOM y-down; the engine samples y-up) and
// straight alpha.
//
// Deliberately three-free — it only touches RenderContext + GL — so it
// stays a pure engine helper. The three.WebGLRenderer lives in the calling
// node's ctx.state. See specdocs/archive/061626_3d-nodes-and-context.md §4.

import type { ImageValue, RenderContext } from "./types";

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  // Flip vertically: the uploaded canvas has its top row at texture row 0,
  // but drawFullscreen's v_uv is y-up (v=0 at bottom).
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

// Lease/create the per-node RGBA8 upload texture that the three canvas is
// copied into each frame. Stored in ctx.state under `<key>:upload-tex`.
// Mirrors Video Source's texture setup (straight alpha, LINEAR, clamp).
export function ensureUploadTexture(
  ctx: RenderContext,
  key: string
): WebGLTexture {
  const stateKey = `${key}:upload-tex`;
  const existing = ctx.state[stateKey] as WebGLTexture | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error(`three-bridge: failed to create texture (${key})`);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  ctx.state[stateKey] = tex;
  return tex;
}

export function disposeUploadTexture(ctx: RenderContext, key: string): void {
  const stateKey = `${key}:upload-tex`;
  const tex = ctx.state[stateKey] as WebGLTexture | undefined;
  if (tex) ctx.gl.deleteTexture(tex);
  delete ctx.state[stateKey];
}

// Upload `canvas` into `uploadTex`, then blit it (flipped) into a freshly
// leased pool image and return it. Caller owns the returned image's
// texture (the evaluator releases it on cache eviction, same as any
// computed output).
export function blitCanvasToImage(
  ctx: RenderContext,
  canvas: HTMLCanvasElement,
  uploadTex: WebGLTexture
): ImageValue {
  const gl = ctx.gl;
  const output = ctx.allocImage();

  gl.bindTexture(gl.TEXTURE_2D, uploadTex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  try {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      canvas
    );
  } catch {
    // Canvas not yet uploadable (zero-sized / context lost) — keep the
    // last good frame rather than throwing.
  }
  gl.bindTexture(gl.TEXTURE_2D, null);

  const prog = ctx.getShader("three-bridge/blit", BLIT_FS);
  ctx.drawFullscreen(prog, output, (gl2) => {
    gl2.activeTexture(gl2.TEXTURE0);
    gl2.bindTexture(gl2.TEXTURE_2D, uploadTex);
    gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
  });

  return output;
}
