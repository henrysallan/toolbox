import type {
  CursorState,
  ImageValue,
  MaskValue,
  RenderContext,
  UvValue,
} from "./types";

const FULLSCREEN_VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  v_uv = (p + 1.0) * 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, v_uv);
}`;

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  src: string
): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error("Failed to create shader");
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error("Shader compile failed: " + log + "\n--\n" + src);
  }
  return s;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vs: WebGLShader,
  fs: WebGLShader
): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error("Failed to create program");
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("Program link failed: " + gl.getProgramInfoLog(p));
  }
  return p;
}

export interface EngineBackend {
  readonly gl: WebGL2RenderingContext;
  readonly hiddenCanvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  // The same `state` map exposed on RenderContext — exposed here so UI code
  // (e.g. the Timeline curve editor reading per-node playhead values stashed
  // by Timeline.compute) can read it without going through a render tick.
  readonly state: Record<string, unknown>;
  resize(width: number, height: number): void;
  makeContext(
    time: number,
    frame: number,
    cursor?: CursorState,
    playing?: boolean
  ): RenderContext;
  destroy(): void;
}

export function createEngineBackend(
  initialWidth: number,
  initialHeight: number
): EngineBackend {
  const hiddenCanvas = document.createElement("canvas");
  hiddenCanvas.width = initialWidth;
  hiddenCanvas.height = initialHeight;

  const gl = hiddenCanvas.getContext("webgl2", {
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error("WebGL2 not supported");

  const hasColorBufferFloat = !!gl.getExtension("EXT_color_buffer_float");
  gl.getExtension("OES_texture_float_linear");
  if (!hasColorBufferFloat) {
    console.warn(
      "EXT_color_buffer_float unavailable — falling back to RGBA8 render targets"
    );
  }

  const shaderCache = new Map<string, WebGLProgram>();
  const vao = gl.createVertexArray();
  if (!vao) throw new Error("Failed to create VAO");
  const sharedVs = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error("Failed to create FBO");

  let width = initialWidth;
  let height = initialHeight;
  const persistentState: Record<string, unknown> = {};

  function getShader(key: string, fragSrc: string): WebGLProgram {
    const cached = shaderCache.get(key);
    if (cached) return cached;
    const fs = compileShader(gl!, gl!.FRAGMENT_SHADER, fragSrc);
    const prog = linkProgram(gl!, sharedVs, fs);
    gl!.deleteShader(fs);
    shaderCache.set(key, prog);
    return prog;
  }

  const blitProgram = getShader("__blit__", BLIT_FS);

  function allocTexture(
    w: number,
    h: number,
    channels: "rgba" | "r"
  ): WebGLTexture {
    const tex = gl!.createTexture();
    if (!tex) throw new Error("Failed to create texture");
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
    if (channels === "rgba") {
      if (hasColorBufferFloat) {
        gl!.texImage2D(
          gl!.TEXTURE_2D,
          0,
          gl!.RGBA16F,
          w,
          h,
          0,
          gl!.RGBA,
          gl!.HALF_FLOAT,
          null
        );
      } else {
        gl!.texImage2D(
          gl!.TEXTURE_2D,
          0,
          gl!.RGBA8,
          w,
          h,
          0,
          gl!.RGBA,
          gl!.UNSIGNED_BYTE,
          null
        );
      }
    } else {
      if (hasColorBufferFloat) {
        gl!.texImage2D(
          gl!.TEXTURE_2D,
          0,
          gl!.R16F,
          w,
          h,
          0,
          gl!.RED,
          gl!.HALF_FLOAT,
          null
        );
      } else {
        gl!.texImage2D(
          gl!.TEXTURE_2D,
          0,
          gl!.R8,
          w,
          h,
          0,
          gl!.RED,
          gl!.UNSIGNED_BYTE,
          null
        );
      }
    }
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    gl!.bindTexture(gl!.TEXTURE_2D, null);
    return tex;
  }

  function bindTarget(target: ImageValue | MaskValue | UvValue | null) {
    if (!target) {
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
      gl!.viewport(0, 0, gl!.drawingBufferWidth, gl!.drawingBufferHeight);
      return;
    }
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
    gl!.framebufferTexture2D(
      gl!.FRAMEBUFFER,
      gl!.COLOR_ATTACHMENT0,
      gl!.TEXTURE_2D,
      target.texture,
      0
    );
    gl!.viewport(0, 0, target.width, target.height);
  }

  function makeContext(
    time: number,
    frame: number,
    cursor?: CursorState,
    playing = false
  ): RenderContext {
    return {
      gl: gl!,
      get width() {
        return width;
      },
      get height() {
        return height;
      },
      time,
      frame,
      playing,
      cursor: cursor ?? { x: 0.5, y: 0.5, active: false },
      state: persistentState,
      allocImage(opts) {
        const w = opts?.width ?? width;
        const h = opts?.height ?? height;
        const tex = allocTexture(w, h, "rgba");
        return { kind: "image", texture: tex, width: w, height: h };
      },
      allocMask(opts) {
        const w = opts?.width ?? width;
        const h = opts?.height ?? height;
        const tex = allocTexture(w, h, "r");
        return { kind: "mask", texture: tex, width: w, height: h };
      },
      allocUv(opts) {
        // UV fields live in the same half-float RGBA texture as images. R = u,
        // G = v; B and A are currently unused (reserved for future per-pixel
        // derivatives or a mask channel).
        const w = opts?.width ?? width;
        const h = opts?.height ?? height;
        const tex = allocTexture(w, h, "rgba");
        return { kind: "uv", texture: tex, width: w, height: h };
      },
      releaseTexture(tex) {
        if (tex) gl!.deleteTexture(tex);
      },
      drawFullscreen(program, target, setup) {
        bindTarget(target);
        gl!.useProgram(program);
        gl!.bindVertexArray(vao);
        gl!.disable(gl!.DEPTH_TEST);
        gl!.disable(gl!.BLEND);
        if (setup) setup(gl!);
        gl!.drawArrays(gl!.TRIANGLES, 0, 3);
        gl!.bindVertexArray(null);
      },
      clearTarget(target, rgba) {
        bindTarget(target);
        const [r, g, b, a] = rgba ?? [0, 0, 0, 1];
        gl!.clearColor(r, g, b, a);
        gl!.clear(gl!.COLOR_BUFFER_BIT);
      },
      getShader,
      blitToCanvas(image, targetCanvas) {
        const w = targetCanvas.width;
        const h = targetCanvas.height;
        if (hiddenCanvas.width !== w) hiddenCanvas.width = w;
        if (hiddenCanvas.height !== h) hiddenCanvas.height = h;
        gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
        gl!.viewport(0, 0, w, h);
        gl!.clearColor(0, 0, 0, 1);
        gl!.clear(gl!.COLOR_BUFFER_BIT);
        gl!.useProgram(blitProgram);
        gl!.bindVertexArray(vao);
        gl!.activeTexture(gl!.TEXTURE0);
        gl!.bindTexture(gl!.TEXTURE_2D, image.texture);
        const loc = gl!.getUniformLocation(blitProgram, "u_src");
        gl!.uniform1i(loc, 0);
        gl!.drawArrays(gl!.TRIANGLES, 0, 3);
        gl!.bindVertexArray(null);

        const ctx2d = targetCanvas.getContext("2d");
        if (ctx2d) {
          ctx2d.clearRect(0, 0, w, h);
          ctx2d.drawImage(hiddenCanvas, 0, 0);
        }
      },
      blitToGLCanvas(image, w, h) {
        // Same GPU draw as blitToCanvas' first half, then we hand
        // the internal WebGL canvas back untouched. No ctx2d copy
        // means no readback — MediaPipe (and any other consumer
        // accepting a TexImageSource) can sample it directly.
        if (hiddenCanvas.width !== w) hiddenCanvas.width = w;
        if (hiddenCanvas.height !== h) hiddenCanvas.height = h;
        gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
        gl!.viewport(0, 0, w, h);
        gl!.clearColor(0, 0, 0, 1);
        gl!.clear(gl!.COLOR_BUFFER_BIT);
        gl!.useProgram(blitProgram);
        gl!.bindVertexArray(vao);
        gl!.activeTexture(gl!.TEXTURE0);
        gl!.bindTexture(gl!.TEXTURE_2D, image.texture);
        const loc = gl!.getUniformLocation(blitProgram, "u_src");
        gl!.uniform1i(loc, 0);
        gl!.drawArrays(gl!.TRIANGLES, 0, 3);
        gl!.bindVertexArray(null);
        return hiddenCanvas;
      },
    };
  }

  return {
    gl: gl!,
    hiddenCanvas,
    state: persistentState,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    resize(w, h) {
      width = w;
      height = h;
      hiddenCanvas.width = w;
      hiddenCanvas.height = h;
    },
    makeContext,
    destroy() {
      shaderCache.forEach((p) => gl!.deleteProgram(p));
      shaderCache.clear();
      gl!.deleteVertexArray(vao);
      gl!.deleteShader(sharedVs);
      gl!.deleteFramebuffer(fbo);
    },
  };
}
