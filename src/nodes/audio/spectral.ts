import type { AudioFrame } from "@/engine/audio-analysis";
import {
  binToHz,
  getAudioFrame,
  hzToMidi,
  offlineChainFrameAt,
  offlineFrameAt,
} from "@/engine/audio-analysis";
import type {
  AudioValue,
  NodeDefinition,
  NodeOutput,
  RenderContext,
} from "@/engine/types";

// Audio Spectral — turn an audio signal into a spectrum image: a spatial
// scalar field (frequency along an axis, magnitude as the value) you can
// sample to drive other things — Displace, Copy-to-Points heights, gradient
// stops, an SDF field, etc. The primary `image` coerces to `mask`.
//
// Algorithms ("various compositions"):
//   linear   — magnitude vs linear frequency
//   log      — magnitude vs log frequency (more low-end detail)
//   mel      — magnitude vs mel (perceptual) frequency
//   waveform    — the time-domain signal as a field
//   chroma      — 12 pitch classes (octave-folded)
//   spectrogram — 2D: log-frequency × scrolling time history (newest edge)
//
// Analysis is shared via engine/audio-analysis.ts. stable:false (live
// signal each frame). A temporal one-pole smooths the 1D field. The
// spectrogram accumulates a history of columns live (one per scene frame)
// and reconstructs that history deterministically offline (one FFT per
// row at the preceding frame times) — see the offline branch.

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_field;  // bins × 1, value in .r
uniform int u_orient;       // 0 = frequency along X, 1 = along Y
uniform int u_mirror;       // 1 = mirror both halves around center
out vec4 outColor;
void main() {
  float t = (u_orient == 1) ? v_uv.y : v_uv.x;
  if (u_mirror == 1) {
    t = t < 0.5 ? t * 2.0 : (1.0 - t) * 2.0;
  }
  float v = texture(u_field, vec2(clamp(t, 0.0, 1.0), 0.5)).r;
  outColor = vec4(v, v, v, 1.0);
}`;

// 2D spectrogram: one axis frequency, the other scrolling time (newest at
// the far edge). Texture is bins(x) × history(y), row 0 = oldest.
const FS_SPECTROGRAM = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_field;  // bins(x) × history(y)
uniform int u_orient;       // 0 = freq X / time Y, 1 = freq Y / time X
uniform int u_mirror;
out vec4 outColor;
void main() {
  float f = (u_orient == 1) ? v_uv.y : v_uv.x;   // frequency axis
  float t = (u_orient == 1) ? v_uv.x : v_uv.y;   // time axis
  if (u_mirror == 1) {
    f = f < 0.5 ? f * 2.0 : (1.0 - f) * 2.0;
  }
  float v = texture(u_field, vec2(clamp(f, 0.0, 1.0), clamp(t, 0.0, 1.0))).r;
  outColor = vec4(v, v, v, 1.0);
}`;

interface SpectralState {
  field: Float32Array | null; // smoothed 1D field (length = bins)
  // Spectrogram history, newest last. Each row is a bins-length column.
  rows: Float32Array[] | null;
  lastFrame: number;
}

function ensureState(ctx: RenderContext, nodeId: string): SpectralState {
  const key = `audio-spectral:${nodeId}`;
  const existing = ctx.state[key] as SpectralState | undefined;
  if (existing) return existing;
  const s: SpectralState = { field: null, rows: null, lastFrame: -1 };
  ctx.state[key] = s;
  return s;
}

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

// Compute the chosen representation as a [0,1] field of length `bins`.
function buildField(
  frame: AudioFrame,
  algorithm: string,
  bins: number,
  dbFloor: number,
  dbCeil: number,
  gamma: number,
  fMin: number
): Float32Array {
  const out = new Float32Array(bins);
  const sr = frame.sampleRate;
  const fft = frame.fftSize;
  const nyq = sr / 2;

  if (algorithm === "waveform") {
    const td = frame.timeDomain;
    for (let x = 0; x < bins; x++) {
      const i = Math.min(td.length - 1, Math.floor((x / bins) * td.length));
      out[x] = td[i] * 0.5 + 0.5;
    }
    return out;
  }

  const mag = frame.freq();
  const half = mag.length;
  const span = Math.max(1e-3, dbCeil - dbFloor);
  const toNorm = (m: number): number => {
    const db = 20 * Math.log10(Math.max(m, 1e-7));
    const v = Math.max(0, Math.min(1, (db - dbFloor) / span));
    return Math.pow(v, gamma);
  };

  if (algorithm === "chroma") {
    const chroma = new Float32Array(12);
    for (let b = 1; b < half; b++) {
      const f = binToHz(b, sr, fft);
      if (f < 20) continue;
      const pc = (((Math.round(hzToMidi(f)) % 12) + 12) % 12);
      chroma[pc] += mag[b];
    }
    let mx = 0;
    for (let i = 0; i < 12; i++) mx = Math.max(mx, chroma[i]);
    for (let x = 0; x < bins; x++) {
      const pc = Math.floor((x / bins) * 12) % 12;
      out[x] = mx > 0 ? Math.pow(Math.min(1, chroma[pc] / mx), gamma) : 0;
    }
    return out;
  }

  // linear / log / mel — map each output column to a source frequency.
  const denom = bins > 1 ? bins - 1 : 1;
  for (let x = 0; x < bins; x++) {
    const t = x / denom;
    let f: number;
    if (algorithm === "log") {
      const lo = Math.max(1, fMin);
      f = lo * Math.pow(nyq / lo, t);
    } else if (algorithm === "mel") {
      const melMax = 2595 * Math.log10(1 + nyq / 700);
      f = 700 * (Math.pow(10, (t * melMax) / 2595) - 1);
    } else {
      f = t * nyq;
    }
    const bin = Math.max(0, Math.min(half - 1, Math.round((f * fft) / sr)));
    out[x] = toNorm(mag[bin]);
  }
  return out;
}

