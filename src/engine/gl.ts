import type {
  CursorState,
  ImageValue,
  MaskValue,
  RenderContext,
  UvValue,
} from "./types";
import * as prof from "./profiler";

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

// Y-flipped blit for readImagePixels. readPixels returns rows starting at
// framebuffer y=0 (the visual bottom), while every CPU consumer expects
// canvas ImageData row order (row 0 = visual top — what the old
// blitToCanvas + getImageData recipe produced). Flipping at draw time makes
// the readPixels output come back top-down with no CPU row shuffle.
const READBACK_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
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
    playing?: boolean,
    timeline?: { tick: number; ticksPerFrame: number; fps: number; bpm?: number },
    offline?: boolean,
    wedgeIndex?: number
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

  // Lazy WebGPU device handle. Resolved on the first getWebGPUDevice()
  // call and cached forever after. We hold the promise (not just the
  // device) so concurrent callers all await the same boot. `null` is
  // a valid resolved value meaning "this browser/hw can't do WebGPU";
  // callers should branch on that rather than throw.
  let webGpuDevicePromise: Promise<GPUDevice | null> | null = null;
  function getWebGPUDevice(): Promise<GPUDevice | null> {
    if (webGpuDevicePromise) return webGpuDevicePromise;
    webGpuDevicePromise = (async (): Promise<GPUDevice | null> => {
      const nav = typeof navigator !== "undefined" ? navigator : null;
      const gpu = (nav as Navigator & { gpu?: GPU }).gpu;
      if (!gpu) return null;
      try {
        const adapter = await gpu.requestAdapter();
        if (!adapter) return null;
        return await adapter.requestDevice();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("WebGPU device request failed:", err);
        return null;
      }
    })();
    return webGpuDevicePromise;
  }

  // ---- Cross-context bridges ----------------------------------------
  // These use a transient FBO + readPixels for the read side, and
  // texSubImage2D for the write side. Both go through CPU memory; for
  // v1 that's the simplest stable interop path across WebGL ↔ WebGPU.
  function readImageToFloat32Internal(image: ImageValue): Float32Array {
    const w = image.width;
    const h = image.height;
    const fboLocal = gl!.createFramebuffer();
    if (!fboLocal) throw new Error("readImageToFloat32: createFramebuffer failed");
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fboLocal);
    gl!.framebufferTexture2D(
      gl!.FRAMEBUFFER,
      gl!.COLOR_ATTACHMENT0,
      gl!.TEXTURE_2D,
      image.texture,
      0
    );
    const status = gl!.checkFramebufferStatus(gl!.FRAMEBUFFER);
    if (status !== gl!.FRAMEBUFFER_COMPLETE) {
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
      gl!.deleteFramebuffer(fboLocal);
      throw new Error(`readImageToFloat32: incomplete framebuffer (0x${status.toString(16)})`);
    }
    const out = new Float32Array(w * h * 4);
    if (hasColorBufferFloat) {
      // Source is RGBA16F (or fallback RGBA8). EXT_color_buffer_float
      // lets us read back as FLOAT directly — best path.
      gl!.readPixels(0, 0, w, h, gl!.RGBA, gl!.FLOAT, out);
    } else {
      // RGBA8 fallback: read as UNSIGNED_BYTE then scale to 0..1.
      const bytes = new Uint8Array(w * h * 4);
      gl!.readPixels(0, 0, w, h, gl!.RGBA, gl!.UNSIGNED_BYTE, bytes);
      for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] / 255;
    }
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.deleteFramebuffer(fboLocal);
    return out;
  }

  function uploadFloat32ToImageInternal(
    data: Float32Array,
    w: number,
    h: number
  ): ImageValue {
    if (data.length !== w * h * 4) {
      throw new Error(
        `uploadFloat32ToImage: expected ${w * h * 4} floats, got ${data.length}`
      );
    }
    const tex = allocTexture(w, h, "rgba");
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
    if (hasColorBufferFloat) {
      // RGBA16F target accepts FLOAT uploads — WebGL2 spec converts
      // float-to-half on the driver side.
      gl!.texSubImage2D(
        gl!.TEXTURE_2D,
        0,
        0,
        0,
        w,
        h,
        gl!.RGBA,
        gl!.FLOAT,
        data
      );
    } else {
      // RGBA8 fallback: clamp + scale to 0..255.
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        const v = Math.max(0, Math.min(1, data[i]));
        bytes[i] = (v * 255) | 0;
      }
      gl!.texSubImage2D(
        gl!.TEXTURE_2D,
        0,
        0,
        0,
        w,
        h,
        gl!.RGBA,
        gl!.UNSIGNED_BYTE,
        bytes
      );
    }
    gl!.bindTexture(gl!.TEXTURE_2D, null);
    return { kind: "image", texture: tex, width: w, height: h };
  }

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
  const readbackProgram = getShader("__readback__", READBACK_FS);

  // ---- CPU pixel readback --------------------------------------------
  // Replaces the blitToCanvas + getImageData recipe for nodes that need
  // image pixels on the CPU (scatter density, point samplers, content
  // rects…). That recipe resized hiddenCanvas — the canvas hosting this
  // GL context — to the readback size, reallocating the default
  // framebuffer up to twice per frame (readback size, then back to
  // preview size at present). Rendering into a pooled offscreen RGBA8
  // target and calling readPixels leaves hiddenCanvas alone entirely.
  //
  // Targets are RGBA8 regardless of the source's RGBA16F: readPixels with
  // UNSIGNED_BYTE needs a normalized-byte framebuffer, and byte output is
  // what every consumer wants anyway (ImageData parity). Pool is keyed by
  // size — a handful of nodes each read at one stable size per frame, so
  // the map stays tiny; it's emptied wholesale if it ever grows past 8.
  const readbackTargets = new Map<string, WebGLTexture>();
  const readbackFbo = gl.createFramebuffer();
  if (!readbackFbo) throw new Error("Failed to create readback FBO");

  function readImagePixelsInternal(
    image: ImageValue,
    width?: number,
    height?: number
  ): Uint8ClampedArray<ArrayBuffer> | null {
    const w = Math.max(1, Math.floor(width ?? image.width));
    const h = Math.max(1, Math.floor(height ?? image.height));
    const key = `${w}x${h}`;
    let tex = readbackTargets.get(key);
    if (!tex) {
      if (readbackTargets.size >= 8) {
        for (const t of readbackTargets.values()) gl!.deleteTexture(t);
        readbackTargets.clear();
      }
      const created = gl!.createTexture();
      if (!created) return null;
      gl!.bindTexture(gl!.TEXTURE_2D, created);
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
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.NEAREST);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
      gl!.bindTexture(gl!.TEXTURE_2D, null);
      readbackTargets.set(key, created);
      tex = created;
    }

    gl!.bindFramebuffer(gl!.FRAMEBUFFER, readbackFbo);
    gl!.framebufferTexture2D(
      gl!.FRAMEBUFFER,
      gl!.COLOR_ATTACHMENT0,
      gl!.TEXTURE_2D,
      tex,
      0
    );
    if (gl!.checkFramebufferStatus(gl!.FRAMEBUFFER) !== gl!.FRAMEBUFFER_COMPLETE) {
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
      return null;
    }
    gl!.viewport(0, 0, w, h);
    gl!.disable(gl!.DEPTH_TEST);
    gl!.disable(gl!.BLEND);
    gl!.useProgram(readbackProgram);
    gl!.bindVertexArray(vao);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, image.texture);
    gl!.uniform1i(gl!.getUniformLocation(readbackProgram, "u_src"), 0);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    gl!.bindVertexArray(null);

    const bytes = new Uint8Array(w * h * 4);
    gl!.readPixels(0, 0, w, h, gl!.RGBA, gl!.UNSIGNED_BYTE, bytes);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    // Zero-copy view — values are already 0..255 so clamping semantics
    // are moot; the type just matches ImageData.data for drop-in reuse.
    return new Uint8ClampedArray(bytes.buffer);
  }

  // ---- Texture free-list pool ----
  // Measured before building this (perf spec, Fix 10): recycling just
  // Bloom's 11 per-eval mip textures saved 2.1 ms of GPU per frame at 4K —
  // create/delete churn is real GPU time, not merely bookkeeping. The pool
  // makes the devguide's long-standing "lease from a pool" description true
  // for every allocImage/allocMask/allocUv.
  //
  // - Key = size + channel format. texKey remembers each pool texture's key
  //   so releaseTexture can file it; textures created elsewhere (node-state
  //   textures) miss the WeakMap and delete exactly as before.
  // - A reused texture is CLEARED before hand-out: WebGL zero-initializes
  //   fresh textures and nodes may legitimately rely on alloc = transparent
  //   black. The clear is a load-op on tile GPUs — far cheaper than the
  //   create + delete it replaces.
  // - `inPool` guards double-release: filing the same texture twice would
  //   hand one texture to two owners later, which presents as impossible
  //   cross-node bleed, not as a pool bug.
  // - Aging: entries idle past POOL_MAX_AGE leases die in a periodic sweep,
  //   per-key lists cap at POOL_MAX_PER_KEY, and resize()/destroy() flush
  //   outright — a resized canvas or shrunk graph can't strand VRAM.
  // - The profiler still counts every lease/release (unchanged semantics —
  //   per-node attribution depends on it), so its "allocs" now measure pool
  //   TRAFFIC; real driver allocations are only the pool misses.
  const freeLists = new Map<string, { tex: WebGLTexture; tick: number }[]>();
  const texKey = new WeakMap<WebGLTexture, string>();
  const inPool = new WeakSet<WebGLTexture>();
  let poolTick = 0;
  const POOL_MAX_PER_KEY = 16;
  const POOL_MAX_AGE = 2048;

  function flushPool() {
    for (const list of freeLists.values()) {
      for (const e of list) {
        inPool.delete(e.tex);
        gl!.deleteTexture(e.tex);
      }
    }
    freeLists.clear();
  }

  function sweepPool() {
    const cutoff = poolTick - POOL_MAX_AGE;
    for (const [key, list] of freeLists) {
      const keep = list.filter((e) => e.tick >= cutoff);
      if (keep.length === list.length) continue;
      for (const e of list) {
        if (e.tick < cutoff) {
          inPool.delete(e.tex);
          gl!.deleteTexture(e.tex);
        }
      }
      if (keep.length === 0) freeLists.delete(key);
      else freeLists.set(key, keep);
    }
  }

  function allocTexture(
    w: number,
    h: number,
    channels: "rgba" | "r"
  ): WebGLTexture {
    prof.countAlloc(w, h, channels === "rgba" ? (hasColorBufferFloat ? 8 : 4) : hasColorBufferFloat ? 2 : 1);
    poolTick++;
    const key = `${w}:${h}:${channels}`;
    const entry = freeLists.get(key)?.pop();
    if (entry) {
      inPool.delete(entry.tex);
      // Reproduce the zero-init a fresh texture would have had.
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
      gl!.framebufferTexture2D(
        gl!.FRAMEBUFFER,
        gl!.COLOR_ATTACHMENT0,
        gl!.TEXTURE_2D,
        entry.tex,
        0
      );
      gl!.viewport(0, 0, w, h);
      gl!.clearColor(0, 0, 0, 0);
      gl!.clear(gl!.COLOR_BUFFER_BIT);
      return entry.tex;
    }
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
    texKey.set(tex, key);
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
    playing = false,
    timeline?: { tick: number; ticksPerFrame: number; fps: number; bpm?: number },
    offline = false,
    wedgeIndex?: number
  ): RenderContext {
    const tpf = timeline?.ticksPerFrame ?? 1000;
    const renderFps = timeline?.fps ?? (frame > 0 && time > 0 ? frame / time : 60);
    const tick = timeline?.tick ?? Math.round(time * renderFps * tpf);
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
      tick,
      ticksPerFrame: tpf,
      fps: renderFps,
      bpm: timeline?.bpm,
      playing,
      offline,
      wedgeIndex,
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
        if (!tex) return;
        prof.countRelease();
        const key = texKey.get(tex);
        if (!key || inPool.has(tex)) {
          // Not pool-born (a node-state texture routed here) or a double
          // release — delete/ignore rather than corrupt the free list.
          if (!inPool.has(tex)) gl!.deleteTexture(tex);
          return;
        }
        let list = freeLists.get(key);
        if (!list) {
          list = [];
          freeLists.set(key, list);
        }
        if (list.length >= POOL_MAX_PER_KEY) {
          gl!.deleteTexture(tex);
        } else {
          inPool.add(tex);
          list.push({ tex, tick: poolTick });
        }
        if ((poolTick & 255) === 0) sweepPool();
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
        // Present is a straight copy: the source already holds the final
        // composited RGBA with straight alpha. Blending here would mix it
        // over the opaque-black clear above and flatten alpha to 1 — which
        // silently kills transparency in PNG-frame captures (ProRes 4444
        // export, etc.). Force it off so the captured frame keeps real alpha.
        gl!.disable(gl!.BLEND);
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
      getWebGPUDevice,
      readImageToFloat32: readImageToFloat32Internal,
      uploadFloat32ToImage: uploadFloat32ToImageInternal,
      readImagePixels: readImagePixelsInternal,
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
      // Old-size pool entries can never be leased again — drop them now
      // rather than waiting out the age sweep with 66 MB textures.
      flushPool();
    },
    makeContext,
    destroy() {
      flushPool();
      shaderCache.forEach((p) => gl!.deleteProgram(p));
      shaderCache.clear();
      readbackTargets.forEach((t) => gl!.deleteTexture(t));
      readbackTargets.clear();
      gl!.deleteFramebuffer(readbackFbo);
      gl!.deleteVertexArray(vao);
      gl!.deleteShader(sharedVs);
      gl!.deleteFramebuffer(fbo);
    },
  };
}
