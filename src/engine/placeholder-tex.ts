// Shared 1×1 zero texture helper. Nodes that conditionally sample a socket
// (e.g., optional UV input) still need a valid GL texture bound to the
// corresponding sampler — this keeps a single placeholder per owner, cached
// in the render context's persistent state so it survives across frames.

export function getPlaceholderTex(
  gl: WebGL2RenderingContext,
  state: Record<string, unknown>,
  key: string
): WebGLTexture {
  const cached = state[key] as WebGLTexture | undefined;
  if (cached) return cached;
  const tex = gl.createTexture();
  if (!tex) throw new Error(`failed to create placeholder texture (${key})`);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
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
  state[key] = tex;
  return tex;
}

export function disposePlaceholderTex(
  gl: WebGL2RenderingContext,
  state: Record<string, unknown>,
  key: string
): void {
  const cached = state[key] as WebGLTexture | undefined;
  if (cached) gl.deleteTexture(cached);
  delete state[key];
}