function getFieldTexture(
  gl: WebGL2RenderingContext,
  state: Record<string, unknown>,
  nodeId: string,
  data: Uint8Array,
  width: number,
  height: number
): WebGLTexture {
  const key = `audio-spectral:${nodeId}:tex`;
  let tex = state[key] as WebGLTexture | undefined;
  if (!tex) {
    const created = gl.createTexture();
    if (!created) throw new Error("audio-spectral: failed to create texture");
    tex = created;
    state[key] = tex;
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    data
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

// Pack a grayscale [0,1] field to 8-bit RGBA rows (row-major, value in rgb).
function packField(values: Float32Array): Uint8Array {
  const data = new Uint8Array(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round(values[i] * 255)));
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return data;
}

function packRows(rows: Float32Array[], bins: number): Uint8Array {
  const data = new Uint8Array(bins * rows.length * 4);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const base = r * bins * 4;
    for (let x = 0; x < bins; x++) {
      const v = Math.max(0, Math.min(255, Math.round(row[x] * 255)));
      const o = base + x * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return data;
}

// Upload the packed field and draw it fullscreen into `output`.
function drawField(
  ctx: RenderContext,
  nodeId: string,
  output: ReturnType<RenderContext["allocImage"]>,
  prog: WebGLProgram,
  data: Uint8Array,
  width: number,
  height: number,
  orient: number,
  mirror: number
): void {
  const tex = getFieldTexture(ctx.gl, ctx.state, nodeId, data, width, height);
  ctx.drawFullscreen(prog, output, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_field"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_orient"), orient);
    gl.uniform1i(gl.getUniformLocation(prog, "u_mirror"), mirror);
  });
}

// Build the spectrogram's row history (row 0 = oldest, last = newest).
// Live: accumulate one log-frequency column per scene frame. Offline:
// reconstruct deterministically by running one FFT per row at the
// preceding frame times. Returns null while the offline buffer is still
// decoding (the settle handshake re-renders once it's ready) or when the
// live analyser has no data yet.
function buildSpectrogramRows(
  audio: AudioValue,
  ctx: RenderContext,
  state: SpectralState,
  bins: number,
  history: number,
  dbFloor: number,
  dbCeil: number,
  gamma: number,
  fMin: number
): Float32Array[] | null {
  const column = (frame: AudioFrame): Float32Array =>
    buildField(frame, "log", bins, dbFloor, dbCeil, gamma, fMin);

  if (ctx.offline) {
    // Chain taps win over the element passthrough, same precedence as
    // getAudioFrame: the chain buffer is the POST-effect signal. `now` for
    // a chain is scene time (the buffer renders from scene t=0); for an
    // element it stays the seeked currentTime.
    const chain = audio.chain;
    if (!chain && !audio.element) return null;
    const now = chain ? ctx.time : audio.element!.currentTime || 0;
    const dt = 1 / Math.max(1, ctx.fps);
    const rows: Float32Array[] = [];
    let anyReady = false;
    for (let r = 0; r < history; r++) {
      const age = history - 1 - r; // r=0 → oldest
      const f = chain
        ? offlineChainFrameAt(chain, ctx, Math.max(0, now - age * dt))
        : offlineFrameAt(audio, ctx, Math.max(0, now - age * dt));
      if (f) {
        anyReady = true;
        rows.push(column(f));
      } else {
        rows.push(new Float32Array(bins));
      }
    }
    return anyReady ? rows : null;
  }

  const frame = getAudioFrame(audio, ctx);
  if (!frame) return null;
  const current = column(frame);
  let rows = state.rows;
  if (!rows || rows.length !== history || rows[0].length !== bins) {
    rows = Array.from({ length: history }, () => current.slice());
    state.rows = rows;
    state.lastFrame = ctx.frame;
  } else if (ctx.frame !== state.lastFrame) {
    // Advance one row per scene frame — not on param-edit re-evals.
    rows.shift();
    rows.push(current);
    state.lastFrame = ctx.frame;
  } else {
    rows[rows.length - 1] = current;
  }
  return rows;
}

