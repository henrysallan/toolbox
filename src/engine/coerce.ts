import type {
  AudioValue,
  RenderContext,
  SocketType,
  SocketValue,
} from "./types";

// Shared 1×1 scratch canvas for the image/mask → scalar readback. Lives
// on ctx.state so it persists across evals without re-allocating, and
// gets torn down with the render context. Each eval reuses the same
// canvas; content is overwritten by blitToCanvas.
const SCRATCH_KEY = "__coerce_scratch_1x1__";

function getScratchCanvas(ctx: RenderContext): HTMLCanvasElement {
  const existing = ctx.state[SCRATCH_KEY] as HTMLCanvasElement | undefined;
  if (existing) return existing;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  ctx.state[SCRATCH_KEY] = canvas;
  return canvas;
}

// Audio analyser machinery for the audio → scalar coercion.
//
// We maintain one AudioContext per tab (lazy) and one AnalyserNode per
// audio element (cached on ctx.state). The analyser taps the element's
// playback through a MediaElement or MediaStream source:
//
//   file source → MediaElementSource → Analyser → Destination
//   mic source  → MediaStreamSource  → Analyser  (no destination — the
//                                                 <audio> element already
//                                                 plays live via
//                                                 srcObject, and routing
//                                                 the mic to speakers
//                                                 would feedback loop)
//
// The emitted scalar is the RMS of the current time-domain buffer —
// 0 when silent, ~1 on a saturated signal. Works as a "level meter" for
// driving animation parameters with audio loudness.

const AUDIO_CTX_KEY = "__coerce_audio_ctx__";
const ANALYSER_MAP_KEY = "__coerce_audio_analysers__";

function getAudioContext(ctx: RenderContext): AudioContext | null {
  const existing = ctx.state[AUDIO_CTX_KEY] as AudioContext | undefined;
  if (existing) {
    if (existing.state === "suspended") existing.resume().catch(() => {});
    return existing;
  }
  try {
    const audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    ctx.state[AUDIO_CTX_KEY] = audioCtx;
    return audioCtx;
  } catch {
    return null;
  }
}

interface AnalyserEntry {
  analyser: AnalyserNode;
  // Explicit `Uint8Array<ArrayBuffer>` (vs. the default
  // `Uint8Array<ArrayBufferLike>`) so TS's narrowed DOM types accept it
  // in `getByteTimeDomainData`, which refuses SharedArrayBuffer backing.
  buffer: Uint8Array<ArrayBuffer>;
}

function getOrCreateAnalyser(
  ctx: RenderContext,
  value: AudioValue
): AnalyserEntry | null {
  const map = (ctx.state[ANALYSER_MAP_KEY] ??= new Map()) as Map<
    HTMLAudioElement,
    AnalyserEntry
  >;
  const cached = map.get(value.element);
  if (cached) return cached;

  const audioCtx = getAudioContext(ctx);
  if (!audioCtx) return null;

  try {
    let source: AudioNode;
    if (value.source === "mic") {
      // `srcObject` carries the MediaStream for mic-mode elements —
      // createMediaStreamSource taps it without interrupting the
      // element's own audible playback path.
      const stream = (value.element as HTMLAudioElement & {
        srcObject: MediaStream | null;
      }).srcObject;
      if (!stream) return null;
      source = audioCtx.createMediaStreamSource(stream);
    } else {
      // createMediaElementSource is one-shot per element. It ALSO
      // diverts the element's normal audio output through WebAudio,
      // so we must connect to destination ourselves to keep file
      // playback audible.
      source = audioCtx.createMediaElementSource(value.element);
      source.connect(audioCtx.destination);
    }
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    // `smoothingTimeConstant` only affects frequency-domain data,
    // not the time-domain buffer we sample — included for future
    // consumers that might want FFT data.
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);
    const entry: AnalyserEntry = {
      analyser,
      // Explicit ArrayBuffer so TS's narrowed DOM types accept it in
      // `getByteTimeDomainData` (which requires an ArrayBuffer-backed
      // Uint8Array, not a SharedArrayBuffer-backed one).
      buffer: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
    };
    map.set(value.element, entry);
    return entry;
  } catch {
    return null;
  }
}

function audioAmplitudeRms(entry: AnalyserEntry): number {
  entry.analyser.getByteTimeDomainData(entry.buffer);
  let sum = 0;
  for (let i = 0; i < entry.buffer.length; i++) {
    const v = (entry.buffer[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / entry.buffer.length);
}

// Sample the representative value of an image-like texture by blitting it
// through a 1×1 framebuffer (the WebGL hiddenCanvas inside blitToCanvas
// resizes to match the target), then reading that one pixel back. The
// sampled UV is the fullscreen triangle's fragment center ≈ (0.5, 0.5),
// so for smooth inputs (noise, gradients) this is the visual "middle
// value." For high-contrast images it's just whatever single pixel the
// linear-filter sampler lands on — good enough for the common case of
// wiring noise → scalar params.
function sampleImageRed(
  value: { texture: WebGLTexture; width: number; height: number },
  ctx: RenderContext
): number | null {
  const canvas = getScratchCanvas(ctx);
  try {
    ctx.blitToCanvas(
      { kind: "image", texture: value.texture, width: value.width, height: value.height },
      canvas
    );
  } catch {
    return null;
  }
  const c2d = canvas.getContext("2d");
  if (!c2d) return null;
  const data = c2d.getImageData(0, 0, 1, 1).data;
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

const IMAGE_TO_MASK_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  vec3 c = texture(u_src, v_uv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  outColor = vec4(l, 0.0, 0.0, 1.0);
}`;

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

  // Audio → scalar. Taps the element through a WebAudio AnalyserNode
  // (created lazily, cached per element) and emits the RMS of the
  // current time-domain buffer: 0 when silent, ~1 on a loud signal.
  // Wire Audio Source into Transform's scale, a Math node, a Remap's
  // input, etc. — anywhere a scalar belongs.
  if (value.kind === "audio" && target === "scalar") {
    const entry = getOrCreateAnalyser(ctx, value);
    if (!entry) return { kind: "scalar", value: 0 };
    return { kind: "scalar", value: audioAmplitudeRms(entry) };
  }

  return undefined;
}