export const audioSpectralNode: NodeDefinition = {
  type: "audio-spectral",
  name: "Audio Spectral",
  category: "audio",
  subcategory: "generator",
  description:
    "Turn audio into a spectrum image — a scalar field (frequency × magnitude) to drive Displace, Copy-to-Points, gradients, SDF fields, and more. Linear / log / mel / waveform / chroma / 2D spectrogram.",
  backend: "webgl2",
  stable: false,
  noMaskInput: true,
  inputs: [{ name: "audio", type: "audio", required: true, label: "Audio" }],
  params: [
    {
      name: "algorithm",
      label: "Algorithm",
      type: "enum",
      options: ["linear", "log", "mel", "waveform", "chroma", "spectrogram"],
      default: "log",
    },
    {
      name: "bins",
      label: "Resolution",
      type: "scalar",
      min: 16,
      max: 1024,
      softMax: 512,
      step: 1,
      default: 256,
    },
    {
      name: "history",
      label: "History (rows)",
      type: "scalar",
      min: 16,
      max: 512,
      softMax: 256,
      step: 1,
      default: 128,
      visibleIf: (p) => p.algorithm === "spectrogram",
    },
    {
      name: "f_min",
      label: "Min freq (Hz)",
      type: "scalar",
      min: 10,
      max: 2000,
      softMax: 200,
      step: 1,
      default: 40,
      visibleIf: (p) =>
        p.algorithm === "log" ||
        p.algorithm === "mel" ||
        p.algorithm === "spectrogram",
    },
    {
      name: "db_floor",
      label: "dB floor",
      type: "scalar",
      min: -120,
      max: 0,
      step: 1,
      default: -70,
      visibleIf: (p) => p.algorithm !== "waveform",
    },
    {
      name: "db_ceil",
      label: "dB ceil",
      type: "scalar",
      min: -60,
      max: 12,
      step: 1,
      default: -10,
      visibleIf: (p) => p.algorithm !== "waveform",
    },
    {
      name: "gamma",
      label: "Contrast (γ)",
      type: "scalar",
      min: 0.2,
      max: 4,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.algorithm !== "waveform",
    },
    {
      name: "smoothing",
      label: "Smoothing",
      type: "scalar",
      min: 0,
      max: 0.99,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "orientation",
      label: "Orientation",
      type: "enum",
      options: ["horizontal", "vertical"],
      default: "horizontal",
    },
    {
      name: "mirror",
      label: "Mirror",
      type: "boolean",
      default: false,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }): NodeOutput {
    const output = ctx.allocImage();
    const state = ensureState(ctx, nodeId);
    const audio = inputs.audio?.kind === "audio" ? inputs.audio : null;

    const algorithm = (params.algorithm as string) ?? "log";
    const bins = Math.max(16, Math.min(1024, Math.floor(num(params.bins, 256))));
    const dbFloor = num(params.db_floor, -70);
    const dbCeil = num(params.db_ceil, -10);
    const gamma = num(params.gamma, 1);
    const fMin = num(params.f_min, 40);
    const orient = (params.orientation as string) === "vertical" ? 1 : 0;
    const mirror = (params.mirror as boolean) ? 1 : 0;

    const clear = (): NodeOutput => {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output };
    };

    if (!audio) return clear();

    if (algorithm === "spectrogram") {
      const history = Math.max(16, Math.min(512, Math.floor(num(params.history, 128))));
      const rows = buildSpectrogramRows(
        audio, ctx, state, bins, history, dbFloor, dbCeil, gamma, fMin
      );
      if (!rows) return clear();
      const prog = ctx.getShader("audio-spectral/spectrogram", FS_SPECTROGRAM);
      drawField(ctx, nodeId, output, prog, packRows(rows, bins), bins, rows.length, orient, mirror);
      return { primary: output };
    }

    // ---- 1D field path ----
    const frame = getAudioFrame(audio, ctx);
    if (!frame) return clear();

    const smoothing = Math.max(0, Math.min(0.99, num(params.smoothing, 0.5)));
    const target = buildField(frame, algorithm, bins, dbFloor, dbCeil, gamma, fMin);

    // Temporal one-pole smoothing (reset when bins change).
    let field = state.field;
    if (!field || field.length !== bins) {
      field = target.slice();
    } else {
      for (let i = 0; i < bins; i++) {
        field[i] = field[i] * smoothing + target[i] * (1 - smoothing);
      }
    }
    state.field = field;

    const prog = ctx.getShader("audio-spectral/fs", FS);
    drawField(ctx, nodeId, output, prog, packField(field), bins, 1, orient, mirror);
    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const texKey = `audio-spectral:${nodeId}:tex`;
    const tex = ctx.state[texKey] as WebGLTexture | undefined;
    if (tex) ctx.gl.deleteTexture(tex);
    delete ctx.state[texKey];
    delete ctx.state[`audio-spectral:${nodeId}`];
  },
};
